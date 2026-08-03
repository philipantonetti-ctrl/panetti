import { describe, it, expect } from 'vitest'
import { b2bExternalId, formatB2bNumber, parseB2bNumber } from './numbering'

describe('formatB2bNumber', () => {
  it('pads to four digits so a list sorts the way it reads', () => {
    expect(formatB2bNumber(1)).toBe('B-0001')
    expect(formatB2bNumber(42)).toBe('B-0042')
    expect(formatB2bNumber(9999)).toBe('B-9999')
  })

  it('simply gets longer past four digits rather than wrapping', () => {
    expect(formatB2bNumber(10000)).toBe('B-10000')
  })
})

describe('parseB2bNumber', () => {
  it('reads its own format back', () => {
    expect(parseB2bNumber('B-0007')).toBe(7)
    expect(parseB2bNumber('B-10000')).toBe(10000)
  })

  it('returns 0 for anything that is not one of ours', () => {
    // A WooCommerce number, an empty string, junk. 0 means "counts for
    // nothing when we look for the highest", which is exactly right.
    expect(parseB2bNumber('1042')).toBe(0)
    expect(parseB2bNumber('')).toBe(0)
    expect(parseB2bNumber('B-')).toBe(0)
    expect(parseB2bNumber('B-abc')).toBe(0)
  })
})

describe('b2bExternalId', () => {
  it('namespaces the id so a WooCommerce order can never collide with it', () => {
    // Woo external ids are always String(woo.id) — plain digits.
    expect(b2bExternalId('B-0007')).toBe('b2b:B-0007')
  })
})
