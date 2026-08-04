import { utcDay } from '../dates'
import { zonedDayStr } from '../tz'
import { pct, sum } from '../money'
import { costOn } from './costs'
import { expenseInRange } from './expenses'
import { convert, crossConvert } from './fx'
import {
  UNPAID_STATUSES,
  VOIDED_STATUSES,
  ZERO_FIGURES,
  type CostBook,
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

/** Membership by CALENDAR DAY in the workspace timezone (from/to name calendar days). */
function inRange(when: Date, from: Date, to: Date, tz: string): boolean {
  const day = zonedDayStr(when, tz)
  return day >= utcDay(from).toISOString().slice(0, 10) && day <= utcDay(to).toISOString().slice(0, 10)
}

/**
 * An order as the period sees it. A sale is one entry at +1. A refund is TWO:
 * the original sale still stands on the day it happened, and the whole order
 * comes back off on the day the money did. Every figure below is multiplied by
 * `sign`, so the reversal is the same arithmetic rather than a second set of
 * rules that could drift from it.
 */
type Entry = { order: EngineOrder; sign: 1 | -1 }

function entriesIn(orders: EngineOrder[], from: Date, to: Date, tzFor: (id: string) => string): Entry[] {
  const out: Entry[] = []

  for (const order of orders) {
    const status = order.status.toLowerCase()
    // Not paid yet is not the same as paid and given back: an unpaid order
    // simply does not count until it is paid, and never reverses.
    if (UNPAID_STATUSES.includes(status as never)) continue

    const tz = tzFor(order.shopId)

    if (!VOIDED_STATUSES.includes(status as never)) {
      if (inRange(order.placedAt, from, to, tz)) out.push({ order, sign: 1 })
      continue
    }

    // Voided but we never learned when — leave every existing figure alone.
    if (!order.voidedAt) continue

    if (inRange(order.placedAt, from, to, tz)) out.push({ order, sign: 1 })
    if (inRange(order.voidedAt, from, to, tz)) out.push({ order, sign: -1 })
  }

  return out
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
 *   net profit   = net revenue - cogs - fulfillment - fees - operational expenses - commission
 *
 * Money arrives in each shop's own currency and is converted to `displayCurrency`
 * using the rate from the order's own date, so history never shifts.
 */
export function computeMetrics(input: MetricsInput): EngineResult {
  const { shops, orders, expenses, costs, rates, displayCurrency, from, to } = input

  const tz = input.timezone ?? 'UTC'
  const tzFor = (shopId: string) => input.shopTimezones?.get(shopId) ?? tz
  const live = entriesIn(orders, from, to, tzFor)

  const byShop: ShopFigures[] = shops.map((shop) => {
    const shopOrders = live.filter((e) => e.order.shopId === shop.id)

    // Convert an amount from this order's currency into the display currency,
    // at the rate that applied on the day the order was placed.
    const conv = (amount: number, order: EngineOrder) =>
      convert(amount, order.currency, order.placedAt, displayCurrency, rates)

    // Product costs and fulfillment rates are held in the SHOP's currency,
    // which a B2B order invoiced in another currency does not share.
    const convCost = (amount: number, order: EngineOrder) =>
      convert(amount, order.costCurrency, order.placedAt, displayCurrency, rates)

    const grossSales = sum(shopOrders.map((e) => e.sign * conv(e.order.grossSales, e.order)))
    const discounts = sum(shopOrders.map((e) => e.sign * conv(e.order.discountTotal, e.order)))
    const netSales = sum(shopOrders.map((e) => e.sign * conv(e.order.netSales, e.order)))
    const shippingCharged = sum(shopOrders.map((e) => e.sign * conv(e.order.shippingCharged, e.order)))
    const taxes = sum(shopOrders.map((e) => e.sign * conv(e.order.taxTotal, e.order)))

    // Fulfillment: what this order actually cost to ship when it says so — a
    // hand-entered B2B order does — otherwise the shop's rate on its day.
    const ratesForShop = input.fulfillmentRates?.get(shop.id) ?? []
    const fulfillment = sum(
      shopOrders.map((e) =>
        e.sign * convCost(e.order.fulfillmentCost ?? fulfillmentOn(ratesForShop, e.order.placedAt), e.order),
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
            .filter((e) => e.order.chargesGatewayFee !== false)
            .map((e) => {
              const pctPart = Math.round((e.order.total * fee.percent) / 100)
              const fixedPart = crossConvert(fee.fixedMinor, fee.currency, e.order.currency, e.order.placedAt, rates)
              return e.sign * conv(pctPart + fixedPart, e.order)
            }),
        )
    const netRevenue = netSales + shippingCharged

    const cogs = sum(
      shopOrders.map((e) =>
        e.sign *
        sum(
          e.order.items.map((item) => {
            const cost = costOn(costs.get(item.productId) ?? [], e.order.placedAt)
            return convCost(item.quantity * (cost.costPerItem + cost.handlingCost), e.order)
          }),
        ),
      ),
    )

    // Commission is a percentage of NET SALES — after discount, before shipping, excl VAT.
    const commission = sum(
      shopOrders.map((e) =>
        e.order.ambassadorId ? e.sign * conv(pct(e.order.netSales, e.order.commissionRate), e.order) : 0,
      ),
    )
    const ambassadorSales = sum(
      shopOrders.map((e) => (e.order.ambassadorId ? e.sign * conv(e.order.netSales, e.order) : 0)),
    )

    // Expenses are dated by day, not by order, so they convert at the range's start.
    const operationalExpenses = sum(
      expenses
        .filter((e) => e.shopId === shop.id)
        .map((e) => convert(expenseInRange(e, from, to), e.currency, from, displayCurrency, rates)),
    )

    const netProfit =
      netRevenue - cogs - fulfillment - transactionFees - operationalExpenses - commission

    // A reversal is not an un-placed order, so only the sale side counts —
    // for the tally AND for what it divides.
    const placed = shopOrders.filter((e) => e.sign === 1).length

    return {
      shopId: shop.id,
      shopName: shop.name,
      orders: placed,
      grossSales,
      discounts,
      netSales,
      shippingCharged,
      taxes,
      netRevenue,
      // What the customer actually paid: net revenue plus the VAT collected.
      grossRevenue: netRevenue + taxes,
      cogs,
      fulfillment,
      transactionFees,
      operationalExpenses,
      commission,
      netProfit,
      netMargin: netRevenue === 0 ? 0 : netProfit / netRevenue,
      avgOrderValue: placed === 0 ? 0 : Math.round(netRevenue / placed),
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
    operationalExpenses: add((r) => r.operationalExpenses),
    commission: add((r) => r.commission),
    netProfit,
    netMargin: netRevenue === 0 ? 0 : netProfit / netRevenue,
    avgOrderValue: orders === 0 ? 0 : Math.round(netRevenue / orders),
    ambassadorSales: add((r) => r.ambassadorSales),
  }
}
