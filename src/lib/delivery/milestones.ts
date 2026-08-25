/**
 * What a parcel's history MEANS, independently of who carried it.
 *
 * Pure: no database, no network. Every rule about when a parcel counts as
 * delivered lives here and nowhere else - which is the point of the file. Two
 * carriers reporting the same journey in two vocabularies must still produce
 * the same milestones, or the delivery median silently measures a different
 * thing per carrier and nothing on the Delivery page can be compared.
 *
 * The status strings below are Bring's, adopted as OUR canonical vocabulary
 * because it was first and because the Nordic pickup-point distinction it
 * encodes is real. A carrier mapper's job is to translate into these, not to
 * invent its own - see src/lib/dhl/map.ts, which turns DHL's statusCode enum
 * into exactly these words before this file ever sees them.
 */

export type MappedEvent = {
  status: string
  occurredAt: Date
  description: string | null
  location: string | null
}

export type Milestones = {
  bookedAt: Date | null
  handedInAt: Date | null
  availableAt: Date | null
  collectedAt: Date | null
  outcome: 'DELIVERED' | 'RETURNED' | 'CANCELLED' | null
  lastStatus: string | null
}

export type MappedPackage = {
  trackingNumber: string
  events: MappedEvent[]
  milestones: Milestones
}

/**
 * The parcel is with the customer's chosen collection point, or in their hands.
 * This is THE clock stop: the moment the company's obligation ends.
 *
 * READY_FOR_PICKUP counts because in the Nordics a large share of parcels wait
 * at a pickup point for days, and Bring only reports DELIVERED on collection.
 * Judging against collection would raise alerts about customers who took a week
 * to walk to the shop.
 */
const AVAILABLE = new Set(['READY_FOR_PICKUP', 'DELIVERED'])

/** In the customer's hands. Recorded and shown, never judged against a promise. */
const COLLECTED = new Set(['DELIVERED', 'COLLECTED'])

/** Going back. Such a parcel is never available, and never counts as delivered. */
const RETURNED = new Set(['RETURN', 'DELIVERED_SENDER'])

const CANCELLED = new Set(['DELIVERY_CANCELLED'])

const first = (events: MappedEvent[], match: (s: string) => boolean): Date | null => {
  const hits = events.filter((e) => match(e.status)).map((e) => e.occurredAt.getTime())
  // Earliest, not latest: a milestone restated later did not happen later.
  return hits.length ? new Date(Math.min(...hits)) : null
}

export function milestonesFrom(events: MappedEvent[]): Milestones {
  const returned = events.some((e) => RETURNED.has(e.status))
  const cancelled = events.some((e) => CANCELLED.has(e.status))

  // A returned or cancelled parcel never became available to the customer.
  // Without this, a return would sit past its promise forever and the late list
  // would only ever grow.
  const availableAt = returned || cancelled ? null : first(events, (s) => AVAILABLE.has(s))

  const latest = events.reduce<MappedEvent | null>(
    (best, e) => (!best || e.occurredAt > best.occurredAt ? e : best),
    null,
  )

  return {
    bookedAt: first(events, (s) => s === 'PRE_NOTIFIED'),
    handedInAt: first(events, (s) => s === 'HANDED_IN'),
    availableAt,
    collectedAt: returned || cancelled ? null : first(events, (s) => COLLECTED.has(s)),
    outcome: returned ? 'RETURNED' : cancelled ? 'CANCELLED' : availableAt ? 'DELIVERED' : null,
    lastStatus: latest?.status ?? null,
  }
}

/** A trimmed non-empty string, or null. Both carrier mappers parse defensively. */
export const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null
