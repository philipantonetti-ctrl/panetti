import { describe, expect, it } from 'vitest'
import { mapInvoices } from './invoice-map'

const raw = {
  invoices: [
    {
      customerNumber: '20020467369',
      invoiceNumber: '4710001522',
      invoiceDate: '31.07.2026',
      dueDate: '2026-08-14',
      amount: '84786.85',
      taxAmount: '21197.02',
      totalAmount: '105983.87',
      currency: 'NOK',
      type: 'Invoice',
      invoiceSpecificationAvailable: true,
    },
    {
      customerNumber: '20020152102',
      invoiceNumber: '4070009812',
      invoiceDate: '31.07.2026',
      dueDate: '2026-08-13',
      amount: '6240.0',
      taxAmount: '0.0',
      totalAmount: '6240.0',
      currency: 'SEK',
      type: 'Invoice',
      invoiceSpecificationAvailable: false,
    },
  ],
}

describe('mapInvoices', () => {
  it('reads amounts as minor units, including a single decimal place', () => {
    const [first, second] = mapInvoices(raw)
    expect(first.amountMinor).toBe(8478685)
    expect(first.taxMinor).toBe(2119702)
    expect(first.totalMinor).toBe(10598387)
    // '6240.0' is one decimal place, not two. parseFloat then scale, never
    // string surgery: '6240.0' read as digits would be 62400.
    expect(second.amountMinor).toBe(624000)
  })

  it('reads invoiceDate as dd.mm.yyyy, not ISO', () => {
    const [first] = mapInvoices(raw)
    expect(first.invoiceDate.toISOString().slice(0, 10)).toBe('2026-07-31')
  })

  it('carries whether a specification exists, because that decides retry or give up', () => {
    const [first, second] = mapInvoices(raw)
    expect(first.specificationAvailable).toBe(true)
    expect(second.specificationAvailable).toBe(false)
  })

  it('returns nothing rather than throwing when the body is not what we expect', () => {
    expect(mapInvoices(null)).toEqual([])
    expect(mapInvoices({})).toEqual([])
    expect(mapInvoices({ invoices: 'no' })).toEqual([])
    expect(mapInvoices({ invoices: [null] })).toEqual([])
  })
})
