import { db } from '../db'
import { eachDay, utcDay } from '../dates'
import type { RateRow } from '../metrics/fx'

const DISPLAY = 'USD'

export type FrankfurterResponse = {
  base: string
  rates: Record<string, Record<string, number>>
}

/**
 * Frankfurter returns "1 USD = X NOK". The engine wants "1 NOK = ? USD",
 * so we invert. A zero rate is skipped rather than dividing by zero.
 */
export function parseFrankfurter(res: FrankfurterResponse): RateRow[] {
  const rows: RateRow[] = []

  for (const [day, perCurrency] of Object.entries(res.rates)) {
    const date = utcDay(new Date(day + 'T00:00:00Z'))

    // The display currency is always worth exactly one of itself.
    rows.push({ date, currency: DISPLAY, rate: 1 })

    for (const [currency, perUsd] of Object.entries(perCurrency)) {
      if (!perUsd) continue // 0 or NaN — skip, never divide by zero
      rows.push({ date, currency, rate: 1 / perUsd })
    }
  }
  return rows
}

/** Which days in [from,to] are not already covered by `have`? */
export function missingDays(from: Date, to: Date, have: Date[]): Date[] {
  const known = new Set(have.map((d) => utcDay(d).toISOString().slice(0, 10)))
  return eachDay(from, to).filter((d) => !known.has(d.toISOString().slice(0, 10)))
}

/**
 * Make sure we hold rates for every day in the range, fetching only the gaps.
 * Called before computing metrics.
 */
export async function ensureRates(from: Date, to: Date, currencies: string[]): Promise<void> {
  const wanted = currencies.filter((c) => c !== DISPLAY)
  if (wanted.length === 0) return

  const existing = await db.fxRate.findMany({
    where: { quote: DISPLAY, date: { gte: utcDay(from), lte: utcDay(to) } },
    select: { date: true },
    distinct: ['date'],
  })

  const gaps = missingDays(from, to, existing.map((r) => r.date))
  if (gaps.length === 0) return

  const start = gaps[0].toISOString().slice(0, 10)
  const end = gaps[gaps.length - 1].toISOString().slice(0, 10)
  const url = `https://api.frankfurter.app/${start}..${end}?from=${DISPLAY}&to=${wanted.join(',')}`

  try {
    const res = await fetch(url)
    if (!res.ok) return // leave the gap; convert() falls back to the nearest earlier rate
    const rows = parseFrankfurter((await res.json()) as FrankfurterResponse)

    await db.$transaction(
      rows.map((r) =>
        db.fxRate.upsert({
          where: { date_base_quote: { date: r.date, base: r.currency, quote: DISPLAY } },
          create: { date: r.date, base: r.currency, quote: DISPLAY, rate: r.rate },
          update: { rate: r.rate },
        }),
      ),
    )
  } catch {
    // Offline or the source is down. Not fatal: convert() falls back to the
    // nearest earlier rate, and the figure is shown as approximate.
  }
}

/** Load every rate we hold, as the engine's RateRow shape. */
export async function loadRates(): Promise<RateRow[]> {
  const rows = await db.fxRate.findMany({ where: { quote: DISPLAY } })
  return rows.map((r) => ({ date: r.date, currency: r.base, rate: r.rate }))
}
