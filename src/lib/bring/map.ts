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
 * The field selectors below (`packageSet`, `packageNumber`, `eventSet`,
 * `status`, `dateIso`, `description`, `city`, `countryCode`) are CONFIRMED
 * against a recorded real response — __fixtures__/real-package.json, exercised
 * by map.test.ts's 'maps the recorded real response', which runs rather than
 * skips. (This comment used to say the opposite, describing them as provisional
 * and the probe as not yet run; that was true when written and stopped being
 * true when the fixture landed.)
 *
 * Timestamps need no interpretation here, unlike DHL's. Bring sends
 * `dateIso` with an explicit offset — "2026-08-18T08:52:56+02:00", verified
 * live 2026-08-18 — so `new Date()` reads it exactly, with no assumption about
 * which zone was meant. See the long note in dhl/map.ts for the carrier that
 * gives no offset at all.
 *
 * Statuses pass through UNTRANSLATED, again unlike DHL's: our milestone
 * vocabulary in delivery/milestones.ts is Bring's own wording, so there is no
 * mapping table to get wrong. Which words are proven by real data, and which
 * are still only documented, is recorded in map.test.ts.
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
