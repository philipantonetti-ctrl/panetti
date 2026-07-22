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
 * The table's day-keys, sorted once and reused. `rateOn` runs for every money
 * conversion — tens of thousands per request — so re-sorting the keys each time
 * (an allocation and an O(n log n) sort) dominated the whole compute. The table
 * is rebuilt per request, so a WeakMap keyed on it caches for exactly that long.
 */
const sortedDaysCache = new WeakMap<RateTable, string[]>()
function sortedDays(rates: RateTable): string[] {
  let days = sortedDaysCache.get(rates)
  if (!days) {
    days = [...rates.keys()].sort()
    sortedDaysCache.set(rates, days)
  }
  return days
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
/** The USD rate for `currency` on `date`: that day's, else the nearest earlier, else the earliest known. */
function rateOn(currency: string, date: Date, rates: RateTable): number | undefined {
  const wanted = key(date)
  const days = sortedDays(rates)

  let chosen: number | undefined
  for (const day of days) {
    if (day > wanted) break
    const r = rates.get(day)?.get(currency)
    if (r !== undefined) chosen = r
  }
  if (chosen === undefined) {
    for (const day of days) {
      const r = rates.get(day)?.get(currency)
      if (r !== undefined) {
        chosen = r
        break
      }
    }
  }
  return chosen
}

export function convert(
  amount: number,
  from: string,
  date: Date,
  display: string,
  rates: RateTable,
): number {
  if (from === display) return amount
  const chosen = rateOn(from, date, rates)
  if (chosen === undefined) return amount // unknown currency — never zero it out
  return mulRate(amount, chosen)
}

/**
 * Convert between two arbitrary currencies via their USD legs — needed when a
 * fee fixed in EUR lands on a NOK order shown in NOK. Missing either leg, the
 * amount passes through unchanged (honest, never zeroed).
 */
export function crossConvert(
  amount: number,
  from: string,
  to: string,
  date: Date,
  rates: RateTable,
): number {
  if (from === to) return amount
  if (to === 'USD') return convert(amount, from, date, to, rates)
  const fromUsd = from === 'USD' ? 1 : rateOn(from, date, rates)
  const toUsd = rateOn(to, date, rates)
  if (fromUsd === undefined || toUsd === undefined || toUsd === 0) return amount
  return mulRate(amount, fromUsd / toUsd)
}
