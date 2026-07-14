import { describe, it, expect } from 'vitest'
import { costOn } from './costs'
import type { CostPoint } from './types'

const history: CostPoint[] = [
  { costPerItem: 10000, handlingCost: 100, effectiveFrom: new Date('2026-01-01') },
  { costPerItem: 12000, handlingCost: 200, effectiveFrom: new Date('2026-06-01') },
  { costPerItem: 15000, handlingCost: 300, effectiveFrom: new Date('2026-09-01') },
]

describe('costOn', () => {
  it('uses the cost in effect on the order date, not the newest one', () => {
    expect(costOn(history, new Date('2026-03-15'))).toEqual({ costPerItem: 10000, handlingCost: 100 })
    expect(costOn(history, new Date('2026-07-15'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
    expect(costOn(history, new Date('2026-10-15'))).toEqual({ costPerItem: 15000, handlingCost: 300 })
  })

  it('applies a cost from its effectiveFrom day, inclusive', () => {
    expect(costOn(history, new Date('2026-06-01'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
  })

  it('returns zero when the order predates every known cost — never guesses', () => {
    expect(costOn(history, new Date('2025-12-31'))).toEqual({ costPerItem: 0, handlingCost: 0 })
  })

  it('returns zero when there is no cost history at all', () => {
    expect(costOn([], new Date('2026-07-15'))).toEqual({ costPerItem: 0, handlingCost: 0 })
  })

  it('does not care what order the history arrives in', () => {
    const shuffled = [history[2], history[0], history[1]]
    expect(costOn(shuffled, new Date('2026-07-15'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
  })

  it('ignores the time of day — an order at 23:59 uses that day cost', () => {
    expect(costOn(history, new Date('2026-06-01T23:59:59Z'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
  })
})
