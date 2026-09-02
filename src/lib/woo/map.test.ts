import { describe, it, expect } from 'vitest'
import { mapOrder, type WooOrder } from './map'

// A realistic WooCommerce order. Woo gives strings, and line `total` is
// ALREADY after discount and EXCLUDING tax - which is exactly our net sales.
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

// Alias for the tests below: they build on the same realistic order but read
// more clearly under the name "the order we start from".
const baseOrder = woo

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

  it('picks up the product photo WooCommerce sends with the line item', () => {
    const o = mapOrder({
      ...woo,
      line_items: [{ ...woo.line_items[0], image: { id: '55', src: 'https://shop.no/pro-x.jpg' } }],
    })
    expect(o.items[0].imageUrl).toBe('https://shop.no/pro-x.jpg')
  })

  it('has no photo when WooCommerce sends none, rather than crashing', () => {
    expect(mapOrder(woo).items[0].imageUrl).toBeNull()
  })

  it('carries the status through so refunds can be excluded downstream', () => {
    expect(mapOrder({ ...woo, status: 'refunded' }).status).toBe('refunded')
  })

  it('reads the customer from billing, name first and email alongside', () => {
    const o = mapOrder({
      ...woo,
      billing: { first_name: 'Tino', last_name: 'Skaarup', email: 'tino@example.dk' },
    })
    expect(o.customerName).toBe('Tino Skaarup')
    expect(o.customerEmail).toBe('tino@example.dk')
  })

  it("records '' - checked, nothing there - when the store has no billing details", () => {
    // '' and not null: null means "never looked", and the backfill relies on
    // that difference to know when it is finished.
    const o = mapOrder(woo)
    expect(o.customerName).toBe('')
    expect(o.customerEmail).toBe('')
  })

  it('survives partial billing: an email-only guest still shows who bought', () => {
    const o = mapOrder({ ...woo, billing: { email: 'guest@example.no' } })
    expect(o.customerName).toBe('')
    expect(o.customerEmail).toBe('guest@example.no')
  })

  it('survives a missing or malformed number without crashing', () => {
    // Line items here must imply zero discount (subtotal === total) - otherwise
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

  it('takes the destination country from the shipping address', () => {
    const o = mapOrder({
      ...baseOrder,
      shipping: { country: 'SE' },
    } as never)
    expect(o.shippingCountry).toBe('SE')
  })

  it('falls back to the billing country when there is no shipping address', () => {
    const o = mapOrder({ ...baseOrder, billing: { country: 'DK' } } as never)
    expect(o.shippingCountry).toBe('DK')
  })

  it('reports an empty string, never null, when the store has no country at all', () => {
    const o = mapOrder(baseOrder as never)
    expect(o.shippingCountry).toBe('')
  })

  it('uppercases the country so DE and de never split a report in two', () => {
    const o = mapOrder({ ...baseOrder, shipping: { country: 'de' } } as never)
    expect(o.shippingCountry).toBe('DE')
  })
})

describe('customer phone', () => {
  it('carries the billing phone, and an empty string when the store has none', () => {
    expect(mapOrder({ ...baseOrder, billing: { phone: ' +47 912 34 567 ' } }).customerPhone).toBe('+47 912 34 567')
    expect(mapOrder({ ...baseOrder, billing: {} }).customerPhone).toBe('')
    expect(mapOrder(baseOrder).customerPhone).toBe('')
  })
})

describe('the payment transaction id', () => {
  it('travels through as WooCommerce holds it', () => {
    const o = mapOrder({ ...baseOrder, transaction_id: 'P11114428.5Gooe6v4sQE1VE1VxCGY8m' })
    expect(o.transactionId).toBe('P11114428.5Gooe6v4sQE1VE1VxCGY8m')
  })

  it("reads as '' when the store has none on file - checked, not unknown", () => {
    expect(mapOrder(baseOrder).transactionId).toBe('')
    expect(mapOrder({ ...baseOrder, transaction_id: '  ' }).transactionId).toBe('')
  })
})

describe('the dintero plugin metas', () => {
  it('reads the dwc session reference from the order meta', () => {
    const o = mapOrder({
      ...baseOrder,
      meta_data: [{ key: '_dintero_merchant_reference', value: 'dwc6a853ea38988a9.79866913' }],
    })
    expect(o.dinteroReference).toBe('dwc6a853ea38988a9.79866913')
    expect(mapOrder(baseOrder).dinteroReference).toBe('')
  })

  it('falls back to the meta transaction id when the core field is empty', () => {
    // Older plugin versions wrote only the meta, never set_transaction_id.
    const o = mapOrder({
      ...baseOrder,
      meta_data: [{ key: '_dintero_transaction_id', value: 'P11114417.OLD123' }],
    })
    expect(o.transactionId).toBe('P11114417.OLD123')
    // The core field, when present, wins.
    const o2 = mapOrder({
      ...baseOrder,
      transaction_id: 'P11114417.CORE',
      meta_data: [{ key: '_dintero_transaction_id', value: 'P11114417.OLD123' }],
    })
    expect(o2.transactionId).toBe('P11114417.CORE')
  })
})
