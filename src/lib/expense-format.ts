import { utcDay } from './dates'

/** How the operational-expenses table describes an expense. */

/** 1 -> "1st", 22 -> "22nd", 11 -> "11th" (the teens are the trap). */
export function ordinal(n: number): string {
  const teen = n % 100
  if (teen >= 11 && teen <= 13) return `${n}th`

  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/** One stable date format everywhere, whatever the machine's locale: "14 Jul 2026". */
export function formatDay(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d)
}

/**
 * The small print under the recurrence, e.g. "on the 1st, spread daily".
 * "Spread daily" is the important part: a monthly cost is charged day by day, so
 * profit is right for any date range you look at — not just whole months.
 */
export function recurrenceDetail(recurrence: string, startDate: Date): string {
  const day = utcDay(startDate)

  switch (recurrence) {
    case 'MONTHLY':
      return `on the ${ordinal(day.getUTCDate())}, spread daily`
    case 'YEARLY': {
      const dayMonth = new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }).format(day)
      return `on ${dayMonth}, spread daily`
    }
    case 'WEEKLY':
      return 'spread daily'
    case 'DAILY':
      return 'every day'
    case 'ONE_TIME':
      return `one-off on ${formatDay(day)}`
    default:
      return ''
  }
}

/** When the expense stops. "N/A" while it is still running. */
export function finalPayment(endDate: Date | null): string {
  return endDate ? formatDay(endDate) : 'N/A'
}
