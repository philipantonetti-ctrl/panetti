import { db } from '../db'
import { utcDay } from '../dates'
import { zoneDayEndUtc, zoneDayStartUtc } from '../tz'
import { groupByCurrency } from '../currency-groups'
import { buildRateTable } from '../metrics/fx'
import { ensureRates, loadRates } from '../fx/rates'
import type { CostBook } from '../metrics/types'
import type { ProductInput, ProductMeta, ProductOrder } from '../metrics/products'

/**
 * Everything the product page needs for one query.
 *
 * Deliberately NOT `loadMetricsInput`. That one selects only productId,
 * quantity and lineNetTotal from order items; this page also needs the sku,
 * name and unit price. Widening the shared select would make every Dashboard
 * request haul three unused columns across thousands of rows.
 *
 * The display currency is the selected shops' shared currency — not USD.
 * Mixing currencies is refused rather than converted, because a product table
 * that silently consolidates is one a client cannot check against his own till.
 */

export type LoadProductsArgs = {
  shopIds?: string[] // undefined = every active shop
  from: Date
  to: Date
  timezone?: string
}

export type CurrencyGroup = { currency: string; shops: { id: string; name: string }[] }

export class MixedCurrencyError extends Error {
  readonly groups: CurrencyGroup[]
  constructor(groups: CurrencyGroup[]) {
    super('The selected stores use different currencies, so their product totals cannot be added together.')
    this.name = 'MixedCurrencyError'
    this.groups = groups
  }
}

export async function loadProductsInput(args: LoadProductsArgs): Promise<ProductInput> {
  const { from, to } = args

  const shopRows = await db.shop.findMany({
    where: { active: true, ...(args.shopIds?.length ? { id: { in: args.shopIds } } : {}) },
    orderBy: { name: 'asc' },
  })

  const groups = groupByCurrency(shopRows.map((s) => ({ id: s.id, name: s.name, currency: s.currency })))
  if (groups.length > 1) throw new MixedCurrencyError(groups)

  const shops = shopRows.map((s) => ({ id: s.id, name: s.name, currency: s.currency }))
  const shopIds = shops.map((s) => s.id)
  // No shops at all still has to return something the aggregation can chew on.
  const displayCurrency = groups[0]?.currency ?? 'USD'

  const tz = args.timezone ?? 'UTC'
  const shopTimezones = new Map(shopRows.map((s) => [s.id, s.timezone ?? tz]))
  const zones = [...new Set([tz, ...shopTimezones.values()])]
  const fromDay = utcDay(from).toISOString().slice(0, 10)
  const toDay = utcDay(to).toISOString().slice(0, 10)
  const windowStart = new Date(Math.min(...zones.map((z) => zoneDayStartUtc(fromDay, z).getTime())))
  const windowEnd = new Date(Math.max(...zones.map((z) => zoneDayEndUtc(toDay, z).getTime())))

  const currencyByShop = new Map(shopRows.map((s) => [s.id, s.currency]))

  const orderRows = await db.order.findMany({
    where: {
      shopId: { in: shopIds },
      OR: [
        { placedAt: { gte: windowStart, lte: windowEnd } },
        // An order placed before this window but refunded inside it must still
        // be fetched, or its products can never be taken back off.
        { voidedAt: { gte: windowStart, lte: windowEnd } },
      ],
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
      ambassadorId: true,
      items: {
        select: { productId: true, sku: true, name: true, quantity: true, unitPrice: true, lineNetTotal: true },
      },
    },
  })

  const orders: ProductOrder[] = orderRows.map((o) => ({
    id: o.id,
    shopId: o.shopId,
    placedAt: o.placedAt,
    status: o.status,
    voidedAt: o.voidedAt,
    currency: o.currency,
    costCurrency: currencyByShop.get(o.shopId) ?? o.currency,
    grossSales: o.grossSales,
    discountTotal: o.discountTotal,
    netSales: o.netSales,
    shippingCharged: o.shippingCharged,
    taxTotal: o.taxTotal,
    total: o.total,
    ambassadorId: o.ambassadorId,
    // Commission never reaches a product figure, so the rate is not looked up.
    commissionRate: 0,
    items: o.items.map((i) => ({
      productId: i.productId,
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineNetTotal: i.lineNetTotal,
    })),
  }))

  const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId)))]

  const productRows = await db.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, shopId: true, sku: true, externalId: true, name: true, imageUrl: true },
  })
  const products = new Map<string, ProductMeta>(
    productRows.map((p) => [
      p.id,
      { productId: p.id, shopId: p.shopId, sku: p.sku, externalId: p.externalId, name: p.name, imageUrl: p.imageUrl },
    ]),
  )

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

  // Every shop shares one currency here, so the only thing that can still need
  // a rate is an order invoiced in a different one — a B2B order, typically.
  const inPlay = new Set([displayCurrency, ...orders.map((o) => o.currency)])
  if (inPlay.size > 1) await ensureRates(from, to, [...inPlay])

  return {
    shops,
    orders,
    products,
    costs,
    rates: buildRateTable(await loadRates()),
    displayCurrency,
    from,
    to,
    timezone: tz,
    shopTimezones,
  }
}
