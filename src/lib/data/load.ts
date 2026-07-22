import { db } from '../db'
import { ACTIVE_GATEWAY } from '../gateways'
import { utcDay } from '../dates'
import { zoneDayEndUtc, zoneDayStartUtc } from '../tz'
import { buildRateTable } from '../metrics/fx'
import { ensureRates, loadRates } from '../fx/rates'
import type { CostBook, EngineExpense, EngineOrder, EngineShop, Recurrence } from '../metrics/types'
import type { MetricsInput } from '../metrics/engine'

export type LoadArgs = {
  shopIds?: string[] // undefined = every active shop
  from: Date
  to: Date
  /** Workspace timezone: day boundaries follow it. Defaults to UTC. */
  timezone?: string
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

  const tz = args.timezone ?? 'UTC'

  // A shop with its own timezone buckets days in ITS zone; the query window
  // must span the earliest day-start and latest day-end across every zone.
  const shopTimezones = new Map(shopRows.map((s) => [s.id, s.timezone ?? tz]))
  const zones = [...new Set([tz, ...shopTimezones.values()])]
  const fromDay = utcDay(from).toISOString().slice(0, 10)
  const toDay = utcDay(to).toISOString().slice(0, 10)
  const starts = zones.map((z) => zoneDayStartUtc(fromDay, z).getTime())
  const ends = zones.map((z) => zoneDayEndUtc(toDay, z).getTime())

  // Commission rate per ambassador, looked up in memory. Joining the whole
  // ambassador row onto every order made the query haul the same handful of
  // people thousands of times; the map is a few dozen rows fetched once.
  const rateByAmbassador = new Map(
    (await db.ambassador.findMany({ select: { id: true, commissionRate: true } })).map((a) => [
      a.id,
      a.commissionRate,
    ]),
  )

  // Select ONLY the columns the engine reads — a big range is thousands of rows,
  // so every unused column (SKU, names, prices) is wasted transfer and hydration.
  const orderRows = await db.order.findMany({
    where: {
      shopId: { in: shopIds },
      placedAt: { gte: new Date(Math.min(...starts)), lte: new Date(Math.max(...ends)) },
    },
    select: {
      id: true,
      shopId: true,
      placedAt: true,
      status: true,
      currency: true,
      grossSales: true,
      discountTotal: true,
      netSales: true,
      shippingCharged: true,
      taxTotal: true,
      total: true,
      ambassadorId: true,
      items: { select: { productId: true, quantity: true, lineNetTotal: true } },
    },
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
    commissionRate: o.ambassadorId ? rateByAmbassador.get(o.ambassadorId) ?? 0 : 0,
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

  const feeRow = await db.processingFee.findFirst({
    where: { gateway: ACTIVE_GATEWAY, active: true, noFeesApply: false },
  })
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
    timezone: tz,
    shopTimezones,
  }
}
