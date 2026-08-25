import { isConvertible } from '../../currencies'
import type { Fact } from '../types'

/**
 * Facts about whether the other facts can be TRUSTED.
 *
 * These bypass the materiality gates on purpose. "Norway's profit is overstated
 * because three products have no cost on file" is worth saying at any size -
 * it is the product's own "say when you don't know" principle applied to the
 * briefing itself, and it is the difference between a wrong number the client
 * acts on and a gap he can close.
 */

/** Uncosted products at which the shop's profit figure is thoroughly unreliable. */
export const UNCOSTED_SATURATION = 5

/**
 * Which currencies in play have no exchange rate held.
 *
 * USD is the pivot every rate is stored against (`quote: 'USD'` throughout
 * src/lib/fx), so crossing NOK into SEK reads BOTH currencies' USD rates and
 * divides one by the other. A missing rate therefore breaks conversion
 * whatever the display currency is - which is why this cannot be gated on the
 * display currency being USD, as it once was. That gate silently switched the
 * warning off for every workspace that consolidates into anything else, and
 * this one consolidates into NOK.
 *
 * USD itself is never missing: it is the pivot, and its own rate is 1 by
 * definition. Nor is a currency the rate provider does not quote - an AED B2B
 * order can never gain a row, so reporting it would be a warning nobody can
 * ever clear. src/lib/fx/rates.ts makes the same exclusion for the same reason.
 */
export function missingRateCurrencies(args: {
  /** Every currency in play: the shops' own, plus the display currency. */
  inPlay: string[]
  /** Currency codes we hold a rate for in the window. */
  held: Set<string>
}): string[] {
  return [...new Set(args.inPlay)]
    .filter((c) => c !== 'USD' && isConvertible(c) && !args.held.has(c))
    .sort()
}

export type QualityFactsArgs = {
  uncostedByShop: { shopId: string; shopName: string; count: number }[]
  failingShops: { shopId: string; shopName: string; error: string }[]
  missingRates: string[]
}

export function qualityFacts(args: QualityFactsArgs): Fact[] {
  const facts: Fact[] = []

  for (const shop of args.uncostedByShop) {
    if (shop.count <= 0) continue
    facts.push({
      id: `uncosted:${shop.shopId}`,
      kind: 'UNCOSTED_PRODUCTS',
      shopId: shop.shopId,
      shopName: shop.shopName,
      subject: null,
      current: shop.count,
      previous: null,
      deltaPct: null,
      unit: 'count',
      severity: Math.min(shop.count / UNCOSTED_SATURATION, 1),
    })
  }

  for (const shop of args.failingShops) {
    facts.push({
      id: `sync-failing:${shop.shopId}`,
      kind: 'SHOP_SYNC_FAILING',
      shopId: shop.shopId,
      shopName: shop.shopName,
      // The reason IS the subject here: "Mazzetti Germany's sync is failing" is
      // half a sentence without it, and the client cannot act on half.
      subject: shop.error,
      current: null,
      previous: null,
      deltaPct: null,
      unit: 'count',
      // A frozen store means every figure it reports is stale. Nothing about
      // that is partial, so nothing about the severity is either.
      severity: 1,
    })
  }

  for (const currency of args.missingRates) {
    facts.push({
      id: `missing-fx:${currency}`,
      kind: 'MISSING_FX',
      shopId: null,
      shopName: null,
      subject: currency,
      current: null,
      previous: null,
      deltaPct: null,
      unit: 'count',
      severity: 1,
    })
  }

  return facts
}
