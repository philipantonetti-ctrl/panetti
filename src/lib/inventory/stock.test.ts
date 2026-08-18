import { describe, expect, it } from 'vitest'
import { agreeStock, resolveStock, type ShopStock } from './stock'

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

const visma = (quantity: number, measuredAt = new Date('2026-08-18T08:57:32Z')) =>
  ({ quantity, measuredAt })

/**
 * Visma is the ERP the warehouse actually works in; the shops are copies of it
 * that drift. So when Visma has a figure it is the figure, and the vote among
 * copies is only there for the SKUs it does not carry.
 */
describe('resolveStock', () => {
  it('takes Visma"s number over the shops', () => {
    const got = resolveStock(visma(991), [s('Panetti Norway', 976), s('Mazzetti Norway', 976)])

    expect(got.quantity).toBe(991)
    expect(got.source).toBe('visma')
  })

  /**
   * Zero is a real answer and it is falsy, which is exactly how it would go
   * missing. Sold out must not read as "Visma said nothing" and quietly hand
   * the forecast a stale shop figure.
   */
  it('lets Visma say zero rather than falling through to the shops', () => {
    const got = resolveStock(visma(0), [s('Panetti Norway', 12)])

    expect(got.quantity).toBe(0)
    expect(got.source).toBe('visma')
  })

  it('falls back to the shops when Visma does not carry the SKU', () => {
    const got = resolveStock(null, [s('Panetti Norway', 906), s('Mazzetti Norway', 906)])

    expect(got.quantity).toBe(906)
    expect(got.source).toBe('shops')
  })

  /** The 2026-08-13 case: four shops said 906 and Germany said 939. */
  it('still outvotes a drifted mirror when it has to fall back', () => {
    const got = resolveStock(null, [
      s('Denmark', 906), s('Finland', 906), s('Norway', 906), s('Sweden', 906), s('Germany', 939),
    ])

    expect(got.quantity).toBe(906)
    expect(got.disagrees).toBe(true)
  })

  it('reports nothing rather than zero when neither source has a figure', () => {
    const got = resolveStock(null, [s('Panetti Norway', null)])

    expect(got.quantity).toBeNull()
    expect(got.source).toBe('none')
  })

  it('keeps every shop reading, so the page can still show who says what', () => {
    const rows = [s('Panetti Norway', 976), s('Mazzetti Norway', 976)]

    expect(resolveStock(visma(991), rows).byShop).toEqual(rows)
  })

  /**
   * A drifting mirror is worth saying out loud whether or not Visma settled the
   * number, because it means a shop is showing customers the wrong figure.
   */
  it('still reports mirror drift when Visma decided the number', () => {
    const got = resolveStock(visma(991), [s('Panetti Norway', 976), s('Mazzetti Norway', 939)])

    expect(got.source).toBe('visma')
    expect(got.disagrees).toBe(true)
  })

  it('carries Visma"s reading through, so the gap can be shown', () => {
    const got = resolveStock(visma(991, new Date('2026-08-18T08:57:32Z')), [s('Panetti Norway', 976)])

    expect(got.visma).toEqual({ quantity: 991, measuredAt: new Date('2026-08-18T08:57:32Z') })
  })

  it('has no Visma reading to show when Visma did not carry the SKU', () => {
    expect(resolveStock(null, [s('Panetti Norway', 976)]).visma).toBeNull()
  })
})
