import { describe, it, expect } from 'vitest'
import { mapOrder, type WooOrder } from './map'

// A realistic WooCommerce order. Woo gives strings, and line `total` is
// ALREADY after discount and EXCLUDING tax — which is exactly our net sales.
const woo: WooOrder = {
  id: 501,
  number: '501',
  status: 'completed',
  currency: 'NOK',
  date_created_gmt: '2026-07-10T09:30:00',
  discount_total: '100.00',
  discount_tax: '25.00',
  shipping_total: '50.00',
  shipping_tax: '12.50',
  total_tax: '237.50',
  total: '1237.50',
  coupon_lines: [{ code: 'emma10' }],
  line_items: [
    { id: 1, product_id: 9001, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 2, subtotal: '1000.00', total: '900.00' },
  ],
}

describe('mapOrder', () => {
  it('reads net sales as the line total AFTER discount and EXCLUDING VAT', () => {
    const o = mapOrder(woo)
    expect(o.grossSales).toBe(100000) // subtotal 1000.00 before discount
    expect(o.discountTotal).toBe(10000) //  discount  100.00
    expect(o.netSales).toBe(90000) //  net       900.00  <- commission base
  })

  it('never lets VAT into revenue', () => {
    const o = mapOrder(woo)
    expect(o.taxTotal).toBe(23750) // recorded...
    expect(o.netSales).toBe(90000) // ...but not in net sales
    expect(o.shippingCharged).toBe(5000) // shipping ex-VAT, not 62.50
  })

  it('picks up the coupon code, uppercased so matching is reliable', () => {
    expect(mapOrder(woo).couponCode).toBe('EMMA10')
  })

  it('has no coupon when none was used', () => {
    expect(mapOrder({ ...woo, coupon_lines: [] }).couponCode).toBeNull()
  })

  it('takes the FIRST coupon when several were used', () => {
    const o = mapOrder({ ...woo, coupon_lines: [{ code: 'sofia10' }, { code: 'emma10' }] })
    expect(o.couponCode).toBe('SOFIA10')
  })

  it('maps the line items', () => {
    const o = mapOrder(woo)
    expect(o.items).toHaveLength(1)
    expect(o.items[0].quantity).toBe(2)
    expect(o.items[0].lineNetTotal).toBe(90000) // after discount, ex VAT
    expect(o.items[0].externalProductId).toBe('9001')
  })

  it('carries the status through so refunds can be excluded downstream', () => {
    expect(mapOrder({ ...woo, status: 'refunded' }).status).toBe('refunded')
  })

  it('survives a missing or malformed number without crashing', () => {
    // Line items here must imply zero discount (subtotal === total) — otherwise
    // discountTotal would be derived from the lines regardless of discount_total,
    // and this test would not actually exercise the malformed-field fallback path.
    const o = mapOrder({
      ...woo,
      discount_total: '',
      shipping_total: undefined as unknown as string,
      line_items: [{ ...woo.line_items[0], subtotal: woo.line_items[0].total }],
    })
    expect(o.discountTotal).toBe(0)
    expect(o.shippingCharged).toBe(0)
  })

  it('produces a stable external id, so syncing twice updates rather than duplicates', () => {
    const a = mapOrder(woo)
    const b = mapOrder({ ...woo, status: 'processing' }) // same order, changed status
    expect(a.externalId).toBe(b.externalId)
  })
})
