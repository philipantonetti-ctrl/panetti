import { db } from '../db'
import { ACTIVE_GATEWAY } from '../gateways'
import { utcDay } from '../dates'
import { zoneDayEndUtc, zoneDayStartUtc } from '../tz'
import { buildRateTable } from '../metrics/fx'
import { ensureRates, loadRates } from '../fx/rates'
import { attributedSpend, relevantAdCurrencies } from '../ads/attribution'
import { affiliateCosts, relevantAffiliateCurrencies } from '../affiliate/cost'
import { normaliseSku } from '../inventory/sku'
import { getSetting } from '../settings'
import type { ShippingPoint } from '../inventory/shipping'
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
 *   several shops     -> the workspace's displayCurrency setting (default USD)
 */
export async function loadMetricsInput(args: LoadArgs): Promise<MetricsInput> {
  const { from, to } = args

  const shopRows = await db.shop.findMany({
    where: { active: true, ...(args.shopIds?.length ? { id: { in: args.shopIds } } : {}) },
    orderBy: { name: 'asc' },
  })

  const shops: EngineShop[] = shopRows.map((s) => ({ id: s.id, name: s.name, currency: s.currency }))
  const shopIds = shops.map((s) => s.id)

  // Several shops have to cross into one currency to be summable. WHICH one is
  // a workspace choice, read here rather than passed in: all four callers
  // already fetch the setting for `timezone`, and one that forgot to pass a
  // second field would render a page quoting a different currency from the one
  // beside it. One shop needs no crossing, so it keeps its own currency and the
  // figure still matches the platform exactly.
  const setting = await getSetting()
  const displayCurrency = shops.length === 1 ? shops[0].currency : setting.displayCurrency

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
  // so every unused column (names, prices) is wasted transfer and hydration.
  // The line's SKU is now one the engine does read: it is what a per-unit
  // shipping rate is keyed by, and a product id could not be, being shop-scoped.
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
      items: { select: { productId: true, sku: true, quantity: true, lineNetTotal: true } },
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
      sku: i.sku,
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

  // Per-unit shipping, keyed by the SKU it was typed against. Every row, not
  // just the SKUs on this page's orders: there are a few dozen of them against
  // thousands of order lines, so an IN clause would cost more than it saved.
  // Keys are normalised because the resolver looks them up that way — a rate
  // typed as "panpizpro" must reach an order line reading "PANPIZPRO".
  const shippingRates = new Map<string, ShippingPoint[]>()
  for (const r of await db.shippingRate.findMany()) {
    const sku = normaliseSku(r.sku)
    const list = shippingRates.get(sku) ?? []
    list.push({ perUnit: r.perUnit, currency: r.currency, effectiveFrom: r.effectiveFrom })
    shippingRates.set(sku, list)
  }

  // Ad spend, so the engine can charge marketing to profit. Resolved per
  // campaign for split accounts and per account otherwise — see attribution.ts.
  const adSpend: EngineAdSpend[] = await attributedSpend(shopIds, from, to)

  // Affiliate cost, the same road ad spend travels: pre-attributed flat rows
  // the engine converts at each day's own rate.
  const affiliate = await affiliateCosts(shopIds, from, to)

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
    // Sourced from every relevant account, not just today's spend rows: a
    // currency with nothing booked yet still needs a rate the moment it does.
    ...(await relevantAdCurrencies(shopIds)),
    // Affiliate rows carry their own currency too — measured: FI sales in SEK.
    ...(await relevantAffiliateCurrencies(shopIds)),
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
    affiliate,
    costs,
    rates: buildRateTable(await loadRates()),
    displayCurrency,
    from,
    to,
    fulfillmentRates,
    shippingRates,
    processingFee,
    timezone: tz,
    shopTimezones,
  }
}
