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
 * Per-currency, the days we hold a rate for (ascending) and the matching rates.
 * `rateOn` runs for every money conversion — tens of thousands per request — so
 * a per-call scan of the whole table dominated the compute. This index is built
 * once and binary-searched instead. The table is rebuilt per request, so a
 * WeakMap keyed on it caches for exactly that long.
 */
type CurrencyIndex = Map<string, { days: string[]; rates: number[] }>
const indexCache = new WeakMap<RateTable, CurrencyIndex>()

function currencyIndex(rates: RateTable): CurrencyIndex {
  const cached = indexCache.get(rates)
  if (cached) return cached

  const index: CurrencyIndex = new Map()
  for (const day of [...rates.keys()].sort()) {
    for (const [currency, rate] of rates.get(day)!) {
      let entry = index.get(currency)
      if (!entry) {
        entry = { days: [], rates: [] }
        index.set(currency, entry)
      }
      entry.days.push(day) // days are visited in ascending order
      entry.rates.push(rate)
    }
  }
  indexCache.set(rates, index)
  return index
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
  const entry = currencyIndex(rates).get(currency)
  if (!entry) return undefined // a currency we hold no rate for at all

  const wanted = key(date)
  const { days, rates: values } = entry

  // Binary search for the latest day <= wanted (the nearest earlier rate).
  let lo = 0
  let hi = days.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (days[mid] <= wanted) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  // Before every rate we hold: fall back to the earliest one.
  return found >= 0 ? values[found] : values[0]
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
