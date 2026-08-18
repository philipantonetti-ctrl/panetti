import { describe, expect, it } from 'vitest'
import { overdueMessage } from './alerts'
import type { OpenItem } from './overdue'

const TODAY = new Date('2026-08-18T00:00:00Z')
const APP = 'https://panetti.vercel.app'

const item = (over: Partial<OpenItem> = {}): OpenItem => ({
  referenceNumber: '123194',
  customerName: 'Konfliktrådene',
  dueDate: new Date('2026-01-16T00:00:00Z'),
  currency: 'NOK',
  balance: 3999900,
  ...over,
})

describe('overdueMessage', () => {
  it('counts one invoice in the singular', () => {
    expect(overdueMessage([item()], TODAY, APP)).toMatch(/^1 invoice is overdue/)
  })

  it('counts several in the plural', () => {
    const msg = overdueMessage([item(), item({ referenceNumber: '2' })], TODAY, APP)

    expect(msg).toMatch(/^2 invoices are overdue/)
  })

  /**
   * Per currency in the headline, because the six real ones span four. One
   * summed number would be arithmetic on four different things.
   */
  it('totals each currency separately in the headline', () => {
    const msg = overdueMessage(
      [item({ currency: 'NOK', balance: 3999900 }), item({ referenceNumber: '2', currency: 'SEK', balance: 4499900 })],
      TODAY,
      APP,
    )

    expect(msg).toContain('39 999.00 NOK')
    expect(msg).toContain('44 999.00 SEK')
  })

  it('names the customer, the days over and what they owe', () => {
    const msg = overdueMessage([item({ dueDate: new Date('2026-08-08T00:00:00Z') })], TODAY, APP)

    expect(msg).toContain('Konfliktrådene')
    expect(msg).toContain('10 days')
    expect(msg).toContain('39 999.00 NOK')
  })

  /** The reader clicks this. It has to go to the page, not to a bare number. */
  it('links to the finance page', () => {
    expect(overdueMessage([item()], TODAY, APP)).toContain(`<${APP}/finance|`)
  })

  it('puts the most overdue first', () => {
    const msg = overdueMessage(
      [
        item({ referenceNumber: 'newer', dueDate: new Date('2026-08-01T00:00:00Z') }),
        item({ referenceNumber: 'oldest', dueDate: new Date('2023-02-01T00:00:00Z') }),
      ],
      TODAY,
      APP,
    )

    expect(msg.indexOf('oldest')).toBeLessThan(msg.indexOf('newer'))
  })

  /** A channel nobody can read is a channel nobody reads. */
  it('caps the list and says how many it did not name', () => {
    const many = Array.from({ length: 25 }, (_, n) =>
      item({ referenceNumber: `INV-${n}`, dueDate: new Date('2026-01-16T00:00:00Z') }),
    )

    const msg = overdueMessage(many, TODAY, APP)

    expect(msg).toMatch(/and \d+ more/)
    expect(msg.split('\n').length).toBeLessThan(25)
  })

  it('says nothing at all when nothing is overdue', () => {
    expect(overdueMessage([], TODAY, APP)).toBe('')
  })
})
