import { utcDay } from './dates'

/**
 * An operational expense's lifecycle, as the Add Expense modal offers it.
 *
 * The important part: an expense that has ENDED is NOT switched off — it keeps its end
 * date. That way the months it actually ran are still charged, and last quarter's profit
 * never silently changes. "Off" would erase it from history.
 */

export const EXPENSE_STATUSES = ['ACTIVE', 'ENDED', 'ACTIVE_WITH_END_DATE'] as const

export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number]

export const EXPENSE_STATUS_LABEL: Record<ExpenseStatus, string> = {
  ACTIVE: 'Active',
  ENDED: 'Ended',
  ACTIVE_WITH_END_DATE: 'Active with End Date',
}

/** What to store for the status the user picked. */
export function fieldsForStatus(
  status: ExpenseStatus,
  endDate?: string | null,
): { active: boolean; endDate: Date | null } {
  if (status === 'ACTIVE') return { active: true, endDate: null }

  // Both ENDED and ACTIVE_WITH_END_DATE simply have an end date; whether it is in the
  // past or the future is what tells them apart when we read it back.
  const parsed = endDate ? new Date(endDate) : null
  const valid = parsed && !Number.isNaN(parsed.getTime()) ? utcDay(parsed) : null

  return { active: true, endDate: valid }
}

/** Read the status back off a stored expense. */
export function statusOf(expense: { endDate: Date | null }, today: Date = new Date()): ExpenseStatus {
  if (!expense.endDate) return 'ACTIVE'
  return utcDay(expense.endDate).getTime() < utcDay(today).getTime() ? 'ENDED' : 'ACTIVE_WITH_END_DATE'
}
