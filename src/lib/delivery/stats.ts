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
    // "Late RIGHT NOW" is the live queue: missed its promise AND still not with
    // the customer. `late` alone also covers orders that arrived late, which
    // belong in the on-time rate but not in a tile someone reads as a to-do
    // list. A returned parcel has no availableAt, so it correctly stays here.
    lateNow: views.filter((v) => v.late && v.availableAt === null).length,
    noTracking: views.filter((v) => v.state === 'NO_TRACKING').length,
    // Booked is the warehouse still holding it; in transit is the carrier
    // moving it. Counted from the same `state` the Late list and the Orders
    // column already badge, so the strip can never disagree with the rows.
    booked: views.filter((v) => v.state === 'BOOKED').length,
    inTransit: views.filter((v) => v.state === 'IN_TRANSIT').length,
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
