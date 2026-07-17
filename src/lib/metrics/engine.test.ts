import { describe, it, expect } from 'vitest'
import { computeMetrics } from './engine'
import { buildRateTable } from './fx'
import type { CostBook, EngineExpense, EngineOrder, EngineShop } from './types'

const shops: EngineShop[] = [
  { id: 'no', name: 'Mazzetti.no', currency: 'NOK' },
  { id: 'se', name: 'Mazzetti.se', currency: 'SEK' },
]

// 1 NOK = 0.10 USD, 1 SEK = 0.09 USD
const rates = buildRateTable([
  { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-01'), currency: 'SEK', rate: 0.09 },
])

// Product p1 costs 100.00 kr/item + 10.00 kr handling from 1 Jan 2026.
const costs: CostBook = new Map([
  ['p1', [{ costPerItem: 10000, handlingCost: 1000, effectiveFrom: new Date('2026-01-01') }]],
])

function order(over: Partial<EngineOrder> = {}): EngineOrder {
  return {
    id: 'o1',
    shopId: 'no',
    placedAt: new Date('2026-07-01'),
    status: 'completed',
    currency: 'NOK',
    grossSales: 100000, // 1000.00 kr before discount
    discountTotal: 10000, //  100.00 kr discount
    netSales: 90000, //  900.00 kr  <- commission base
    shippingCharged: 5000, //   50.00 kr
    taxTotal: 22500, //  225.00 kr VAT — never revenue
    ambassadorId: null,
    commissionRate: 0,
    items: [{ productId: 'p1', quantity: 2, lineNetTotal: 90000 }],
    ...over,
  }
}

describe('computeMetrics', () => {
  it('computes profit for one shop in its own currency', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order()],
      expenses: [],
      costs,
      rates,
      displayCurrency: 'NOK',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
    })

    const t = res.total
    expect(t.orders).toBe(1)
    expect(t.netSales).toBe(90000) // 900 kr
    expect(t.netRevenue).toBe(95000) // + 50 kr shipping
    expect(t.cogs).toBe(22000) // 2 x (10000 + 1000)
    expect(t.commission).toBe(0) // unattributed
    expect(t.netProfit).toBe(73000) // 95000 - 22000
    expect(t.netMargin).toBeCloseTo(73000 / 95000, 6)
    expect(t.avgOrderValue).toBe(95000)
  })

  it('never counts VAT as revenue', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [order()], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    // taxTotal was 22500 and appears nowhere in revenue or profit.
    expect(res.total.netRevenue).toBe(95000)
    expect(res.total.netProfit).toBe(73000)
  })

  it('pays 10% commission on net sales, not on gross and not on shipping', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order({ ambassadorId: 'a1', commissionRate: 0.1 })],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.commission).toBe(9000) // 10% of 90000 netSales
    expect(res.total.ambassadorSales).toBe(90000)
    expect(res.total.netProfit).toBe(73000 - 9000)
  })

  it('excludes refunded and cancelled orders from everything', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [
        order({ id: 'good' }),
        order({ id: 'refunded', status: 'refunded', ambassadorId: 'a1', commissionRate: 0.1 }),
        order({ id: 'cancelled', status: 'cancelled' }),
      ],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.orders).toBe(1) // only the good one
    expect(res.total.netSales).toBe(90000)
    expect(res.total.commission).toBe(0) // the refunded order earns nothing
  })

  it('subtracts operational expenses for the selected range', () => {
    const expense: EngineExpense = {
      id: 'e1', shopId: 'no', amount: 3100000, currency: 'NOK',
      recurrence: 'MONTHLY', startDate: new Date('2026-01-01'), endDate: null, active: true,
    }
    const res = computeMetrics({
      shops: [shops[0]], orders: [order()], expenses: [expense], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    // 31 000 kr / 31 days = 1 000 kr for the single selected day
    expect(res.total.operationalExpenses).toBe(100000)
    expect(res.total.netProfit).toBe(73000 - 100000) // this day runs at a loss
  })

  it('consolidates several shops into USD using each order own-date rate', () => {
    const res = computeMetrics({
      shops,
      orders: [
        order({ id: 'n1', shopId: 'no', currency: 'NOK' }),
        order({ id: 's1', shopId: 'se', currency: 'SEK' }),
      ],
      expenses: [], costs, rates,
      displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    const no = res.byShop.find((s) => s.shopId === 'no')!
    const se = res.byShop.find((s) => s.shopId === 'se')!

    expect(no.netSales).toBe(9000) // 90000 øre x 0.10
    expect(se.netSales).toBe(8100) // 90000 öre x 0.09
    expect(res.total.netSales).toBe(17100) // and the total adds up
    expect(res.displayCurrency).toBe('USD')
  })

  it('returns a row for a shop with no orders rather than dropping it', () => {
    const res = computeMetrics({
      shops, orders: [order({ shopId: 'no' })], expenses: [], costs, rates,
      displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    const se = res.byShop.find((s) => s.shopId === 'se')!
    expect(se.orders).toBe(0)
    expect(se.netRevenue).toBe(0)
  })

  it('reports zero margin instead of dividing by zero when there is no revenue', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.netMargin).toBe(0)
    expect(res.total.avgOrderValue).toBe(0)
    expect(Number.isNaN(res.total.netMargin)).toBe(false)
  })

  it('costs an order with a product that has no cost entered as zero, not as a crash', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order({ items: [{ productId: 'unknown-product', quantity: 3, lineNetTotal: 90000 }] })],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.cogs).toBe(0)
    expect(res.total.netProfit).toBe(95000) // full revenue, no cost known
  })

  it('ignores orders outside the selected date range', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order({ placedAt: new Date('2026-06-30') }), order({ id: 'in', placedAt: new Date('2026-07-01') })],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.orders).toBe(1)
  })

  it('reports VAT for the period without letting it touch profit', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [
        order(),
        order({ id: 'refunded', status: 'refunded' }), // contributes no tax either
      ],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.taxes).toBe(22500) // the one live order's VAT
    expect(res.total.netProfit).toBe(73000) // unchanged — VAT is not a cost
    expect(res.byShop[0].taxes).toBe(22500)
  })

  it('converts VAT at each order own-date rate like every other figure', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [order()], expenses: [], costs, rates,
      displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.taxes).toBe(2250) // 22 500 øre x 0.10
  })
})
