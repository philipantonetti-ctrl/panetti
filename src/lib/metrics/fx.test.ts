import { describe, it, expect } from 'vitest'
import { convert, buildRateTable, crossFactor } from './fx'

const rates = buildRateTable([
  { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-02'), currency: 'NOK', rate: 0.2 },
  { date: new Date('2026-07-01'), currency: 'SEK', rate: 0.09 },
])

describe('convert', () => {
  it('converts using the rate on that specific day', () => {
    expect(convert(10000, 'NOK', new Date('2026-07-01'), 'USD', rates)).toBe(1000)
    expect(convert(10000, 'NOK', new Date('2026-07-02'), 'USD', rates)).toBe(2000)
  })

  it('is a no-op when the amount is already in the display currency', () => {
    expect(convert(10000, 'USD', new Date('2026-07-01'), 'USD', rates)).toBe(10000)
  })

  it('falls back to the most recent earlier rate when a day is missing', () => {
    // No rate on 5 Jul -> use 2 Jul rate of 0.2
    expect(convert(10000, 'NOK', new Date('2026-07-05'), 'USD', rates)).toBe(2000)
  })

  it('falls back to the earliest known rate when the date predates all rates', () => {
    expect(convert(10000, 'NOK', new Date('2026-06-01'), 'USD', rates)).toBe(1000)
  })

  it('returns the amount unchanged when the currency is entirely unknown', () => {
    // Showing an unconverted number is honest; showing zero would hide real money.
    expect(convert(10000, 'JPY', new Date('2026-07-01'), 'USD', rates)).toBe(10000)
  })
})

/**
 * The strict half of crossConvert, for the one caller that must not accept a
 * guess: writing a product cost into another shop's currency. crossConvert
 * returns the amount UNCONVERTED when a rate is missing (fx.ts:114), which is
 * right for a display figure - never zero out money on screen - and catastrophic
 * for a stored cost, where a NOK number saved as SEK is close enough to look
 * plausible while overstating profit for good.
 */
describe('crossFactor', () => {
  it('gives the multiplier between two non-USD currencies on a day', () => {
    // NOK 0.1 USD, SEK 0.09 USD, so one NOK buys 0.1/0.09 SEK.
    expect(crossFactor('NOK', 'SEK', new Date('2026-07-01'), rates)).toBeCloseTo(0.1 / 0.09, 10)
  })

  it('is exactly 1 for the same currency, without consulting a rate', () => {
    expect(crossFactor('NOK', 'NOK', new Date('2030-01-01'), new Map())).toBe(1)
  })

  it('says it does not know, rather than guessing 1, for a currency it holds no rate for', () => {
    expect(crossFactor('NOK', 'JPY', new Date('2026-07-01'), rates)).toBeUndefined()
    expect(crossFactor('JPY', 'NOK', new Date('2026-07-01'), rates)).toBeUndefined()
  })

  it('handles USD on either side', () => {
    expect(crossFactor('NOK', 'USD', new Date('2026-07-01'), rates)).toBeCloseTo(0.1, 10)
    expect(crossFactor('USD', 'NOK', new Date('2026-07-01'), rates)).toBeCloseTo(10, 10)
  })
})
