import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'

/**
 * The order list for admins: every order in a date range, newest first, with
 * what was bought inside each one. Paged, because a busy store has tens of
 * thousands. Each order is shown in ITS OWN currency — an order only ever has
 * one — so nothing needs converting here.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200)
    const offset = Math.max(Number(params.get('offset')) || 0, 0)
    const includeVoided = params.get('includeVoided') === 'true'

    const activeShops = await db.shop.findMany({
      where: { active: true, ...(shopIds?.length ? { id: { in: shopIds } } : {}) },
      select: { id: true },
    })

    const where = {
      shopId: { in: activeShops.map((s) => s.id) },
      placedAt: {
        gte: zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
        lte: zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
      },
      // By default hide refunded/cancelled/failed, like every other figure; the
      // list can opt back in to see the whole picture.
      ...(includeVoided ? {} : { status: { notIn: [...EXCLUDED_STATUSES] } }),
    }

    const [total, rows] = await Promise.all([
      db.order.count({ where }),
      db.order.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          number: true,
          placedAt: true,
          status: true,
          currency: true,
          netSales: true,
          taxTotal: true,
          shippingCharged: true,
          total: true,
          couponCode: true,
          shop: { select: { name: true } },
          items: { select: { name: true, sku: true, quantity: true } },
        },
      }),
    ])

    const orders = rows.map((o) => ({
      id: o.id,
      number: o.number,
      placedAt: o.placedAt.toISOString(),
      status: o.status,
      shop: o.shop.name,
      currency: o.currency,
      netSales: o.netSales,
      taxTotal: o.taxTotal,
      shippingCharged: o.shippingCharged,
      total: o.total,
      couponCode: o.couponCode,
      itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
      products: o.items.map((i) => ({ name: i.name, sku: i.sku, quantity: i.quantity })),
    }))

    return NextResponse.json({ orders, total })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load orders' }, { status: 500 })
  }
}
