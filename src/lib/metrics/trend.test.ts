import { describe, it, expect } from 'vitest'
import { previousRange, deltaPct, dailySeries } from './trend'
import { buildRateTable } from './fx'
import type { CostBook, EngineOrder, EngineShop } from './types'

const day = (d: Date) => d.toISOString().slice(0, 10)

describe('previousRange', () => {
  it('is the same length, immediately before', () => {
    // 1-7 Jul is 7 days -> the 7 days before it are 24-30 Jun.
    const prev = previousRange(new Date('2026-07-01'), new Date('2026-07-07'))
    expect(day(prev.from)).toBe('2026-06-24')
    expect(day(prev.to)).toBe('2026-06-30')
  })

  it('handles a single day', () => {
    const prev = previousRange(new Date('2026-07-14'), new Date('2026-07-14'))
    expect(day(prev.from)).toBe('2026-07-13')
    expect(day(prev.to)).toBe('2026-07-13')
  })

  it('crosses a month boundary without drifting', () => {
    const prev = previousRange(new Date('2026-03-01'), new Date('2026-03-31'))
    expect(day(prev.to)).toBe('2026-02-28')
    expect(day(prev.from)).toBe('2026-01-29') // 31 days back from 28 Feb
  })
})

describe('deltaPct', () => {
  it('is the change against the period before', () => {
    expect(deltaPct(110, 100)).toBeCloseTo(0.1, 6)
    expect(deltaPct(90, 100)).toBeCloseTo(-0.1, 6)
  })

  it('is null when there is nothing to compare against — never Infinity', () => {
    // Growing from zero is not "+∞%", it is simply not a percentage.
    expect(deltaPct(500, 0)).toBeNull()
    expect(deltaPct(0, 0)).toBeNull()
  })

  it('handles a negative previous period without lying about the direction', () => {
    // Last month lost 100, this month lost 50: that is an improvement.
    expect(deltaPct(-50, -100)).toBeGreaterThan(0)
  })
})

describe('dailySeries', () => {
  const shops: EngineShop[] = [{ id: 's1', name: 'Shop', currency: 'USD' }]
  const rates = buildRateTable([{ date: new Date('2026-07-01'), currency: 'USD', rate: 1 }])
  const costs: CostBook = new Map([
    ['p1', [{ costPerItem: 1000, handlingCost: 0, effectiveFrom: new Date('2026-01-01') }]],
  ])

  function order(id: string, on: string): EngineOrder {
    return {
      id, shopId: 's1', placedAt: new Date(on), status: 'completed', currency: 'USD',
      grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0, taxTotal: 2500,
      ambassadorId: null, commissionRate: 0,
      items: [{ productId: 'p1', quantity: 1, lineNetTotal: 10000 }],
    }
  }

  const input = {
    shops,
    orders: [order('a', '2026-07-01'), order('b', '2026-07-01'), order('c', '2026-07-03')],
    expenses: [],
    costs,
    rates,
    displayCurrency: 'USD',
    from: new Date('2026-07-01'),
    to: new Date('2026-07-03'),
  }

  it('returns one point per day in the range, even days with no orders', () => {
    const series = dailySeries(input)
    expect(series.map((p) => p.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it('puts each day’s revenue on that day', () => {
    const series = dailySeries(input)
    expect(series[0].netRevenue).toBe(20000) // two orders
    expect(series[1].netRevenue).toBe(0) // quiet day
    expect(series[2].netRevenue).toBe(10000)
  })

  it('computes profit per day, costs included', () => {
    const series = dailySeries(input)
    expect(series[0].netProfit).toBe(20000 - 2000) // 2 x 1000 cogs
    expect(series[2].netProfit).toBe(10000 - 1000)
  })

  it('adds up to the same total as the whole-range figure', () => {
    const series = dailySeries(input)
    const summed = series.reduce((n, p) => n + p.netRevenue, 0)
    expect(summed).toBe(30000)
  })
})
