import { utcDay } from '../dates'
import { pct, sum } from '../money'
import { costOn } from './costs'
import { expenseInRange } from './expenses'
import { convert } from './fx'
import {
  EXCLUDED_STATUSES,
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

export type MetricsInput = {
  shops: EngineShop[]
  orders: EngineOrder[]
  expenses: EngineExpense[]
  costs: CostBook
  rates: RateTable
  displayCurrency: string
  from: Date
  to: Date
}

/** An order that contributes nothing — refunded, cancelled, failed. */
function counts(order: EngineOrder): boolean {
  return !EXCLUDED_STATUSES.includes(order.status.toLowerCase() as never)
}

function inRange(order: EngineOrder, from: Date, to: Date): boolean {
  const t = utcDay(order.placedAt).getTime()
  return t >= utcDay(from).getTime() && t <= utcDay(to).getTime()
}

/**
 * THE function. Every number on every screen comes from here.
 *
 *   net sales    = gross sales - discounts          (excl VAT — VAT is never revenue)
 *   net revenue  = net sales + shipping charged
 *   cogs         = qty x (cost + handling), at the cost in effect ON THE ORDER'S DATE
 *   commission   = rate x net sales, for attributed orders only
 *   net profit   = net revenue - cogs - operational expenses - commission
 *
 * Money arrives in each shop's own currency and is converted to `displayCurrency`
 * using the rate from the order's own date, so history never shifts.
 */
export function computeMetrics(input: MetricsInput): EngineResult {
  const { shops, orders, expenses, costs, rates, displayCurrency, from, to } = input

  const live = orders.filter((o) => counts(o) && inRange(o, from, to))

  const byShop: ShopFigures[] = shops.map((shop) => {
    const shopOrders = live.filter((o) => o.shopId === shop.id)

    // Convert an amount from this order's currency into the display currency,
    // at the rate that applied on the day the order was placed.
    const conv = (amount: number, order: EngineOrder) =>
      convert(amount, order.currency, order.placedAt, displayCurrency, rates)

    const grossSales = sum(shopOrders.map((o) => conv(o.grossSales, o)))
    const discounts = sum(shopOrders.map((o) => conv(o.discountTotal, o)))
    const netSales = sum(shopOrders.map((o) => conv(o.netSales, o)))
    const shippingCharged = sum(shopOrders.map((o) => conv(o.shippingCharged, o)))
    const netRevenue = netSales + shippingCharged

    const cogs = sum(
      shopOrders.map((order) =>
        sum(
          order.items.map((item) => {
            const cost = costOn(costs.get(item.productId) ?? [], order.placedAt)
            const line = item.quantity * (cost.costPerItem + cost.handlingCost)
            return conv(line, order)
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

    const netProfit = netRevenue - cogs - operationalExpenses - commission

    return {
      shopId: shop.id,
      shopName: shop.name,
      orders: shopOrders.length,
      grossSales,
      discounts,
      netSales,
      shippingCharged,
      netRevenue,
      cogs,
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
    netRevenue,
    cogs: add((r) => r.cogs),
    operationalExpenses: add((r) => r.operationalExpenses),
    commission: add((r) => r.commission),
    netProfit,
    netMargin: netRevenue === 0 ? 0 : netProfit / netRevenue,
    avgOrderValue: orders === 0 ? 0 : Math.round(netRevenue / orders),
    ambassadorSales: add((r) => r.ambassadorSales),
  }
}
