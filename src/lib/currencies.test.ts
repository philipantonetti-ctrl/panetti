import { describe, it, expect } from 'vitest'
import { currencySymbol, allCurrencies, isConvertible } from './currencies'

describe('currencySymbol', () => {
  it('gives the symbol people recognise', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('CAD')).toBe('CA$')
  })

  it('uses the Nordic symbols people here actually recognise', () => {
    // Left to the default data these come out as "NOK", "SEK", "DKK" — which reads
    // as "NOK - NOK" in the picker. Our shops live in these currencies.
    expect(currencySymbol('NOK')).toBe('Nkr')
    expect(currencySymbol('SEK')).toBe('Skr')
    expect(currencySymbol('DKK')).toBe('Dkr')
  })

  it('falls back to the code itself rather than crashing on a bad one', () => {
    expect(currencySymbol('ZZZ')).toBe('ZZZ')
    expect(currencySymbol('')).toBe('')
  })
})

describe('allCurrencies', () => {
  const list = allCurrencies()

  it('offers the whole world of currencies, not a handful', () => {
    expect(list.length).toBeGreaterThan(100)
  })

  it('labels them the way the picker shows them', () => {
    const usd = list.find((c) => c.code === 'USD')!
    expect(usd.label).toBe('USD - $')
  })

  it('puts the currencies we actually trade in at the top', () => {
    expect(list.slice(0, 6).map((c) => c.code)).toEqual(['USD', 'EUR', 'NOK', 'SEK', 'DKK', 'GBP'])
  })

  it('lists the rest alphabetically', () => {
    const rest = list.slice(6).map((c) => c.code)
    expect([...rest].sort()).toEqual(rest)
  })

  it('has no duplicates', () => {
    const codes = list.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('includes the currencies our shops use', () => {
    const codes = list.map((c) => c.code)
    for (const code of ['NOK', 'SEK', 'DKK', 'EUR', 'USD']) expect(codes).toContain(code)
  })
})

/**
 * We hold daily exchange rates for the ECB's list only. Anything else cannot be
 * converted into the USD totals, and the UI has to say so rather than quietly
 * counting 1 000 of it as 1 000 USD.
 */
describe('isConvertible', () => {
  it('knows the currencies we hold rates for', () => {
    expect(isConvertible('NOK')).toBe(true)
    expect(isConvertible('USD')).toBe(true)
    expect(isConvertible('EUR')).toBe(true)
    expect(isConvertible('JPY')).toBe(true)
  })

  it('knows the ones we do not', () => {
    expect(isConvertible('AFN')).toBe(false)
    expect(isConvertible('AED')).toBe(false)
  })

  it('is not fooled by lower case', () => {
    expect(isConvertible('nok')).toBe(true)
  })
})
