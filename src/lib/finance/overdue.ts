/**
 * What is overdue, and by how much.
 *
 * Pure arithmetic over a snapshot of Visma's ledger, shared by the finance page
 * and the Slack warning so the two can never disagree about what "overdue"
 * means — the same reason `promiseOn` is shared by the delivery page and its
 * alerts.
 */

const DAY_MS = 86_400_000

/** The part of a receivable this file needs. Anything wider is the caller's. */
export type OpenItem = {
  referenceNumber: string
  customerName: string
  /** Null when Visma reported none. Such a document is never late. */
  dueDate: Date | null
  currency: string
  /** Minor units, in `currency`. */
  balance: number
}

/**
 * Days past due, or null when it is not late.
 *
 * Null rather than 0 or a negative, because "not late" and "late by nothing"
 * are different facts and only one of them belongs on a warning list. Due
 * today counts as not late: there is still a day left to pay it.
 */
export function daysOverdue(item: OpenItem, now: Date): number | null {
  if (!item.dueDate) return null
  const days = Math.floor((now.getTime() - item.dueDate.getTime()) / DAY_MS)
  return days > 0 ? days : null
}

/** Everything past its due date, worst first. */
export function overdueOn<T extends OpenItem>(items: T[], now: Date): T[] {
  return items
    .filter((i) => daysOverdue(i, now) !== null)
    .sort((a, b) => (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0))
}

/**
 * What is owed, one total per currency, biggest first.
 *
 * Never a single figure. The six open invoices span NOK, SEK, DKK and EUR, and
 * one number across four currencies is arithmetic on four different things.
 * Converting them would need a rate for the day each falls due, which is a
 * bigger claim than this page needs to make.
 */
export function totalsByCurrency(items: OpenItem[]): { currency: string; total: number }[] {
  const by = new Map<string, number>()
  for (const i of items) by.set(i.currency, (by.get(i.currency) ?? 0) + i.balance)
  return [...by]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => b.total - a.total)
}
