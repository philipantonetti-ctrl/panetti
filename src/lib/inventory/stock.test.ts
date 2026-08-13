import { describe, expect, it } from 'vitest'
import { agreeStock, type ShopStock } from './stock'

const s = (shopName: string, quantity: number | null, updatedAt = new Date('2026-08-13')): ShopStock =>
  ({ shopName, quantity, updatedAt })

describe('agreeStock', () => {
  it('takes the figure the shops agree on', () => {
    const r = agreeStock([s('P-Norway', 906), s('P-Sweden', 906), s('P-Denmark', 906)])
    expect(r.quantity).toBe(906)
    expect(r.disagrees).toBe(false)
  })

  it('takes the most common figure and flags the disagreement', () => {
    // The live case on 2026-08-13: four shops said 906 and Germany said 939.
    const r = agreeStock([
      s('P-Denmark', 906), s('P-Finland', 906), s('P-Norway', 906),
      s('P-Sweden', 906), s('P-Germany', 939),
    ])
    expect(r.quantity).toBe(906)
    expect(r.disagrees).toBe(true)
  })

  it('breaks a tie on the freshest reading, not on shop order', () => {
    const r = agreeStock([
      s('P-Norway', 10, new Date('2026-08-01')),
      s('P-Sweden', 20, new Date('2026-08-13')),
    ])
    expect(r.quantity).toBe(20)
    expect(r.disagrees).toBe(true)
  })

  it('is null when no shop reports a figure, never zero', () => {
    // Zero means sold out and would sort to the top as an emergency. "We do not
    // know" must not be able to raise that alarm.
    const r = agreeStock([s('P-Norway', null), s('P-Sweden', null)])
    expect(r.quantity).toBeNull()
    expect(r.disagrees).toBe(false)
  })

  it('ignores shops with no figure when others have one', () => {
    const r = agreeStock([s('P-Norway', null), s('P-Sweden', 42)])
    expect(r.quantity).toBe(42)
    expect(r.disagrees).toBe(false)
  })

  it('keeps every shop in the breakdown so the disagreement is inspectable', () => {
    const r = agreeStock([s('P-Norway', 906), s('P-Germany', 939)])
    expect(r.byShop).toHaveLength(2)
  })

  it('reports nothing for an empty list', () => {
    expect(agreeStock([]).quantity).toBeNull()
  })
})
