import { describe, expect, it } from 'vitest'
import type { ReorderTip } from '../../inventory/reorder'
import { MAX_REORDER_FACTS, reorderFacts } from './inventory'

const TODAY = new Date('2026-08-13T00:00:00Z')
const inDays = (n: number) => new Date(TODAY.getTime() + n * 86400000)

const tip = (sku: string, over: Partial<ReorderTip> = {}): ReorderTip => ({
  sku,
  name: `Pizzaovntrekk ${sku}`,
  supplierName: 'Ningbo Foshan',
  quantity: 800,
  needed: 800,
  raisedBy: null,
  orderBy: inDays(10),
  daysLate: null,
  daysUntil: 10,
  ...over,
})

describe('reorderFacts', () => {
  it('makes a fact of a product whose order date has gone past', () => {
    const [fact] = reorderFacts([tip('COVER', { orderBy: inDays(-61), daysLate: 61, daysUntil: 0 })])
    expect(fact).toMatchObject({
      id: 'reorder:COVER',
      kind: 'REORDER_DUE',
      subject: 'Pizzaovntrekk COVER',
      current: 800,
      unit: 'count',
      severity: 1,
    })
  })

  /**
   * The briefing groups facts by shop, and this one belongs to none: the shops
   * mirror a single warehouse, and it is the warehouse that runs out.
   */
  it('belongs to no shop, because it is the warehouse that empties', () => {
    const [fact] = reorderFacts([tip('A')])
    expect(fact.shopId).toBeNull()
    expect(fact.shopName).toBeNull()
  })

  it('has nothing to compare against, and does not invent a movement', () => {
    const [fact] = reorderFacts([tip('A')])
    expect(fact.previous).toBeNull()
    expect(fact.deltaPct).toBeNull()
  })

  it('ranks an order that is already late above one due in three weeks', () => {
    const [late] = reorderFacts([tip('L', { daysLate: 4, daysUntil: 0 })])
    const [soon] = reorderFacts([tip('S', { daysUntil: 21 })])
    expect(late.severity).toBeGreaterThan(soon.severity)
  })

  it('says nothing when nothing is due', () => {
    expect(reorderFacts([])).toEqual([])
  })

  /**
   * Every product is overdue the morning lead times are first entered. Left
   * uncapped, twenty of these at full severity would fill the briefing and push
   * out everything about the money. The Forecast page is the complete list; this
   * is a digest, and it says so by being one.
   */
  it('carries at most a handful, and keeps the most urgent of them', () => {
    const tips = [
      tip('LATE', { daysLate: 30, daysUntil: 0 }),
      ...Array.from({ length: 9 }, (_, i) => tip(`SOON${i}`, { daysUntil: 20 + i })),
    ]
    const facts = reorderFacts(tips)
    expect(facts).toHaveLength(MAX_REORDER_FACTS)
    expect(facts[0].id).toBe('reorder:LATE')
  })
})
