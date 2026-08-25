import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { utcDay } from '@/lib/dates'
import { buildRateTable, crossConvert } from '@/lib/metrics/fx'
import { ensureRates, loadRates } from '@/lib/fx/rates'
import { getSetting } from '@/lib/settings'
import { affiliateGroups, toShopDayCurrency } from '@/lib/affiliate/cost'
import type { RateTable } from '@/lib/metrics/types'

/**
 * The Marketing page's Affiliate section: totals, per shop and per channel.
 *
 * Channel detail lives here rather than in the engine - the engine speaks in
 * per-shop figures, and "which blog earned what" is not one of them.
 *
 * The COST figure cannot disagree with the Dashboard's Affiliate column,
 * structurally: both come from the same `affiliateGroups` query through the
 * same `toShopDayCurrency` roll-up (src/lib/affiliate/cost.ts), then convert
 * each (shop, day, currency) slice at THAT day's own rate. There is no second
 * where-clause or cost formula here to drift from the engine's.
 */

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

type Slice = { sales: number; orderValue: number; cost: number }

/** Money still in its own currency, on the day it was booked - a channel's
 *  (channelId, day, currency) bucket, summed exactly before any conversion. */
type ChannelBucket = {
  channelId: string
  date: Date
  currency: string
  amount: number
  orderValue: number
  sales: number
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
    // helpers - a preset must not resolve to a different fortnight here than
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

    // THE affiliate-cost query - the one the engine's own loader uses
    // (src/lib/affiliate/cost.ts), at its finest (…, channel) grain so the
    // channel table can be carved from the same read.
    const groups = await affiliateGroups(shopIds, from, to)

    // Money whose market matched no shop. The `shopId: { in: shopIds }` filter
    // above excludes it from the headline total and the channel table too, not
    // merely from the per-shop rows - so the client needs the AMOUNT, not just
    // a count, to say honestly what is missing. Same predicate otherwise,
    // grouped per (day, currency) so it converts at each day's own rate.
    const unmatchedGroups = await db.affiliateTransaction.groupBy({
      by: ['date', 'currency'],
      where: { shopId: null, denyDate: null, date: { gte: utcDay(from), lte: utcDay(to) } },
      _count: { _all: true },
      _sum: { commission: true, brokerageFee: true },
    })

    // A currency with no rate row converts to itself silently, which reads as
    // a real number and is not one - so top up before converting anything.
    // Unmatched rows count here too: an unmatched sale in a foreign currency
    // must not convert against a missing rate.
    const currencies = new Set([
      displayCurrency,
      ...groups.map((g) => g.currency),
      ...unmatchedGroups.map((g) => g.currency),
    ])
    const needsRates = currencies.size > 1
    if (needsRates) await ensureRates(from, to, [...currencies])
    const rates: RateTable = needsRates ? buildRateTable(await loadRates()) : new Map()

    const convertMoney = (amount: number, currency: string, date: Date) =>
      crossConvert(amount, currency, displayCurrency, date, rates)

    // Shop rows and the total, from THE engine roll-up: each (shop, day,
    // currency) slice converted at its own day's rate - the same rows, summed
    // by the same code, as the Dashboard's Affiliate column.
    const byShop = new Map<string, Slice>()
    const total: Slice = { sales: 0, orderValue: 0, cost: 0 }
    for (const b of toShopDayCurrency(groups)) {
      const slice: Slice = {
        sales: b.sales,
        orderValue: convertMoney(b.orderValue, b.currency, b.date),
        cost: convertMoney(b.amount, b.currency, b.date),
      }
      addTo(byShop, b.shopId, slice)
      total.sales += slice.sales
      total.orderValue += slice.orderValue
      total.cost += slice.cost
    }

    // The channel view of the same groups: re-summed to (channel, day,
    // currency) - still exact minor units - before any conversion.
    const channelBuckets = new Map<string, ChannelBucket>()
    // A renamed channel leaves groups under both names for one channelId; the
    // one with the most recent date carries the name the platform now uses.
    // (The name tie-breaks deterministically for two names on one day.)
    const channelNames = new Map<string, { name: string; date: Date }>()
    for (const g of groups) {
      const key = `${g.channelId}|${g.date.toISOString()}|${g.currency}`
      const found = channelBuckets.get(key)
      const amount = g.commission + g.brokerageFee
      if (found) {
        found.amount += amount
        found.orderValue += g.orderValue
        found.sales += g.sales
      } else {
        channelBuckets.set(key, {
          channelId: g.channelId,
          date: g.date,
          currency: g.currency,
          amount,
          orderValue: g.orderValue,
          sales: g.sales,
        })
      }
      const held = channelNames.get(g.channelId)
      if (
        !held ||
        g.date > held.date ||
        (g.date.getTime() === held.date.getTime() && g.channelName > held.name)
      ) {
        channelNames.set(g.channelId, { name: g.channelName, date: g.date })
      }
    }

    // Keyed on the platform's channel id, not its name: two affiliate sites
    // sharing a display name are two channels, and merging them would print
    // a total belonging to neither.
    const byChannel = new Map<string, Slice>()
    for (const b of channelBuckets.values())
      addTo(byChannel, b.channelId, {
        sales: b.sales,
        orderValue: convertMoney(b.orderValue, b.currency, b.date),
        cost: convertMoney(b.amount, b.currency, b.date),
      })

    const channelRows = [...byChannel.entries()].map(([channelId, s]) => ({
      channelId,
      channelName: channelNames.get(channelId)?.name ?? channelId,
      ...s,
    }))

    // The channel partition and the shop partition sum the SAME groups under
    // the SAME per-day rates - every bucket of a given (day, currency) shares
    // one rate - so any difference between their converted sums is pure
    // rounding (each bucket rounds once, at most half a minor unit per
    // bucket). The engine-grain total is the canonical figure; adding the
    // difference to the largest channel row reconciles the table to it
    // exactly. This is arithmetic, not a fudge: no money is invented or lost,
    // the rounding remainder is simply carried by one row instead of vanishing
    // between two.
    if (channelRows.length > 0) {
      let costSum = 0
      let valueSum = 0
      for (const r of channelRows) {
        costSum += r.cost
        valueSum += r.orderValue
      }
      const largest = channelRows.reduce((a, b) => (b.cost > a.cost ? b : a))
      largest.cost += total.cost - costSum
      largest.orderValue += total.orderValue - valueSum
    }

    // Loud, never silent: money that belongs to no shop is still money, and
    // by construction it is missing from the total, the channel table and the
    // shop table alike. Deliberately NOT folded into `total.cost` - the whole
    // point of this endpoint is quoting exactly the engine's figure.
    let unmatched = 0
    let unmatchedCost = 0
    for (const g of unmatchedGroups) {
      unmatched += g._count._all
      unmatchedCost += convertMoney(
        (g._sum.commission ?? 0) + (g._sum.brokerageFee ?? 0),
        g.currency,
        g.date,
      )
    }

    return NextResponse.json(
      {
        connected,
        displayCurrency,
        range: { from: utcDay(from).toISOString(), to: utcDay(to).toISOString() },
        total,
        byShop: [...byShop.entries()]
          .map(([shopId, s]) => ({ shopId, shopName: nameById.get(shopId) ?? shopId, ...s }))
          .sort((a, b) => b.cost - a.cost || a.shopName.localeCompare(b.shopName)),
        byChannel: channelRows.sort(
          (a, b) => b.cost - a.cost || a.channelName.localeCompare(b.channelName),
        ),
        unmatched,
        unmatchedCost,
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
