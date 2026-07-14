import { daysInRange, eachDay, utcDay } from '../dates'
import { computeMetrics, type MetricsInput } from './engine'

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
  return eachDay(input.from, input.to).map((day) => {
    const { total } = computeMetrics({ ...input, from: day, to: day })

    return {
      date: day.toISOString().slice(0, 10),
      netRevenue: total.netRevenue,
      netProfit: total.netProfit,
    }
  })
}
