import { describe, expect, it } from 'vitest'
import { spreadCost } from './cost-spread'

const NORWAY = { id: 'p-no', shopName: 'Panetti Norway', currency: 'NOK' }
const SWEDEN = { id: 'p-se', shopName: 'Panetti Sweden', currency: 'SEK' }
const GERMANY = { id: 'p-de', shopName: 'Panetti Germany', currency: 'EUR' }

/** One NOK buys 1.1 SEK; EUR is a currency we hold no rate for. */
const factor = (from: string, to: string): number | undefined => {
  if (from === to) return 1
  if (from === 'NOK' && to === 'SEK') return 1.1
  return undefined
}

const spread = (siblings: typeof NORWAY[], over: Partial<Parameters<typeof spreadCost>[0]> = {}) =>
  spreadCost({
    from: 'NOK',
    costPerItem: 100_000,
    handlingCost: 2_400,
    siblings,
    factor,
    ...over,
  })

describe('spreadCost', () => {
  it('writes the entered amounts unchanged to a shop on the same currency', () => {
    expect(spread([NORWAY]).writes).toEqual([
      { productId: 'p-no', costPerItem: 100_000, handlingCost: 2_400 },
    ])
  })

  it('converts into another shop’s currency', () => {
    const { writes } = spread([SWEDEN])

    expect(writes).toEqual([{ productId: 'p-se', costPerItem: 110_000, handlingCost: 2_640 }])
  })

  /**
   * The whole reason this is not a call to crossConvert. That returns the amount
   * unconverted when a rate is missing, which would store 100,000 NOK into a
   * German product as 100,000 EUR — an eleven-fold error that reads as an
   * ordinary number and would overstate nothing visibly while destroying every
   * profit figure that product touches.
   */
  it('refuses a shop whose rate it does not have, and names it', () => {
    const { writes, skipped } = spread([NORWAY, GERMANY])

    expect(writes.map((w) => w.productId)).toEqual(['p-no'])
    expect(skipped).toEqual([{ shopName: 'Panetti Germany', currency: 'EUR' }])
  })

  it('rounds to whole minor units, because a third of an øre cannot be stored', () => {
    const { writes } = spread([SWEDEN], { costPerItem: 3, handlingCost: 0 })

    // 3 * 1.1 = 3.3000000000000003 in binary floating point.
    expect(writes[0].costPerItem).toBe(3)
    expect(Number.isInteger(writes[0].costPerItem)).toBe(true)
  })

  /**
   * Zero is a real answer here, not a missing one: the costs page treats
   * costPerItem 0 as "never entered" and warns about it, so a converted zero has
   * to stay zero rather than drift to 1 through a rate.
   */
  it('keeps a zero at zero through the conversion', () => {
    const { writes } = spread([SWEDEN], { costPerItem: 0, handlingCost: 0 })

    expect(writes[0]).toEqual({ productId: 'p-se', costPerItem: 0, handlingCost: 0 })
  })

  it('spreads across every shop that shares the product', () => {
    const { writes } = spread([NORWAY, SWEDEN])

    expect(writes.map((w) => w.productId)).toEqual(['p-no', 'p-se'])
  })

  it('reports nothing to write when the product is in no shop at all', () => {
    expect(spread([])).toEqual({ writes: [], skipped: [] })
  })
})
