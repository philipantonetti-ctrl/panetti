import { wallClock, zoneTimeUtc } from '../tz'
import { addCalendarDays, isBusinessDay } from './days'

/**
 * When a warehouse file should first have carried an order's tracking number.
 *
 * Until that moment an order with no parcel is not a problem, it is simply too
 * new: the file that would have mentioned it has not been produced yet. The
 * Delivery page counted those orders as "No tracking" from the second they were
 * placed, so every order of the last day and a half sat in a list headed "no
 * warehouse file has mentioned these", which was true of them and true of
 * nothing being wrong.
 *
 * Two facts about the operation decide it, both from the client:
 *
 *   Customer order cutoff:     12:00, same-day dispatch is promised before it
 *   Warehouse tracking import: once daily, 18:00
 *
 * So an order placed before noon is expected in THAT evening's file, and one
 * placed after noon in the NEXT one.
 */

/** Same-day dispatch is promised only before this hour, local. */
export const ORDER_CUTOFF_HOUR = 12

/** The warehouse produces its End-of-Day export at this hour, local. */
export const FILE_HOUR = 18

const FILE_TIME = `${String(FILE_HOUR).padStart(2, '0')}:00:00`

/**
 * The instant the order's first expected file exists, in `tz`.
 *
 * `tz` is the shop's own zone, which for every shop here is CET. Local clock
 * time throughout, so the answer is 18:00 on the ground in both summer and
 * winter rather than a fixed UTC offset that drifts by an hour twice a year.
 */
export function trackingDueAt(placedAt: Date, tz: string): Date {
  const wall = wallClock(placedAt, tz) // 'yyyy-mm-ddTHH:mm:ss'
  const placedDay = wall.slice(0, 10)
  const hour = Number(wall.slice(11, 13))

  // Noon itself is not "before 12:00". An off-by-one here moves a whole day of
  // orders into the wrong file without anything looking broken.
  let dispatchDay = hour < ORDER_CUTOFF_HOUR ? placedDay : addCalendarDays(placedDay, 1)

  /**
   * The warehouse is closed at the weekend, so no file is produced and an
   * order that would dispatch into one waits for Monday's.
   *
   * ASKED, not assumed, and both ways round. Shipped first as business days on
   * my own reasoning, then flipped to calendar days on a misreading, then
   * settled by the client in his own words on 2026-08-20: "We only get
   * tracking link week days", "Warehouse is closed saturdays and sundays".
   * His six tabled rows are all Wednesday to Friday and passed under every one
   * of those three rules, so the tests could never have decided it.
   *
   * Public holidays are not modelled, the same stated limitation days.ts
   * carries. A closed Constitution Day will produce a handful of orders flagged
   * a day early.
   */
  while (!isBusinessDay(dispatchDay)) dispatchDay = addCalendarDays(dispatchDay, 1)

  return zoneTimeUtc(dispatchDay, FILE_TIME, tz)
}
