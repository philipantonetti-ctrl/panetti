import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { pct } from '@/lib/money'
import { buildRateTable, convert } from '@/lib/metrics/fx'
import { loadRates, ensureRates } from '@/lib/fx/rates'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'

const DISPLAY = 'USD'

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
      include: { codes: true },
    })

    const orders = await db.order.findMany({
      where: {
        ambassadorId: me.id, // <- from the session. Not from the request.
        placedAt: {
          gte: zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
          lte: zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
        },
        status: { notIn: [...EXCLUDED_STATUSES] },
      },
      include: { shop: { select: { name: true, currency: true } } },
      orderBy: { placedAt: 'desc' },
    })

    await ensureRates(from, to, [...new Set(orders.map((o) => o.currency))])
    const rates = buildRateTable(await loadRates())

    let sales = 0
    let commission = 0
    const recent = orders.slice(0, 10).map((o) => {
      const orderSales = convert(o.netSales, o.currency, o.placedAt, DISPLAY, rates)
      const orderCommission = convert(pct(o.netSales, me.commissionRate), o.currency, o.placedAt, DISPLAY, rates)
      return {
        id: o.id,
        date: o.placedAt.toISOString(),
        shop: o.shop.name,
        sales: orderSales,
        commission: orderCommission,
      }
    })

    for (const o of orders) {
      sales += convert(o.netSales, o.currency, o.placedAt, DISPLAY, rates)
      commission += convert(pct(o.netSales, me.commissionRate), o.currency, o.placedAt, DISPLAY, rates)
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
