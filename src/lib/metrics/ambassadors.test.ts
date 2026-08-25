import { describe, it, expect } from 'vitest'
import { leaderboard } from './ambassadors'
import { buildRateTable } from './fx'
import type { EngineOrder } from './types'

const rates = buildRateTable([{ date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 }])

function order(over: Partial<EngineOrder>): EngineOrder {
  return {
    id: 'o', shopId: 'no', placedAt: new Date('2026-07-01'), status: 'completed', currency: 'NOK',
    costCurrency: 'NOK',
    grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    ambassadorId: null, commissionRate: 0.1, items: [], ...over,
  }
}

const people = [
  { id: 'a1', name: 'Emma Nilsen', shops: ['Panetti Norway'] },
  { id: 'a2', name: 'Johan Berg', shops: ['Panetti Norway', 'Panetti Sweden'] },
  { id: 'a3', name: 'Sofia Lind', shops: [] },
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

  it('a pending order earns nothing on the leaderboard until it is paid', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [
        order({ id: '1', ambassadorId: 'a1', netSales: 100000 }),
        order({ id: '2', ambassadorId: 'a1', netSales: 500000, status: 'pending' }),
      ],
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows[0].orders).toBe(1)
    expect(rows[0].sales).toBe(10000)
  })

  it("carries each ambassador's shops through to the row", () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [order({ ambassadorId: 'a2', netSales: 100000 })],
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows[0].shops).toEqual(['Panetti Norway', 'Panetti Sweden'])
    expect(rows.find((r) => r.name === 'Sofia Lind')?.shops).toEqual([])
  })

  it('converts a DKK order into a NOK display currency using the true cross rate', () => {
    // Same defect class as engine.ts: NOK 0.10 USD, DKK 0.15 USD, so the true
    // DKK->NOK cross rate is 1.5. Plain `convert` would instead apply the bare
    // DKK->USD rate (0.15) and call the result NOK - a tenfold undercount.
    const dkRates = buildRateTable([
      { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
      { date: new Date('2026-07-01'), currency: 'DKK', rate: 0.15 },
    ])
    const rows = leaderboard({
      ambassadors: people,
      orders: [order({ ambassadorId: 'a1', currency: 'DKK', netSales: 100000 })],
      rates: dkRates, displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows[0].sales).toBe(150000) // 100000 x (0.15 / 0.10)
    expect(rows[0].commission).toBe(15000) // 10% of the converted sale
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
