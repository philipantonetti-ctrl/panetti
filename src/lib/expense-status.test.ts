import { describe, it, expect } from 'vitest'
import { fieldsForStatus, statusOf, EXPENSE_STATUSES } from './expense-status'
import { expenseInRange } from './metrics/expenses'
import type { EngineExpense } from './metrics/types'

const TODAY = new Date('2026-07-14')
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

describe('expense status', () => {
  it('offers exactly the three statuses BeProfit does', () => {
    expect(EXPENSE_STATUSES).toEqual(['ACTIVE', 'ENDED', 'ACTIVE_WITH_END_DATE'])
  })

  it('Active runs indefinitely — no end date', () => {
    expect(fieldsForStatus('ACTIVE', '2026-09-01')).toEqual({ active: true, endDate: null })
  })

  it('Active with End Date keeps the end date', () => {
    const f = fieldsForStatus('ACTIVE_WITH_END_DATE', '2026-09-01')
    expect(f.active).toBe(true)
    expect(day(f.endDate)).toBe('2026-09-01')
  })

  it('Ended keeps the end date too, so the months it ran still count', () => {
    const f = fieldsForStatus('ENDED', '2026-03-31')
    expect(day(f.endDate)).toBe('2026-03-31')
  })

  it('reads back as Active when there is no end date', () => {
    expect(statusOf({ endDate: null }, TODAY)).toBe('ACTIVE')
  })

  it('reads back as Ended once the end date has passed', () => {
    expect(statusOf({ endDate: new Date('2026-03-31') }, TODAY)).toBe('ENDED')
  })

  it('reads back as Active with End Date while the end date is still ahead', () => {
    expect(statusOf({ endDate: new Date('2026-09-01') }, TODAY)).toBe('ACTIVE_WITH_END_DATE')
  })
})

/**
 * The point of storing an end date instead of just switching an expense off:
 * an expense that has ENDED must still be charged to the period it actually ran.
 * Otherwise last quarter's profit would silently change.
 */
describe('an ended expense and history', () => {
  const ended: EngineExpense = {
    id: 'e1',
    shopId: 's1',
    amount: 3100000, // 31 000 kr / month -> 1 000 kr a day in a 31-day month
    currency: 'NOK',
    recurrence: 'MONTHLY',
    startDate: new Date('2026-01-01'),
    ...fieldsForStatus('ENDED', '2026-03-31'),
  }

  it('still counts for the months it ran', () => {
    // All of March: it was running, so the full month is charged.
    expect(expenseInRange(ended, new Date('2026-03-01'), new Date('2026-03-31'))).toBe(3100000)
  })

  it('charges nothing after it ended', () => {
    expect(expenseInRange(ended, new Date('2026-04-01'), new Date('2026-04-30'))).toBe(0)
  })

  it('charges only the days before it ended when the range straddles the end', () => {
    // Ends 31 Mar; a 1 Mar - 30 Apr view charges only March.
    expect(expenseInRange(ended, new Date('2026-03-01'), new Date('2026-04-30'))).toBe(3100000)
  })
})
