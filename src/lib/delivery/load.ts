import { db } from '../db'
import { getSetting } from '../settings'
import { deliveryFor, type DeliveryOrder, type OrderDelivery } from './view'
import type { PromisePoint } from './promise'

export type LoadedDelivery = {
  order: DeliveryOrder
  /**
   * Who bought it. Null when we hold no name, '' when the shop was checked and
   * had none - see the schema comment on Order.customerName.
   *
   * Beside DeliveryOrder rather than inside it, because `deliveryFor` has no
   * use for a name and DeliveryOrder is its input contract. Putting it there
   * made the Orders column and the Slack alert supply a field neither of them
   * reads, to satisfy a page neither of them draws.
   */
  customerName: string | null
  view: OrderDelivery
}

/**
 * Every order in the window with its parcels, and what happened to each.
 *
 * Bulk-loaded in two queries, never per row - the same rule
 * api/orders/route.ts follows for costs and rates.
 */
export async function loadDelivery(
  shopIds: string[],
  from: Date,
  to: Date,
  now = new Date(),
): Promise<{ rows: LoadedDelivery[]; promises: PromisePoint[] }> {
  const [orders, promises, { timezone }] = await Promise.all([
    db.order.findMany({
      where: { shopId: { in: shopIds }, placedAt: { gte: from, lte: to } },
      orderBy: { placedAt: 'desc' },
      select: {
        id: true, number: true, placedAt: true, status: true, shippingCountry: true,
        customerName: true,
        shopId: true,
        shop: { select: { name: true, timezone: true, deliveryTrackingFrom: true } },
        shipments: {
          select: {
            // carrier decides where the parcel's tracking link points. Without
            // it every number on screen went to Bring's site, DHL's included.
            trackingNumber: true, carrier: true, bookedAt: true, handedInAt: true,
            availableAt: true, collectedAt: true, outcome: true, lastStatus: true,
          },
        },
      },
    }),
    db.deliveryPromise.findMany(),
    getSetting(),
  ])

  const rows = orders.map((o) => {
    const order: DeliveryOrder = {
      id: o.id, number: o.number, placedAt: o.placedAt, status: o.status,
      shippingCountry: o.shippingCountry,
      shopId: o.shopId,
      shopName: o.shop.name,
      shopTimezone: o.shop.timezone,
      shopTrackingFrom: o.shop.deliveryTrackingFrom,
      shipments: o.shipments,
    }
    return {
      order,
      customerName: o.customerName,
      view: deliveryFor(order, promises, timezone, now),
    }
  })

  return { rows, promises }
}
