import { utcDay } from '../dates'
import { mulRate } from '../money'
import type { RateTable } from './types'

export type RateRow = { date: Date; currency: string; rate: number }

const key = (d: Date) => utcDay(d).toISOString().slice(0, 10)

/** Build the lookup used by `convert`. A rate means "1 unit of currency = rate USD". */
export function buildRateTable(rows: RateRow[]): RateTable {
  const table: RateTable = new Map()
  for (const row of rows) {
    const k = key(row.date)
    if (!table.has(k)) table.set(k, new Map())
    table.get(k)!.set(row.currency, row.rate)
  }
  return table
}

/**
 * Convert `amount` (minor units, in `from` currency) into `display` currency using
 * the rate that applied ON `date`.
 *
 * Missing that exact day we walk backwards to the most recent earlier rate; if the
 * date predates every rate we hold, we use the earliest one. An entirely unknown
 * currency is returned unchanged rather than zeroed — an unconverted number is
 * honest, a zero would hide real money.
 */
export function convert(
  amount: number,
  from: string,
  date: Date,
  display: string,
  rates: RateTable,
): number {
  if (from === display) return amount

  const wanted = key(date)
  const days = [...rates.keys()].sort()

  // The most recent day at or before `date` that has a rate for this currency.
  let chosen: number | undefined
  for (const day of days) {
    if (day > wanted) break
    const r = rates.get(day)?.get(from)
    if (r !== undefined) chosen = r
  }

  // Nothing at or before it: fall forward to the earliest rate we know.
  if (chosen === undefined) {
    for (const day of days) {
      const r = rates.get(day)?.get(from)
      if (r !== undefined) {
        chosen = r
        break
      }
    }
  }

  if (chosen === undefined) return amount // unknown currency — never zero it out
  return mulRate(amount, chosen)
}
