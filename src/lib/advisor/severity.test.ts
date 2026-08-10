import { describe, expect, it } from 'vitest'
import { movingFact, severityOf } from './severity'

describe('severityOf', () => {
  it('rejects a move smaller than 10%, however much money it is worth', () => {
    expect(severityOf(0.04, 0.5)).toBeNull()
  })

  it('rejects a huge percentage worth almost nothing', () => {
    // A shop tripling on three orders. This gate is the whole reason a small
    // market cannot shout down a large one.
    expect(severityOf(2.0, 0.002)).toBeNull()
  })

  it('rejects a null delta, because the previous period was zero', () => {
    expect(severityOf(null, 0.5)).toBeNull()
  })

  it('scores a move by its share of total revenue', () => {
    expect(severityOf(0.12, 0.02)).toBeCloseTo(0.4)
  })

  it('saturates at a move worth 5% of total revenue', () => {
    expect(severityOf(0.2, 0.08)).toBe(1)
  })

  it('scores a fall exactly as it scores a rise of the same size', () => {
    expect(severityOf(-0.2, 0.03)).toBe(severityOf(0.2, 0.03))
  })
})

describe('movingFact', () => {
  const base = {
    id: 'revenue:shop_a',
    kind: 'REVENUE_MOVE' as const,
    shopId: 'shop_a',
    shopName: 'Panetti Sweden',
    subject: null,
    unit: 'money' as const,
    currency: 'USD',
  }

  it('returns a fact when both gates are cleared', () => {
    const fact = movingFact({ ...base, current: 80_000, previous: 100_000, impact: 20_000, baseline: 1_000_000 })
    expect(fact).not.toBeNull()
    expect(fact!.deltaPct).toBeCloseTo(-0.2)
    expect(fact!.severity).toBeCloseTo(0.4)
  })

  it('returns null when the move is immaterial', () => {
    expect(movingFact({ ...base, current: 80, previous: 100, impact: 20, baseline: 1_000_000 })).toBeNull()
  })

  it('returns null rather than dividing by a zero baseline', () => {
    expect(movingFact({ ...base, current: 80_000, previous: 100_000, impact: 20_000, baseline: 0 })).toBeNull()
  })
})
