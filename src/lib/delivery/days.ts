import { zoneDayEndUtc, zonedDayStr } from '../tz'

/**
 * Business-day arithmetic on plain 'yyyy-mm-dd' strings.
 *
 * Business days rather than calendar days because a Friday-afternoon order with
 * a three-day promise is not late on Monday. Counting calendar days would mark
 * every weekend order late and fill the Slack channel with noise nobody can act
 * on, which is exactly the failure that makes people mute an alert channel.
 *
 * PUBLIC HOLIDAYS ARE NOT MODELLED. Constitution Day and Christmas will produce
 * a handful of false lates. That is a stated limitation, not an oversight - see
 * the spec. If it proves to matter, a holiday table goes in here and nowhere
 * else.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Parse and re-emit as 'yyyy-mm-dd' via UTC, so no local zone can shift a date. */
const toUtc = (day: string) => new Date(`${day}T00:00:00Z`)
const toStr = (d: Date) => d.toISOString().slice(0, 10)

export function isBusinessDay(day: string): boolean {
  const dow = toUtc(day).getUTCDay()
  return dow !== 0 && dow !== 6
}

export function addCalendarDays(day: string, n: number): string {
  return toStr(new Date(toUtc(day).getTime() + n * DAY_MS))
}

/** `n` business days after `day`. Counting starts the day AFTER `day`. */
export function addBusinessDays(day: string, n: number): string {
  let current = day
  let left = n
  while (left > 0) {
    current = addCalendarDays(current, 1)
    if (isBusinessDay(current)) left--
  }
  return current
}

/**
 * When this order stops being on time: the LAST INSTANT of the due day in the
 * shop's timezone.
 *
 * End of day, not the same clock time: an order placed at 16:00 with a
 * three-day promise is not late at 16:01 three days later, and treating it that
 * way would alert on parcels being delivered that same afternoon.
 */
export function deadlineFor(
  placedAt: Date,
  days: number,
  businessDays: boolean,
  tz: string,
): Date {
  const placedDay = zonedDayStr(placedAt, tz)
  const dueDay = businessDays
    ? addBusinessDays(placedDay, days)
    : addCalendarDays(placedDay, days)
  return zoneDayEndUtc(dueDay, tz)
}

/**
 * Calendar days elapsed between two instants, counted by the DAY each falls on
 * in `tz` - not by dividing milliseconds. An order placed at 23:00 and
 * delivered at 01:00 two nights later took two days, not one and a bit.
 */
export function daysBetween(from: Date, to: Date, tz: string): number {
  const a = toUtc(zonedDayStr(from, tz)).getTime()
  const b = toUtc(zonedDayStr(to, tz)).getTime()
  return Math.round((b - a) / DAY_MS)
}
