import { utcDay } from '../dates'
import { zonedDayStr } from '../tz'
import { pct } from '../money'
import { convert } from './fx'
import { EXCLUDED_STATUSES, type EngineOrder, type RateTable } from './types'

export type LeaderboardRow = {
  rank: number
  ambassadorId: string
  name: string
  orders: number
  sales: number // net sales, display currency
  commission: number // display currency
}

export type LeaderboardInput = {
  ambassadors: { id: string; name: string }[]
  orders: EngineOrder[]
  rates: RateTable
  displayCurrency: string
  from: Date
  to: Date
  timezone?: string
}

/**
 * Who sold the most. Same rules as the engine: refunded orders count for nothing,
 * commission is a percentage of net sales.
 *
 * Ambassadors with no sales in the range are still listed (with zeroes) — an empty
 * row is information; a missing row looks like a bug.
 */
export function leaderboard(input: LeaderboardInput): LeaderboardRow[] {
  const { ambassadors, orders, rates, displayCurrency, from, to } = input

  const tz = input.timezone ?? 'UTC'
  const start = utcDay(from).toISOString().slice(0, 10)
  const end = utcDay(to).toISOString().slice(0, 10)

  const live = orders.filter((o) => {
    if (!o.ambassadorId) return false
    if (EXCLUDED_STATUSES.includes(o.status.toLowerCase() as never)) return false
    const day = zonedDayStr(o.placedAt, tz)
    return day >= start && day <= end
  })

  const rows = ambassadors.map((person) => {
    const mine = live.filter((o) => o.ambassadorId === person.id)

    let sales = 0
    let commission = 0
    for (const o of mine) {
      sales += convert(o.netSales, o.currency, o.placedAt, displayCurrency, rates)
      commission += convert(pct(o.netSales, o.commissionRate), o.currency, o.placedAt, displayCurrency, rates)
    }

    return { rank: 0, ambassadorId: person.id, name: person.name, orders: mine.length, sales, commission }
  })

  rows.sort((a, b) => b.sales - a.sales)
  rows.forEach((row, i) => (row.rank = i + 1))
  return rows
}
