import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { utcDay } from '@/lib/dates'
import { buildRateTable, crossConvert } from '@/lib/metrics/fx'
import { ensureRates, loadRates } from '@/lib/fx/rates'
import { getSetting } from '@/lib/settings'
import type { RateTable } from '@/lib/metrics/types'

/**
 * The Marketing page's Affiliate section: totals, per shop and per channel.
 *
 * Channel detail lives here rather than in the engine — the engine speaks in
 * per-shop figures, and "which blog earned what" is not one of them.
 *
 * The COST figure follows the engine's conventions exactly, so this section and
 * the Dashboard's Affiliate column can never disagree: non-denied rows only,
 * commission + brokerage fee, summed per (shop, day, currency) and converted at
 * THAT day's own rate — the same grouping src/lib/affiliate/cost.ts hands the
 * engine. Converting row by row instead would round each conversion separately
 * and drift a few minor units away from the dashboard's number.
 */

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

type Slice = { sales: number; orderValue: number; cost: number }

/**
 * Money still in its own currency, on the day it was booked. `id` is whatever
 * the bucket is grouped under — a shop id or a channel id — carried on the
 * bucket rather than parsed back out of the map key.
 */
type Bucket = { id: string; date: Date; currency: string; amount: number; orderValue: number; sales: number }

function bucketInto(map: Map<string, Bucket>, key: string, b: Bucket) {
  const found = map.get(key)
  if (!found) {
    map.set(key, { ...b })
    return
  }
  found.amount += b.amount
  found.orderValue += b.orderValue
  found.sales += b.sales
}

function addTo(map: Map<string, Slice>, key: string, s: Slice) {
  const found = map.get(key) ?? { sales: 0, orderValue: 0, cost: 0 }
  found.sales += s.sales
  found.orderValue += s.orderValue
  found.cost += s.cost
  map.set(key, found)
}

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const setting = await getSetting()
    // The same range and shop resolution /api/marketing uses, from the same
    // helpers — a preset must not resolve to a different fortnight here than
    // it does one section up the page.
    const { from, to } = rangeFromQuery(params, new Date(), setting.timezone)
    const asked = shopIdsFromQuery(params)
    const shopRows = await db.shop.findMany({
      where: { active: true, ...(asked?.length ? { id: { in: asked } } : {}) },
      select: { id: true, name: true, currency: true },
      orderBy: { name: 'asc' },
    })
    const shopIds = shopRows.map((s) => s.id)
    const nameById = new Map(shopRows.map((s) => [s.id, s.name]))

    // One shop needs no crossing and keeps its own currency; several have to
    // meet somewhere, and where is a workspace choice. Exactly the rule in
    // src/lib/data/load.ts, so the two surfaces quote one currency.
    const displayCurrency = shopRows.length === 1 ? shopRows[0].currency : setting.displayCurrency

    const connected = (await db.affiliateAccount.count({ where: { active: true } })) > 0

    // One read, grouped finely enough to answer both breakdowns. Two queries
    // could be torn apart by a sync landing between them, leaving the channel
    // table and the shop table describing different money.
    const groups = await db.affiliateTransaction.groupBy({
      by: ['shopId', 'channelId', 'channelName', 'date', 'currency'],
      where: {
        shopId: { in: shopIds },
        denyDate: null,
        date: { gte: utcDay(from), lte: utcDay(to) },
      },
      _count: { _all: true },
      _sum: { commission: true, brokerageFee: true, orderValue: true },
    })

    // Re-aggregated to the two grains that matter BEFORE any conversion. The
    // shop grain is deliberately the engine's own — see the header comment.
    const shopBuckets = new Map<string, Bucket>()
    const channelBuckets = new Map<string, Bucket>()
    const channelNames = new Map<string, string>()
    for (const g of groups) {
      const shopId = g.shopId! // the `in` filter above makes null impossible
      const day = g.date.toISOString()
      const money = {
        date: g.date,
        currency: g.currency,
        amount: (g._sum.commission ?? 0) + (g._sum.brokerageFee ?? 0),
        orderValue: g._sum.orderValue ?? 0,
        sales: g._count._all,
      }
      bucketInto(shopBuckets, `${shopId}|${day}|${g.currency}`, { id: shopId, ...money })
      bucketInto(channelBuckets, `${g.channelId}|${day}|${g.currency}`, { id: g.channelId, ...money })
      // Keyed on the platform's channel id, not its name: two affiliate sites
      // sharing a display name are two channels, and merging them would print
      // a total belonging to neither.
      channelNames.set(g.channelId, g.channelName)
    }

    // A currency with no rate row converts to itself silently, which reads as a
    // real number and is not one — so top up before converting anything.
    const currencies = new Set([displayCurrency, ...groups.map((g) => g.currency)])
    const needsRates = currencies.size > 1
    if (needsRates) await ensureRates(from, to, [...currencies])
    const rates: RateTable = needsRates ? buildRateTable(await loadRates()) : new Map()

    const converted = (b: Bucket): Slice => ({
      sales: b.sales,
      orderValue: crossConvert(b.orderValue, b.currency, displayCurrency, b.date, rates),
      cost: crossConvert(b.amount, b.currency, displayCurrency, b.date, rates),
    })

    const byShop = new Map<string, Slice>()
    const total: Slice = { sales: 0, orderValue: 0, cost: 0 }
    for (const b of shopBuckets.values()) {
      const slice = converted(b)
      addTo(byShop, b.id, slice)
      total.sales += slice.sales
      total.orderValue += slice.orderValue
      total.cost += slice.cost
    }

    const byChannel = new Map<string, Slice>()
    for (const b of channelBuckets.values()) addTo(byChannel, b.id, converted(b))

    // Loud, never silent: money that belongs to no shop is still money, and it
    // is missing from every per-shop figure above by definition.
    const unmatched = await db.affiliateTransaction.count({
      where: { shopId: null, denyDate: null, date: { gte: utcDay(from), lte: utcDay(to) } },
    })

    return NextResponse.json(
      {
        connected,
        displayCurrency,
        range: { from: utcDay(from).toISOString(), to: utcDay(to).toISOString() },
        total,
        byShop: [...byShop.entries()]
          .map(([shopId, s]) => ({ shopId, shopName: nameById.get(shopId) ?? shopId, ...s }))
          .sort((a, b) => b.cost - a.cost || a.shopName.localeCompare(b.shopName)),
        byChannel: [...byChannel.entries()]
          .map(([channelId, s]) => ({
            channelId,
            channelName: channelNames.get(channelId) ?? channelId,
            ...s,
          }))
          .sort((a, b) => b.cost - a.cost || a.channelName.localeCompare(b.channelName)),
        unmatched,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load affiliate figures' },
      { status: 500, headers: NO_STORE },
    )
  }
}
