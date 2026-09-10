import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { wallClock, zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { candidatesFor } from '@/lib/delivery/candidates'
import { daysBetween } from '@/lib/delivery/days'
import { loadDelivery, type LoadedDelivery } from '@/lib/delivery/load'
import { deliveryStats } from '@/lib/delivery/stats'
import { carrierName, trackingUrl } from '@/lib/delivery/tracking-url'
import { stillLate } from '@/lib/delivery/view'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * How many late rows the payload carries in full, worst first. `lateTotal`
 * carries the true count so the page can say so out loud when this cap
 * bites, rather than silently showing a partial list as if it were whole.
 */
const LATE_LIMIT = 200

/**
 * The Delivery page's data: how long orders took, what is late right now, and
 * what we could not account for.
 *
 * The last part matters as much as the first. An unlinked parcel and a failed
 * import are both invisible by nature - the page simply shows fewer orders and
 * looks like a quiet week - so both are counted out loud.
 */
export async function GET(req: Request) {
  try {
    assertOperations(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const shops = await db.shop.findMany({
      where: { active: true, ...(shopIds?.length ? { id: { in: shopIds } } : {}) },
      select: { id: true, name: true, deliveryTrackingFrom: true },
    })
    const shopRows = shops.map((s) => ({ id: s.id, name: s.name }))

    // One `now` for the whole response. loadDelivery would default its own,
    // and a row's "waiting 9 days" computed a few milliseconds later than the
    // state it belongs to is a disagreement waiting for a midnight boundary.
    const now = new Date()

    const { rows } = await loadDelivery(
      shops.map((s) => s.id),
      zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
      zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
      now,
    )

    const stats = deliveryStats(
      rows.map((r) => r.view),
      rows.map((r) => r.order.shippingCountry),
    )

    /**
     * Two lists, not one, because they are two different jobs.
     *
     * An order with a parcel that is overdue is chased with the CARRIER: there
     * is a number, and somebody can go and ask where it is. An order past its
     * promise with no parcel at all is chased with the WAREHOUSE: we are not
     * saying it is late, only that no file has told us anything about it.
     *
     * Measured live 2026-08-18: ~120 late rows, SIX of them with a parcel. Run
     * together, the six rows anyone could act on were invisible, and the other
     * ~114 asserted a lateness the data cannot support - a missing file is not
     * evidence of a missed promise.
     *
     * Split on the parcel rather than on state === 'NO_TRACKING': the parcel IS
     * the thing that makes a row actionable, so it should be the thing the
     * split reads.
     */
    const byUrgency = (a: LoadedDelivery, b: LoadedDelivery) =>
      (b.view.daysOver ?? 0) - (a.view.daysOver ?? 0)

    /**
     * How long we have been in the dark about an order, in the SHOP's timezone
     * - the same clock deliveryFor judges its promise against, so a row can
     * never report a day more or less than the state beside it.
     */
    const waitingDays = (r: LoadedDelivery) =>
      daysBetween(r.order.placedAt, now, r.order.shopTimezone ?? timezone)

    // Longest wait first. daysOver ranks nothing here: most of this list is
    // still inside its promise, so it is zero for row after row.
    const byWaiting = (a: LoadedDelivery, b: LoadedDelivery) => waitingDays(b) - waitingDays(a)

    const toRow = (r: LoadedDelivery) => ({
      id: r.order.id,
      number: r.order.number,
      waitingDays: waitingDays(r),
      // The shop's own clock, date AND time, not a UTC instant. An order
      // placed at 23:30 in Oslo would otherwise print one date while counting
      // its waiting days from the next. The time is carried because the
      // warehouse cutoff is noon local, so it is what decides which file the
      // order belongs in - see lib/delivery/due.ts.
      placedAtLocal: wallClock(r.order.placedAt, r.order.shopTimezone ?? timezone),
      // Null stays null rather than becoming ''. The page decides how to print
      // an order we hold no name for, and it cannot if the two are flattened.
      customerName: r.customerName,
      shop: r.order.shopName,
      country: r.order.shippingCountry || null,
      daysOver: r.view.daysOver ?? 0,
      promiseDays: r.view.promiseDays,
      state: r.view.state,
      parcels: r.view.parcels,
    })

    /**
     * The chase queue, from the SAME function the tile above is counted with
     * (lib/delivery/view.ts). Not a rule of its own: this list has now twice
     * drifted from the tile it sits under - 155 against 8 when the tile forgot
     * the parcel clause, then 13 against 16 when this list kept every order
     * that had SINCE ARRIVED and advertised the fact in its own heading.
     *
     * The client's words on the second one: "when order is delivered or ready
     * for collection, it can go away from the Late section." A parcel in the
     * customer's hands is not something anybody can chase, and a to-do list
     * carrying finished work stops being read. Those orders are still on the
     * page - they are what the on-time rate is made of, and "Where everything
     * is now" counts them under Ready for collection and Delivered - they are
     * simply no longer queued.
     */
    const chasable = rows.filter((r) => stillLate(r.view))

    /**
     * EVERY order with no parcel, not only the ones also past their promise.
     *
     * Splitting the late list fixed one fault and left a smaller copy of it:
     * this list held the overdue subset while the tile above counted the whole
     * NO_TRACKING set, so the two reported different sizes for the same idea
     * and the rows in the gap were reachable from nowhere on the page. Keyed
     * on the same `state` deliveryStats counts, the tile and the list are now
     * the same set by construction rather than by agreement.
     */
    const unfiled = rows.filter((r) => r.view.state === 'NO_TRACKING')

    // The true totals, not the capped array lengths. Both lists are capped for
    // the payload's sake, and a heading that reports the cap is a wrong number
    // exactly when the situation is worst - 300 unlinked parcels would read as
    // "50", on the one section whose whole job is to make a linking outage
    // visible.
    const lateTotal = chasable.length
    const late = chasable.sort(byUrgency).slice(0, LATE_LIMIT).map(toRow)
    const noTrackingTotal = unfiled.length

    const [unlinked, unlinkedTotal, imports, config] = await Promise.all([
      db.shipment.findMany({
        where: { orderId: null, dismissedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          trackingNumber: true, carrier: true, lastStatus: true,
          destinationCountry: true, weightKg: true, bookedAt: true, recipientName: true,
          unlinkedReason: true, identifiedAt: true, createdAt: true,
          // Server-side only, for candidates and the note below. Stripped before the response.
          recipientEmail: true, consignmentId: true,
        },
      }),
      db.shipment.count({ where: { orderId: null, dismissedAt: null } }),
      db.trackingImport.findMany({
        orderBy: { receivedAt: 'desc' },
        take: 10,
        select: {
          id: true, filename: true, receivedAt: true,
          rowsParsed: true, rowsLinked: true, rowsUnmatched: true, error: true,
          // Both were written and neither was ever read. `unmatched` is the JSON
          // list of refusals with their stated reasons - without it the page
          // says "27 parsed, 25 linked, 2 unmatched" and gives an operator no
          // way at all to learn why those two were refused. `source` says
          // whether the file arrived by email or by hand, which is the first
          // thing you want to know when the automatic feed looks quiet.
          unmatched: true, source: true,
        },
      }),
      // Only the timestamp. getDeliveryConfig would decrypt the Bring key and
      // the Slack URL to answer a question about freshness, and a page load has
      // no business touching either.
      db.deliveryConfig.findUnique({
        where: { id: 'singleton' },
        select: { lastSyncAt: true },
      }),
    ])

    // Candidates are computed live, one query per listed parcel: the answer
    // changes as other parcels link, and fifty small reads on a page load is
    // cheaper than a stored answer that is wrong by the next morning.
    const withCandidates = await Promise.all(
      unlinked.map(async (s) => ({ ...s, ...(await candidatesFor(s)) })),
    )

    /**
     * The one thing a no-tracking order can be told in this phase: a parcel
     * for the same customer was in a file and refused. Keyed on the email
     * both sides hold; DHL parcels carry none, which is what phase 2 is for.
     */
    const refusedByEmail = new Map<string, { trackingNumber: string; reason: string; createdAt: string }>()
    for (const s of [...unlinked].reverse()) {
      if (s.recipientEmail && s.unlinkedReason) {
        refusedByEmail.set(s.recipientEmail.toLowerCase(), {
          trackingNumber: s.trackingNumber, reason: s.unlinkedReason, createdAt: s.createdAt.toISOString(),
        })
      }
    }
    const noteFor = (r: LoadedDelivery) =>
      (r.customerEmail && refusedByEmail.get(r.customerEmail.toLowerCase())) ?? null

    const noTracking = unfiled.sort(byWaiting).slice(0, LATE_LIMIT).map((r) => ({ ...toRow(r), refusedParcel: noteFor(r) }))

    return NextResponse.json(
      {
        stats,
        late,
        lateTotal,
        noTracking,
        noTrackingTotal,
        unlinked: withCandidates.map((s) => ({
          trackingNumber: s.trackingNumber,
          carrier: carrierName(s.carrier),
          url: trackingUrl(s.trackingNumber, s.carrier),
          lastStatus: s.lastStatus,
          destinationCountry: s.destinationCountry,
          bookedAt: s.bookedAt?.toISOString() ?? null,
          weightKg: s.weightKg,
          recipientName: s.recipientName,
          reason: s.unlinkedReason,
          identifiedAt: s.identifiedAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
          candidates: s.candidates,
          candidatesTotal: s.total,
        })),
        unlinkedTotal,
        // For the manual link form: an order number means nothing without its shop.
        shops: shopRows,
        imports: imports.map((i) => ({ ...i, receivedAt: i.receivedAt.toISOString() })),
        trackedShops: shops.filter((s) => s.deliveryTrackingFrom !== null).length,
        // When the carrier was last asked about the moving parcels. Null means
        // never. Without it, a page whose figures are all still blank looks
        // exactly like one whose sync died three days ago.
        lastCheckedAt: config?.lastSyncAt?.toISOString() ?? null,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load delivery data' },
      { status: 500, headers: NO_STORE },
    )
  }
}
