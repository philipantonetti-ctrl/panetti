/**
 * What an order cost us to ship, worked out per unit from its SKUs.
 *
 * A flat `FulfillmentRate` per order says an order of fifty pizza ovens ships
 * for what one oven ships for, which is the client's complaint in one line:
 * "maybe its easier if we just add an average unit cost we pay per shipping
 * depending on the supplier ... it also calculate the shipping cost we had to
 * pay based on the SKU and quantity the customer bought".
 *
 * Keyed by SKU, not by product, for the reason `sources.ts` and `SupplyItem`
 * are: `Product` is shop-scoped, so one physical object is up to nine rows, and
 * a shipping cost belongs to the object rather than to a Norwegian listing of
 * it.
 *
 * Pure and database-free on purpose — this is the one place that decides what an
 * order's shipping cost was, and both callers (the orders list and the metrics
 * engine) must get the identical answer or the two screens disagree about the
 * same order's profit.
 */

import { normaliseSku } from './sku'

export type ShippingPoint = { perUnit: number; currency: string; effectiveFrom: Date }
export type CostedLine = { sku: string; quantity: number }

/**
 * The rate in force on `date`, or null when no rate covers it.
 *
 * The newest `effectiveFrom` at or before the date wins, and a tie is broken by
 * the first row given — the same two rules `fulfillmentOn` in metrics/engine.ts
 * has always used, deliberately copied rather than improved on. These two
 * functions answer the same question about the same order, so any difference
 * between them is a difference in what an order cost.
 *
 * null, not a zero rate: "nobody has costed this SKU yet" and "shipping this SKU
 * is free" are different facts, and only the caller can decide what to do about
 * the first one.
 */
export function shippingRateOn(points: ShippingPoint[], date: Date): ShippingPoint | null {
  let chosen: ShippingPoint | null = null
  let best = -Infinity
  for (const p of points) {
    const t = p.effectiveFrom.getTime()
    if (t <= date.getTime() && t > best) {
      best = t
      chosen = p
    }
  }
  return chosen
}

/**
 * What the lines cost to ship, or null when NO line has a rate — which means
 * "unknown", and the caller falls back to the per-order figure.
 *
 * **null is not 0, and the difference is the whole point of this return type.**
 * 0 asserts that shipping this order was free, which would silently overstate
 * its profit and, worse, would do so for every order ever placed the moment this
 * shipped — there is real trading history in these numbers. null asserts nothing
 * at all, so the caller keeps the flat `FulfillmentRate` figure it has always
 * used and an installation with no SKU rates behaves exactly as it did before.
 * That is what makes this change safe to deploy before a single rate is typed.
 *
 * A line whose SKU has no rate contributes 0 while the others still count:
 * partial knowledge about an order is better than none, and the alternative —
 * discarding the whole order's per-SKU cost because one item is uncosted — would
 * make the feature useless until the very last SKU had been entered. The "no
 * line at all" case above is what stops that leniency from becoming a lie.
 *
 * `ratesBySku` must be keyed by `normaliseSku`, and every point in it must be
 * held in ONE currency — see `ratesInCurrency`.
 */
export function shippingCostOf(
  lines: CostedLine[],
  ratesBySku: Map<string, ShippingPoint[]>,
  date: Date,
): number | null {
  let total = 0
  let known = false
  for (const line of lines) {
    const rate = shippingRateOn(ratesBySku.get(normaliseSku(line.sku)) ?? [], date)
    if (!rate) continue
    known = true
    total += rate.perUnit * line.quantity
  }
  return known ? total : null
}

/**
 * The rates held in `currency`, keyed as they came in.
 *
 * A `ShippingRate` is keyed by SKU, and a SKU is not shop-scoped, so unlike
 * `FulfillmentRate.perOrder` there is no shop currency for it to inherit — the
 * row has to name its own. `shippingCostOf` then sums bare integers, so it can
 * only ever be handed one currency's worth of them; this is how a caller picks
 * which.
 *
 * Rates in any other currency are dropped rather than converted. Converting
 * would mean guessing an exchange rate for a figure someone typed against a
 * named currency, and reading a 900 EUR rate as 900 NOK is an elevenfold cost
 * error entered in good faith — the same failure the costs page avoids by
 * refusing to label a combined input when the source shops disagree about
 * currency. Dropping is visible (the flat per-order rate keeps applying and
 * profit does not move); guessing is not.
 */
export function ratesInCurrency(
  ratesBySku: Map<string, ShippingPoint[]>,
  currency: string,
): Map<string, ShippingPoint[]> {
  const kept = new Map<string, ShippingPoint[]>()
  for (const [sku, points] of ratesBySku) {
    const matching = points.filter((p) => p.currency === currency)
    if (matching.length > 0) kept.set(sku, matching)
  }
  return kept
}
