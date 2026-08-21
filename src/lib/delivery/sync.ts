import { db } from '../db'
import { getSetting } from '../settings'
import { fetchTracking as fetchBring } from '../bring/client'
import { mapConsignments } from '../bring/map'
import {
  fetchTracking as fetchDhl,
  DAILY_CALL_BUDGET,
  RATE_LIMIT_GAP_MS,
} from '../dhl/client'
import { mapShipments } from '../dhl/map'
import { getDeliveryConfig } from './config'
import { deadlineFor } from './days'
import type { MappedPackage, Milestones } from './milestones'
import { promiseOn } from './promise'

export type ShipmentSyncResult = {
  polled: number
  updated: number
  failed: number
  /** DHL calls this run spent. The budget is small enough to be worth seeing. */
  dhlCalls?: number
  /**
   * DHL parcels that were due and went unasked for want of a key.
   *
   * Counted because skipping them is silent by design — no error on the parcel
   * and no change to its schedule — and DHL's credentials are an environment
   * variable with no settings row, no status line and no way to notice. Every
   * other integration here says whether it is connected; this is how DHL does.
   */
  dhlSkippedNoKey?: number
  error?: string
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * A parcel sitting at a pickup point this long is not going to be collected.
 * We stop asking rather than poll it forever.
 */
const ABANDONED_AFTER = 30 * DAY

/**
 * How many DHL parcels one run may ask about.
 *
 * DHL's free tier is 250 calls a day; we hold 240 back as the budget. The sync
 * cron runs every 15 minutes, so:
 *
 *     240 calls/day ÷ 96 runs/day = 2.5 calls per run
 *
 * Two, rounded down: 2 × 96 = 192 calls a day, comfortably inside the tier with
 * room for a manual refresh. Against roughly eighty open DHL parcels that is
 * about two looks at each per day, which is the right cadence for a carrier
 * whose events arrive a handful of times per parcel.
 *
 * Bring has no such cap because Bring does not meter us. This is the one place
 * the two carriers are treated differently, and DHL's rate limit is the whole
 * reason.
 */
export const DHL_CALLS_PER_RUN = 2

/**
 * When to look at this parcel again.
 *
 * Delivery events happen a handful of times per parcel, so polling everything
 * every fifteen minutes would be tens of thousands of wasted calls a day. The
 * tiers spend the budget where something is actually likely to have changed,
 * and on the parcels somebody is actually waiting for.
 *
 * Carrier-neutral on purpose: a DHL parcel and a Bring parcel near the same
 * promise deserve the same attention, and DHL's rate limit is handled by the
 * per-run cap above rather than by making its parcels less urgent.
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

  // Booked but still in the warehouse, or not yet known to the carrier at all.
  return { nextPollAt: new Date(now.getTime() + 6 * HOUR), terminal: false }
}

/**
 * Ask one carrier about one parcel.
 *
 * Null means the carrier does not know the number. Both carriers are one parcel
 * per request — Bring answers about a single `q` however many are sent
 * (measured 2026-08-12), and DHL's endpoint has no batch form at all — so there
 * is no batching to be had on either side.
 */
type Tracker = (
  trackingNumber: string,
  opts: { deadline?: number },
) => Promise<MappedPackage | null>

const sleepFor = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Poll every parcel that is due, oldest first.
 *
 * Oldest-first is the same fairness rule syncAllShops gets from ordering by
 * lastRunAt: without it, a run that cannot reach everything starves the same
 * parcels every time. It matters more now than it did with one carrier, because
 * DHL's per-run cap guarantees some runs cannot reach everything.
 *
 * A per-parcel failure is written to its own lastError and never thrown. One
 * dead parcel must not stop the rest — the same rule ads/sync.ts follows for
 * one broken ad account.
 */
export async function syncShipments(
  opts: { deadline?: number; now?: Date; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<ShipmentSyncResult> {
  const now = opts.now ?? new Date()
  // Injected by tests so the six-second DHL spacing does not make a suite take
  // six seconds. Production always uses the real one.
  const sleep = opts.sleep ?? sleepFor

  const { creds } = await getDeliveryConfig()
  const dhlKey = process.env.DHL_API_KEY ?? null

  const trackers: Record<string, Tracker | undefined> = {
    BRING: creds
      ? async (n, o) => mapConsignments(await fetchBring(creds, [n], o))[0] ?? null
      : undefined,
    DHL: dhlKey
      ? async (n, o) => {
          const raw = await fetchDhl(dhlKey, n, o)
          return raw === null ? null : (mapShipments(raw)[0] ?? null)
        }
      : undefined,
  }

  if (!trackers.BRING && !trackers.DHL) {
    return { polled: 0, updated: 0, failed: 0, error: 'No carrier is connected.' }
  }

  // The promise book and the workspace timezone, once for the run, never per
  // parcel. Both are tiny and change rarely.
  const promises = await db.deliveryPromise.findMany()
  const { timezone: fallbackTz } = await getSetting()

  const due = await db.shipment.findMany({
    /**
     * NULL means "never scheduled", and that is the STRONGEST claim on this
     * poller's attention, not the weakest.
     *
     * `nextPollAt: { lte: now }` alone silently drops those rows: in SQL
     * `NULL <= now()` evaluates to NULL, not true, so they are not returned by
     * any run, ever. And nothing backfills the column — the DHL import wrote
     * NULL deliberately, back when this poller asked Bring about every number
     * regardless of carrier and a due date would have sent a DHL number to
     * Bring. Those parcels were left permanently invisible.
     *
     * Found live 2026-08-18: five DHL parcels shown as "In transit" and counted
     * as late, while DHL's API reported every one delivered, the oldest five
     * days before. The orderBy below already said `nulls: 'first'`; only this
     * where clause disagreed with it.
     *
     * Self-healing on purpose: one run gives every stranded parcel a real
     * schedule, so no migration or re-import is needed to rescue them.
     */
    where: { terminal: false, OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] },
    orderBy: { nextPollAt: { sort: 'asc', nulls: 'first' } },
    select: {
      id: true,
      trackingNumber: true,
      orderId: true,
      // Which carrier to ask. Without this the poller asked Bring about every
      // parcel, which is why dhl/link.ts refused to set nextPollAt at all.
      carrier: true,
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
  let dhlCalls = 0
  let dhlSkippedNoKey = 0

  for (const s of due) {
    // Checked before the request, not after: starting a lookup we have no time
    // to finish takes the budget from parcels already further behind.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break

    const track = trackers[s.carrier]
    // A carrier we hold no credentials for. Left completely alone — no error on
    // the parcel, no change to nextPollAt — so that connecting it later picks
    // these up exactly where they were. Recording a failure here would fill the
    // delivery page with red for a carrier nobody has connected yet.
    //
    // Counted on the way past, though. Silent on the PARCEL is right; silent
    // for the whole RUN is what let every DHL parcel go unchecked behind a
    // page reporting a healthy sync.
    if (!track) {
      if (s.carrier === 'DHL') dhlSkippedNoKey++
      continue
    }

    if (s.carrier === 'DHL') {
      // The run's share of the daily allowance is spent. These parcels keep
      // their due date and are first in line next run, which is what
      // oldest-first ordering is for.
      if (dhlCalls >= DHL_CALLS_PER_RUN) continue
      // Between calls, never before the first: DHL allows one every five
      // seconds, and a run asking about a single parcel should not pause.
      if (dhlCalls > 0) {
        // The wait is checked against the deadline BEFORE it is taken, for the
        // same reason the lookup above is: sleeping through the deadline and
        // then asking anyway buys a one-millisecond request budget, an abort,
        // and a healthy parcel recorded as failed — the poller inventing a
        // failure out of its own waiting.
        if (opts.deadline !== undefined && Date.now() + RATE_LIMIT_GAP_MS >= opts.deadline) break
        await sleep(RATE_LIMIT_GAP_MS)
      }
      dhlCalls++
    }

    let found: MappedPackage | null
    try {
      found = await track(s.trackingNumber, { deadline: opts.deadline })
    } catch (e) {
      // A network error, a bad key, a rate limit. Record it on the parcel and
      // carry on — the next run retries.
      const error = e instanceof Error ? e.message : 'Tracking lookup failed'
      failed++
      await db.shipment
        .update({
          where: { id: s.id },
          data: { lastError: error, nextPollAt: new Date(now.getTime() + HOUR) },
        })
        .catch(() => {})
      continue
    }

    polled++

    if (!found) {
      // Not an error worth stopping for: the warehouse may have sent us the
      // number before handing the parcel over. Recorded so a number that is
      // simply wrong is visible rather than silently never tracked.
      await db.shipment
        .update({
          where: { id: s.id },
          data: {
            lastError: `${s.carrier} does not know this number yet`,
            nextPollAt: new Date(now.getTime() + 6 * HOUR),
          },
        })
        .catch(() => {})
      continue
    }

    const m = found.milestones
    // An unlinked parcel, or one whose country has no promise in force, simply
    // uses the ordinary tiers. No promise means NO deadline — never a zero one,
    // which would make every parcel look overdue and put the whole backlog into
    // the every-run tier.
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
          data: found!.events.map((e) => ({
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
      // long history — aborts every parcel still queued behind it. Worse under
      // oldest-first ordering: a persistently-failing row holds the head of the
      // queue and starves everything else on every later run too, which is the
      // exact outage syncAllShops's lastRunAt rule exists to prevent.
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

  // Only claim a successful sync when one actually happened.
  //
  // This is the only writer of DeliveryConfig.lastError anywhere, so clearing
  // it unconditionally meant the field could never be non-null: a revoked
  // Mybring key produced "Last synced: a minute ago", no error, forever, while
  // every parcel quietly recorded its own failure on a screen nobody reads.
  // Same silent-success seam that slackLastError already closed for the alert
  // half; this is the carrier half of it.
  //
  // A partial failure still counts as a sync — parcels that did poll are
  // genuinely fresh, and their own lastError carries the detail. Only a run
  // that reached nothing at all is a failed run.
  //
  // A carrier we were never able to ASK is the third case, and it used to fall
  // through here as a success. DHL's key is an environment variable: no
  // settings row, no status line, nothing to notice — so with it unset the
  // poller skipped every DHL parcel, wrote nothing anywhere, and stamped the
  // sync healthy. That is how three parcels DHL had delivered on 2026-08-13
  // were still being reported as in transit and a week overdue on the 21st.
  //
  // Said alongside a stamped lastSyncAt rather than instead of it: the run did
  // happen and Bring's half of it worked, so calling the whole thing failed
  // would trade one wrong story for another. The words are the ones the DHL
  // test button already uses, because it is the same fix in both places.
  //
  // And the fourth: parcels were due and the run got no clock at all. This
  // poll is last in the cron behind a shop sync allowed 240s of a 275s budget
  // and three Visma imports carrying no deadline, so the loop's first deadline
  // check can break before one parcel is asked about. polled and failed are
  // then both zero — which is also exactly what a run with nothing due looks
  // like, and why it was read as healthy. The number of parcels that WERE due
  // is the only thing separating the two, so it is what decides.
  const reachedNothing = polled === 0 && failed > 0
  const ranDry = polled === 0 && failed === 0 && dhlSkippedNoKey === 0 && due.length > 0
  const problem = reachedNothing
    ? `Could not reach the carrier for any parcel (${failed} failed).`
    : dhlSkippedNoKey > 0
      ? `DHL is not connected, so ${dhlSkippedNoKey} DHL ${
          dhlSkippedNoKey === 1 ? 'parcel was' : 'parcels were'
        } not checked. Add DHL_API_KEY in Vercel, then redeploy.`
      : ranDry
        ? `No time left in this run to check any of the ${due.length} ${
            due.length === 1 ? 'parcel' : 'parcels'
          } due. The stages before parcel tracking are using the whole run.`
        : null

  await db.deliveryConfig
    .update({
      where: { id: 'singleton' },
      data: reachedNothing ? { lastError: problem } : { lastSyncAt: new Date(), lastError: problem },
    })
    .catch(() => {})

  return { polled, updated, failed, dhlCalls, dhlSkippedNoKey }
}

/** The daily allowance this poller is written against. Exported for the docs. */
export { DAILY_CALL_BUDGET }
