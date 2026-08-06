import { db } from '../db'
import { ACTIVE_GATEWAY } from '../gateways'
import { utcDay } from '../dates'
import { zoneDayEndUtc, zoneDayStartUtc } from '../tz'
import { buildRateTable } from '../metrics/fx'
import { ensureRates, loadRates } from '../fx/rates'
import type { CostBook, EngineAdSpend, EngineExpense, EngineOrder, EngineShop, Recurrence } from '../metrics/types'
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
  const windowStart = new Date(Math.min(...starts))
  const windowEnd = new Date(Math.max(...ends))

  // A shop's costs are in ITS currency. An order need not share it — a B2B
  // customer can be invoiced in EUR from a NOK store.
  const currencyByShop = new Map(shopRows.map((s) => [s.id, s.currency]))

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
      // Placed inside the window, and nothing else. An order belongs to the day
      // it was placed; a refund no longer books a reversal on the day the money
      // went back, so an order placed elsewhere and voided inside this window
      // now produces no entry and was being fetched only to be discarded.
      placedAt: { gte: windowStart, lte: windowEnd },
    },
    select: {
      id: true,
      shopId: true,
      placedAt: true,
      status: true,
      voidedAt: true,
      currency: true,
      grossSales: true,
      discountTotal: true,
      netSales: true,
      shippingCharged: true,
      taxTotal: true,
      total: true,
      b2bCustomerId: true,
      fulfillmentCost: true,
      ambassadorId: true,
      items: { select: { productId: true, quantity: true, lineNetTotal: true } },
    },
  })

  const orders: EngineOrder[] = orderRows.map((o) => ({
    id: o.id,
    shopId: o.shopId,
    placedAt: o.placedAt,
    status: o.status,
    voidedAt: o.voidedAt,
    currency: o.currency,
    costCurrency: currencyByShop.get(o.shopId) ?? o.currency,
    fulfillmentCost: o.fulfillmentCost,
    // An invoiced B2B order never touched the gateway.
    chargesGatewayFee: o.b2bCustomerId === null,
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

  // Ad spend, so the engine can charge marketing to profit. The account carries
  // the shop and the billing currency; the spend row carries only a day and an
  // amount, so the two are joined in memory the way ambassador rates are.
  const adAccounts = await db.adAccount.findMany({
    where: { active: true, shopId: { in: shopIds } },
    select: { id: true, shopId: true, currency: true },
  })
  const accountById = new Map(adAccounts.map((a) => [a.id, a]))
  const spendRows = adAccounts.length
    ? await db.adSpend.findMany({
        // Platforms report a plain UTC day, so the window is a UTC day window —
        // the same one /api/marketing uses, so the two screens see the same rows.
        where: {
          accountId: { in: adAccounts.map((a) => a.id) },
          date: { gte: utcDay(from), lte: utcDay(to) },
        },
        select: { accountId: true, date: true, spend: true },
        orderBy: { date: 'asc' },
      })
    : []
  const adSpend: EngineAdSpend[] = spendRows.map((r) => {
    const account = accountById.get(r.accountId)!
    return { shopId: account.shopId, date: r.date, spend: r.spend, currency: account.currency }
  })

  const feeRow = await db.processingFee.findFirst({
    where: { gateway: ACTIVE_GATEWAY, active: true, noFeesApply: false },
  })
  const processingFee = feeRow
    ? { percent: feeRow.percent, fixedMinor: feeRow.fixedMinor, currency: feeRow.currency }
    : null

  // Every currency in play. More than one means something has to cross, and
  // crossing needs a rate. The previous version looked only at shop, expense
  // and fee currencies, so a EUR order on a NOK shop fetched nothing and was
  // then converted with whatever stale rates happened to be lying around.
  const inPlay = new Set([
    displayCurrency,
    ...shops.map((s) => s.currency),
    ...orders.map((o) => o.currency),
    ...expenses.map((e) => e.currency),
    // An ad account can bill in a currency no shop trades in, and its spend is
    // now a cost against profit — an unfetched rate is real money mis-stated.
    ...adAccounts.map((a) => a.currency),
    ...(processingFee ? [processingFee.currency] : []),
  ])
  if (inPlay.size > 1) {
    await ensureRates(from, to, [...inPlay])
  }

  return {
    shops,
    orders,
    expenses,
    adSpend,
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
