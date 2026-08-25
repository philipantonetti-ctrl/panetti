import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { deliveryFor, type OrderDelivery, type Parcel } from '@/lib/delivery/view'
import { VOIDED_STATUSES } from '@/lib/metrics/types'
import { deliveryPhrase } from './delivery-phrase'

export type OrderSummary = {
  id: string
  number: string
  shop: string
  placedAt: string
  status: string
  /** Refunded or cancelled in the shop. We know the order, not the bank. */
  refunded: boolean
  currency: string
  total: number
  products: { name: string; quantity: number }[]
  parcels: Parcel[]
  delivery: OrderDelivery
  deliveryPhrase: string | null
}

export type CustomerContext = {
  customer: { name: string; email: string; phone: string | null; country: string | null } | null
  orders: OrderSummary[]
  previousTickets: { id: string; number: number; subject: string; status: string; lastMessageAt: string }[]
}

const MAX_ORDERS = 10

/**
 * Everything the sidebar shows about the person on the other end, derived
 * from orders - there is no Customer table, on purpose, and at this scale a
 * lookup by email is instant. Delivery comes from the same deliveryFor() the
 * Delivery page prints, so support and the owner read one story.
 */
export async function customerContext(email: string, excludeTicketId: string, now: Date = new Date()): Promise<CustomerContext> {
  const [orders, tickets, promises, setting] = await Promise.all([
    db.order.findMany({
      where: { customerEmail: { equals: email, mode: 'insensitive' } },
      orderBy: { placedAt: 'desc' },
      take: MAX_ORDERS,
      include: {
        shop: { select: { name: true, timezone: true, deliveryTrackingFrom: true } },
        items: { select: { name: true, quantity: true } },
        shipments: true,
      },
    }),
    db.ticket.findMany({
      where: { customerEmail: { equals: email, mode: 'insensitive' }, id: { not: excludeTicketId } },
      orderBy: { lastMessageAt: 'desc' },
      take: 20,
      select: { id: true, number: true, subject: true, status: true, lastMessageAt: true },
    }),
    db.deliveryPromise.findMany(),
    getSetting(),
  ])

  if (orders.length === 0 && tickets.length === 0) return { customer: null, orders: [], previousTickets: [] }

  // The newest order is the freshest word on who they are. Null means we
  // never stored it, and the sidebar says so rather than showing a blank.
  const newest = orders[0]
  const customer = newest
    ? {
        name: newest.customerName ?? '',
        email: newest.customerEmail ?? email,
        phone: newest.customerPhone || null,
        country: newest.shippingCountry || null,
      }
    : null

  return {
    customer,
    orders: orders.map((o) => {
      const delivery = deliveryFor(
        {
          id: o.id, number: o.number, placedAt: o.placedAt, status: o.status, shippingCountry: o.shippingCountry,
          shopId: o.shopId, shopName: o.shop.name, shopTimezone: o.shop.timezone, shopTrackingFrom: o.shop.deliveryTrackingFrom,
          shipments: o.shipments,
        },
        promises,
        setting.timezone,
        now,
      )
      return {
        id: o.id,
        number: o.number,
        shop: o.shop.name,
        placedAt: o.placedAt.toISOString(),
        status: o.status,
        refunded: (VOIDED_STATUSES as readonly string[]).includes(o.status.toLowerCase()),
        currency: o.currency,
        total: o.total,
        products: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
        parcels: delivery.parcels,
        delivery,
        deliveryPhrase: deliveryPhrase(delivery),
      }
    }),
    previousTickets: tickets.map((t) => ({ ...t, lastMessageAt: t.lastMessageAt.toISOString() })),
  }
}
