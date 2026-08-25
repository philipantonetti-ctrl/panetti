/**
 * What the advisor knows, before any model sees it.
 *
 * A fact is a COMPUTED COMPARISON, not an observation: every one of these came
 * out of the same engine the Dashboard uses, over two windows. The model is
 * given these and asked only to rank and explain them - it never derives a
 * figure of its own, because a confident wrong number is the one thing this
 * product must never ship.
 */

export type FactKind =
  | 'REVENUE_MOVE'
  | 'PROFIT_MOVE'
  | 'MARGIN_MOVE'
  | 'ROAS_MOVE'
  | 'SPEND_VS_BUDGET'
  | 'DELIVERY_DAYS_MOVE'
  | 'ON_TIME_MOVE'
  | 'LATE_NOW'
  | 'PRODUCT_RATE_MOVE'
  | 'B2B_QUIET'
  | 'AMBASSADOR_MOVE'
  | 'REORDER_DUE'
  | 'UNCOSTED_PRODUCTS'
  | 'SHOP_SYNC_FAILING'
  | 'MISSING_FX'

/** How the interface should print `current` and `previous`. */
export type FactUnit = 'money' | 'ratio' | 'days' | 'count' | 'percent'

export type Fact = {
  /** Stable within one briefing, e.g. "roas:shop_abc". The model cites these. */
  id: string
  kind: FactKind
  shopId: string | null
  shopName: string | null
  /** The subject when it is not a whole shop: a product, a country, a customer. */
  subject: string | null
  /** Now and before. Minor units when `unit` is 'money'. */
  current: number | null
  previous: number | null
  /** Fractional change. Null when the previous value was zero - growing from
   *  nothing is not a percentage, the same call `deltaPct` already makes. */
  deltaPct: number | null
  unit: FactUnit
  /** 0..1, by rule. Decides which facts are sent and in what order. */
  severity: number
  /** The display currency of `current`/`previous` when `unit` is 'money'. */
  currency?: string
}

/**
 * Facts about whether a number can be TRUSTED rather than how big it is.
 * They bypass the materiality gates and are always sent: "profit is overstated
 * because three products have no cost" matters at any size.
 */
export const QUALITY_KINDS: readonly FactKind[] = [
  'UNCOSTED_PRODUCTS',
  'SHOP_SYNC_FAILING',
  'MISSING_FX',
]

export function isQuality(fact: Fact): boolean {
  return QUALITY_KINDS.includes(fact.kind)
}
