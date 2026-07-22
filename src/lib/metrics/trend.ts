import { daysInRange, eachDay, utcDay } from '../dates'
import { zonedDayStr } from '../tz'
import { computeMetrics, type MetricsInput } from './engine'
import type { EngineOrder } from './types'

/** Change over time, and change against the period before. */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The equally-long period immediately before this one, so "this month" is compared with
 * the month before it rather than with an arbitrary window.
 */
export function previousRange(from: Date, to: Date): { from: Date; to: Date } {
  const length = daysInRange(from, to)
  const end = new Date(utcDay(from).getTime() - DAY_MS)
  const start = new Date(end.getTime() - (length - 1) * DAY_MS)
  return { from: start, to: end }
}

/**
 * How much this period moved against the one before.
 *
 * Returns null when the previous period was zero: growing from nothing is not
 * "+∞%", it simply is not a percentage, and printing one would be a lie.
 */
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null
  return (current - previous) / Math.abs(previous)
}

export type SeriesPoint = {
  date: string // yyyy-mm-dd
  netRevenue: number
  netProfit: number
}

/**
 * Revenue and profit per day, for the trend chart.
 *
 * Each day is run through the same engine as the totals, so a point on the chart and
 * the number in the header can never disagree.
 */
export function dailySeries(input: MetricsInput): SeriesPoint[] {
  const tz = input.timezone ?? 'UTC'
  const tzFor = (shopId: string) => input.shopTimezones?.get(shopId) ?? tz

  // Bucket every order onto its own day ONCE, in the very zone the engine uses.
  // Then each day is computed from only its own orders. Without this, every day
  // re-scanned every order in the range (an expensive Intl call per order), so a
  // year was O(days x orders) — hundreds of thousands of scans. The per-day
  // compute still runs the real engine, so the numbers are byte-for-byte the same.
  const byDay = new Map<string, EngineOrder[]>()
  for (const o of input.orders) {
    const k = zonedDayStr(o.placedAt, tzFor(o.shopId))
    const list = byDay.get(k)
    if (list) list.push(o)
    else byDay.set(k, [o])
  }

  return eachDay(input.from, input.to).map((day) => {
    const date = day.toISOString().slice(0, 10)
    const { total } = computeMetrics({ ...input, orders: byDay.get(date) ?? [], from: day, to: day })

    return {
      date,
      netRevenue: total.netRevenue,
      netProfit: total.netProfit,
    }
  })
}
