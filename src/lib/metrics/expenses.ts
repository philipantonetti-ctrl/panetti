import { eachDay, utcDay, daysInMonthOf, daysInYearOf } from '../dates'
import type { EngineExpense } from './types'

/**
 * How much of `expense` falls inside [from, to]?
 *
 * Recurring expenses are converted to a DAILY amount and charged per active day.
 * A month's daily amount depends on that month's own length, so February and July
 * are each charged correctly — which is why we walk day by day instead of
 * multiplying by an average.
 *
 * A ONE_TIME expense lands entirely on its startDate.
 *
 * Returns minor units in the EXPENSE'S OWN currency. Converting to the display
 * currency is the caller's job (see fx.ts).
 */
export function expenseInRange(expense: EngineExpense, from: Date, to: Date): number {
  if (!expense.active) return 0

  const start = utcDay(expense.startDate).getTime()
  const end = expense.endDate ? utcDay(expense.endDate).getTime() : null

  if (expense.recurrence === 'ONE_TIME') {
    const rangeStart = utcDay(from).getTime()
    const rangeEnd = utcDay(to).getTime()
    return start >= rangeStart && start <= rangeEnd ? expense.amount : 0
  }

  // Accumulate the EXACT daily share and round only the running total, so a full
  // period sums to exactly the period's amount and no øre goes missing.
  let exact = 0
  for (const day of eachDay(from, to)) {
    const t = day.getTime()
    if (t < start) continue // hadn't started yet
    if (end !== null && t > end) continue // already ended
    exact += exactDailyAmount(expense, day)
  }
  return Math.round(exact)
}

/** The expense's exact (unrounded) share of a single day. */
function exactDailyAmount(expense: EngineExpense, day: Date): number {
  switch (expense.recurrence) {
    case 'DAILY':
      return expense.amount
    case 'WEEKLY':
      return expense.amount / 7
    case 'MONTHLY':
      return expense.amount / daysInMonthOf(day)
    case 'YEARLY':
      return expense.amount / daysInYearOf(day)
    case 'ONE_TIME':
      return 0 // handled above
  }
}
