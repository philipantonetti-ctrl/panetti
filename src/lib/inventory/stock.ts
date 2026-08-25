export type ShopStock = {
  shopName: string
  /** Null = this store does not manage stock for the item. */
  quantity: number | null
  updatedAt: Date | null
}

export type AgreedStock = {
  /** Null = no shop reported a figure. Deliberately not zero. */
  quantity: number | null
  /** True when the shops report more than one distinct figure. */
  disagrees: boolean
  byShop: ShopStock[]
}

/**
 * One stock figure from up to nine mirrors of it.
 *
 * The shops are not nine warehouses. Denmark, Finland, Norway and Sweden carry
 * IDENTICAL quantities for the same SKU, which is one physical warehouse
 * mirrored into each store. So the job is not to sum them - that would multiply
 * the warehouse by five - but to agree on what the one number is.
 *
 * The most common value wins, because a mirror that has drifted is outvoted by
 * the ones that have not. On 2026-08-13 that was exactly the situation: four
 * shops said 906 and Germany said 939.
 *
 * `disagrees` is the point of the function as much as `quantity` is. A drifting
 * mirror is invisible by nature - each store looks perfectly consistent on its
 * own - so the disagreement has to be said out loud.
 */
export function agreeStock(rows: ShopStock[]): AgreedStock {
  const known = rows.filter((r) => r.quantity !== null)
  if (known.length === 0) return { quantity: null, disagrees: false, byShop: rows }

  const counts = new Map<number, { n: number; freshest: number }>()
  for (const r of known) {
    const at = r.updatedAt?.getTime() ?? 0
    const seen = counts.get(r.quantity!)
    if (seen) {
      seen.n++
      seen.freshest = Math.max(seen.freshest, at)
    } else {
      counts.set(r.quantity!, { n: 1, freshest: at })
    }
  }

  // Most common; a tie goes to the freshest reading rather than to whichever
  // shop happened to be first in the list.
  let best = -1
  let bestOf = { n: 0, freshest: -1 }
  for (const [value, tally] of counts) {
    if (tally.n > bestOf.n || (tally.n === bestOf.n && tally.freshest > bestOf.freshest)) {
      best = value
      bestOf = tally
    }
  }

  return { quantity: best, disagrees: counts.size > 1, byShop: rows }
}

/** Where the number on the page actually came from. */
export type StockSource = 'visma' | 'shops' | 'none'

/** What Visma counted, in the warehouses we sell from. */
export type VismaReading = {
  quantity: number
  /** When Visma last moved that warehouse row, not when we read it. */
  measuredAt: Date | null
}

export type ResolvedStock = AgreedStock & {
  source: StockSource
  /** Visma's reading, kept even when it decided the number, so the gap shows. */
  visma: VismaReading | null
}

/**
 * One stock figure, from the source that is entitled to give it.
 *
 * Visma is the ERP the warehouse works in. The shops are copies of it, and
 * `agreeStock` exists only because copies drift - a vote is what you do when
 * nobody is authoritative. So Visma wins outright wherever it has the SKU, and
 * the vote is left to settle the ones it does not.
 *
 * Measured on 2026-08-18: of the 52 SKUs the forecast covers, the shops and
 * Visma disagreed on 12. The gaps are small on the big sellers (976 against 991
 * on Pizzetta Pro) and proportionally large on parts (5 against 13 on the
 * Mazzetti Pro mainline), and ten SKUs had no shop figure at all.
 *
 * `disagrees` keeps its own meaning either way: it is the SHOPS disagreeing
 * among themselves, which is worth saying whoever settled the number, because
 * it means a storefront is quoting customers a figure the warehouse never had.
 */
export function resolveStock(visma: VismaReading | null, rows: ShopStock[]): ResolvedStock {
  const agreed = agreeStock(rows)

  // `visma !== null`, never a truthiness check: a sold-out product reads zero,
  // zero is falsy, and falling through on it would quietly hand the forecast a
  // stale shop figure for exactly the product that most needs reordering.
  if (visma !== null) return { ...agreed, quantity: visma.quantity, source: 'visma', visma }

  return { ...agreed, source: agreed.quantity === null ? 'none' : 'shops', visma: null }
}
