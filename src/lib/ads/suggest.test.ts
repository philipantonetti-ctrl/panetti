import { describe, expect, it } from 'vitest'
import { suggestShop } from './suggest'

const SHOPS = [
  { id: 'no', name: 'Mazzetti.no' },
  { id: 'se', name: 'Mazzetti.se' },
  { id: 'pd', name: 'Panetti Denmark' },
  { id: 'pn', name: 'Panetti Norway' },
  { id: 'bn', name: 'Bellino.no' },
]

describe('suggestShop', () => {
  it('maps country shorthands the way a Nordic ad account is actually named', () => {
    expect(suggestShop('Mazzetti NO', SHOPS)).toBe('no')
    expect(suggestShop('Mazzetti - SE', SHOPS)).toBe('se')
    expect(suggestShop('Panetti Danmark', SHOPS)).toBe('pd')
    expect(suggestShop('Panetti Norge', SHOPS)).toBe('pn')
  })

  it('gives no guess when the name fits nothing or fits too many', () => {
    expect(suggestShop('Levoit - NO', SHOPS)).toBeNull() // brand matches nothing
    expect(suggestShop('Mazzetti', SHOPS)).toBeNull() // one word, two shops
    expect(suggestShop('Jacob Kjos Hanssen', SHOPS)).toBeNull()
  })
})
