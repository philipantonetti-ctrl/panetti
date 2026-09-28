import { bucketStart } from '../dates'
import { computeMetrics, type MetricsInput } from './engine'
import { deltaPct } from './trend'

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

export type Grain = 'week' | 'month'

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
  const totals = buckets.map(
    (b) => computeMetrics({ ...input, orders, from: b.from, to: b.countedTo }).total,
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

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "22-28 Sep", "29 Dec - 4 Jan", or "September 2026". Hyphens, never dashes. */
export function periodLabel(from: string, to: string, grain: Grain): string {
  const f = day(from)
  const t = day(to)
  if (grain === 'month') return `${MONTH_LONG[f.getUTCMonth()]} ${f.getUTCFullYear()}`
  if (f.getUTCMonth() === t.getUTCMonth()) {
    return `${f.getUTCDate()}-${t.getUTCDate()} ${MONTH_SHORT[t.getUTCMonth()]}`
  }
  return `${f.getUTCDate()} ${MONTH_SHORT[f.getUTCMonth()]} - ${t.getUTCDate()} ${MONTH_SHORT[t.getUTCMonth()]}`
}
