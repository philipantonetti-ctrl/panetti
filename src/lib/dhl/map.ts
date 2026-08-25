/**
 * DHL's Shipment Tracking JSON into our own shape.
 *
 * Pure: no database, no network. What the resulting events MEAN is decided in
 * src/lib/delivery/milestones.ts, which this file feeds - DHL's words are
 * translated into that vocabulary here so a DHL parcel and a Bring parcel are
 * measured by one rule. A carrier that kept its own words would make the
 * delivery median mean something different per carrier.
 *
 * Selectors below are from a RECORDED response (__fixtures__/real-shipment.json,
 * captured 2026-08-17 from api-eu.dhl.com with the client's own key), not from
 * the documentation alone. The one exception is noted at RETURN_FLAG below.
 */

import {
  milestonesFrom,
  str,
  type MappedEvent,
  type MappedPackage,
} from '../delivery/milestones'

/**
 * DHL's normalised statusCode, into the vocabulary we judge against.
 *
 * `pre-transit` is proven by the recording ("Consignment created"). `transit`
 * and `delivered` are DHL's documented enum. The last two are deliberately NOT
 * milestone words: milestonesFrom ignores them, so they are recorded and shown
 * without moving a date.
 *
 * FAILURE especially. A failed delivery attempt is neither a delivery nor a
 * return, and calling it either would either stop the clock early or drop the
 * parcel out of the late list - both of which hide a parcel that needs chasing.
 */
const STATUS: Record<string, string> = {
  'pre-transit': 'PRE_NOTIFIED',
  transit: 'HANDED_IN',
  delivered: 'DELIVERED',
  failure: 'FAILURE',
  unknown: 'UNKNOWN',
}

/**
 * DHL sends "2026-08-17T12:19:54" - no offset, no Z.
 *
 * Handed to `new Date()` unchanged, that string is parsed as the READER's local
 * time: the same parcel would sit at 12:19 on Vercel and 04:19 on a laptop in
 * Manila, and a delivery median would move with whoever ran the query. Reading
 * it as UTC at least makes the answer identical everywhere.
 *
 * UNVERIFIED ASSUMPTION, stated plainly rather than dressed up as a decision:
 * we do not know that DHL MEANS UTC. Checked against a full live response
 * 2026-08-18 - there is no zone field anywhere in the payload (no offset, no
 * tz key, nothing on the event or the shipment), so it cannot be read off the
 * data. If DHL is reporting local time at the event's location, every one of
 * these is two hours early for a European summer parcel.
 *
 * Impact is bounded: everything downstream is measured in DAYS, so a two-hour
 * error only changes an answer for a parcel whose event falls within two hours
 * of midnight. Worth knowing, not worth guessing a correction for - applying a
 * +2 that turns out to be wrong is worse than a known 2-hour uncertainty.
 *
 * To settle it: fetch a parcel that is moving RIGHT NOW and compare its newest
 * event to the current UTC time. A timestamp AHEAD of UTC proves local time in
 * one observation. Could not be done on 2026-08-18 - every DHL parcel we hold
 * was already delivered, so no event was recent enough to discriminate.
 *
 * A timestamp that already carries a zone is left alone.
 */
function occurredAt(raw: unknown): Date | null {
  const iso = str(raw)
  if (!iso) return null

  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)
  const when = new Date(zoned ? iso : `${iso}Z`)
  // An Invalid Date is truthy and would reach Prisma as a throw or a null
  // column. Drop the event: a missing event is honest, a wrong time is not.
  return Number.isNaN(when.getTime()) ? null : when
}

/**
 * KNOWN GAP: `returnFlag`.
 *
 * It sits on the shipment and is `false` in the only real response we hold, so
 * neither what a `true` one looks like nor whether the return also arrives as
 * an event is determined. Left unmapped rather than guessed: marking a live
 * parcel returned nulls its availableAt and takes it off the late list, so a
 * wrong guess hides the parcel most worth chasing. See the skipped test in
 * map.test.ts - unskip it the day a returned DHL parcel is recorded.
 */
export function mapShipments(raw: unknown): MappedPackage[] {
  const shipments = (raw as { shipments?: unknown })?.shipments
  if (!Array.isArray(shipments)) return []

  const out: MappedPackage[] = []

  for (const shipment of shipments) {
    const s = shipment as { id?: unknown; events?: unknown }
    const trackingNumber = str(s?.id)
    if (!trackingNumber) continue

    const events: MappedEvent[] = []
    for (const e of Array.isArray(s.events) ? s.events : []) {
      const raw = e as {
        timestamp?: unknown
        statusCode?: unknown
        status?: unknown
        description?: unknown
        location?: { address?: { addressLocality?: unknown } }
      }

      const when = occurredAt(raw?.timestamp)
      if (!when) continue

      // The normalised code decides the milestone. DHL's own `status` ("ACT-2")
      // is a per-service code that means nothing outside its service, so it is
      // never used to judge - only the description is kept, for reading.
      const code = str(raw?.statusCode)?.toLowerCase()
      const status = (code && STATUS[code]) ?? 'UNKNOWN'

      events.push({
        status,
        occurredAt: when,
        description: str(raw?.description),
        location: str(raw?.location?.address?.addressLocality),
      })
    }

    out.push({ trackingNumber, events, milestones: milestonesFrom(events) })
  }

  return out
}
