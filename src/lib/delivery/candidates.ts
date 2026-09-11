import { db } from '../db'
import { MATCH_WINDOW_DAYS } from '../bring/match'
import { nameKey } from './name-key'

/**
 * The orders a person may attach an unlinked parcel to.
 *
 * Computed, never stored: the answer changes as other parcels link. By email
 * when the carrier gave one (Bring), else by destination country (DHL gives
 * no name and no email), else nothing and the person types an order number.
 * The items are what lets a person tell a 154 kg chair from a 1.6 kg whisk.
 */

export type Candidate = {
  orderId: string
  number: string
  shop: string
  customerName: string | null
  placedAt: string
  /** "1 x Panetti ProMix, 2 x Peel". */
  items: string
  /** Holds a parcel from another consignment, which is why the machine did not choose it. */
  holdsParcel: boolean
  /** The label's folded name equals this order's; listed first. */
  sameName: boolean
}

export type CandidateRow = {
  recipientEmail: string | null
  recipientName: string | null
  destinationCountry: string | null
  bookedAt: Date | null
  createdAt: Date
  consignmentId: string | null
}

export const CANDIDATE_LIMIT = 30

/** More than anyone will read; the count above it is what is reported. */
const READ_CEILING = 50

const DAY = 24 * 60 * 60 * 1000

export async function candidatesFor(row: CandidateRow): Promise<{ candidates: Candidate[]; total: number }> {
  const key = nameKey(row.recipientName)
  if (!key && !row.recipientEmail && !row.destinationCountry) return { candidates: [], total: 0 }

  const upper = row.bookedAt ?? row.createdAt
  const window = { gte: new Date(upper.getTime() - MATCH_WINDOW_DAYS * DAY), lte: upper }
  const base = { shop: { deliveryTrackingFrom: { not: null } }, placedAt: window, voidedAt: null }
  const select = {
    id: true, number: true, placedAt: true, customerName: true,
    shop: { select: { name: true } },
    items: { select: { name: true, quantity: true } },
    shipments: { select: { consignmentId: true } },
  }

  // The label's name first, any country: the country a carrier reports and
  // the one the customer typed at checkout disagree often enough (a gift, a
  // holiday address) that a same-name order elsewhere is worth showing.
  const byName = key
    ? await db.order.findMany({ where: { ...base, customerNameKey: key }, orderBy: { placedAt: 'desc' }, take: READ_CEILING, select })
    : []
  const rest =
    row.recipientEmail || row.destinationCountry
      ? await db.order.findMany({
          where: {
            ...base,
            ...(row.recipientEmail
              ? { customerEmail: { equals: row.recipientEmail, mode: 'insensitive' } }
              : { shippingCountry: { equals: row.destinationCountry!, mode: 'insensitive' }, shipments: { none: {} } }),
            id: { notIn: byName.map((o) => o.id) },
          },
          orderBy: { placedAt: 'desc' },
          take: READ_CEILING,
          select,
        })
      : []

  const toCandidate = (o: (typeof byName)[number], sameName: boolean): Candidate => ({
    orderId: o.id,
    number: o.number,
    shop: o.shop.name,
    customerName: o.customerName,
    placedAt: o.placedAt.toISOString(),
    items: o.items.map((i) => `${i.quantity} x ${i.name}`).join(', '),
    holdsParcel: o.shipments.some((s) => s.consignmentId === null || s.consignmentId !== row.consignmentId),
    sameName,
  })
  const all = [...byName.map((o) => toCandidate(o, true)), ...rest.map((o) => toCandidate(o, false))]
  return { candidates: all.slice(0, CANDIDATE_LIMIT), total: all.length }
}
