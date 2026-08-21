import type { OrderDelivery } from './view'

export type CountryStat = {
  country: string
  delivered: number
  medianDays: number | null
  onTimeRate: number | null
}

export type DeliveryStats = {
  delivered: number
  medianDays: number | null
  medianWarehouseDays: number | null
  medianTransitDays: number | null
  /** Share of judged orders that arrived within their promise. Null if none. */
  onTimeRate: number | null
  /** Delivered orders that HAD a promise to be judged against. */
  judged: number
  /** Delivered but with no promise in force, so deliberately not rated. */
  unjudged: number
  lateNow: number
  noTracking: number
  /**
   * Orders with no parcel whose first warehouse file is not due yet.
   *
   * Counted apart from `noTracking`, never inside it: the warehouse exports
   * once a day at 18:00, so an order placed this morning having no tracking
   * number is the system working, not failing. Kept as its own figure rather
   * than dropped, because "Where everything is now" has to be able to account
   * for every order it was given.
   */
  notDue: number
  /**
   * Where the orders that have NOT arrived are sitting right now.
   *
   * Every other figure above describes deliveries that finished. On a workspace
   * that has just been switched on, all of them are legitimately null, and a
   * page built only from them cannot tell "nothing is set up" apart from
   * "everything is set up and thirty parcels are moving". These two counts are
   * what make that difference sayable.
   */
  booked: number
  inTransit: number
  /**
   * The two ways an order ends, counted apart — collected splits off from
   * `delivered`, it does not replace it.
   *
   * `delivered` is every order whose clock has stopped, and stays the
   * denominator for the median and the on-time rate: the clock stops when the
   * parcel reaches the pickup point, not when the customer walks to it.
   * "Where everything is now" asks a different question, and answering it with
   * `delivered` reported an uncollected parcel as delivered.
   *
   * They sum to `delivered` by construction, so the strip cannot count one
   * arrived order in two places.
   */
  collected: number
  readyForCollection: number
  /**
   * Arrived on the warehouse file's word, with no date from the carrier yet.
   *
   * Its own figure rather than a share of `delivered`, because `delivered` is
   * the population the median and the on-time rate are computed from and these
   * orders have no date to contribute to either. Counted all the same: the
   * parcel is with the customer, so leaving it out of the strip entirely would
   * lose an order that "Where everything is now" promised to account for.
   *
   * A number that stays high is worth reading as a fault — it means the poller
   * is not reaching those parcels, and the delivery median is being computed
   * from whatever it did reach.
   */
  deliveredUndated: number
  distribution: { days: number; count: number }[]
  byCountry: CountryStat[]
}

/**
 * The middle value. Null for nothing — never zero, which would read as
 * "delivered same day" on an empty page.
 *
 * Median rather than mean throughout: two parcels stuck in customs for a month
 * would drag a mean into fiction, and the headline figure has to describe the
 * ordinary order.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const rate = (delivered: OrderDelivery[]) => {
  const judged = delivered.filter((v) => v.promiseDays !== null)
  if (judged.length === 0) return null
  // Reuse deliveryFor's verdict rather than recomputing a worse one. `late`
  // already accounts for business days, the per-country promise and the shop's
  // timezone. Comparing raw calendar days against promiseDays here silently
  // disagreed with it: a Thursday order delivered Monday against a 3
  // business-day promise counted against this rate while being correctly
  // absent from the late list on the same page — the tile and the list
  // contradicting each other about the same order.
  //
  // `late`, not `lateNow`: an order that ARRIVED late must still count against
  // the rate. Only the live queue cares whether it has since turned up.
  return judged.filter((v) => !v.late).length / judged.length
}

/**
 * Roll up a page's worth of orders.
 *
 * `countries` is parallel to `views` rather than carried inside them: the view
 * is about one order's timeline, and pushing a reporting dimension into it
 * would make it the wrong shape for the Orders column, which needs no such
 * thing.
 */
export function deliveryStats(
  views: OrderDelivery[],
  countries: (string | null)[],
): DeliveryStats {
  const delivered = views.filter((v) => v.totalDays !== null)
  // Split out of `delivered` rather than filtered from `views` independently,
  // so the two can never drift from the total they are a split of.
  const collected = delivered.filter((v) => v.collectedAt !== null)

  const counts = new Map<number, number>()
  for (const v of delivered) counts.set(v.totalDays!, (counts.get(v.totalDays!) ?? 0) + 1)

  const byCountry = new Map<string, OrderDelivery[]>()
  views.forEach((v, i) => {
    if (v.totalDays === null) return
    // Never dropped. An order whose country we failed to capture is still an
    // order that took some number of days, and hiding it would quietly shrink
    // every total on the page.
    const key = (countries[i] ?? '').trim().toUpperCase() || 'Unknown'
    byCountry.set(key, [...(byCountry.get(key) ?? []), v])
  })

  return {
    delivered: delivered.length,
    medianDays: median(delivered.map((v) => v.totalDays!)),
    medianWarehouseDays: median(
      delivered.filter((v) => v.warehouseDays !== null).map((v) => v.warehouseDays!),
    ),
    medianTransitDays: median(
      delivered.filter((v) => v.transitDays !== null).map((v) => v.transitDays!),
    ),
    onTimeRate: rate(delivered),
    judged: delivered.filter((v) => v.promiseDays !== null).length,
    unjudged: delivered.filter((v) => v.promiseDays === null).length,
    // "Late RIGHT NOW" is the live queue: missed its promise, still not with
    // the customer, and HAS A PARCEL somebody can go and ask about. `late`
    // alone also covers orders that arrived late, which belong in the on-time
    // rate but not in a tile someone reads as a to-do list. A returned parcel
    // has no availableAt, so it correctly stays here.
    //
    // The parcel clause is the one that was missing. api/delivery/route.ts
    // splits the late rows in two — a parcel is chased with the carrier, a
    // missing file is chased with the warehouse — and this count was never
    // told. Live on 2026-08-19 the tile read 155 against a list of 8, and the
    // 147-row difference was orders with no tracking number at all: unchasable
    // by the tile's own definition of itself, and asserting a lateness that a
    // missing file is no evidence of. They keep their own section and their
    // own count; what they lose is a claim on this one.
    lateNow: views.filter((v) => v.late && v.availableAt === null && v.parcels.length > 0).length,
    noTracking: views.filter((v) => v.state === 'NO_TRACKING').length,
    notDue: views.filter((v) => v.state === 'NOT_DUE').length,
    // Booked is the warehouse still holding it; in transit is the carrier
    // moving it. Counted from the same `state` the Late list and the Orders
    // column already badge, so the strip can never disagree with the rows.
    booked: views.filter((v) => v.state === 'BOOKED').length,
    inTransit: views.filter((v) => v.state === 'IN_TRANSIT').length,
    collected: collected.length,
    readyForCollection: delivered.length - collected.length,
    deliveredUndated: views.filter((v) => v.state === 'DELIVERED_UNDATED').length,
    distribution: [...counts.entries()]
      .map(([days, count]) => ({ days, count }))
      .sort((a, b) => a.days - b.days),
    byCountry: [...byCountry.entries()]
      .map(([country, list]) => ({
        country,
        delivered: list.length,
        medianDays: median(list.map((v) => v.totalDays!)),
        onTimeRate: rate(list),
      }))
      .sort((a, b) => b.delivered - a.delivered),
  }
}
