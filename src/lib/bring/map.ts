/**
 * Bring's tracking JSON into our own shape.
 *
 * Pure: no database, no network. What the resulting events MEAN — when a parcel
 * counts as delivered, returned, available — is not decided here but in
 * src/lib/delivery/milestones.ts, so that DHL's mapper and this one cannot
 * drift into measuring different things.
 */

import { milestonesFrom, str, type MappedEvent, type MappedPackage } from '../delivery/milestones'

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
