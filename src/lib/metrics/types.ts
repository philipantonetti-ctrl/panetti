/**
 * The engine's own view of the world. Deliberately NOT the Prisma types —
 * the engine must not care where the data came from.
 * All money is INTEGER MINOR UNITS in the currency named alongside it.
 */

export type Recurrence = 'ONE_TIME' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/** Dead ends: the order earns nothing, ever. */
export const VOIDED_STATUSES = ['refunded', 'cancelled', 'failed', 'trash'] as const

/**
 * Not paid yet. Woo's `pending` means no payment received; `on-hold` means
 * payment awaited (bank transfer and the like). The webhook flips them to
 * `processing` the moment payment lands — and only from that moment do they
 * count. Money that has not arrived is not revenue.
 */
export const UNPAID_STATUSES = ['pending', 'on-hold'] as const

/** Statuses that contribute nothing to any money figure: no revenue, no commission. */
export const EXCLUDED_STATUSES = [...VOIDED_STATUSES, ...UNPAID_STATUSES] as const

export type CostPoint = {
  costPerItem: number
  handlingCost: number
  effectiveFrom: Date
}

export type EngineOrderItem = {
  productId: string
  quantity: number
  lineNetTotal: number // after discount, excl VAT
}

export type EngineOrder = {
  id: string
  shopId: string
  placedAt: Date
  status: string
  /**
   * When this order was voided, if we saw it happen. The order then counts
   * positively on `placedAt` and negatively here. Absent on a voided order
   * means we never learned the date, and it counts nowhere at all.
   */
  voidedAt?: Date | null
  currency: string
  /**
   * The currency this order's PRODUCT COSTS and FULFILLMENT RATE are held in —
   * its shop's. Usually the same as `currency`, and deliberately required
   * rather than defaulted: a B2B order can be invoiced in EUR while the shop's
   * costs stay in NOK, and silently reading one as the other is a tenfold
   * error in COGS. The compiler should make every caller say which it means.
   */
  costCurrency: string
  grossSales: number
  discountTotal: number
  netSales: number // THE commission base
  shippingCharged: number
  taxTotal: number
  total: number // what the customer was charged, incl VAT — the gateway-fee base
  ambassadorId: string | null
  commissionRate: number // e.g. 0.10; 0 when unattributed
  /**
   * What shipping this order actually cost us, in `costCurrency`. Absent or
   * null = an ordinary webshop order, which is charged the shop's standing
   * per-order rate instead.
   */
  fulfillmentCost?: number | null
  /**
   * Does the payment gateway take a cut? Absent = yes, which is every order
   * that arrived through a checkout. False for an invoiced B2B order.
   */
  chargesGatewayFee?: boolean
  items: EngineOrderItem[]
}

export type EngineExpense = {
  id: string
  shopId: string
  amount: number
  currency: string
  recurrence: Recurrence
  startDate: Date
  endDate: Date | null
  active: boolean
}

export type EngineShop = {
  id: string
  name: string
  currency: string
}

/** productId -> its full cost history */
export type CostBook = Map<string, CostPoint[]>

/** date (yyyy-mm-dd) -> currency -> rate to 1 unit of the display currency */
export type RateTable = Map<string, Map<string, number>>

/** Every figure below is in the DISPLAY currency, in minor units. */
export type Figures = {
  orders: number
  grossSales: number
  discounts: number
  netSales: number
  shippingCharged: number
  taxes: number // VAT collected — reported, never revenue and never a cost
  fulfillment: number // per-order fulfillment cost at the rate in effect that day
  transactionFees: number // payment gateway: % of charged total + fixed part
  netRevenue: number
  grossRevenue: number // net revenue + VAT = what customers actually paid (Nordic "brutto")
  cogs: number // product cost + handling combined
  operationalExpenses: number
  commission: number
  netProfit: number
  netMargin: number // 0.24 = 24%; 0 when there is no revenue
  avgOrderValue: number
  ambassadorSales: number // netSales of attributed orders only
}

export type ShopFigures = Figures & { shopId: string; shopName: string }

export type EngineResult = {
  displayCurrency: string
  byShop: ShopFigures[]
  total: Figures
}

export const ZERO_FIGURES: Figures = {
  orders: 0,
  grossSales: 0,
  discounts: 0,
  netSales: 0,
  shippingCharged: 0,
  taxes: 0,
  fulfillment: 0,
  transactionFees: 0,
  netRevenue: 0,
  grossRevenue: 0,
  cogs: 0,
  operationalExpenses: 0,
  commission: 0,
  netProfit: 0,
  netMargin: 0,
  avgOrderValue: 0,
  ambassadorSales: 0,
}
