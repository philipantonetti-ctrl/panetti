import { describe, it, expect } from 'vitest'
import { leaderboard } from './ambassadors'
import { buildRateTable } from './fx'
import type { EngineOrder } from './types'

const rates = buildRateTable([{ date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 }])

function order(over: Partial<EngineOrder>): EngineOrder {
  return {
    id: 'o', shopId: 'no', placedAt: new Date('2026-07-01'), status: 'completed', currency: 'NOK',
    grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    ambassadorId: null, commissionRate: 0.1, items: [], ...over,
  }
}

const people = [
  { id: 'a1', name: 'Emma Nilsen' },
  { id: 'a2', name: 'Johan Berg' },
  { id: 'a3', name: 'Sofia Lind' },
]

describe('leaderboard', () => {
  it('ranks ambassadors by their sales, biggest first', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [
        order({ id: '1', ambassadorId: 'a1', netSales: 100000 }),
        order({ id: '2', ambassadorId: 'a2', netSales: 300000 }),
        order({ id: '3', ambassadorId: 'a1', netSales: 100000 }),
      ],
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(rows[0].name).toBe('Johan Berg')   // 3000 kr
    expect(rows[1].name).toBe('Emma Nilsen')  // 2000 kr across 2 orders
    expect(rows[0].rank).toBe(1)
    expect(rows[1].rank).toBe(2)
    expect(rows[1].orders).toBe(2)
  })

  it('converts sales and commission to the display currency', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [order({ ambassadorId: 'a1', netSales: 100000 })], // 1000 kr
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows[0].sales).toBe(10000)      // $100.00
    expect(rows[0].commission).toBe(1000)  // $10.00 = 10%
  })

  it('excludes refunded orders from an ambassador totals', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [
        order({ id: '1', ambassadorId: 'a1', netSales: 100000 }),
        order({ id: '2', ambassadorId: 'a1', netSales: 500000, status: 'refunded' }),
      ],
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows[0].orders).toBe(1)
    expect(rows[0].sales).toBe(10000)
  })

  it('includes an ambassador with no sales, ranked last with zeroes', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [order({ ambassadorId: 'a1', netSales: 100000 })],
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows).toHaveLength(3)
    expect(rows[2].sales).toBe(0)
    expect(rows[2].orders).toBe(0)
  })
})
