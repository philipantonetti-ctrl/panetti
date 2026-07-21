import { db } from '../db'
import { utcDay } from '../dates'
import { buildRateTable } from '../metrics/fx'
import { ensureRates, loadRates } from '../fx/rates'
import type { CostBook, EngineExpense, EngineOrder, EngineShop, Recurrence } from '../metrics/types'
import type { MetricsInput } from '../metrics/engine'

export type LoadArgs = {
  shopIds?: string[] // undefined = every active shop
  from: Date
  to: Date
}

/**
 * Gather everything the engine needs for one query.
 *
 * The display currency is decided here, and it follows one rule:
 *   exactly one shop  -> that shop's own currency
 *   several shops     -> USD, so the totals mean something
 */
export async function loadMetricsInput(args: LoadArgs): Promise<MetricsInput> {
  const { from, to } = args

  const shopRows = await db.shop.findMany({
    where: { active: true, ...(args.shopIds?.length ? { id: { in: args.shopIds } } : {}) },
    orderBy: { name: 'asc' },
  })

  const shops: EngineShop[] = shopRows.map((s) => ({ id: s.id, name: s.name, currency: s.currency }))
  const shopIds = shops.map((s) => s.id)

  const displayCurrency = shops.length === 1 ? shops[0].currency : 'USD'

  const orderRows = await db.order.findMany({
    where: { shopId: { in: shopIds }, placedAt: { gte: utcDay(from), lte: endOfDay(to) } },
    include: { items: true, ambassador: true },
  })

  const orders: EngineOrder[] = orderRows.map((o) => ({
    id: o.id,
    shopId: o.shopId,
    placedAt: o.placedAt,
    status: o.status,
    currency: o.currency,
    grossSales: o.grossSales,
    discountTotal: o.discountTotal,
    netSales: o.netSales,
    shippingCharged: o.shippingCharged,
    taxTotal: o.taxTotal,
    total: o.total,
    ambassadorId: o.ambassadorId,
    // The rate is read from the ambassador, so a rate change applies to future
    // reports — but the ATTRIBUTION itself was frozen at sync time.
    commissionRate: o.ambassador?.commissionRate ?? 0,
    items: o.items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      lineNetTotal: i.lineNetTotal,
    })),
  }))

  // Cost history for exactly the products these orders touched.
  const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId)))]
  const costRows = await db.productCost.findMany({
    where: { productId: { in: productIds } },
    orderBy: { effectiveFrom: 'asc' },
  })

  const costs: CostBook = new Map()
  for (const c of costRows) {
    const list = costs.get(c.productId) ?? []
    list.push({ costPerItem: c.costPerItem, handlingCost: c.handlingCost, effectiveFrom: c.effectiveFrom })
    costs.set(c.productId, list)
  }

  const expenseRows = await db.operationalExpense.findMany({ where: { shopId: { in: shopIds } } })
  const expenses: EngineExpense[] = expenseRows.map((e) => ({
    id: e.id,
    shopId: e.shopId,
    amount: e.amount,
    currency: e.currency,
    recurrence: e.recurrence as Recurrence,
    startDate: e.startDate,
    endDate: e.endDate,
    active: e.active,
  }))

  const rateRows = await db.fulfillmentRate.findMany({ where: { shopId: { in: shopIds } } })
  const fulfillmentRates = new Map<string, { perOrder: number; effectiveFrom: Date }[]>()
  for (const r of rateRows) {
    const list = fulfillmentRates.get(r.shopId) ?? []
    list.push({ perOrder: r.perOrder, effectiveFrom: r.effectiveFrom })
    fulfillmentRates.set(r.shopId, list)
  }

  const feeRow = await db.processingFee.findFirst({ where: { active: true } })
  const processingFee = feeRow
    ? { percent: feeRow.percent, fixedMinor: feeRow.fixedMinor, currency: feeRow.currency }
    : null

  // Only fetch FX when we actually need to convert something: consolidating to
  // USD, or crossing the gateway fee's currency into the shops' own.
  const currencies = [...new Set([...shops.map((s) => s.currency), ...expenses.map((e) => e.currency)])]
  if (processingFee) currencies.push(processingFee.currency)
  const needsRates =
    (displayCurrency === 'USD' && currencies.some((c) => c !== 'USD')) ||
    (processingFee !== null && currencies.some((c) => c !== processingFee.currency))
  if (needsRates) {
    await ensureRates(from, to, [...new Set(currencies)])
  }

  return {
    shops,
    orders,
    expenses,
    costs,
    rates: buildRateTable(await loadRates()),
    displayCurrency,
    from,
    to,
    fulfillmentRates,
    processingFee,
  }
}

/** 23:59:59.999 on `d`, so an order placed in the evening is inside the range. */
function endOfDay(d: Date): Date {
  const day = utcDay(d)
  return new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1)
}
