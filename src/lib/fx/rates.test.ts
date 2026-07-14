import { describe, it, expect, vi } from 'vitest'
import { parseFrankfurter, missingDays } from './rates'

describe('parseFrankfurter', () => {
  it('turns the API response into rate rows to USD', () => {
    // Frankfurter with base=USD gives "1 USD = X NOK". We need the inverse: 1 NOK = ? USD.
    const rows = parseFrankfurter({
      base: 'USD',
      rates: {
        '2026-07-01': { NOK: 10, SEK: 11.111111 },
        '2026-07-02': { NOK: 8 },
      },
    })

    const nok1 = rows.find((r) => r.currency === 'NOK' && r.date.toISOString().startsWith('2026-07-01'))!
    expect(nok1.rate).toBeCloseTo(0.1, 6) // 1 NOK = 0.10 USD

    const sek1 = rows.find((r) => r.currency === 'SEK')!
    expect(sek1.rate).toBeCloseTo(0.09, 5)

    const nok2 = rows.find((r) => r.currency === 'NOK' && r.date.toISOString().startsWith('2026-07-02'))!
    expect(nok2.rate).toBeCloseTo(0.125, 6)
  })

  it('always includes USD to USD as exactly 1', () => {
    const rows = parseFrankfurter({ base: 'USD', rates: { '2026-07-01': { NOK: 10 } } })
    const usd = rows.find((r) => r.currency === 'USD')!
    expect(usd.rate).toBe(1)
  })

  it('skips a zero rate rather than dividing by zero', () => {
    const rows = parseFrankfurter({ base: 'USD', rates: { '2026-07-01': { NOK: 0 } } })
    expect(rows.find((r) => r.currency === 'NOK')).toBeUndefined()
  })
})

describe('missingDays', () => {
  it('returns the days in the range we do not already hold', () => {
    const have = [new Date('2026-07-01'), new Date('2026-07-03')]
    const gaps = missingDays(new Date('2026-07-01'), new Date('2026-07-04'), have)
    expect(gaps.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-07-02', '2026-07-04'])
  })

  it('returns nothing when we hold every day', () => {
    const have = [new Date('2026-07-01'), new Date('2026-07-02')]
    expect(missingDays(new Date('2026-07-01'), new Date('2026-07-02'), have)).toEqual([])
  })
})
