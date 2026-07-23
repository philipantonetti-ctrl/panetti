import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { pct } from '@/lib/money'
import { buildRateTable, crossConvert } from '@/lib/metrics/fx'
import { loadRates, ensureRates } from '@/lib/fx/rates'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'

/**
 * An ambassador's own figures — and ONLY their own.
 *
 * The ambassador id is taken from the SESSION, never from the query string.
 * There is therefore no id for a caller to tamper with.
 */
export async function GET(req: Request) {
  try {
    const user = await currentUser()
    if (!user) throw new AuthError('Sign in first')

    // Which ambassador's figures? An ambassador sees their own, taken from the
    // session and never the request. An admin sees the ambassador that shares
    // their email — their own. Either way it is a single ambassador they are
    // entitled to: an admin viewing this sees their OWN portal, nothing wider.
    let ambassadorId: string | null = null
    if (user.role === 'AMBASSADOR') {
      ambassadorId = user.ambassadorId
    } else if (user.role === 'ADMIN') {
      const mine = await db.ambassador.findFirst({ where: { email: user.email }, select: { id: true } })
      ambassadorId = mine?.id ?? null
    }
    if (!ambassadorId) {
      return NextResponse.json({ error: 'You do not have an ambassador code yet.' }, { status: 404 })
    }

    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(new URL(req.url).searchParams, new Date(), timezone)

    const me = await db.ambassador.findUniqueOrThrow({
      where: { id: ambassadorId },
      include: { codes: { include: { shop: { select: { currency: true } } } } },
    })

    // Report in the money they actually sell in. Same rule the dashboard uses:
    // one currency across their stores -> that currency, untouched; several ->
    // consolidate to USD, because adding NOK to SEK would mean nothing.
    const own = [...new Set(me.codes.map((c) => c.shop.currency))]
    const DISPLAY = own.length === 1 ? own[0] : 'USD'

    const mine = {
      ambassadorId: me.id, // <- from the session. Not from the request.
      placedAt: {
        gte: zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
        lte: zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
      },
      status: { notIn: [...EXCLUDED_STATUSES] },
    }

    // Totals need every order in the range, but not what was inside them.
    const orders = await db.order.findMany({
      where: mine,
      select: { netSales: true, currency: true, placedAt: true },
    })

    // Only the orders actually shown carry their line items — an ambassador with
    // thousands of sales should not haul every product row to render ten.
    const recentRows = await db.order.findMany({
      where: mine,
      orderBy: { placedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        placedAt: true,
        netSales: true,
        currency: true,
        shop: { select: { name: true } },
        items: { select: { name: true, quantity: true } },
      },
    })

    // The display currency needs its own USD leg too, to cross into it.
    await ensureRates(from, to, [...new Set([...orders.map((o) => o.currency), DISPLAY])])
    const rates = buildRateTable(await loadRates())

    let sales = 0
    let commission = 0
    const recent = recentRows.map((o) => ({
      id: o.id,
      date: o.placedAt.toISOString(),
      shop: o.shop.name,
      sales: crossConvert(o.netSales, o.currency, DISPLAY, o.placedAt, rates),
      commission: crossConvert(pct(o.netSales, me.commissionRate), o.currency, DISPLAY, o.placedAt, rates),
      // What was actually sold in this order.
      products: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
    }))

    for (const o of orders) {
      sales += crossConvert(o.netSales, o.currency, DISPLAY, o.placedAt, rates)
      commission += crossConvert(pct(o.netSales, me.commissionRate), o.currency, DISPLAY, o.placedAt, rates)
    }

    // Rank: where do I stand among all ambassadors this period?
    const everyone = await db.order.groupBy({
      by: ['ambassadorId'],
      where: {
        ambassadorId: { not: null },
        placedAt: {
          gte: zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
          lte: zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
        },
        status: { notIn: [...EXCLUDED_STATUSES] },
      },
      _sum: { netSales: true },
    })

    // Note: ranking compares raw netSales across currencies. Good enough for a rank,
    // and it never exposes another ambassador's figures — only a position.
    const better = everyone.filter((row) => (row._sum.netSales ?? 0) > (everyone.find((r) => r.ambassadorId === me.id)?._sum.netSales ?? 0)).length
    // rank and total must come from the SAME population, or you get "#9 of 8".
    // The population is everyone with an attributed order in range; `active` plays no
    // part, because a deactivated ambassador's past sales genuinely happened.
    // If I have no orders in range I am absent from `everyone`, so count me in myself.
    const iAmInPopulation = everyone.some((row) => row.ambassadorId === me.id)
    const totalAmbassadors = iAmInPopulation ? everyone.length : everyone.length + 1

    return NextResponse.json({
      name: me.name,
      codes: me.codes.map((c) => c.code),
      commissionRate: me.commissionRate,
      currency: DISPLAY,
      sales,
      commission,
      orders: orders.length,
      rank: orders.length > 0 ? better + 1 : null,
      totalAmbassadors,
      recent,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load your figures' }, { status: 500 })
  }
}
