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
 * mirrored into each store. So the job is not to sum them — that would multiply
 * the warehouse by five — but to agree on what the one number is.
 *
 * The most common value wins, because a mirror that has drifted is outvoted by
 * the ones that have not. On 2026-08-13 that was exactly the situation: four
 * shops said 906 and Germany said 939.
 *
 * `disagrees` is the point of the function as much as `quantity` is. A drifting
 * mirror is invisible by nature — each store looks perfectly consistent on its
 * own — so the disagreement has to be said out loud.
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
