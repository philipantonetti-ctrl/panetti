import { db } from '../db'
import type { ParsedRow } from './parse'

export type UnmatchedRow = ParsedRow & { reason: string }
export type LinkResult = { linked: number; unmatched: UnmatchedRow[] }

/**
 * Every order number we hold, for the extractor to match the document against.
 * Only shops that are delivery-tracked: a shop shipping from somewhere else has
 * no business claiming a parcel out of this warehouse's file.
 */
export async function knownOrderNumbers(): Promise<Set<string>> {
  const rows = await db.order.findMany({
    where: { shop: { deliveryTrackingFrom: { not: null } } },
    select: { number: true },
  })
  return new Set(rows.map((r) => r.number))
}

/**
 * Write one Shipment per pair.
 *
 * Order.number is NOT unique across shops — the only uniqueness on Order is
 * [shopId, externalId]. So a number two shops both hold is ambiguous, and we
 * refuse it rather than guess: a wrong link would poison that order's delivery
 * figure permanently, and unlike a missing link nobody would ever notice.
 *
 * An existing parcel is adopted, never rebuilt. A shipment that has been
 * tracked for days before its file arrives keeps every milestone it earned.
 */
export async function linkRows(rows: ParsedRow[]): Promise<LinkResult> {
  const unmatched: UnmatchedRow[] = []
  let linked = 0

  for (const row of rows) {
    const orders = await db.order.findMany({
      where: { number: row.orderNumber, shop: { deliveryTrackingFrom: { not: null } } },
      select: { id: true },
      take: 2, // one is enough to link, two is enough to refuse
    })

    if (orders.length === 0) {
      unmatched.push({ ...row, reason: `No order numbered ${row.orderNumber}` })
      continue
    }
    if (orders.length > 1) {
      unmatched.push({
        ...row,
        reason: `Order number ${row.orderNumber} matched 2 orders in different shops`,
      })
      continue
    }

    await db.shipment.upsert({
      where: { trackingNumber: row.trackingNumber },
      // Due immediately, so the next cron run picks it up.
      create: {
        trackingNumber: row.trackingNumber,
        orderId: orders[0].id,
        linkSource: 'FILE',
        nextPollAt: new Date(),
      },
      // Only the link. Milestones, events and poll state are the sync's to own,
      // and a re-import must not undo a week of tracking.
      update: { orderId: orders[0].id, linkSource: 'FILE' },
    })
    linked++
  }

  return { linked, unmatched }
}
