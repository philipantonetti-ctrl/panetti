import type { ProductResult } from '../../metrics/products'
import { movingFact } from '../severity'
import type { Fact } from '../types'

/**
 * Which products moved, per shop.
 *
 * ONE CURRENCY GROUP AT A TIME. `loadProductsInput` refuses to add NOK and EUR
 * together — it throws MixedCurrencyError — so the collector calls it once per
 * group and calls this once per result. Nothing here converts anything.
 *
 * The materiality share is therefore built in two hops, neither of which needs
 * a rate:
 *
 *   (this product's move / this shop's own prior revenue)   <- group currency
 * x (this shop's prior revenue / the whole business's)      <- already USD
 * = this product's move as a share of total revenue
 */

export type ProductFactsArgs = {
  now: ProductResult
  before: ProductResult
  /** shopId -> name, for shops in this currency group. */
  shopNames: Map<string, string>
  /** shopId -> that shop's PREVIOUS window net revenue, in THIS group's currency. */
  shopBaselines: Map<string, number>
  /** shopId -> that shop's share of the whole business's previous revenue, 0..1. */
  shopShares: Map<string, number>
}

export function productFacts(args: ProductFactsArgs): Fact[] {
  const { now, before, shopNames, shopBaselines, shopShares } = args

  // key -> shopId -> that store's slice of the product, in the previous window.
  const priorByKey = new Map<string, Map<string, number>>()
  for (const row of before.rows) {
    priorByKey.set(row.key, new Map(row.stores.map((s) => [s.shopId, s.netSales])))
  }

  const facts: Fact[] = []

  for (const row of now.rows) {
    const prior = priorByKey.get(row.key)
    if (!prior) continue // a product with no history has nothing to compare

    for (const store of row.stores) {
      const previous = prior.get(store.shopId)
      if (previous === undefined) continue

      const shopBaseline = shopBaselines.get(store.shopId)
      const shopShare = shopShares.get(store.shopId)
      if (!shopBaseline || shopShare === undefined) continue

      // movingFact divides impact by baseline, so scaling the baseline UP by
      // the reciprocal of the shop's share is the same arithmetic as scaling
      // the share down — done here so movingFact keeps one meaning of baseline.
      const scaledBaseline = shopShare > 0 ? shopBaseline / shopShare : 0

      const fact = movingFact({
        id: `product:${store.shopId}:${row.key}`,
        kind: 'PRODUCT_RATE_MOVE',
        shopId: store.shopId,
        shopName: shopNames.get(store.shopId) ?? store.shopName,
        subject: row.name,
        current: store.netSales,
        previous,
        unit: 'money',
        currency: now.displayCurrency,
        impact: store.netSales - previous,
        baseline: scaledBaseline,
      })
      if (fact) facts.push(fact)
    }
  }

  return facts
}
