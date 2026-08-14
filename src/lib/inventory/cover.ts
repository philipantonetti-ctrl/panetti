/**
 * Turning a stock figure into something you can act on.
 *
 * Both of these are pure and take "now" as an argument rather than reading the
 * clock, so they can be tested without freezing time.
 */

const DAY = 86_400_000
const HOUR = 3_600_000

/**
 * Whole days until a product runs out.
 *
 * Derived from the forecast's own run-out date rather than dividing stock by
 * sales, deliberately. A fresh division would ignore the purchase orders on the
 * water and the seasonal rate, so the Stock page would quote a different number
 * from the Forecast page for the same product — and two figures that look like
 * they should agree but do not are worse than either alone.
 *
 * Null in, null out: no run-out date means there is nothing to count towards,
 * which the caller says in words instead.
 *
 * Never negative. A date already past means the stock is gone, and "-6 days
 * left" reads as a countdown that is somehow still running.
 */
export function daysLeft(runsOutOn: Date | null, today: Date): number | null {
  if (!runsOutOn) return null
  // Floored to UTC days on both sides, matching how forecast() normalises every
  // date it produces.
  const days = Math.floor(runsOutOn.getTime() / DAY) - Math.floor(today.getTime() / DAY)
  return Math.max(0, days)
}

/**
 * How old a stock reading is, in the shortest honest form.
 *
 * Worth showing because a figure nobody has refreshed for a week is a different
 * claim from one taken an hour ago, and the page cannot tell them apart today.
 *
 * A reading stamped slightly in the future is treated as current rather than
 * negative: shop clocks drift, and "-1h ago" would look like a bug.
 */
export function readAgo(updatedAt: Date | null, now: Date): string {
  if (!updatedAt) return 'never'
  const elapsed = Math.max(0, now.getTime() - updatedAt.getTime())
  if (elapsed < HOUR) return 'just now'
  const hours = Math.round(elapsed / HOUR)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
