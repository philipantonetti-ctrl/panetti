/**
 * One cost, entered once, expressed in every webshop's own currency.
 *
 * `ProductCost` hangs off a `Product`, and `Product` is per shop
 * (`@@unique([shopId, externalId])`), so the same physical item carries a
 * separate cost row in each of the nine stores — each "minor units, shop
 * currency". That is why the costs page asks for the same figure nine times, and
 * the client's complaint about seeing one product per webshop is most literally
 * true there.
 *
 * The cost of a unit does not depend on which store sold it: one warehouse, one
 * supplier invoice. So it is entered once against the source shop and converted
 * outward from here.
 *
 * The FX lookup is injected rather than imported, so the arithmetic and — much
 * more importantly — the refusal can be tested without a rate table or a
 * database.
 */

import { mulRate } from './money'

export type SiblingProduct = {
  /** The `Product` row to write against. */
  id: string
  shopName: string
  currency: string
}

export type CostWrite = {
  productId: string
  /** Minor units, in that product's own shop currency. */
  costPerItem: number
  handlingCost: number
}

export type Spread = {
  writes: CostWrite[]
  /** Shops left untouched because no usable rate was available. */
  skipped: { shopName: string; currency: string }[]
}

export function spreadCost(input: {
  /** Currency the figures were entered in — the source shop's. */
  from: string
  /** Minor units, in `from`. */
  costPerItem: number
  handlingCost: number
  siblings: SiblingProduct[]
  /** One unit of `from` in `to`, or undefined when unknown. */
  factor: (from: string, to: string) => number | undefined
}): Spread {
  const writes: CostWrite[] = []
  const skipped: Spread['skipped'] = []

  for (const s of input.siblings) {
    const rate = input.factor(input.from, s.currency)

    // Skipped, never written through unconverted. A NOK figure stored as EUR is
    // an elevenfold error wearing the clothes of an ordinary number: nothing on
    // any page would look wrong, and every profit figure that product touches
    // would be wrong from then on. Better to write eight shops and say which one
    // was left.
    if (rate === undefined) {
      skipped.push({ shopName: s.shopName, currency: s.currency })
      continue
    }

    writes.push({
      productId: s.id,
      // mulRate returns whole minor units — a third of an øre cannot be stored,
      // and rounding here is the same rounding every other converted figure in
      // the system gets.
      costPerItem: rate === 1 ? input.costPerItem : mulRate(input.costPerItem, rate),
      handlingCost: rate === 1 ? input.handlingCost : mulRate(input.handlingCost, rate),
    })
  }

  return { writes, skipped }
}
