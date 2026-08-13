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

  const centre = day.getTime() - 365 * DAY
  const half = (SEASON_WINDOW_DAYS / 2) * DAY
  const inWindow = unitsBetween(sales, centre - half, centre + half)

  const yearTo = centre + half
  const overYear = unitsBetween(sales, yearTo - 365 * DAY, yearTo)
  if (overYear === 0) return 1

  const expected = (overYear / 365) * SEASON_WINDOW_DAYS
  if (expected === 0) return 1

  return Math.min(INDEX_MAX, Math.max(INDEX_MIN, inWindow / expected))
}
