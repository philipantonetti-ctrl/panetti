import { bucketStart } from '../dates'
import { zonedDayStr } from '../tz'
import { computeMetrics, entriesIn, type MetricsInput } from './engine'
import { mergeKey, type ProductMeta } from './products'
import { deltaPct } from './trend'
import type { EngineOrder } from './types'
import type { Grain } from './period-label'

export { periodLabel, type Grain } from './period-label'

/**
 * Sales by week or by month, for the operations manager's Dashboard.
 *
 * Every row is the owner's own `computeMetrics` over that week or month, and
 * only three of its numbers are read: orders, net revenue and the average
 * order. The status rules, the rule that an order belongs to the day it was
 * placed in its own shop's timezone, and the rate of the order's own day are
 * therefore the owner's dashboard's, not a copy of them - so a week here and
 * the same dates on the owner's dashboard cannot disagree.
 *
 * Units sold is the one figure the engine does not total: it is the summed
 * line quantity of exactly the orders the engine counts (`entriesIn`, the
 * engine's own gate), so an order that is not a sale there is not one here.
 *
 * Nothing that is a cost leaves this file: no row type has a field for one.
 */

/** How many periods the table shows. */
export const PERIODS = 12

/**
 * One week or month. `from`..`to` is the whole calendar period, which is what
 * the label names; `countedTo` is the last day counted, which is today for the
 * period we are in and `to` for every other.
 */
export type PeriodBucket = { from: Date; to: Date; countedTo: Date; soFar: boolean }

export type PeriodRow = {
  from: string
  to: string
  soFar: boolean
  orders: number
  sales: number
  avgOrder: number
  units: number
  vsPrevious: number | null
}

/** What names a product on the units table: the Product row, minus its photo. */
export type ProductName = Pick<ProductMeta, 'productId' | 'shopId' | 'sku' | 'externalId' | 'name'>

/**
 * One shop, or one product, across the shown periods. `units[i]` belongs to
 * the i-th row `salesByPeriod` gives for the same buckets - newest first.
 */
export type UnitsRow = { id: string; name: string; units: number[] }

const DAY_MS = 24 * 60 * 60 * 1000
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const day = (s: string) => new Date(`${s}T00:00:00Z`)

/**
 * The period `today` falls in, and the `count` before it, newest first.
 *
 * One more than is shown: the oldest is only there so the oldest shown row has
 * a period to be compared with. `today` is the workspace's calendar day as a
 * UTC midnight, as `todayInZone` gives it.
 */
export function periodBuckets(grain: Grain, today: Date, count: number): PeriodBucket[] {
  const out: PeriodBucket[] = []
  let start = day(bucketStart(ymd(today), grain))

  for (let i = 0; i <= count; i++) {
    const end =
      grain === 'week'
        ? new Date(start.getTime() + 6 * DAY_MS)
        : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
    const soFar = i === 0
    out.push({ from: start, to: end, countedTo: soFar ? today : end, soFar })

    start =
      grain === 'week'
        ? new Date(start.getTime() - 7 * DAY_MS)
        : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1))
  }
  return out
}

/**
 * One row per shown bucket, each compared with the WHOLE bucket before it.
 *
 * `excludeZero` drops orders whose customer paid nothing (`total === 0`) from
 * the input once, before any bucket is computed, so every row and every
 * comparison base leave them out alike.
 */
export function salesByPeriod(
  input: MetricsInput,
  buckets: PeriodBucket[],
  opts: { excludeZero: boolean },
): PeriodRow[] {
  const { tzFor, ordersInRange } = groupByDay(input, opts.excludeZero)

  const totals = buckets.map((b) => {
    const orders = ordersInRange(b.from, b.countedTo)
    const total = computeMetrics({ ...input, orders, from: b.from, to: b.countedTo }).total
    const units = sumUnits(entriesIn(orders, b.from, b.countedTo, tzFor).map((e) => e.order))
    return { ...total, units }
  })

  return buckets.slice(0, -1).map((b, i) => ({
    from: ymd(b.from),
    to: ymd(b.to),
    soFar: b.soFar,
    orders: totals[i].orders,
    sales: totals[i].netRevenue,
    avgOrder: totals[i].avgOrderValue,
    units: totals[i].units,
    vsPrevious: deltaPct(totals[i].netRevenue, totals[i + 1].netRevenue),
  }))
}

/**
 * Units sold in each shown bucket, once per shop and once per product.
 *
 * Shops come back in the order given, every one of them, so a shop that sold
 * nothing reads as a row of zeros rather than going missing. Products are
 * merged the way the Products page merges them (`mergeKey`: one SKU across
 * shops is one product, a listing without a SKU stays its shop's own), named
 * by the shop that sold the most of it, and sorted biggest first. A line
 * whose product row is unknown keeps its units under its SKU: the point of
 * the table is that each column adds up to the sales table's units.
 */
export function unitsByPeriod(
  input: MetricsInput,
  buckets: PeriodBucket[],
  opts: { excludeZero: boolean; products: Map<string, ProductName> },
): { byShop: UnitsRow[]; byProduct: UnitsRow[] } {
  const { tzFor, ordersInRange } = groupByDay(input, opts.excludeZero)
  const shown = buckets.slice(0, -1)
  const zeros = () => shown.map(() => 0)

  const byShop = new Map(input.shops.map((s) => [s.id, { id: s.id, name: s.name, units: zeros() }]))
  // product key -> its row, plus how much each shop's listing sold, for the name.
  const byProduct = new Map<string, UnitsRow & { sellers: Map<string, { name: string; units: number }> }>()

  shown.forEach((b, i) => {
    for (const { order } of entriesIn(ordersInRange(b.from, b.countedTo), b.from, b.countedTo, tzFor)) {
      for (const item of order.items) {
        const shop = byShop.get(order.shopId)
        if (shop) shop.units[i] += item.quantity

        const meta = opts.products.get(item.productId)
        const key = meta ? mergeKey(meta) : `product:${item.productId}`
        let row = byProduct.get(key)
        if (!row) {
          row = { id: key, name: '', units: zeros(), sellers: new Map() }
          byProduct.set(key, row)
        }
        row.units[i] += item.quantity
        const seller = row.sellers.get(order.shopId) ?? { name: meta?.name ?? item.sku, units: 0 }
        seller.units += item.quantity
        row.sellers.set(order.shopId, seller)
      }
    }
  })

  const total = (r: UnitsRow) => r.units.reduce((n, u) => n + u, 0)
  const products: UnitsRow[] = [...byProduct.values()].map(({ sellers, ...row }) => {
    // The biggest seller names the row, as on the Products page; shopId breaks
    // a tie so two loads of the same data never read differently.
    const [best] = [...sellers.entries()].sort((a, b) => b[1].units - a[1].units || a[0].localeCompare(b[0]))
    return { ...row, name: best[1].name }
  })
  products.sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

  return { byShop: [...byShop.values()], byProduct: products }
}

/** Every unit of every line of the orders given. */
function sumUnits(orders: EngineOrder[]): number {
  let n = 0
  for (const o of orders) for (const item of o.items) n += item.quantity
  return n
}

/**
 * The orders a bucket can contain, found without rescanning the whole window.
 *
 * `excludeZero` drops orders whose customer paid nothing (`total === 0`) from
 * the input once, before any bucket is computed, so every row and every
 * comparison base leave them out alike. An order from a shop that is not in
 * `input.shops` goes too: the engine sums only the shops it is given, so such
 * an order earns nothing on the sales rows, and its units may not appear
 * anywhere either - the loader never hands one over, but the promise that the
 * three figures agree must not depend on that.
 *
 * Every kept order is grouped onto its own calendar day ONCE, in the very zone
 * the engine uses for it - the same fix dailySeries (trend.ts) already applies
 * to the identical problem. Without this, each of the up to 13 buckets' own
 * computeMetrics call re-scanned every order in the whole window (a timezone
 * format per order per bucket): at production volume that was seconds of CPU
 * for one page load. Grouped once, each bucket's computeMetrics runs over only
 * the orders whose day falls within it - the engine still applies its own
 * status and day rules to that subset, so the rows are unchanged.
 */
function groupByDay(input: MetricsInput, excludeZero: boolean) {
  const counted = new Set(input.shops.map((s) => s.id))
  const orders = input.orders.filter((o) => counted.has(o.shopId) && (!excludeZero || o.total !== 0))

  const tz = input.timezone ?? 'UTC'
  const tzFor = (shopId: string) => input.shopTimezones?.get(shopId) ?? tz
  const byDay = new Map<string, EngineOrder[]>()
  for (const o of orders) {
    const key = zonedDayStr(o.placedAt, tzFor(o.shopId))
    const list = byDay.get(key)
    if (list) list.push(o)
    else byDay.set(key, [o])
  }

  const ordersInRange = (from: Date, to: Date): EngineOrder[] => {
    const fromKey = ymd(from)
    const toKey = ymd(to)
    const out: EngineOrder[] = []
    for (const [key, list] of byDay) {
      if (key >= fromKey && key <= toKey) out.push(...list)
    }
    return out
  }

  return { tzFor, ordersInRange }
}
