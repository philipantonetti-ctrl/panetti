import { describe, expect, it } from 'vitest'
import { hostOf, matchMarketsToShops } from './match'

describe('hostOf', () => {
  it('lowers the case and strips protocol and www', () => {
    expect(hostOf('https://www.Panetti.no')).toBe('panetti.no')
    expect(hostOf('http://panetti.de/')).toBe('panetti.de')
    expect(hostOf('panetti.se')).toBe('panetti.se') // Shop.wooUrl may be typed bare
  })
  it('nothing to parse is null, never a throw', () => {
    expect(hostOf(null)).toBeNull()
    expect(hostOf('')).toBeNull()
    expect(hostOf('not a url at all ???')).toBeNull()
  })
})

describe('matchMarketsToShops', () => {
  const shops = [
    { id: 's-no', wooUrl: 'https://www.panetti.no' },
    { id: 's-de', wooUrl: 'panetti.de' },
    { id: 's-none', wooUrl: null },
  ]
  it('maps each market to the shop whose wooUrl shares its host', () => {
    const { byMarket, unmatched } = matchMarketsToShops(
      [
        { market: 'NO', url: 'https://www.panetti.no' },
        { market: 'DE', url: 'https://www.panetti.de' },
      ],
      shops,
    )
    expect(byMarket.get('NO')).toBe('s-no')
    expect(byMarket.get('DE')).toBe('s-de')
    expect(unmatched).toEqual([])
  })
  it('an unknown domain is reported, never guessed', () => {
    const { byMarket, unmatched } = matchMarketsToShops(
      [{ market: 'FI', url: 'https://www.panetti.fi' }],
      shops,
    )
    expect(byMarket.has('FI')).toBe(false)
    expect(unmatched).toEqual(['FI'])
  })
})
