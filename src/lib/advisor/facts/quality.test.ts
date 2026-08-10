import { describe, expect, it } from 'vitest'
import { isQuality } from '../types'
import { qualityFacts } from './quality'

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
