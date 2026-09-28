import { bucketStart } from '../dates'
import { zonedDayStr } from '../tz'
import { computeMetrics, type MetricsInput } from './engine'
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
 * Nothing that is a cost leaves this file: the row type has no field for one.
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
  vsPrevious: number | null
}

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
  const orders = opts.excludeZero ? input.orders.filter((o) => o.total !== 0) : input.orders

  // Group every kept order onto its own calendar day ONCE, in the very zone
  // the engine uses for it - the same fix dailySeries (trend.ts) already
  // applies to the identical problem. Without this, each of the up to 13
  // buckets' own computeMetrics call re-scanned every order in the whole
  // window (a timezone format per order per bucket): at production volume
  // that was seconds of CPU for one page load. Grouped once, each bucket's
  // computeMetrics runs over only the orders whose day falls within it - the
  // engine still applies its own status and day rules to that subset, so the
  // rows are unchanged.
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

  const totals = buckets.map(
    (b) =>
      computeMetrics({ ...input, orders: ordersInRange(b.from, b.countedTo), from: b.from, to: b.countedTo })
        .total,
  )

  return buckets.slice(0, -1).map((b, i) => ({
    from: ymd(b.from),
    to: ymd(b.to),
    soFar: b.soFar,
    orders: totals[i].orders,
    sales: totals[i].netRevenue,
    avgOrder: totals[i].avgOrderValue,
    vsPrevious: deltaPct(totals[i].netRevenue, totals[i + 1].netRevenue),
  }))
}
