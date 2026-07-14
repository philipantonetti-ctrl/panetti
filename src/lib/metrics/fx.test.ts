import { describe, it, expect } from 'vitest'
import { convert, buildRateTable } from './fx'

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
