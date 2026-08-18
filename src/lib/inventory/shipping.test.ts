import { describe, expect, it } from 'vitest'
import { ratesInCurrency, shippingCostOf, shippingRateOn, type ShippingPoint } from './shipping'

const point = (over: Partial<ShippingPoint> = {}): ShippingPoint => ({
  perUnit: 10000, // 100.00 kr
  currency: 'NOK',
  effectiveFrom: new Date('2026-01-01'),
  ...over,
})

const JULY = new Date('2026-07-01')

describe('shippingRateOn', () => {
  it('returns null when nothing has ever been entered', () => {
    expect(shippingRateOn([], JULY)).toBeNull()
  })

  it('picks the newest rate that was already in force', () => {
    const rates = [
      point({ perUnit: 10000, effectiveFrom: new Date('2026-01-01') }),
      point({ perUnit: 15000, effectiveFrom: new Date('2026-06-01') }),
      point({ perUnit: 12000, effectiveFrom: new Date('2026-03-01') }),
    ]
    expect(shippingRateOn(rates, JULY)?.perUnit).toBe(15000)
  })

  it('does not apply a rate that starts after the date', () => {
    // The whole reason this is effective-dated: a rate typed today must not
    // rewrite what an order cost last spring.
    const rates = [point({ perUnit: 99000, effectiveFrom: new Date('2026-08-01') })]
    expect(shippingRateOn(rates, JULY)).toBeNull()
  })

  it('applies a rate that starts on the very day', () => {
    const rates = [point({ perUnit: 15000, effectiveFrom: JULY })]
    expect(shippingRateOn(rates, JULY)?.perUnit).toBe(15000)
  })

  it('breaks a tie the way fulfillmentOn does — the first row given wins', () => {
    const rates = [
      point({ perUnit: 10000, effectiveFrom: new Date('2026-06-01') }),
      point({ perUnit: 20000, effectiveFrom: new Date('2026-06-01') }),
    ]
    expect(shippingRateOn(rates, JULY)?.perUnit).toBe(10000)
  })

  it('answers with the whole point, currency included', () => {
    const rates = [point({ perUnit: 900, currency: 'EUR' })]
    expect(shippingRateOn(rates, JULY)).toEqual(point({ perUnit: 900, currency: 'EUR' }))
  })
})

describe('shippingCostOf', () => {
  const rates = new Map<string, ShippingPoint[]>([
    ['PANPIZPRO', [point({ perUnit: 10000 })]],
    ['MAZADVCOM', [point({ perUnit: 25000 })]],
  ])

  it('charges per unit and sums the lines', () => {
    // The client's complaint in one assertion: fifty ovens must not cost what
    // one oven costs.
    expect(
      shippingCostOf(
        [
          { sku: 'PANPIZPRO', quantity: 50 },
          { sku: 'MAZADVCOM', quantity: 2 },
        ],
        rates,
        JULY,
      ),
    ).toBe(50 * 10000 + 2 * 25000)
  })

  it('uses the rate in force on the order date, not the newest one', () => {
    const history = new Map<string, ShippingPoint[]>([
      [
        'PANPIZPRO',
        [
          point({ perUnit: 10000, effectiveFrom: new Date('2026-01-01') }),
          point({ perUnit: 30000, effectiveFrom: new Date('2026-08-01') }),
        ],
      ],
    ])
    expect(shippingCostOf([{ sku: 'PANPIZPRO', quantity: 3 }], history, JULY)).toBe(30000)
  })

  it('counts a SKU with a rate even when another line has none', () => {
    // Partial knowledge beats none: the oven's shipping is real whether or not
    // anyone has costed the chair yet.
    expect(
      shippingCostOf(
        [
          { sku: 'PANPIZPRO', quantity: 2 },
          { sku: 'NEVER-COSTED', quantity: 7 },
        ],
        rates,
        JULY,
      ),
    ).toBe(20000)
  })

  it('returns null, never 0, when NO line has a rate', () => {
    // 0 would claim the shipping was free and silently overstate profit. null
    // means "we do not know", which is what lets the caller keep the per-order
    // figure it has always used.
    const answer = shippingCostOf(
      [
        { sku: 'NEVER-COSTED', quantity: 7 },
        { sku: 'ALSO-NEVER', quantity: 1 },
      ],
      rates,
      JULY,
    )
    expect(answer).toBeNull()
    expect(answer).not.toBe(0)
  })

  it('returns null when every rate for the SKU starts after the order', () => {
    const future = new Map<string, ShippingPoint[]>([
      ['PANPIZPRO', [point({ perUnit: 10000, effectiveFrom: new Date('2026-08-01') })]],
    ])
    expect(shippingCostOf([{ sku: 'PANPIZPRO', quantity: 4 }], future, JULY)).toBeNull()
  })

  it('returns null for an order with no lines', () => {
    expect(shippingCostOf([], rates, JULY)).toBeNull()
  })

  it('matches a SKU whatever its case and spacing', () => {
    expect(shippingCostOf([{ sku: '  panpizpro ', quantity: 2 }], rates, JULY)).toBe(20000)
  })

  it('charges a zero-quantity line nothing but still counts as known', () => {
    // A rate exists, so the answer is knowledge rather than absence — 0 here is
    // an answer, and the caller must not fall back to the per-order figure.
    expect(shippingCostOf([{ sku: 'PANPIZPRO', quantity: 0 }], rates, JULY)).toBe(0)
  })
})

describe('ratesInCurrency', () => {
  const mixed = new Map<string, ShippingPoint[]>([
    [
      'PANPIZPRO',
      [point({ perUnit: 10000, currency: 'NOK' }), point({ perUnit: 900, currency: 'EUR' })],
    ],
    ['MAZADVCOM', [point({ perUnit: 2500, currency: 'EUR' })]],
  ])

  it('keeps only the rates held in that currency', () => {
    const nok = ratesInCurrency(mixed, 'NOK')
    expect(nok.get('PANPIZPRO')).toEqual([point({ perUnit: 10000, currency: 'NOK' })])
  })

  it('drops a SKU whose every rate is in another currency', () => {
    // A 900 EUR rate read as 9 kr — or as 900 øre — is the tenfold cost error
    // this whole split exists to prevent. We never guess an exchange rate for a
    // figure someone typed against a named currency.
    expect(ratesInCurrency(mixed, 'NOK').has('MAZADVCOM')).toBe(false)
  })

  it('is empty when no rate is held in that currency at all', () => {
    expect(ratesInCurrency(mixed, 'SEK').size).toBe(0)
  })
})
