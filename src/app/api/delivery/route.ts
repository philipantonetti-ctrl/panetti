import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { loadDelivery } from '@/lib/delivery/load'
import { deliveryStats } from '@/lib/delivery/stats'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** How many late orders the page lists before it asks you to narrow the range. */
const LATE_LIMIT = 200

/**
 * The Delivery page's data: how long orders took, what is late right now, and
 * what we could not account for.
 *
 * The last part matters as much as the first. An unlinked parcel and a failed
 * import are both invisible by nature — the page simply shows fewer orders and
 * looks like a quiet week — so both are counted out loud.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const shops = await db.shop.findMany({
      where: { active: true, ...(shopIds?.length ? { id: { in: shopIds } } : {}) },
      select: { id: true, deliveryTrackingFrom: true },
    })

    const { rows } = await loadDelivery(
      shops.map((s) => s.id),
      zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
      zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
    )

    const stats = deliveryStats(
      rows.map((r) => r.view),
      rows.map((r) => r.order.shippingCountry),
    )

    const late = rows
      .filter((r) => r.view.late)
      .sort((a, b) => (b.view.daysOver ?? 0) - (a.view.daysOver ?? 0))
      .slice(0, LATE_LIMIT)
      .map((r) => ({
        id: r.order.id,
        number: r.order.number,
        shop: r.order.shopName,
        country: r.order.shippingCountry || null,
        daysOver: r.view.daysOver ?? 0,
        promiseDays: r.view.promiseDays,
        state: r.view.state,
        trackingNumbers: r.view.trackingNumbers,
      }))

    const [unlinked, imports] = await Promise.all([
      db.shipment.findMany({
        where: { orderId: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { trackingNumber: true, lastStatus: true },
      }),
      db.trackingImport.findMany({
        orderBy: { receivedAt: 'desc' },
        take: 10,
        select: {
          id: true, filename: true, receivedAt: true,
          rowsParsed: true, rowsLinked: true, rowsUnmatched: true, error: true,
        },
      }),
    ])

    return NextResponse.json(
      {
        stats,
        late,
        unlinked,
        imports: imports.map((i) => ({ ...i, receivedAt: i.receivedAt.toISOString() })),
        trackedShops: shops.filter((s) => s.deliveryTrackingFrom !== null).length,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load delivery data' },
      { status: 500, headers: NO_STORE },
    )
  }
}
