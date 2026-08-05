import { utcDay } from '../dates'
import { sum } from '../money'
import { costOn } from './costs'
import { entriesIn } from './engine'
import { crossConvert } from './fx'
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

  // DISTINCT order ids across the whole page, for the total row. A per-product
  // bucket counts an order once per product it appears in (correct there —
  // that is literally "orders of this product"), but summing those counts
  // would report an order that bought both an oven and a brush as two orders.
  const allOrderIds = new Set<string>()

  for (const entry of entriesIn(orders, from, to, tzFor)) {
    const { order, sign } = entry

    // A reversal is not an un-placed order, so only the sale side counts.
    if (sign === 1) allOrderIds.add(order.id)

    // Revenue crosses from the ORDER's currency; costs from the SHOP's. A B2B
    // order can be invoiced in EUR while its shop's costs stay in NOK, and
    // reading one as the other is a tenfold error. `crossConvert`, not
    // `convert`, because this page's display currency is a store group's own
    // currency and is never USD — the only case plain `convert` handles
    // correctly (it multiplies by the from->USD rate and calls the result
    // "display currency" regardless of what display currency actually is).
    const conv = (amount: number) => crossConvert(amount, order.currency, displayCurrency, order.placedAt, rates)
    const convCost = (amount: number) =>
      crossConvert(amount, order.costCurrency, displayCurrency, order.placedAt, rates)

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

      const history = costs.get(item.productId) ?? []

      // A cost is "entered" when some point was already in force on the
      // order's day — NOT when the resulting number happens to be zero. A
      // product costed at {costPerItem: 0, handlingCost: 500} has a real,
      // if odd, cost on file: flagging it as uncosted would tell the client
      // to enter a cost they already entered.
      const costed = history.some((p) => utcDay(p.effectiveFrom).getTime() <= utcDay(order.placedAt).getTime())
      if (!costed) bucket.hasCost = false

      const cost = costOn(history, order.placedAt)

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
    // Sort once, by netSales desc, with shopId as a deterministic tiebreaker.
    // Without it, two stores tied on netSales make "which store names and
    // photographs this row" depend on Map iteration order — itself dependent
    // on the order the caller happened to list its orders in, so the same
    // merged row could read differently between two loads of the same data.
    const scored = group
      .map((b) => ({ bucket: b, totals: totalsOf(b) }))
      .sort(
        (a, b) => b.totals.netSales - a.totals.netSales || a.bucket.meta.shopId.localeCompare(b.bucket.meta.shopId),
      )

    const stores: ProductStoreRow[] = scored.map(({ bucket: b, totals }) => ({
      ...totals,
      shopId: b.meta.shopId,
      shopName: b.shopName,
      productId: b.meta.productId,
      name: b.meta.name,
      hasCost: b.hasCost,
    }))

    const add = (pick: (s: ProductStoreRow) => number) => sum(stores.map(pick))
    const netSales = add((s) => s.netSales)
    const cogs = add((s) => s.cogs)
    const profit = netSales - cogs

    // The biggest seller names the row, so a merged product reads in one
    // language instead of whichever store happened to be loaded first. A
    // photo has no language, so falling back to another store's photo is
    // fine — but the fallback walks this same sorted order, so which photo
    // wins is deterministic too.
    const name = scored[0].bucket.meta.name
    const imageUrl = scored.find((s) => s.bucket.meta.imageUrl)?.bucket.meta.imageUrl ?? null

    return {
      key,
      sku: group[0].meta.sku,
      name,
      imageUrl,
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

  // A total order, so two loads of the same data never reshuffle the table:
  // key is the last tiebreaker and the only one guaranteed distinct.
  rows.sort((a, b) => b.profit - a.profit || a.key.localeCompare(b.key))

  const add = (pick: (r: ProductRow) => number) => sum(rows.map(pick))
  const netSales = add((r) => r.netSales)
  const cogs = add((r) => r.cogs)
  const profit = netSales - cogs

  return {
    displayCurrency,
    rows,
    total: {
      // An order counts once no matter how many of its lines are products on
      // this page — summing the per-row counts would double an order that
      // bought both an oven and a brush.
      orders: allOrderIds.size,
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
