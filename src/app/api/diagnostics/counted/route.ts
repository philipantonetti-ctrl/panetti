import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { entriesIn } from '@/lib/metrics/engine'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { UNPAID_STATUSES, VOIDED_STATUSES } from '@/lib/metrics/types'
import { zonedDayStr } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { db } from '@/lib/db'

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Why the dashboard's order count is what it is.
 *
 * A shop row says "2 orders" and gives no way to ask WHICH two. When that
 * disagrees with the order list, or with the store itself, there is nothing to
 * read: the count is a number with its reasoning thrown away. Answering it
 * meant round-tripping a human through filter combinations, one screenshot per
 * hypothesis, and that is how a wrong guess survives for days.
 *
 * This lists the orders that were counted, and — the part that actually settles
 * an argument — every order the range loaded that was NOT counted, each with
 * the rule that dropped it.
 *
 * It calls `entriesIn`, the engine's own function, rather than reimplementing
 * the rules. A diagnostic with its own copy of the logic can agree with itself
 * while the engine does something else entirely, which is worse than no
 * diagnostic at all.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const input = await loadMetricsInput({ shopIds, from, to, timezone })
    const tzFor = (shopId: string) => input.shopTimezones?.get(shopId) ?? timezone
    const entries = entriesIn(input.orders, from, to, tzFor)

    // The engine works in internal ids; a human argues in order numbers. Looked
    // up here rather than widened into EngineOrder, which the engine has no use
    // for and which every other caller would then have to carry.
    const numberOf = new Map(
      (
        await db.order.findMany({
          where: { id: { in: input.orders.map((o) => o.id) } },
          select: { id: true, number: true },
        })
      ).map((o) => [o.id, o.number]),
    )
    const num = (id: string) => numberOf.get(id) ?? id

    /**
     * The days on either side, which the range itself never loads.
     *
     * Without them the commonest question of all — "the store shows this order
     * on Tuesday, why isn't it in Tuesday's count?" — has no answer here: an
     * order that landed on Monday by the shop's clock is simply not in the
     * result, and absence looks identical to deletion. These rows make a
     * boundary visible as a boundary.
     */
    const DAY_MS = 24 * 60 * 60 * 1000
    const neighbours = await db.order.findMany({
      where: {
        shopId: { in: input.shops.map((s) => s.id) },
        placedAt: {
          gte: new Date(utcDay(from).getTime() - 2 * DAY_MS),
          lte: new Date(utcDay(to).getTime() + 2 * DAY_MS),
        },
        id: { notIn: input.orders.map((o) => o.id) },
      },
      select: { id: true, shopId: true, number: true, status: true, placedAt: true, currency: true, total: true },
    })

    // The engine's rules, read back as a sentence. Mirrors `entriesIn` branch
    // for branch; if that ever changes, this must change with it.
    const whyDropped = (status: string, voidedAt: Date | null, day: string): string => {
      const s = status.toLowerCase()
      if (UNPAID_STATUSES.includes(s as never)) return `not paid yet (${status})`
      if (VOIDED_STATUSES.includes(s as never) && !voidedAt)
        return `${status}, and we never learned when — left out rather than reversed on a guessed day`
      return `placed on ${day}, outside ${utcDay(from).toISOString().slice(0, 10)}..${utcDay(to).toISOString().slice(0, 10)} on this shop's clock`
    }

    const hasEntry = new Set(entries.map((e) => e.order.id))

    const shops = input.shops.map((shop) => {
      const mine = input.orders.filter((o) => o.shopId === shop.id)
      const tz = tzFor(shop.id)

      const rows = mine.map((o) => ({
        id: o.id,
        order: num(o.id),
        status: o.status,
        placedAt: o.placedAt.toISOString(),
        dayOnShopClock: zonedDayStr(o.placedAt, tz),
        voidedAt: o.voidedAt ? o.voidedAt.toISOString() : null,
        currency: o.currency,
        total: o.total,
        netSales: o.netSales,
      }))

      const signs = entries.filter((e) => e.order.shopId === shop.id)

      return {
        shopId: shop.id,
        shopName: shop.name,
        timezone: tz,
        // What the dashboard's Orders column shows for this shop.
        orderCount: signs.reduce((n, e) => n + e.sign, 0),
        counted: signs.map((e) => ({
          order: num(e.order.id),
          status: e.order.status,
          placedAt: e.order.placedAt.toISOString(),
          dayOnShopClock: zonedDayStr(e.order.placedAt, tz),
          sign: e.sign,
          currency: e.order.currency,
          total: e.order.total,
        })),
        notCounted: rows
          .filter((r) => !hasEntry.has(r.id))
          .map((r) => ({
            ...r,
            reason: whyDropped(r.status, r.voidedAt ? new Date(r.voidedAt) : null, r.dayOnShopClock),
          })),
        // Orders sitting just outside the range on this shop's clock. If the
        // store says an order belongs to this day and it appears here instead,
        // the disagreement is about the DAY, not about a lost order.
        justOutside: neighbours
          .filter((n) => n.shopId === shop.id)
          .map((n) => ({
            order: n.number,
            status: n.status,
            placedAt: n.placedAt.toISOString(),
            dayOnShopClock: zonedDayStr(n.placedAt, tz),
            currency: n.currency,
            total: n.total,
          }))
          .sort((a, b) => a.placedAt.localeCompare(b.placedAt)),
        // Everything the query loaded for this shop, so a missing order is
        // visibly missing rather than merely uncounted.
        loadedForShop: rows.length,
      }
    })

    return NextResponse.json(
      {
        range: { from: from.toISOString(), to: to.toISOString() },
        workspaceTimezone: timezone,
        displayCurrency: input.displayCurrency,
        shops: shops.filter((s) => s.loadedForShop > 0 || s.orderCount !== 0),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not explain the count' }, { status: 500, headers: NO_STORE })
  }
}
