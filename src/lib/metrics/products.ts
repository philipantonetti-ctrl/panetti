import { sum } from '../money'
import { costOn } from './costs'
import { entriesIn } from './engine'
import { convert } from './fx'
import type { CostBook, EngineOrder, EngineOrderItem, EngineShop, RateTable } from './types'

/**
 * How each product performed, per store, over one period.
 *
 * Profit here is net sales minus COGS and NOTHING else. Shipping, gateway fees,
 * fulfillment and ambassador commission sit on the ORDER, not the product;
 * splitting them by share of line value would turn every figure on the page
 * into an estimate. Ad spend is per campaign and is excluded for the same
 * reason, more strongly — no data we hold ties a campaign to a product.
 *
 * Refund handling is not reimplemented here. `entriesIn` is the engine's own,
 * so a refund comes off this page on exactly the day it comes off the
 * Dashboard, permanently.
 */

export type ProductLine = EngineOrderItem & { sku: string; name: string; unitPrice: number }
export type ProductOrder = Omit<EngineOrder, 'items'> & { items: ProductLine[] }

export type ProductMeta = {
  productId: string
  shopId: string
  sku: string
  /** The Woo product id. Equal to `sku` exactly when the listing had no SKU. */
  externalId: string
  name: string
  imageUrl: string | null
}

export type ProductTotals = {
  orders: number
  quantity: number
  grossSales: number
  netSales: number
  cogs: number
  profit: number
  margin: number
}

export type ProductStoreRow = ProductTotals & {
  shopId: string
  shopName: string
  productId: string
  name: string
  hasCost: boolean
}

export type ProductRow = ProductTotals & {
  key: string
  sku: string
  name: string
  imageUrl: string | null
  hasCost: boolean
  stores: ProductStoreRow[]
}

export type ProductInput = {
  shops: EngineShop[]
  orders: ProductOrder[]
  products: Map<string, ProductMeta>
  costs: CostBook
  rates: RateTable
  displayCurrency: string
  from: Date
  to: Date
  timezone?: string
  shopTimezones?: Map<string, string>
}

export type ProductResult = {
  displayCurrency: string
  rows: ProductRow[]
  total: ProductTotals
  uncosted: number
}

/**
 * What makes two rows the same product.
 *
 * The SKU, except when there isn't one: `map.ts` falls back to the Woo product
 * id (`li.sku || String(li.product_id)`), and those ids are per-store
 * sequential. Merging on them would fold two different stores' product #42
 * into a single row that adds up unrelated money.
 */
export function mergeKey(meta: ProductMeta): string {
  if (meta.sku && meta.sku !== meta.externalId) return `sku:${meta.sku}`
  return `product:${meta.productId}`
}

/** One store's slice of one product, accumulated as entries arrive. */
type Bucket = {
  meta: ProductMeta
  shopName: string
  orderIds: Set<string>
  quantity: number
  grossSales: number
  netSales: number
  cogs: number
  hasCost: boolean
}

function totalsOf(b: Bucket): ProductTotals {
  const profit = b.netSales - b.cogs
  return {
    orders: b.orderIds.size,
    quantity: b.quantity,
    grossSales: b.grossSales,
    netSales: b.netSales,
    cogs: b.cogs,
    profit,
    margin: b.netSales === 0 ? 0 : profit / b.netSales,
  }
}

export function productFigures(input: ProductInput): ProductResult {
  const { orders, products, costs, rates, displayCurrency, from, to } = input

  const tz = input.timezone ?? 'UTC'
  const tzFor = (shopId: string) => input.shopTimezones?.get(shopId) ?? tz
  const shopNames = new Map(input.shops.map((s) => [s.id, s.name]))

  // productId -> that product's figures in its own store.
  const buckets = new Map<string, Bucket>()

  for (const entry of entriesIn(orders, from, to, tzFor)) {
    const { order, sign } = entry

    // Revenue crosses from the ORDER's currency; costs from the SHOP's. A B2B
    // order can be invoiced in EUR while its shop's costs stay in NOK, and
    // reading one as the other is a tenfold error.
    const conv = (amount: number) => convert(amount, order.currency, order.placedAt, displayCurrency, rates)
    const convCost = (amount: number) => convert(amount, order.costCurrency, order.placedAt, displayCurrency, rates)

    for (const item of order.items) {
      const meta = products.get(item.productId)
      if (!meta) continue // a line whose product row we did not load; never invent one

      let bucket = buckets.get(item.productId)
      if (!bucket) {
        bucket = {
          meta,
          shopName: shopNames.get(meta.shopId) ?? '',
          orderIds: new Set(),
          quantity: 0,
          grossSales: 0,
          netSales: 0,
          cogs: 0,
          hasCost: true,
        }
        buckets.set(item.productId, bucket)
      }

      // A reversal is not an un-placed order, so only the sale side is tallied.
      if (sign === 1) bucket.orderIds.add(order.id)

      const cost = costOn(costs.get(item.productId) ?? [], order.placedAt)
      if (cost.costPerItem === 0) bucket.hasCost = false

      bucket.quantity += sign * item.quantity
      bucket.grossSales += sign * conv(item.unitPrice * item.quantity)
      bucket.netSales += sign * conv(item.lineNetTotal)
      bucket.cogs += sign * convCost(item.quantity * (cost.costPerItem + cost.handlingCost))
    }
  }

  // Fold the per-store buckets into merged rows.
  const merged = new Map<string, Bucket[]>()
  for (const bucket of buckets.values()) {
    const key = mergeKey(bucket.meta)
    const list = merged.get(key) ?? []
    list.push(bucket)
    merged.set(key, list)
  }

  const rows: ProductRow[] = [...merged.entries()].map(([key, group]) => {
    const stores: ProductStoreRow[] = group
      .map((b) => ({
        ...totalsOf(b),
        shopId: b.meta.shopId,
        shopName: b.shopName,
        productId: b.meta.productId,
        name: b.meta.name,
        hasCost: b.hasCost,
      }))
      .sort((a, b) => b.netSales - a.netSales)

    const add = (pick: (s: ProductStoreRow) => number) => sum(stores.map(pick))
    const netSales = add((s) => s.netSales)
    const cogs = add((s) => s.cogs)
    const profit = netSales - cogs

    // The biggest seller names the row, so a merged product reads in one
    // language instead of whichever store happened to be loaded first.
    const lead = stores[0]

    return {
      key,
      sku: group[0].meta.sku,
      name: lead.name,
      imageUrl: group.find((b) => b.meta.imageUrl)?.meta.imageUrl ?? null,
      orders: add((s) => s.orders),
      quantity: add((s) => s.quantity),
      grossSales: add((s) => s.grossSales),
      netSales,
      cogs,
      profit,
      margin: netSales === 0 ? 0 : profit / netSales,
      hasCost: stores.every((s) => s.hasCost),
      stores,
    }
  })

  rows.sort((a, b) => b.profit - a.profit)

  const add = (pick: (r: ProductRow) => number) => sum(rows.map(pick))
  const netSales = add((r) => r.netSales)
  const cogs = add((r) => r.cogs)
  const profit = netSales - cogs

  return {
    displayCurrency,
    rows,
    total: {
      orders: add((r) => r.orders),
      quantity: add((r) => r.quantity),
      grossSales: add((r) => r.grossSales),
      netSales,
      cogs,
      profit,
      // Recomputed from the totals, never an average of the row margins.
      margin: netSales === 0 ? 0 : profit / netSales,
    },
    uncosted: rows.filter((r) => !r.hasCost).length,
  }
}
