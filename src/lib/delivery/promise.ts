export type PromisePoint = {
  country: string // ISO-2, or '*' for the fallback
  days: number
  businessDays: boolean
  effectiveFrom: Date
}

/** The fallback country code, used when no row names the destination. */
export const ANY_COUNTRY = '*'

/**
 * What we promised this order, at the moment it was placed.
 *
 * The latest row whose effectiveFrom is on or before the order date wins —
 * exactly the rule costOn() and fulfillmentOn() already implement, so a promise
 * edited today never rewrites last month's on-time rate.
 *
 * Returns null when nothing is in force. Deliberately not "zero days": a zero
 * would make every order instantly late, which is the loudest possible way to
 * be wrong.
 */
export function promiseOn(
  points: PromisePoint[],
  country: string | null,
  at: Date,
): PromisePoint | null {
  const wanted = (country ?? '').trim().toUpperCase()

  const pick = (code: string) =>
    points
      .filter((p) => p.country.toUpperCase() === code && p.effectiveFrom <= at)
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null

  return (wanted ? pick(wanted) : null) ?? pick(ANY_COUNTRY)
}
