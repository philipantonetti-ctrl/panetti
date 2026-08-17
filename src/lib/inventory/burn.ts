export type Sale = { day: Date; units: number }

const DAY = 86_400_000

/** How far back the current rate is measured. */
export const BURN_WINDOW_DAYS = 60

/**
 * A year plus margin. Below this a SKU has no "same time last year" to compare
 * against, whatever the shop's age — Panetti Germany opened in September 2025.
 */
export const SEASON_MIN_HISTORY_DAYS = 400

/** Width of the comparison window, centred on the target date a year back. */
export const SEASON_WINDOW_DAYS = 28

/** One freak week must not be allowed to order a container. */
const INDEX_MIN = 0.25
const INDEX_MAX = 4

/** Named because it appears in both the lookback and the baseline width. */
const DAYS_PER_YEAR = 365

const unitsBetween = (sales: Sale[], from: number, to: number): number =>
  sales.reduce((n, s) => (s.day.getTime() >= from && s.day.getTime() < to ? n + s.units : n), 0)

/**
 * Units sold per day, right now, summed across every shop.
 *
 * Across shops because the stores mirror ONE warehouse: what empties it is total
 * demand, not any single country's.
 */
export function dailyBurn(sales: Sale[], today: Date): number {
  const to = today.getTime() + DAY
  return unitsBetween(sales, to - BURN_WINDOW_DAYS * DAY, to) / BURN_WINDOW_DAYS
}

/**
 * The same rate with the season taken out of it.
 *
 * `dailyBurn` answers "what is selling right now", which is the right answer for
 * a column headed Per day and the wrong one to project forward. A rate measured
 * inside Black Week is a Black Week rate; multiplying it by NEXT Black Week's
 * index counts the season twice, and the forecast orders for two Christmases.
 * Measured inside a lull it does the reverse and orders for none.
 *
 * So divide the window's units by the SUM OF ITS OWN INDICES rather than by its
 * day count: 120 units sold across a stretch running at twice the yearly average
 * is an underlying rate of 1 a day, not 2. `forecast()` then multiplies this back
 * by the index of each future day, and the season is applied exactly once.
 *
 * This is also where growth enters the forecast, without anybody computing a
 * growth rate. The level is read from what sold in the last sixty days, so a
 * business trading 15% above last year has a level 15% above last year's, and
 * every future day inherits that 15% on top of last year's shape. That is the
 * whole mechanism: current trading, last year's calendar.
 *
 * The index is passed in rather than computed here for the same reason
 * `forecast()` takes one — it makes the arithmetic testable against a known
 * season instead of against a fixture of two years of sales.
 */
export function seasonalLevel(sales: Sale[], today: Date, index: (day: Date) => number): number {
  const to = today.getTime() + DAY
  const from = to - BURN_WINDOW_DAYS * DAY

  let weight = 0
  for (let i = 0; i < BURN_WINDOW_DAYS; i++) weight += index(new Date(from + i * DAY))

  // seasonalIndex clamps to 0.25 at the bottom and never returns 0, so this
  // cannot divide by zero. Guarded anyway: a caller passing its own index
  // function is not bound by that promise.
  if (weight <= 0) return 0
  return unitsBetween(sales, from, to) / weight
}

/**
 * How this period compares with the same period a year ago.
 *
 * The SAME calendar days, a year apart, so the comparison carries no season of
 * its own — a November measured against a November. That makes it the growth
 * figure the forecast is already applying: the level is this window's rate with
 * the season removed, so multiplying it by a future day's index works out to
 * last year's sales on that day times exactly this ratio. Showing it is showing
 * the mechanism, not decorating it.
 *
 * Null rather than a number in the two cases where a figure would be a lie:
 * when the history does not cover the whole of last year's window (a shop open
 * thirteen months would be dividing by a part-window and reporting growth that
 * never happened), and when that window sold nothing at all — growing from
 * nothing is not a percentage, the same call `deltaPct` makes.
 */
export function yearOverYear(sales: Sale[], today: Date): number | null {
  if (sales.length === 0) return null

  const to = today.getTime() + DAY
  const from = to - BURN_WINDOW_DAYS * DAY
  const wasTo = to - DAYS_PER_YEAR * DAY
  const wasFrom = from - DAYS_PER_YEAR * DAY

  const oldest = Math.min(...sales.map((s) => s.day.getTime()))
  if (oldest > wasFrom) return null

  const earlier = unitsBetween(sales, wasFrom, wasTo)
  if (earlier <= 0) return null

  return unitsBetween(sales, from, to) / earlier - 1
}

/** True when this SKU has a last year worth comparing against. */
export function hasSeasonalHistory(sales: Sale[], today: Date): boolean {
  if (sales.length === 0) return false
  const oldest = Math.min(...sales.map((s) => s.day.getTime()))
  return today.getTime() - oldest >= SEASON_MIN_HISTORY_DAYS * DAY
}

/**
 * How much busier than average this date was a year ago.
 *
 * Returns exactly 1 when there is not enough history — a flat rate stated
 * honestly, rather than a seasonal shape invented from ten months of data. The
 * caller shows "no seasonal history yet" on those rows.
 */
export function seasonalIndex(sales: Sale[], day: Date, today: Date): number {
  if (!hasSeasonalHistory(sales, today)) return 1

  const centre = day.getTime() - DAYS_PER_YEAR * DAY
  const half = (SEASON_WINDOW_DAYS / 2) * DAY
  const inWindow = unitsBetween(sales, centre - half, centre + half)

  const yearTo = centre + half
  const overYear = unitsBetween(sales, yearTo - DAYS_PER_YEAR * DAY, yearTo)
  if (overYear === 0) return 1

  // The baseline must not include the window it is judging. `inWindow` is the
  // most recent 28 days of `overYear`, so leaving it in measures the period
  // against itself: a busy month lifts its own baseline and reports calmer than
  // it was. Taking it out makes a truly 4x period read as 4x rather than 3.25x.
  const baselineUnits = overYear - inWindow
  if (baselineUnits <= 0) return 1 // nothing outside the window to compare against

  const expected = (baselineUnits / (DAYS_PER_YEAR - SEASON_WINDOW_DAYS)) * SEASON_WINDOW_DAYS

  return Math.min(INDEX_MAX, Math.max(INDEX_MIN, inWindow / expected))
}
