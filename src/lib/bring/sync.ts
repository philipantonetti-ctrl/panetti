import { db } from '../db'
import { getSetting } from '../settings'
import { getDeliveryConfig } from '../delivery/config'
import { deadlineFor } from '../delivery/days'
import { promiseOn } from '../delivery/promise'
import { fetchTracking } from './client'
import { mapConsignments, type Milestones } from './map'

export type ShipmentSyncResult = {
  polled: number
  updated: number
  failed: number
  error?: string
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** How many parcels go into one request. Bring accepts repeated `q` values. */
const BATCH = 10

/**
 * A parcel sitting at a pickup point this long is not going to be collected.
 * We stop asking rather than poll it forever.
 */
const ABANDONED_AFTER = 30 * DAY

/**
 * When to look at this parcel again.
 *
 * Delivery events happen a handful of times per parcel, so polling everything
 * every fifteen minutes would be tens of thousands of wasted calls a day. The
 * tiers spend the budget where something is actually likely to have changed,
 * and on the parcels somebody is actually waiting for.
 */
export function nextPollFor(
  m: Milestones,
  deadline: Date | null,
  now: Date,
): { nextPollAt: Date | null; terminal: boolean } {
  const stop = { nextPollAt: null, terminal: true }

  // Nothing more will ever happen to these.
  if (m.outcome === 'RETURNED' || m.outcome === 'CANCELLED') return stop
  if (m.collectedAt) return stop

  if (m.availableAt) {
    // Waiting to be collected. We already have the figure that matters; the
    // collection date is a nicety, so once a day, and not forever.
    if (now.getTime() - m.availableAt.getTime() > ABANDONED_AFTER) return stop
    return { nextPollAt: new Date(now.getTime() + DAY), terminal: false }
  }

  // Near or past its promise: this is the parcel someone will ask about, so it
  // gets checked on every run.
  if (deadline && now.getTime() >= deadline.getTime() - DAY) {
    return { nextPollAt: new Date(now.getTime()), terminal: false }
  }

  // Moving.
  if (m.handedInAt) return { nextPollAt: new Date(now.getTime() + 2 * HOUR), terminal: false }

  // Booked but still in the warehouse, or not yet known to Bring at all.
  return { nextPollAt: new Date(now.getTime() + 6 * HOUR), terminal: false }
}

/**
 * Poll every parcel that is due, oldest first.
 *
 * Oldest-first is the same fairness rule syncAllShops gets from ordering by
 * lastRunAt: without it, a run that cannot reach everything starves the same
 * parcels every time.
 *
 * A per-parcel failure is written to its own lastError and never thrown. One
 * dead parcel must not stop the rest — the same rule ads/sync.ts follows for
 * one broken ad account.
 */
export async function syncShipments(
  opts: { deadline?: number; now?: Date } = {},
): Promise<ShipmentSyncResult> {
  const now = opts.now ?? new Date()
  const { creds } = await getDeliveryConfig()
  if (!creds) return { polled: 0, updated: 0, failed: 0, error: 'Bring is not connected.' }

  // The promise book and the workspace timezone, once for the run, never per
  // parcel. Both are tiny and change rarely.
  const promises = await db.deliveryPromise.findMany()
  const { timezone: fallbackTz } = await getSetting()

  const due = await db.shipment.findMany({
    where: { terminal: false, nextPollAt: { lte: now } },
    orderBy: { nextPollAt: { sort: 'asc', nulls: 'first' } },
    select: {
      id: true,
      trackingNumber: true,
      orderId: true,
      // Carried so each parcel's own deadline can be computed below: a parcel
      // near or past its promise is polled on every run.
      order: {
        select: {
          placedAt: true,
          shippingCountry: true,
          // Promises are per shop as well as per country, so the tier a parcel
          // lands in depends on which shop sold it.
          shopId: true,
          shop: { select: { timezone: true } },
        },
      },
    },
    take: 200,
  })

  let polled = 0
  let updated = 0
  let failed = 0

  for (let i = 0; i < due.length; i += BATCH) {
    // Checked before the request, not after: starting a batch we have no time
    // to finish takes the budget from parcels already further behind.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break

    const batch = due.slice(i, i + BATCH)
    let byNumber: Map<string, ReturnType<typeof mapConsignments>[number]>
    try {
      const raw = await fetchTracking(creds, batch.map((s) => s.trackingNumber), {
        deadline: opts.deadline,
      })
      byNumber = new Map(mapConsignments(raw).map((p) => [p.trackingNumber, p]))
    } catch (e) {
      // The whole batch failed: a network error, a bad key, a rate limit. Record
      // it on each parcel and carry on — the next run retries.
      const error = e instanceof Error ? e.message : 'Tracking lookup failed'
      failed += batch.length
      for (const s of batch) {
        await db.shipment
          .update({
            where: { id: s.id },
            data: { lastError: error, nextPollAt: new Date(now.getTime() + HOUR) },
          })
          .catch(() => {})
      }
      continue
    }

    polled += batch.length

    for (const s of batch) {
      const found = byNumber.get(s.trackingNumber)

      if (!found) {
        // Not an error worth stopping for: the warehouse may have sent us the
        // number before handing the parcel over. Recorded so a number that is
        // simply wrong is visible rather than silently never tracked.
        await db.shipment
          .update({
            where: { id: s.id },
            data: {
              lastError: 'Bring does not know this number yet',
              nextPollAt: new Date(now.getTime() + 6 * HOUR),
            },
          })
          .catch(() => {})
        continue
      }

      const m = found.milestones
      // An unlinked parcel, or one whose country has no promise in force,
      // simply uses the ordinary tiers. No promise means NO deadline — never a
      // zero one, which would make every parcel look overdue and put the whole
      // backlog into the every-run tier.
      const promise = s.order
        ? promiseOn(promises, s.order.shopId, s.order.shippingCountry, s.order.placedAt)
        : null
      const deadline =
        s.order && promise
          ? deadlineFor(
              s.order.placedAt,
              promise.days,
              promise.businessDays,
              s.order.shop.timezone ?? fallbackTz,
            )
          : null

      const { nextPollAt, terminal } = nextPollFor(m, deadline, now)

      try {
        await db.$transaction(async (tx) => {
          // One insert for the whole event set, not one per event: a parcel's
          // history is re-sent in full on every poll, so this runs constantly.
          // skipDuplicates leans on @@unique([shipmentId, status, occurredAt]) —
          // that constraint is what makes re-ingesting a restated history a no-op
          // rather than a pile of duplicates.
          await tx.shipmentEvent.createMany({
            data: found.events.map((e) => ({
              shipmentId: s.id,
              status: e.status,
              occurredAt: e.occurredAt,
              description: e.description,
              location: e.location,
            })),
            skipDuplicates: true,
          })
          await tx.shipment.update({
            where: { id: s.id },
            data: {
              bookedAt: m.bookedAt, handedInAt: m.handedInAt,
              availableAt: m.availableAt, collectedAt: m.collectedAt,
              outcome: m.outcome, lastStatus: m.lastStatus,
              nextPollAt, terminal, lastError: null,
            },
          })
        })
        updated++
      } catch (e) {
        // One parcel's write must not end the run. Without this, a single bad
        // row — a connection blip, or a transaction timeout on a parcel with a
        // long history — aborts every batch still queued behind it. Worse under
        // oldest-first ordering: a persistently-failing row holds the head of
        // the queue and starves everything else on every later run too, which
        // is the exact outage syncAllShops's lastRunAt rule exists to prevent.
        const error = e instanceof Error ? e.message : 'Could not store this parcel'
        failed++
        await db.shipment
          .update({
            where: { id: s.id },
            data: { lastError: error, nextPollAt: new Date(now.getTime() + HOUR) },
          })
          .catch(() => {})
      }
    }
  }

  // Only claim a successful sync when one actually happened.
  //
  // This is the only writer of DeliveryConfig.lastError anywhere, so clearing
  // it unconditionally meant the field could never be non-null: a revoked
  // Mybring key produced "Last synced: a minute ago", no error, forever, while
  // every parcel quietly recorded its own failure on a screen nobody reads.
  // Same silent-success seam that slackLastError already closed for the alert
  // half; this is the Bring half of it.
  //
  // A partial failure still counts as a sync — parcels that did poll are
  // genuinely fresh, and their own lastError carries the detail. Only a run
  // that reached nothing at all is a failed run.
  const reachedNothing = polled === 0 && failed > 0
  await db.deliveryConfig
    .update({
      where: { id: 'singleton' },
      data: reachedNothing
        ? { lastError: `Could not reach Bring for any parcel (${failed} failed).` }
        : { lastSyncAt: new Date(), lastError: null },
    })
    .catch(() => {})

  return { polled, updated, failed }
}
