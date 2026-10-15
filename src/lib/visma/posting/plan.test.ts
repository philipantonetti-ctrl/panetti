import { describe, expect, it } from 'vitest'
import { payoutEntry, planPosting, type OpenInvoice, type PlanLine } from './plan'

const DE = { customer: '10859', clearingAccount: '1509', bankAccount: '1940', feeAccount: '7770' }
const inv = (number: string, ref: string, balance: number, currency = 'EUR'): OpenInvoice => ({
  number, customerRefNumber: ref, currency, balance,
})
const line = (transactionId: string, reference2: string | null, capture: number): PlanLine => ({
  transactionId, reference2, capture,
})

describe('planPosting', () => {
  it('pays each order its capture against the one open invoice with that order number', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 19000, fee: 1000 },
      [line('t1', '14238', 12000), line('t2', '14239', 8000)],
      [inv('130474', '14238', 12000), inv('130475', '14239', 8000)],
      DE,
    )
    expect(plan.payments).toEqual([
      { key: '14238', invoiceNumber: '130474', amount: 12000 },
      { key: '14239', invoiceNumber: '130475', amount: 8000 },
    ])
    expect(plan.skipped).toEqual([])
  })

  it('sums an order captured in two lines into ONE payment', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 9000, fee: 1000 },
      [line('t1', '14238', 6000), line('t2', '14238', 4000)],
      [inv('130474', '14238', 10000)],
      DE,
    )
    expect(plan.payments).toEqual([{ key: '14238', invoiceNumber: '130474', amount: 10000 }])
  })

  it('never pays more than the invoice still owes', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 4999, fee: 0 },
      [line('t1', '13710', 4999)],
      [inv('129000', '13710', 4499)],
      DE,
    )
    expect(plan.payments).toEqual([{ key: '13710', invoiceNumber: '129000', amount: 4499 }])
  })

  it('skips an order with no open invoice, two open invoices, or no number at all', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 3000, fee: 0 },
      [line('t1', '1', 1000), line('t2', '2', 1000), line('t3', null, 1000), line('t4', '  ', 500)],
      [inv('A', '2', 1000), inv('B', '2', 1000)],
      DE,
    )
    expect(plan.payments).toEqual([])
    expect(plan.skipped).toEqual([
      { key: 'transaction t3', reason: 'no order number in the Dintero report' },
      { key: 'transaction t4', reason: 'no order number in the Dintero report' },
      { key: '1', reason: 'no open invoice' },
      { key: '2', reason: '2 open invoices for order 2' },
    ])
  })

  it('ignores invoices in another currency, fully paid ones, and refund-only lines', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: -500, fee: 0 },
      [line('t1', '7', 0), line('t2', '8', 1000)],
      [inv('X', '8', 1000, 'NOK'), inv('Y', '8', 0)],
      DE,
    )
    expect(plan.payments).toEqual([])
    expect(plan.skipped).toEqual([{ key: '8', reason: 'no open invoice' }])
  })

  it('matches order numbers with stray spaces on either side', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 1000, fee: 0 },
      [line('t1', ' 14238 ', 1000)],
      [inv('130474', '14238 ', 1000)],
      DE,
    )
    expect(plan.payments).toEqual([{ key: '14238', invoiceNumber: '130474', amount: 1000 }])
  })
})

describe('payoutEntry', () => {
  it('is the drawing: debit bank = net, debit fees = fee, credit clearing = net + fee', () => {
    expect(payoutEntry({ currency: 'DKK', amount: 7262172, fee: 52528 }, DE)).toEqual([
      { account: '1940', debit: 7262172, credit: 0 },
      { account: '7770', debit: 52528, credit: 0 },
      { account: '1509', debit: 0, credit: 7314700 },
    ])
  })

  it('leaves out a zero fee line', () => {
    expect(payoutEntry({ currency: 'EUR', amount: 1000, fee: 0 }, DE)).toEqual([
      { account: '1940', debit: 1000, credit: 0 },
      { account: '1509', debit: 0, credit: 1000 },
    ])
  })

  it('flips sides when refunds made the net negative, and still balances', () => {
    const lines = payoutEntry({ currency: 'EUR', amount: -3000, fee: 200 }, DE)
    expect(lines).toEqual([
      { account: '1940', debit: 0, credit: 3000 },
      { account: '7770', debit: 200, credit: 0 },
      { account: '1509', debit: 2800, credit: 0 },
    ])
    const debit = lines.reduce((s, l) => s + l.debit, 0)
    const credit = lines.reduce((s, l) => s + l.credit, 0)
    expect(debit).toBe(credit)
  })

  it('is empty when there is nothing to book', () => {
    expect(payoutEntry({ currency: 'EUR', amount: 0, fee: 0 }, DE)).toEqual([])
  })
})
