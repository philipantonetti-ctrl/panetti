// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { FinanceClient, type FinanceRow } from './FinanceClient'

const TODAY = '2026-08-18T00:00:00.000Z'

const row = (over: Partial<FinanceRow> = {}): FinanceRow => ({
  referenceNumber: '123194',
  customerName: 'Konfliktrådene',
  documentType: 'Invoice',
  documentDate: '2025-12-17T00:00:00.000Z',
  dueDate: '2026-01-16T00:00:00.000Z',
  currency: 'NOK',
  balance: 3999900,
  ...over,
})

const show = (rows: FinanceRow[]) => render(<FinanceClient rows={rows} now={TODAY} />)

describe('FinanceClient', () => {
  it('says plainly when nobody owes anything', () => {
    show([])
    expect(screen.getByText(/Nothing is outstanding/)).toBeInTheDocument()
  })

  it('names the customer and what they owe', () => {
    show([row()])
    expect(screen.getByText('Konfliktrådene')).toBeInTheDocument()
    // Twice on purpose: once as the outstanding total, once on its own row.
    expect(screen.getAllByText(/39 999\.00 NOK/)).toHaveLength(2)
  })

  it('says how many days an invoice is overdue', () => {
    show([row({ dueDate: '2026-08-08T00:00:00.000Z' })])
    expect(screen.getByText(/10 days overdue/)).toBeInTheDocument()
  })

  /** An invoice with time left is not a problem and must not be dressed as one. */
  it('does not call an invoice overdue before its due date', () => {
    show([row({ dueDate: '2026-09-01T00:00:00.000Z' })])
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
    expect(screen.getByText(/due 1 Sep 2026/)).toBeInTheDocument()
  })

  /**
   * Null, not "today". Visma leaves a due date off some documents and treating
   * that as due now would invent an overdue invoice out of a missing field.
   */
  it('says an invoice has no due date rather than guessing one', () => {
    show([row({ dueDate: null })])
    expect(screen.getByText(/no due date/)).toBeInTheDocument()
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
  })

  it('puts the most overdue first', () => {
    show([
      row({ referenceNumber: 'newer', customerName: 'Newer AB', dueDate: '2026-08-01T00:00:00.000Z' }),
      row({ referenceNumber: 'oldest', customerName: 'Oldest AS', dueDate: '2023-02-01T00:00:00.000Z' }),
    ])
    const html = document.body.innerHTML
    expect(html.indexOf('Oldest AS')).toBeLessThan(html.indexOf('Newer AB'))
  })

  /** Four currencies, four totals. One summed number would be meaningless. */
  it('totals each currency on its own', () => {
    show([
      row({ currency: 'NOK', balance: 3999900 }),
      row({ referenceNumber: '2', currency: 'SEK', balance: 4499900 }),
      row({ referenceNumber: '3', currency: 'NOK', balance: 2325000 }),
    ])

    const totals = screen.getAllByTestId('finance-total').map((el) => el.textContent)
    expect(totals).toEqual(['63 249.00 NOK', '44 999.00 SEK'])
  })

  it('marks a credit note, which is money owed the other way', () => {
    show([row({ documentType: 'CreditNote' })])
    expect(screen.getByText(/credit note/i)).toBeInTheDocument()
  })
})
