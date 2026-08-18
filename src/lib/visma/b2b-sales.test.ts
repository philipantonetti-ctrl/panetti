import { describe, expect, it } from 'vitest'
import { mapVismaB2bSales, type LinkedCustomers } from './b2b-sales'
import type { VismaCustomerInvoice } from './types'

/** The three customers linkable on 2026-08-18, keyed as Visma numbers them. */
const linked: LinkedCustomers = new Map([
  ['20012', { b2bCustomerId: 'cust-play', shopId: 'shop-se', currency: 'SEK' }],
  ['10681', { b2bCustomerId: 'cust-jpk', shopId: 'shop-no', currency: 'EUR' }],
])

const line = (over: Record<string, unknown> = {}) => ({
  lineType: 'GoodsForSales',
  lineNumber: 1,
  inventoryNumber: 'PZ-100',
  description: 'Panetti Pizzetta Primo',
  quantity: 2,
  unitPrice: 3999,
  unitPriceInCurrency: 3999,
  amount: 7998,
  amountInCurrency: 7998,
  cost: 1200,
  uom: 'STK',
  discountAmount: 0,
  ...over,
})

const invoice = (over: Record<string, unknown> = {}): VismaCustomerInvoice =>
  ({
    referenceNumber: '123194',
    customer: { number: '20012', name: 'Play Nöjesdistribution AB' },
    documentType: 'Invoice',
    documentDate: '2026-08-14T00:00:00',
    documentDueDate: '2026-09-13T00:00:00',
    currencyId: 'SEK',
    status: 'Open',
    invoiceLines: [line()],
    ...over,
  }) as VismaCustomerInvoice

/** How many were skipped for one reason. Absent counts as none. */
const skipped = (result: { skipped: { reason: string; count: number }[] }, reason: string) =>
  result.skipped.find((s) => s.reason === reason)?.count ?? 0

describe('mapVismaB2bSales', () => {
  it('turns a linked customer’s invoice into an order with its lines', () => {
    const { orders, read } = mapVismaB2bSales([invoice()], linked)

    expect(read).toBe(1)
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      referenceNumber: '123194',
      b2bCustomerId: 'cust-play',
      shopId: 'shop-se',
      currency: 'SEK',
    })
    expect(orders[0].placedAt).toEqual(new Date('2026-08-14T00:00:00'))
    expect(orders[0].lines).toEqual([
      { sku: 'PZ-100', name: 'Panetti Pizzetta Primo', quantity: 2, unitPrice: 399900 },
    ])
  })

  /**
   * THE guard the whole feature stands on. Visma raises an invoice for every
   * webshop order too, booked against house accounts named "… - Webkunde", and
   * those same orders already arrive from WooCommerce. Measured 2026-08-18: 994
   * of the first 1000 open documents were one. Importing a single unlinked
   * customer's invoice as a sale doubles revenue.
   */
  it('ignores an invoice for a customer nobody linked, so a webshop order can never be counted twice', () => {
    const result = mapVismaB2bSales(
      [invoice({ customer: { number: '1', name: 'Panetti Norge - Webkunde' } })],
      linked,
    )

    expect(result.orders).toEqual([])
    expect(skipped(result, 'not a linked customer')).toBe(1)
  })

  /**
   * The client's own case, and the reason the filter is an allowlist rather
   * than a "- Webkunde" denylist: a mazzetti.no customer paying by invoice has
   * his order typed into the WEBSHOP and is invoiced from Visma afterwards. The
   * sale is already ours. Only an explicit link may ever make an invoice a sale.
   */
  it('ignores a named customer who was never linked, not just the house accounts', () => {
    const result = mapVismaB2bSales(
      [invoice({ customer: { number: '10920', name: 'Konfliktrådene' } })],
      linked,
    )

    expect(result.orders).toEqual([])
    expect(skipped(result, 'not a linked customer')).toBe(1)
  })

  /**
   * Counted and reported, never guessed at: the client has not yet decided
   * whether a credit note should reduce a customer's recorded sales, and 292 of
   * the first 1000 open documents were credit notes.
   */
  it('skips a credit note and says how many, rather than deciding what it means', () => {
    const result = mapVismaB2bSales([invoice({ documentType: 'Credit Note' })], linked)

    expect(result.orders).toEqual([])
    expect(skipped(result, 'credit note')).toBe(1)
  })

  it('skips an invoice with no reference number, which is the only thing identifying it', () => {
    const result = mapVismaB2bSales([invoice({ referenceNumber: '' })], linked)

    expect(result.orders).toEqual([])
    expect(skipped(result, 'unusable invoice')).toBe(1)
  })

  it('skips an invoice with no lines', () => {
    const result = mapVismaB2bSales([invoice({ invoiceLines: [] })], linked)

    expect(result.orders).toEqual([])
    expect(skipped(result, 'no lines')).toBe(1)
  })

  /**
   * A WooCommerce order id and a Visma reference number are both bare integers.
   * Unprefixed, invoice 123194 and Woo order 123194 would be the same row on
   * `@@unique([shopId, externalId])` — one silently overwriting the other.
   */
  it('namespaces the external id so it cannot collide with a WooCommerce order id', () => {
    const { orders } = mapVismaB2bSales([invoice({ referenceNumber: '123194' })], linked)

    expect(orders[0].externalId).toBe('visma-123194')
  })

  /** Minor units everywhere, as every other money column in this database is. */
  it('stores money in minor units, rounded rather than truncated', () => {
    const { orders } = mapVismaB2bSales(
      [invoice({ invoiceLines: [line({ unitPriceInCurrency: 92.575 })] })],
      linked,
    )

    // Math.trunc would lose an øre a line, every line, forever.
    expect(orders[0].lines[0].unitPrice).toBe(9258)
  })

  /**
   * The price in the DOCUMENT'S currency, not the company's. `unitPrice` is
   * converted to NOK by Visma, so reading it for a customer invoiced in EUR
   * would record roughly eleven times what they were charged.
   */
  it('takes the price the customer was actually charged, not the company-currency one', () => {
    const { orders } = mapVismaB2bSales(
      [invoice({ invoiceLines: [line({ unitPrice: 45000, unitPriceInCurrency: 3999 })] })],
      linked,
    )

    expect(orders[0].lines[0].unitPrice).toBe(399900)
  })

  /**
   * Losing a whole order because one line is odd is worse than an order with
   * one line missing — and a line dropped in silence is indistinguishable from
   * a line that never existed, which is how a missing sale goes unnoticed.
   */
  it('drops a line whose SKU cannot identify a product but keeps the order', () => {
    const result = mapVismaB2bSales(
      [invoice({ invoiceLines: [line(), line({ lineNumber: 2, inventoryNumber: '0' })] })],
      linked,
    )

    expect(result.orders).toHaveLength(1)
    expect(result.orders[0].lines).toHaveLength(1)
    expect(skipped(result, 'unusable line')).toBe(1)
  })

  it('drops a line with no quantity, which would record a sale of nothing', () => {
    const result = mapVismaB2bSales(
      [invoice({ invoiceLines: [line(), line({ lineNumber: 2, quantity: 0 })] })],
      linked,
    )

    expect(result.orders[0].lines).toHaveLength(1)
    expect(skipped(result, 'unusable line')).toBe(1)
  })

  /** An order with nothing on it is not an order, however it came to be empty. */
  it('produces no order at all when every one of its lines was unusable', () => {
    const result = mapVismaB2bSales(
      [invoice({ invoiceLines: [line({ inventoryNumber: '' })] })],
      linked,
    )

    expect(result.orders).toEqual([])
    expect(skipped(result, 'unusable line')).toBe(1)
    expect(skipped(result, 'no lines')).toBe(1)
  })

  it('normalises the SKU, so it joins to a product the way every other SKU here does', () => {
    const { orders } = mapVismaB2bSales(
      [invoice({ invoiceLines: [line({ inventoryNumber: '  pz-100 ' })] })],
      linked,
    )

    expect(orders[0].lines[0].sku).toBe('PZ-100')
  })

  /** Visma wraps some scalars as `{ value: x }` and leaves others bare. */
  it('reads a wrapped scalar the same as a bare one', () => {
    const { orders } = mapVismaB2bSales(
      [
        invoice({
          referenceNumber: { value: '123195' },
          documentType: { value: 'Invoice' },
          documentDate: { value: '2026-08-14T00:00:00' },
          customer: { number: { value: 20012 }, name: { value: 'Play Nöjesdistribution AB' } },
          invoiceLines: [line({ inventoryNumber: { value: 'PZ-100' }, quantity: { value: 2 } })],
        }),
      ],
      linked,
    )

    expect(orders[0].externalId).toBe('visma-123195')
    expect(orders[0].lines[0]).toMatchObject({ sku: 'PZ-100', quantity: 2 })
  })

  it('counts every invoice it read, whatever became of it', () => {
    const result = mapVismaB2bSales(
      [invoice(), invoice({ customer: { number: '1', name: 'Panetti Norge - Webkunde' } })],
      linked,
    )

    expect(result.read).toBe(2)
    expect(result.orders).toHaveLength(1)
  })

  it('imports nothing at all when no customer is linked', () => {
    const result = mapVismaB2bSales([invoice(), invoice({ referenceNumber: '2' })], new Map())

    expect(result.orders).toEqual([])
    expect(skipped(result, 'not a linked customer')).toBe(2)
  })

  it('survives a payload that is not an array', () => {
    expect(mapVismaB2bSales(undefined as never, linked).orders).toEqual([])
  })
})
