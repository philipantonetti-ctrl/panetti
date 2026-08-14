import { describe, expect, it } from 'vitest'
import { isUsableSku, normaliseSku } from './sku'

describe('normaliseSku', () => {
  it('trims and uppercases so one product is one key', () => {
    expect(normaliseSku(' panpizpro ')).toBe('PANPIZPRO')
  })
})

describe('isUsableSku', () => {
  it('accepts a real SKU', () => expect(isUsableSku('PANPIZPRO')).toBe(true))
  it('rejects blank', () => expect(isUsableSku('   ')).toBe(false))

  it('rejects "0", which six live products share across two different items', () => {
    // Panetti Pizzetta Primo and Mazzetti Advanced Comfort both carry SKU "0".
    // Pooling them would average a pizza oven with a massage chair and
    // recommend containers of a product that does not exist.
    expect(isUsableSku('0')).toBe(false)
    expect(isUsableSku('000')).toBe(false)
  })

  it('does not reject a real SKU that merely contains zeros', () => {
    expect(isUsableSku('PPP-DC-001')).toBe(true)
    expect(isUsableSku('0A')).toBe(true)
  })
})
