import { describe, it, expect } from 'vitest'
import { groupByCurrency, selectedShops } from './currency-groups'

const SHOPS = [
  { id: 'no', name: 'Panetti Norway', currency: 'NOK' },
  { id: 'de', name: 'Panetti Germany', currency: 'EUR' },
  { id: 'fi', name: 'Panetti Finland', currency: 'EUR' },
  { id: 'se', name: 'Panetti Sweden', currency: 'SEK' },
]

describe('groupByCurrency', () => {
  it('puts two EUR countries in one group', () => {
    const groups = groupByCurrency(SHOPS)
    const eur = groups.find((g) => g.currency === 'EUR')!
    expect(eur.shops.map((s) => s.id).sort()).toEqual(['de', 'fi'])
  })

  it('orders groups by currency so the UI never reshuffles between renders', () => {
    expect(groupByCurrency(SHOPS).map((g) => g.currency)).toEqual(['EUR', 'NOK', 'SEK'])
  })

  it('returns nothing for no shops', () => {
    expect(groupByCurrency([])).toEqual([])
  })
})

describe('selectedShops', () => {
  it('treats an empty selection as every shop', () => {
    expect(selectedShops(SHOPS, [])).toHaveLength(4)
  })

  it('treats the none sentinel as no shops at all', () => {
    expect(selectedShops(SHOPS, ['none'])).toEqual([])
  })

  it('keeps only the chosen ids', () => {
    expect(selectedShops(SHOPS, ['de', 'fi']).map((s) => s.id)).toEqual(['de', 'fi'])
  })

  it('ignores an id that matches no shop rather than inventing one', () => {
    expect(selectedShops(SHOPS, ['de', 'ghost']).map((s) => s.id)).toEqual(['de'])
  })
})
