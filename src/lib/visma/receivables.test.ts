import { describe, expect, it } from 'vitest'
import { isWebshopAccount, mapReceivables } from './receivables'
import type { VismaCustomerDocument } from './types'

const doc = (over: Record<string, unknown> = {}): VismaCustomerDocument =>
  ({
    referenceNumber: '123194',
    customer: { number: '10920', name: 'Konfliktrådene' },
    documentType: 'Invoice',
    documentDate: '2025-12-17T00:00:00',
    documentDueDate: '2026-01-16T00:00:00',
    currencyId: 'NOK',
    amountInCurrency: 39999,
    balanceInCurrency: 39999,
    status: 'Open',
    ...over,
  }) as VismaCustomerDocument

describe('isWebshopAccount', () => {
  /**
   * These are the collective accounts Visma books webshop orders against. 994
   * of the first 1000 open documents belong to one, 993 of them "overdue" by a
   * same-day due date with a median age of 113 days. None of it is debt.
   */
  it('knows the webshop collective accounts', () => {
    expect(isWebshopAccount('Panetti Norge - Webkunde')).toBe(true)
    expect(isWebshopAccount('Mazzetti Norge - Webkunde')).toBe(true)
    expect(isWebshopAccount('Panetti Deutschland - Webkunde')).toBe(true)
  })

  it('leaves a real customer alone', () => {
    expect(isWebshopAccount('Konfliktrådene')).toBe(false)
    expect(isWebshopAccount('Halsnæs Kommune')).toBe(false)
    expect(isWebshopAccount('Bagaren och Kocken')).toBe(false)
  })

  it('is not fooled by case or spacing', () => {
    expect(isWebshopAccount('  panetti norge - WEBKUNDE  ')).toBe(true)
  })

  /**
   * A customer who merely has the word in their name, rather than being one of
   * the collective accounts, is a real customer. The test is the suffix.
   */
  it('does not swallow a real company whose name merely contains the word', () => {
    expect(isWebshopAccount('Webkunde Logistics AB')).toBe(false)
  })
})

describe('mapReceivables', () => {
  it('reads one open invoice', () => {
    const [r] = mapReceivables([doc()])

    expect(r).toMatchObject({
      referenceNumber: '123194',
      customerNumber: '10920',
      customerName: 'Konfliktrådene',
      documentType: 'Invoice',
      currency: 'NOK',
    })
    expect(r.documentDate).toEqual(new Date('2025-12-17T00:00:00'))
    expect(r.dueDate).toEqual(new Date('2026-01-16T00:00:00'))
  })

  /** Minor units everywhere, as every other money column in this database is. */
  it('stores money in minor units', () => {
    const [r] = mapReceivables([doc({ amountInCurrency: 39999, balanceInCurrency: 39999 })])

    expect(r.amount).toBe(3999900)
    expect(r.balance).toBe(3999900)
  })

  /** Visma really does send these: 9257.5 DKK on an open credit note. */
  it('rounds a fractional amount rather than truncating it', () => {
    const [r] = mapReceivables([doc({ amountInCurrency: 9257.5, balanceInCurrency: 9257.5 })])

    expect(r.balance).toBe(925750)
  })

  it('leaves out the webshop collective accounts', () => {
    const rows = mapReceivables([
      doc({ customer: { number: '10001', name: 'Panetti Norge - Webkunde' } }),
      doc({ referenceNumber: '999', customer: { number: '10920', name: 'Konfliktrådene' } }),
    ])

    expect(rows.map((r) => r.referenceNumber)).toEqual(['999'])
  })

  /** Nothing outstanding is not a receivable, whatever Visma still calls it. */
  it('leaves out a document with nothing left to pay', () => {
    expect(mapReceivables([doc({ balanceInCurrency: 0 })])).toEqual([])
  })

  it('leaves out anything Visma has closed', () => {
    expect(mapReceivables([doc({ status: 'Closed' })])).toEqual([])
  })

  /**
   * Null, not "today". A document with no due date cannot be overdue, and
   * defaulting it to now would invent an overdue invoice out of a missing field.
   */
  it('keeps a missing due date as nothing rather than as today', () => {
    const [r] = mapReceivables([doc({ documentDueDate: undefined })])

    expect(r.dueDate).toBeNull()
  })

  it('skips a document with no reference number to key it on', () => {
    expect(mapReceivables([doc({ referenceNumber: '' })])).toEqual([])
  })

  /** Visma wraps some scalars as `{ value: x }` and leaves others bare. */
  it('reads wrapped values', () => {
    const [r] = mapReceivables([
      doc({
        referenceNumber: { value: '123194' },
        currencyId: { value: 'SEK' },
        balanceInCurrency: { value: 4999 },
        customer: { number: { value: 10681 }, name: { value: 'JPK Trading Kft' } },
      }),
    ])

    expect(r).toMatchObject({ referenceNumber: '123194', currency: 'SEK', customerNumber: '10681' })
    expect(r.balance).toBe(499900)
  })

  it('keeps a credit note, which is money that moves the other way', () => {
    const [r] = mapReceivables([doc({ documentType: 'CreditNote' })])

    expect(r.documentType).toBe('CreditNote')
  })

  it('survives a payload that is not an array', () => {
    expect(mapReceivables(null as never)).toEqual([])
  })

  it('keeps only the last of two readings of the same document', () => {
    const rows = mapReceivables([doc({ balanceInCurrency: 100 }), doc({ balanceInCurrency: 50 })])

    expect(rows).toHaveLength(1)
    expect(rows[0].balance).toBe(5000)
  })
})
