import { describe, expect, it } from 'vitest'
import { isQuality } from '../types'
import { missingRateCurrencies, qualityFacts } from './quality'

describe('missingRateCurrencies', () => {
  it('reports a currency in play with no rate held', () => {
    expect(missingRateCurrencies({ inPlay: ['NOK', 'SEK'], held: new Set(['NOK']) })).toEqual(['SEK'])
  })

  it('reports nothing when every rate is held', () => {
    expect(missingRateCurrencies({ inPlay: ['NOK', 'SEK'], held: new Set(['NOK', 'SEK']) })).toEqual([])
  })

  it('never reports USD, which is the pivot and needs no rate against itself', () => {
    expect(missingRateCurrencies({ inPlay: ['USD', 'NOK'], held: new Set(['NOK']) })).toEqual([])
  })

  it('reports a missing rate even when the workspace consolidates into NOK', () => {
    // The bug this function replaces: gating on displayCurrency === 'USD'
    // silently switched the warning off for every other display currency,
    // and this workspace consolidates into NOK. Rates pivot through USD
    // whatever the display currency is, so the check must run regardless.
    expect(
      missingRateCurrencies({ inPlay: ['NOK', 'SEK', 'DKK'], held: new Set(['NOK']) }),
    ).toEqual(['DKK', 'SEK'])
  })

  it('never reports a currency the rate provider cannot quote', () => {
    // An AED B2B order can never gain a row, so flagging it would be a
    // warning nobody could ever clear.
    expect(missingRateCurrencies({ inPlay: ['AED'], held: new Set() })).toEqual([])
  })

  it('collapses a currency named twice', () => {
    expect(missingRateCurrencies({ inPlay: ['SEK', 'SEK'], held: new Set() })).toEqual(['SEK'])
  })
})

describe('qualityFacts', () => {
  it('reports products with no cost, because profit is overstated without one', () => {
    const facts = qualityFacts({
      uncostedByShop: [{ shopId: 'shop_no', shopName: 'Panetti Norway', count: 3 }],
      failingShops: [],
      missingRates: [],
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].kind).toBe('UNCOSTED_PRODUCTS')
    expect(facts[0].current).toBe(3)
    expect(facts[0].unit).toBe('count')
    expect(isQuality(facts[0])).toBe(true)
  })

  it('reports even a single uncosted product — this gate is trust, not size', () => {
    const facts = qualityFacts({
      uncostedByShop: [{ shopId: 'shop_no', shopName: 'Panetti Norway', count: 1 }],
      failingShops: [],
      missingRates: [],
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].severity).toBeGreaterThan(0)
  })

  it('says nothing when every product has a cost', () => {
    const facts = qualityFacts({
      uncostedByShop: [{ shopId: 'shop_no', shopName: 'Panetti Norway', count: 0 }],
      failingShops: [],
      missingRates: [],
    })
    expect(facts).toEqual([])
  })

  it('reports a shop whose sync is failing, and carries the reason as the subject', () => {
    const facts = qualityFacts({
      uncostedByShop: [],
      failingShops: [{ shopId: 'shop_de', shopName: 'Mazzetti Germany', error: '401 Unauthorized' }],
      missingRates: [],
    })
    expect(facts[0].kind).toBe('SHOP_SYNC_FAILING')
    expect(facts[0].subject).toBe('401 Unauthorized')
    expect(facts[0].severity).toBe(1)
  })

  it('reports a currency with no exchange rate', () => {
    const facts = qualityFacts({ uncostedByShop: [], failingShops: [], missingRates: ['SEK'] })
    expect(facts[0].kind).toBe('MISSING_FX')
    expect(facts[0].subject).toBe('SEK')
    expect(facts[0].shopId).toBeNull()
  })
})
