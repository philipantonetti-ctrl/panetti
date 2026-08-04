import { utcDay } from '../dates'
import { zonedDayStr } from '../tz'
import { pct, sum } from '../money'
import { costOn } from './costs'
import { expenseInRange } from './expenses'
import { convert, crossConvert } from './fx'
import {
  EXCLUDED_STATUSES,
  ZERO_FIGURES,
  type CostBook,
  type EngineAdSpend,
  type EngineExpense,
  type EngineOrder,
  type EngineResult,
  type EngineShop,
  type Figures,
  type RateTable,
  type ShopFigures,
} from './types'

export type FulfillmentPoint = { perOrder: number; effectiveFrom: Date }
export type ProcessingFeeRule = { percent: number; fixedMinor: number; currency: string }

export type MetricsInput = {
  shops: EngineShop[]
  orders: EngineOrder[]
  expenses: EngineExpense[]
  costs: CostBook
  rates: RateTable
  displayCurrency: string
  from: Date
  to: Date
  /** shopId -> that shop's fulfillment rate history (any order). */
  fulfillmentRates?: Map<string, FulfillmentPoint[]>
  /** The one global gateway fee, or null when none is configured. */
  processingFee?: ProcessingFeeRule | null
  /**
   * One row per ad account per day. Absent means no ads ran (or the caller does
   * not care), which makes marketing 0 and leaves net profit exactly as it was.
   */
  adSpend?: EngineAdSpend[]
  /** Workspace timezone for day boundaries. Defaults to UTC. */
  timezone?: string
  /** Per-shop overrides: a shop's orders bucket days in ITS zone. */
  shopTimezones?: Map<string, string>
}

/** The newest rate that was already in force on `date`; 0 before the first one. */
export function fulfillmentOn(points: FulfillmentPoint[], date: Date): number {
  let chosen = 0
  let best = -Infinity
  for (const p of points) {
    const t = p.effectiveFrom.getTime()
    if (t <= date.getTime() && t > best) {
      best = t
      chosen = p.perOrder
    }
  }
  return chosen
}

/**
 * Ad spend is dated by plain UTC day, the way the platforms report it — unlike
 * an order, which belongs to its shop's own calendar day.
 */
function spendInRange(date: Date, from: Date, to: Date): boolean {
  const d = utcDay(date).getTime()
  return d >= utcDay(from).getTime() && d <= utcDay(to).getTime()
}

/** An order that contributes nothing — voided (refunded, cancelled, failed) or not yet paid. */
function counts(order: EngineOrder): boolean {
  return !EXCLUDED_STATUSES.includes(order.status.toLowerCase() as never)
}

/** Membership by CALENDAR DAY in the workspace timezone (from/to name calendar days). */
function inRange(order: EngineOrder, from: Date, to: Date, tz: string): boolean {
  const day = zonedDayStr(order.placedAt, tz)
  return day >= utcDay(from).toISOString().slice(0, 10) && day <= utcDay(to).toISOString().slice(0, 10)
}

/**
 * THE function. Every number on every screen comes from here.
 *
 *   net sales    = gross sales - discounts          (excl VAT — VAT is never revenue)
 *   net revenue  = net sales + shipping charged
 *   cogs         = qty x (cost + handling), at the cost in effect ON THE ORDER'S DATE
 *   commission   = rate x net sales, for attributed orders only
 *   fulfillment  = fixed per-order cost, at the rate in force on the order's day
 *   fees         = gateway % of the charged total + fixed part, per order
 *   marketing    = Meta + Google spend, at each day's own rate
 *   net profit   = net revenue - cogs - fulfillment - fees - marketing - operational expenses - commission
 *
 * Money arrives in each shop's own currency and is converted to `displayCurrency`
 * using the rate from the order's own date, so history never shifts.
 */
export function computeMetrics(input: MetricsInput): EngineResult {
  const { shops, orders, expenses, costs, rates, displayCurrency, from, to } = input

  const tz = input.timezone ?? 'UTC'
  const tzFor = (shopId: string) => input.shopTimezones?.get(shopId) ?? tz
  const live = orders.filter((o) => counts(o) && inRange(o, from, to, tzFor(o.shopId)))

  // Grouped once, not per shop per day: dailySeries calls this function for
  // every day in the range over these same rows, so a filter nested inside the
  // shop loop is shops x rows x days of work for one number.
  const spendByShop = new Map<string, EngineAdSpend[]>()
  for (const row of input.adSpend ?? []) {
    const list = spendByShop.get(row.shopId)
    if (list) list.push(row)
    else spendByShop.set(row.shopId, [row])
  }

  const byShop: ShopFigures[] = shops.map((shop) => {
    const shopOrders = live.filter((o) => o.shopId === shop.id)

    // Convert an amount from this order's currency into the display currency,
    // at the rate that applied on the day the order was placed.
    const conv = (amount: number, order: EngineOrder) =>
      convert(amount, order.currency, order.placedAt, displayCurrency, rates)

    // Product costs and fulfillment rates are held in the SHOP's currency,
    // which a B2B order invoiced in another currency does not share.
    const convCost = (amount: number, order: EngineOrder) =>
      convert(amount, order.costCurrency, order.placedAt, displayCurrency, rates)

    const grossSales = sum(shopOrders.map((o) => conv(o.grossSales, o)))
    const discounts = sum(shopOrders.map((o) => conv(o.discountTotal, o)))
    const netSales = sum(shopOrders.map((o) => conv(o.netSales, o)))
    const shippingCharged = sum(shopOrders.map((o) => conv(o.shippingCharged, o)))
    const taxes = sum(shopOrders.map((o) => conv(o.taxTotal, o)))

    // Fulfillment: what this order actually cost to ship when it says so — a
    // hand-entered B2B order does — otherwise the shop's rate on its day.
    const ratesForShop = input.fulfillmentRates?.get(shop.id) ?? []
    const fulfillment = sum(
      shopOrders.map((o) =>
        convCost(o.fulfillmentCost ?? fulfillmentOn(ratesForShop, o.placedAt), o),
      ),
    )

    // Gateway fee: % of the CHARGED total (incl. VAT — that is what the gateway
    // takes its cut of) plus a fixed part crossing from the fee's own currency.
    const fee = input.processingFee
    const transactionFees = !fee
      ? 0
      : sum(
          shopOrders
            // An invoiced order never went through the gateway, so the gateway
            // took nothing. Charging it anyway quietly shaves profit off every one.
            .filter((o) => o.chargesGatewayFee !== false)
            .map((o) => {
              const pctPart = Math.round((o.total * fee.percent) / 100)
              const fixedPart = crossConvert(fee.fixedMinor, fee.currency, o.currency, o.placedAt, rates)
              return conv(pctPart + fixedPart, o)
            }),
        )

    // Ad spend converts at ITS OWN day's rate, exactly as an order does, so a
    // rate move never rewrites last month's marketing cost. crossConvert, not
    // convert, because an account can bill in a currency that is neither the
    // shop's nor USD — and because buildMarketing converts the same rows the
    // same way, which is what keeps this page and the Marketing page agreeing.
    const marketing = sum(
      (spendByShop.get(shop.id) ?? [])
        .filter((r) => spendInRange(r.date, from, to))
        .map((r) => crossConvert(r.spend, r.currency, displayCurrency, r.date, rates)),
    )
    const netRevenue = netSales + shippingCharged

    const cogs = sum(
      shopOrders.map((order) =>
        sum(
          order.items.map((item) => {
            const cost = costOn(costs.get(item.productId) ?? [], order.placedAt)
            const line = item.quantity * (cost.costPerItem + cost.handlingCost)
            return convCost(line, order)
          }),
        ),
      ),
    )

    // Commission is a percentage of NET SALES — after discount, before shipping, excl VAT.
    const commission = sum(
      shopOrders.map((o) => (o.ambassadorId ? conv(pct(o.netSales, o.commissionRate), o) : 0)),
    )
    const ambassadorSales = sum(shopOrders.map((o) => (o.ambassadorId ? conv(o.netSales, o) : 0)))

    // Expenses are dated by day, not by order, so they convert at the range's start.
    const operationalExpenses = sum(
      expenses
        .filter((e) => e.shopId === shop.id)
        .map((e) => convert(expenseInRange(e, from, to), e.currency, from, displayCurrency, rates)),
    )

    const netProfit =
      netRevenue - cogs - fulfillment - transactionFees - marketing - operationalExpenses - commission

    return {
      shopId: shop.id,
      shopName: shop.name,
      orders: shopOrders.length,
      grossSales,
      discounts,
      netSales,
      shippingCharged,
      taxes,
      netRevenue,
      // What the customer actually paid: net revenue plus the VAT collected.
      grossRevenue: netRevenue + taxes,
      cogs,
      marketing,
      fulfillment,
      transactionFees,
      operationalExpenses,
      commission,
      netProfit,
      netMargin: netRevenue === 0 ? 0 : netProfit / netRevenue,
      avgOrderValue: shopOrders.length === 0 ? 0 : Math.round(netRevenue / shopOrders.length),
      ambassadorSales,
    }
  })

  return { displayCurrency, byShop, total: totalOf(byShop) }
}

/** Add the shop rows up. Ratios are recomputed from the totals, never averaged. */
function totalOf(rows: ShopFigures[]): Figures {
  if (rows.length === 0) return { ...ZERO_FIGURES }

  const add = (pick: (r: ShopFigures) => number) => sum(rows.map(pick))

  const netRevenue = add((r) => r.netRevenue)
  const netProfit = add((r) => r.netProfit)
  const orders = add((r) => r.orders)

  return {
    orders,
    grossSales: add((r) => r.grossSales),
    discounts: add((r) => r.discounts),
    netSales: add((r) => r.netSales),
    shippingCharged: add((r) => r.shippingCharged),
    taxes: add((r) => r.taxes),
    fulfillment: add((r) => r.fulfillment),
    transactionFees: add((r) => r.transactionFees),
    netRevenue,
    grossRevenue: add((r) => r.grossRevenue),
    cogs: add((r) => r.cogs),
    marketing: add((r) => r.marketing),
    operationalExpenses: add((r) => r.operationalExpenses),
    commission: add((r) => r.commission),
    netProfit,
    netMargin: netRevenue === 0 ? 0 : netProfit / netRevenue,
    avgOrderValue: orders === 0 ? 0 : Math.round(netRevenue / orders),
    ambassadorSales: add((r) => r.ambassadorSales),
  }
}
