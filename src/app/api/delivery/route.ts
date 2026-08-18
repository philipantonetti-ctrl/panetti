import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { loadDelivery, type LoadedDelivery } from '@/lib/delivery/load'
import { deliveryStats } from '@/lib/delivery/stats'
import { carrierName, trackingUrl } from '@/lib/delivery/tracking-url'

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
 * import are both invisible by nature — the page simply shows fewer orders and
 * looks like a quiet week — so both are counted out loud.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const shops = await db.shop.findMany({
      where: { active: true, ...(shopIds?.length ? { id: { in: shopIds } } : {}) },
      select: { id: true, deliveryTrackingFrom: true },
    })

    const { rows } = await loadDelivery(
      shops.map((s) => s.id),
      zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
      zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
    )

    const stats = deliveryStats(
      rows.map((r) => r.view),
      rows.map((r) => r.order.shippingCountry),
    )

    // The true totals, not the capped array lengths. Both lists are capped for
    // the payload's sake, and a heading that reports the cap is a wrong number
    // exactly when the situation is worst — 300 unlinked parcels would read as
    // "50", on the one section whose whole job is to make a linking outage
    // visible.
    const lateMatching = rows.filter((r) => r.view.late)

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
     * ~114 asserted a lateness the data cannot support — a missing file is not
     * evidence of a missed promise.
     *
     * Split on the parcel rather than on state === 'NO_TRACKING': the parcel IS
     * the thing that makes a row actionable, so it should be the thing the
     * split reads.
     */
    const byUrgency = (a: LoadedDelivery, b: LoadedDelivery) =>
      (b.view.daysOver ?? 0) - (a.view.daysOver ?? 0)

    const toRow = (r: LoadedDelivery) => ({
      id: r.order.id,
      number: r.order.number,
      shop: r.order.shopName,
      country: r.order.shippingCountry || null,
      daysOver: r.view.daysOver ?? 0,
      promiseDays: r.view.promiseDays,
      state: r.view.state,
      parcels: r.view.parcels,
    })

    const chasable = lateMatching.filter((r) => r.view.parcels.length > 0)
    const unfiled = lateMatching.filter((r) => r.view.parcels.length === 0)

    const lateTotal = chasable.length
    const late = chasable.sort(byUrgency).slice(0, LATE_LIMIT).map(toRow)
    const awaitingFileTotal = unfiled.length
    const awaitingFile = unfiled.sort(byUrgency).slice(0, LATE_LIMIT).map(toRow)

    const [unlinked, unlinkedTotal, imports, config] = await Promise.all([
      db.shipment.findMany({
        where: { orderId: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        // carrier so an unlinked parcel links to whoever is actually holding
        // it. These come straight off the shipment rather than through
        // deliveryFor, which is why the URL is built here instead.
        select: { trackingNumber: true, carrier: true, lastStatus: true },
      }),
      db.shipment.count({ where: { orderId: null } }),
      db.trackingImport.findMany({
        orderBy: { receivedAt: 'desc' },
        take: 10,
        select: {
          id: true, filename: true, receivedAt: true,
          rowsParsed: true, rowsLinked: true, rowsUnmatched: true, error: true,
          // Both were written and neither was ever read. `unmatched` is the JSON
          // list of refusals with their stated reasons — without it the page
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

    return NextResponse.json(
      {
        stats,
        late,
        lateTotal,
        awaitingFile,
        awaitingFileTotal,
        // The link is built here, beside every other one, so the page never
        // has to know which carrier's site a number belongs to.
        unlinked: unlinked.map((s) => ({
          trackingNumber: s.trackingNumber,
          carrier: carrierName(s.carrier),
          url: trackingUrl(s.trackingNumber, s.carrier),
          lastStatus: s.lastStatus,
        })),
        unlinkedTotal,
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
