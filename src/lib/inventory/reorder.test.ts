import { describe, expect, it } from 'vitest'
import { reorderTips, TIP_WINDOW_DAYS, type ReorderCandidate } from './reorder'

const TODAY = new Date('2026-08-13T00:00:00Z')
const inDays = (n: number) => new Date(TODAY.getTime() + n * 86400000)

const candidate = (
  sku: string,
  over: Partial<ReorderCandidate['forecast']> = {},
): ReorderCandidate => ({
  sku,
  name: `Product ${sku}`,
  supplierName: 'Ningbo Foshan',
  forecast: {
    orderBy: inDays(10),
    daysLate: null,
    quantity: 500,
    needed: 500,
    raisedBy: null,
    ...over,
  },
})

describe('reorderTips', () => {
  it('names a product whose order date has already gone past', () => {
    const tips = reorderTips([candidate('LATE', { orderBy: inDays(-61), daysLate: 61 })], TODAY)
    expect(tips.map((t) => t.sku)).toEqual(['LATE'])
    expect(tips[0].daysLate).toBe(61)
  })

  it('names one falling due inside the window', () => {
    expect(reorderTips([candidate('SOON', { orderBy: inDays(10) })], TODAY)).toHaveLength(1)
  })

  it('counts a date landing today as due, not as still to come', () => {
    const tips = reorderTips([candidate('TODAY', { orderBy: TODAY })], TODAY)
    expect(tips).toHaveLength(1)
    expect(tips[0].daysUntil).toBe(0)
  })

  /**
   * A tip list that names everything is a table, and there is already a table.
   * Only what needs deciding this month belongs here.
   */
  it('leaves alone a product not due for months', () => {
    expect(reorderTips([candidate('LATER', { orderBy: inDays(200) })], TODAY)).toEqual([])
  })

  it('honours a window the caller widens', () => {
    const rows = [candidate('LATER', { orderBy: inDays(200) })]
    expect(reorderTips(rows, TODAY, 365)).toHaveLength(1)
  })

  /**
   * Nobody can act on "order some of this by a date we cannot work out". A
   * product with no lead times on file is a settings job, said once in the
   * banner, not a suggestion repeated per product.
   */
  it('says nothing about a product whose order date could not be worked out', () => {
    expect(reorderTips([candidate('NOLEAD', { orderBy: null, quantity: null })], TODAY)).toEqual([])
  })

  it('puts the most urgent first, whatever order the rows arrive in', () => {
    const tips = reorderTips(
      [
        candidate('B', { orderBy: inDays(20) }),
        candidate('A', { orderBy: inDays(-5), daysLate: 5 }),
        candidate('C', { orderBy: inDays(2) }),
      ],
      TODAY,
    )
    expect(tips.map((t) => t.sku)).toEqual(['A', 'C', 'B'])
  })

  /**
   * The whole reason the suggestion is worth reading. "Order 500" is a number to
   * obey; "you need 160, the supplier will not take under 500" is one to weigh.
   */
  it('carries what demand asked for and what raised it, so the tip shows its working', () => {
    const tips = reorderTips(
      [candidate('MOQ', { quantity: 500, needed: 160, raisedBy: 'minimum' })],
      TODAY,
    )
    expect(tips[0]).toMatchObject({ quantity: 500, needed: 160, raisedBy: 'minimum' })
  })

  it('carries the supplier, because the tip is an instruction to contact one', () => {
    expect(reorderTips([candidate('S')], TODAY)[0].supplierName).toBe('Ningbo Foshan')
  })

  it('looks a month ahead by default', () => {
    expect(TIP_WINDOW_DAYS).toBe(30)
  })
})
