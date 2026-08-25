export type PromisePoint = {
  /** The shop this promise belongs to, or null for "every shop". */
  shopId: string | null
  /** ISO-2 destination country, or '*' for "every country". */
  country: string
  days: number
  businessDays: boolean
  effectiveFrom: Date
}

/** The fallback country code, used when no row names the destination. */
export const ANY_COUNTRY = '*'

/**
 * What we promised this order, at the moment it was placed.
 *
 * A promise has two dimensions, shop and country, and either can be "every".
 * Both are needed: Panetti and Mazzetti both ship to Norway and promise
 * different things, so country alone cannot express the real policy, and shop
 * alone cannot express that Norway is quicker than Germany.
 *
 * THE MOST SPECIFIC ROW WINS, not the newest. Four levels, in order:
 *
 *   1. this shop, this country     Panetti to Norway
 *   2. this shop, every country    Panetti everywhere else
 *   3. every shop, this country    anyone to Norway
 *   4. every shop, every country   the catch-all
 *
 * Specificity is checked before recency on purpose. If a newer all-shops row
 * could beat an older shop-specific one, a single blanket edit would silently
 * override every shop's own promise, which is exactly what this shape exists
 * to prevent. Recency only decides between rows at the SAME level, which is
 * what keeps last month's figures intact when a promise changes today - the
 * same rule costOn() and fulfillmentOn() already follow.
 *
 * Returns null when nothing is in force. Deliberately not "zero days": a zero
 * would make every order instantly late, which is the loudest possible way to
 * be wrong.
 */
export function promiseOn(
  points: PromisePoint[],
  shopId: string | null,
  country: string | null,
  at: Date,
): PromisePoint | null {
  const wanted = (country ?? '').trim().toUpperCase()

  // Within one level, the latest row that has already started wins.
  const pick = (shop: string | null, code: string) =>
    points
      .filter(
        (p) =>
          p.shopId === shop && p.country.toUpperCase() === code && p.effectiveFrom <= at,
      )
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null

  // An order with no country skips the two country levels rather than matching
  // a row literally named '', which no row ever is.
  const levels: (PromisePoint | null)[] = [
    shopId && wanted ? pick(shopId, wanted) : null,
    shopId ? pick(shopId, ANY_COUNTRY) : null,
    wanted ? pick(null, wanted) : null,
    pick(null, ANY_COUNTRY),
  ]

  return levels.find((p) => p !== null) ?? null
}
