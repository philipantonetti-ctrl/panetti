import { db } from '../db'
import { matchByEmail, matchByName } from '../bring/match'

/**
 * The one place a parcel with no order tries to find one.
 *
 * Email first, when a carrier gave one (Bring does, DHL never does); then
 * the name on the label, which the warehouse file gives for every carrier.
 * The same rules on both: 30 days, tracked shops, not cancelled, not already
 * holding another consignment's parcel, and exactly one order or nothing.
 *
 * Called from three places on purpose - the importer for every number in a
 * file, the identification step once a carrier has said which country, and
 * the hourly sweep - so a parcel that could not be placed today is placed
 * the day the missing fact arrives, with nobody pressing anything.
 */
export type AttachRow = {
  id: string
  trackingNumber: string
  orderId: string | null
  recipientEmail: string | null
  recipientName: string | null
  bookedAt: Date | null
  createdAt: Date
  consignmentId: string | null
  destinationCountry: string | null
}

export type AttachDecision =
  | { orderId: string; source: 'BRING_EMAIL' | 'FILE_NAME' }
  | { orderId: null; reason: string | null }

export type AttachResult =
  | { linked: true; source: 'BRING_EMAIL' | 'FILE_NAME' }
  | { linked: false; source: null; reason: string | null }

/** Reads only. The upper bound is the booking time, else when the row was first stored. */
export async function decideAttach(row: AttachRow): Promise<AttachDecision> {
  if (row.orderId !== null) return { orderId: null, reason: null }
  const scope = { bookedAt: row.bookedAt, consignmentId: row.consignmentId }
  let emailReason: string | null = null
  if (row.recipientEmail) {
    const byEmail = await matchByEmail(row.recipientEmail, row.createdAt, scope)
    if (byEmail.orderId !== null) return { orderId: byEmail.orderId, source: 'BRING_EMAIL' }
    emailReason = byEmail.reason
  }
  let nameReason: string | null = null
  if (row.recipientName) {
    const byName = await matchByName(row.recipientName, row.createdAt, { ...scope, country: row.destinationCountry })
    if (byName.orderId !== null) return { orderId: byName.orderId, source: 'FILE_NAME' }
    nameReason = byName.reason
  }
  // The email's reason names the repeat customer's orders, which is the more
  // useful sentence; the name's reason only when there was no email to try.
  return { orderId: null, reason: emailReason ?? nameReason }
}

/** Decide, then write. A row that already has an order is left exactly as it is. */
export async function attach(row: AttachRow): Promise<AttachResult> {
  const d = await decideAttach(row)
  if (d.orderId !== null) {
    await db.shipment.update({
      where: { id: row.id },
      data: { orderId: d.orderId, linkSource: d.source, unlinkedReason: null },
    })
    return { linked: true, source: d.source }
  }
  // A real reason replaces the old one; nothing to say leaves the old one.
  if (d.reason !== null) {
    await db.shipment.update({ where: { id: row.id }, data: { unlinkedReason: d.reason } })
  }
  return { linked: false, source: null, reason: d.reason }
}

export const SWEEP_LIMIT = 50
const HOUR = 60 * 60 * 1000

export const ATTACH_SELECT = {
  id: true, trackingNumber: true, orderId: true, recipientEmail: true, recipientName: true,
  bookedAt: true, createdAt: true, consignmentId: true, destinationCountry: true,
} as const

/**
 * Every unlinked parcel that has something to match on, tried again.
 *
 * Hourly per row, not per run: each attempt rewrites the reason, which moves
 * updatedAt, so a row comes round again an hour later at the earliest. Fifty
 * per run spreads a backlog over ticks. Rows with neither email nor name
 * have nothing to try and are not read; a dismissed row is not a customer
 * parcel and is not read either.
 */
export async function sweepUnlinked(now: Date): Promise<{ tried: number; linked: number }> {
  const rows = await db.shipment.findMany({
    where: {
      orderId: null,
      dismissedAt: null,
      updatedAt: { lt: new Date(now.getTime() - HOUR) },
      OR: [{ recipientEmail: { not: null } }, { recipientName: { not: null } }],
    },
    orderBy: { updatedAt: 'asc' },
    take: SWEEP_LIMIT,
    select: ATTACH_SELECT,
  })
  let linked = 0
  for (const r of rows) {
    try {
      if ((await attach(r)).linked) linked++
    } catch {
      // One row's failure must not end the sweep; it comes round next hour.
    }
  }
  return { tried: rows.length, linked }
}
