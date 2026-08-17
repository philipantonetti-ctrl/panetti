import type { Forecast } from './forecast'

const DAY = 86_400_000

/**
 * How far ahead a suggestion looks.
 *
 * A month, because that is the horizon a purchase decision actually sits on: far
 * enough that a container can still be booked, near enough that the list is
 * short. Everything beyond it is already in the table, sorted by run-out date,
 * where it can be read at leisure.
 */
export const TIP_WINDOW_DAYS = 30

/**
 * The parts of an inventory row a suggestion is built from.
 *
 * Narrower than `InventoryRow` on purpose: this file has no business knowing
 * about stock votes or country splits, and a narrow shape is a fixture a test
 * can write in four lines. Every InventoryRow satisfies it.
 */
export type ReorderCandidate = {
  sku: string
  name: string
  supplierName: string | null
  forecast: Pick<Forecast, 'orderBy' | 'daysLate' | 'quantity' | 'needed' | 'raisedBy'>
}

export type ReorderTip = {
  sku: string
  name: string
  supplierName: string | null
  /** How many to order. Already at or above the minimum, already rounded. */
  quantity: number
  /** What demand alone called for, before the minimum and the container. */
  needed: number
  /** Which rule lifted `quantity` above `needed`. Null when demand set it. */
  raisedBy: 'minimum' | 'container' | null
  orderBy: Date
  /** Days the order date is already past. Null while it is still ahead. */
  daysLate: number | null
  /** Whole days until the order date. Zero once it is today or behind us. */
  daysUntil: number
}

/**
 * What to order, and by when.
 *
 * Everything here was already computed by `forecast()`; this only decides what
 * is worth interrupting someone about and in what order. The client asked to be
 * told when to place an order rather than to go and work it out from a table,
 * and a suggestion he has to find is not a suggestion.
 *
 * A row with no order-by date is never a tip. That state means nobody has
 * entered lead times, which is one settings job said once — repeating it as
 * nineteen suggestions would bury the products that genuinely need ordering.
 */
export function reorderTips(
  rows: ReorderCandidate[],
  today: Date,
  withinDays: number = TIP_WINDOW_DAYS,
): ReorderTip[] {
  // Floored to UTC days on both sides, matching how forecast() normalises every
  // date it produces. Anything else makes "due today" depend on the reader's
  // clock rather than on the data.
  const startOfToday = Math.floor(today.getTime() / DAY)
  const cutoff = startOfToday + withinDays

  const tips: ReorderTip[] = []
  for (const row of rows) {
    const { orderBy, quantity, needed } = row.forecast
    if (!orderBy || quantity === null || needed === null) continue

    const day = Math.floor(orderBy.getTime() / DAY)
    if (day > cutoff) continue

    tips.push({
      sku: row.sku,
      name: row.name,
      supplierName: row.supplierName,
      quantity,
      needed,
      raisedBy: row.forecast.raisedBy,
      orderBy,
      daysLate: row.forecast.daysLate,
      daysUntil: Math.max(0, day - startOfToday),
    })
  }

  // Soonest first, and by SKU where two fall on the same day, so the list does
  // not reshuffle between two loads of the same data.
  return tips.sort(
    (a, b) => a.orderBy.getTime() - b.orderBy.getTime() || a.sku.localeCompare(b.sku),
  )
}
