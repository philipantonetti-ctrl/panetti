/**
 * Everything here works in UTC and treats a "day" as a whole calendar day.
 * Ranges are INCLUSIVE of both ends: 1 Jul -> 1 Jul is one day.
 */

export type DateRange = { from: Date; to: Date }

export type Preset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'this_year'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'

const DAY_MS = 24 * 60 * 60 * 1000

/** Strip the time — the UTC midnight that starts this date's day. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Inclusive day count. */
export function daysInRange(from: Date, to: Date): number {
  const a = utcDay(from).getTime()
  const b = utcDay(to).getTime()
  if (b < a) return 0
  return Math.round((b - a) / DAY_MS) + 1
}

/** Every day in the range, inclusive. */
export function eachDay(from: Date, to: Date): Date[] {
  const out: Date[] = []
  const end = utcDay(to).getTime()
  for (let t = utcDay(from).getTime(); t <= end; t += DAY_MS) out.push(new Date(t))
  return out
}

/** How many days are in the calendar month that `d` falls in (handles leap years). */
export function daysInMonthOf(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

/** How many days are in the calendar year that `d` falls in. */
export function daysInYearOf(d: Date): number {
  const y = d.getUTCFullYear()
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return isLeap ? 366 : 365
}

export function resolvePreset(preset: Preset, now: Date = new Date()): DateRange {
  const today = utcDay(now)
  const shift = (days: number) => new Date(today.getTime() + days * DAY_MS)

  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday':
      return { from: shift(-1), to: shift(-1) }
    case 'this_week': {
      // Week starts Monday.
      const dow = (today.getUTCDay() + 6) % 7
      return { from: shift(-dow), to: today }
    }
    case 'this_month':
      return { from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), to: today }
    case 'this_year':
      return { from: new Date(Date.UTC(today.getUTCFullYear(), 0, 1)), to: today }
    case 'last_7_days':
      return { from: shift(-6), to: today } // inclusive of today = 7 days
    case 'last_30_days':
      return { from: shift(-29), to: today }
    case 'last_90_days':
      return { from: shift(-89), to: today }
  }
}

export const PRESET_LABELS: Record<Preset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  this_month: 'This month',
  this_year: 'This year',
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
}
