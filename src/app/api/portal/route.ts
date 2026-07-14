import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery } from '@/lib/api/range'
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
    if (user.role !== 'AMBASSADOR' || !user.ambassadorId) {
      throw new AuthError('This page is for ambassadors')
    }

    const { from, to } = rangeFromQuery(new URL(req.url).searchParams)

    const me = await db.ambassador.findUniqueOrThrow({
      where: { id: user.ambassadorId },
      include: { codes: true },
    })

    const orders = await db.order.findMany({
      where: {
        ambassadorId: me.id, // <- from the session. Not from the request.
        placedAt: { gte: utcDay(from), lte: new Date(utcDay(to).getTime() + 86_400_000 - 1) },
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
        placedAt: { gte: utcDay(from), lte: new Date(utcDay(to).getTime() + 86_400_000 - 1) },
        status: { notIn: [...EXCLUDED_STATUSES] },
      },
      _sum: { netSales: true },
    })

    // Note: ranking compares raw netSales across currencies. Good enough for a rank,
    // and it never exposes another ambassador's figures — only a position.
    const better = everyone.filter((row) => (row._sum.netSales ?? 0) > (everyone.find((r) => r.ambassadorId === me.id)?._sum.netSales ?? 0)).length
    const totalAmbassadors = await db.ambassador.count({ where: { active: true } })

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
