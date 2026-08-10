import { db } from '../db'
import { eachDay, utcDay } from '../dates'
import { isConvertible } from '../currencies'
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

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How far behind we tolerate before calling the rate provider.
 *
 * Markets are shut at weekends and on holidays, so those days have no rate
 * ANYWHERE and can never be filled. Demanding a row for every calendar day
 * meant every dashboard load called an external API that could not help — on
 * every request, forever. `convert()` already falls back to the nearest earlier
 * rate, so a gap costs nothing; only being genuinely behind is worth a call.
 */
const FRESH_DAYS = 4

/**
 * ECB reference rates — the history Frankfurter serves — begin here. A range
 * whose `from` predates this can never gain a row before it, no matter how
 * many times we ask. The "held back to the start of the range" check just
 * below is bounded at whichever is LATER, `from` or this date, so that a
 * range starting before the provider's own history can still resolve to
 * "not missing" once we hold its earliest obtainable coverage — otherwise
 * `missingEntirely` would stay true forever for that range and reproduce the
 * exact FIX 1 problem (an external call on every request, forever) for a
 * request the provider could never satisfy either way.
 */
const PROVIDER_HISTORY_START = new Date('1999-01-04T00:00:00Z')

/**
 * Top up the rates we hold if they have fallen behind the range being asked
 * about. Called before computing metrics, and hourly by the scheduled sync so
 * that a user's request rarely has to do it at all.
 */
export async function ensureRates(from: Date, to: Date, currencies: string[]): Promise<void> {
  const wanted = currencies.filter((c) => c !== DISPLAY)
  if (wanted.length === 0) return

  const end = utcDay(to)

  // Only currencies Frankfurter can actually quote (src/lib/currencies.ts,
  // backed by the same ECB list) can ever gain a row. A currency it does not
  // quote — a B2B order invoiced in AED, say — would otherwise sit in
  // `wanted` forever with no row possible, keeping `missingEntirely` true on
  // every single request from here on: an external call that could not help,
  // on every request, forever. Such a currency is simply never "missing".
  const wantedConvertible = wanted.filter(isConvertible)

  // `newest` below only proves SOME currency was synced recently — it says
  // nothing about whether a specific `wanted` one was ever fetched. An
  // operator picking a display currency no shop or ad account trades in
  // (e.g. SEK, GBP) can hit this function while every OTHER currency is
  // fresh; without this check the freshness shortcut fires, that currency
  // gets no rows at all, and crossConvert (rateOn returning undefined) then
  // returns the amount unconverted — silently, reading as a real number.
  //
  // `held` is bounded to rows AT OR BEFORE the start of the range, not "ANY
  // row, ever": a currency that only just started being held (e.g. a display
  // currency switched on today) can hold rows for today while having NONE
  // for the range being viewed. Treating "any row anywhere" as sufficient let
  // that currency's rows for a PAST range go unfetched — rateOn then fell
  // back to the earliest row it did hold (today's), converting the whole of
  // history at today's rate. Bounded at the later of `from` and the
  // provider's own history start (see PROVIDER_HISTORY_START above).
  const from0 = utcDay(from)
  const heldBoundary = from0 < PROVIDER_HISTORY_START ? PROVIDER_HISTORY_START : from0

  // Strictly "AT OR BEFORE heldBoundary" is too strict: the provider (ECB via
  // Frankfurter) publishes no rate at all for weekends or holidays, so when a
  // viewed range STARTS on one of those days, the fetch that (correctly)
  // covers it writes its first row on the next trading day AFTER the start —
  // never ON or before it. A "<= heldBoundary" test then never matches, so
  // `missingEntirely` stays true and the SAME range gets re-fetched and
  // re-upserted on every subsequent request, forever: the exact "external
  // call that cannot help, on every request" failure FRESH_DAYS exists to
  // prevent, just reached from the held side instead of the freshness side.
  // So a currency counts as held once its EARLIEST row is at or before
  // `heldBoundary + FRESH_DAYS`: wide enough to absorb a weekend plus one
  // holiday sitting right at the start of the range, narrow enough that a
  // currency whose history genuinely begins much later (FIX 2's case — the
  // display currency switched on today, viewed against last year) still
  // counts as missing. Reusing FRESH_DAYS rather than a new constant keeps
  // "how stale is tolerable" answered in exactly one place.
  const heldTolerance = new Date(heldBoundary.getTime() + FRESH_DAYS * DAY_MS)
  const earliestHeld = await db.fxRate.groupBy({
    by: ['base'],
    where: { quote: DISPLAY, base: { in: wantedConvertible } },
    _min: { date: true },
  })
  const earliestByBase = new Map(earliestHeld.map((r) => [r.base, r._min.date]))
  const missingEntirely = wantedConvertible.some((c) => {
    const earliest = earliestByBase.get(c)
    return !earliest || earliest > heldTolerance
  })

  const newest = await db.fxRate.findFirst({
    where: { quote: DISPLAY, date: { lte: end } },
    orderBy: { date: 'desc' },
    select: { date: true },
  })

  if (
    !missingEntirely &&
    newest &&
    Math.round((end.getTime() - utcDay(newest.date).getTime()) / DAY_MS) <= FRESH_DAYS
  ) {
    return // current enough — nothing the provider could add
  }

  // Ask only for what is missing, and never for days before the range itself.
  // A currency missing entirely needs the WHOLE range fetched, not just since
  // the (otherwise irrelevant) newest row of some other currency — starting
  // from `newest` would cover it only from today onward and leave the rest
  // of the requested range unconverted.
  const startDay = !missingEntirely && newest
    ? new Date(Math.max(utcDay(from).getTime(), utcDay(newest.date).getTime() + DAY_MS))
    : utcDay(from)
  if (startDay > end) return

  const start = startDay.toISOString().slice(0, 10)
  const url = `https://api.frankfurter.app/${start}..${end.toISOString().slice(0, 10)}?from=${DISPLAY}&to=${wanted.join(',')}`

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
