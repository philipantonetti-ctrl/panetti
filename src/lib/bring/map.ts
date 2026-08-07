/**
 * Bring's tracking JSON into our own shape, and events into milestones.
 *
 * Pure: no database, no network. Every rule about WHEN a parcel counts as
 * delivered lives here and nowhere else.
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

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/**
 * Defensive throughout: a malformed reply must degrade, never stop the run.
 *
 * Field selectors below (`packageSet`, `packageNumber`, `eventSet`, `status`,
 * `dateIso`, `description`, `city`, `countryCode`) are Bring's *documented*
 * shape, not a recorded response — the Phase 0 probe that would confirm them
 * has not run yet (no warehouse-booked tracking number supplied). They are
 * provisional. See map.test.ts's skipped 'maps the recorded real response'
 * test: the moment __fixtures__/real-package.json exists, that recording wins
 * over the documentation and these selectors get re-checked against it.
 */
export function mapConsignments(raw: unknown[]): MappedPackage[] {
  const out: MappedPackage[] = []

  for (const consignment of raw) {
    const packages = (consignment as { packageSet?: unknown })?.packageSet
    if (!Array.isArray(packages)) continue

    for (const pkg of packages) {
      const p = pkg as { packageNumber?: unknown; eventSet?: unknown }
      const trackingNumber = str(p?.packageNumber)
      if (!trackingNumber) continue

      const events: MappedEvent[] = []
      for (const e of Array.isArray(p.eventSet) ? p.eventSet : []) {
        const raw = e as {
          status?: unknown; dateIso?: unknown; description?: unknown
          city?: unknown; countryCode?: unknown
        }
        const status = str(raw?.status)
        const iso = str(raw?.dateIso)
        if (!status || !iso) continue

        const occurredAt = new Date(iso)
        // An Invalid Date is truthy and would reach Prisma as a null column or
        // a throw. Drop the event instead: a missing event is honest, a wrong
        // timestamp is not.
        if (Number.isNaN(occurredAt.getTime())) continue

        events.push({
          status,
          occurredAt,
          description: str(raw?.description),
          location: [str(raw?.city), str(raw?.countryCode)].filter(Boolean).join(', ') || null,
        })
      }

      out.push({ trackingNumber, events, milestones: milestonesFrom(events) })
    }
  }

  return out
}
