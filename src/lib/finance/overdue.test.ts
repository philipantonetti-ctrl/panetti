import { describe, expect, it } from 'vitest'
import { daysOverdue, overdueOn, totalsByCurrency, type OpenItem } from './overdue'

const TODAY = new Date('2026-08-18T00:00:00Z')

const item = (over: Partial<OpenItem> = {}): OpenItem => ({
  referenceNumber: '123194',
  customerName: 'Konfliktrådene',
  dueDate: new Date('2026-01-16T00:00:00Z'),
  currency: 'NOK',
  balance: 3999900,
  ...over,
})

describe('daysOverdue', () => {
  it('counts the days since the due date', () => {
    expect(daysOverdue(item({ dueDate: new Date('2026-08-08T00:00:00Z') }), TODAY)).toBe(10)
  })

  it('is null on an invoice not yet due', () => {
    expect(daysOverdue(item({ dueDate: new Date('2026-09-01T00:00:00Z') }), TODAY)).toBeNull()
  })

  /** Due today is not late. Someone has until the end of the day to pay it. */
  it('is null on the due date itself', () => {
    expect(daysOverdue(item({ dueDate: TODAY }), TODAY)).toBeNull()
  })

  /**
   * Null, never zero. An invoice Visma gave no due date cannot be late, and
   * treating a missing field as "due now" would invent an overdue invoice.
   */
  it('is null when there is no due date at all', () => {
    expect(daysOverdue(item({ dueDate: null }), TODAY)).toBeNull()
  })
})

describe('overdueOn', () => {
  it('keeps only what is past its due date', () => {
    const rows = overdueOn(
      [
        item({ referenceNumber: 'late', dueDate: new Date('2026-08-01T00:00:00Z') }),
        item({ referenceNumber: 'soon', dueDate: new Date('2026-09-01T00:00:00Z') }),
        item({ referenceNumber: 'undated', dueDate: null }),
      ],
      TODAY,
    )

    expect(rows.map((r) => r.referenceNumber)).toEqual(['late'])
  })

  /** Worst first: the list is read top-down and the oldest debt is the story. */
  it('puts the most overdue first', () => {
    const rows = overdueOn(
      [
        item({ referenceNumber: 'b', dueDate: new Date('2026-08-01T00:00:00Z') }),
        item({ referenceNumber: 'a', dueDate: new Date('2023-02-01T00:00:00Z') }),
        item({ referenceNumber: 'c', dueDate: new Date('2026-08-17T00:00:00Z') }),
      ],
      TODAY,
    )

    expect(rows.map((r) => r.referenceNumber)).toEqual(['a', 'b', 'c'])
  })

  it('finds nothing in an empty ledger', () => {
    expect(overdueOn([], TODAY)).toEqual([])
  })
})

describe('totalsByCurrency', () => {
  /**
   * Per currency, never one number. The six real open invoices span NOK, SEK,
   * DKK and EUR, and adding them together would be arithmetic on four different
   * things.
   */
  it('totals each currency on its own', () => {
    const totals = totalsByCurrency([
      item({ currency: 'NOK', balance: 3999900 }),
      item({ currency: 'NOK', balance: 2325000 }),
      item({ currency: 'SEK', balance: 4499900 }),
    ])

    expect(totals).toEqual([
      { currency: 'NOK', total: 6324900 },
      { currency: 'SEK', total: 4499900 },
    ])
  })

  it('orders the biggest debt first', () => {
    const totals = totalsByCurrency([
      item({ currency: 'EUR', balance: 39900 }),
      item({ currency: 'NOK', balance: 6324900 }),
    ])

    expect(totals.map((t) => t.currency)).toEqual(['NOK', 'EUR'])
  })

  it('has nothing to total when nothing is owed', () => {
    expect(totalsByCurrency([])).toEqual([])
  })
})
