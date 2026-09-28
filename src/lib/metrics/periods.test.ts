import { describe, it, expect } from 'vitest'
import { periodBuckets, periodLabel, salesByPeriod, PERIODS } from './periods'
import { computeMetrics } from './engine'
import { buildRateTable } from './fx'
import type { CostBook, EngineOrder, EngineShop } from './types'
import type { MetricsInput } from './engine'

const d = (s: string) => new Date(`${s}T00:00:00Z`)
const ymd = (x: Date) => x.toISOString().slice(0, 10)

describe('periodBuckets', () => {
  it('gives count + 1 Monday-to-Sunday weeks, newest first, the current one so far', () => {
    // 2026-09-28 is a Monday.
    const b = periodBuckets('week', d('2026-09-30'), 3)
    expect(b).toHaveLength(4)
    expect(b.map((x) => [ymd(x.from), ymd(x.to), ymd(x.countedTo), x.soFar])).toEqual([
      ['2026-09-28', '2026-10-04', '2026-09-30', true],
      ['2026-09-21', '2026-09-27', '2026-09-27', false],
      ['2026-09-14', '2026-09-20', '2026-09-20', false],
      ['2026-09-07', '2026-09-13', '2026-09-13', false],
    ])
  })

  it('gives calendar months, the current one counted to today', () => {
    const b = periodBuckets('month', d('2026-09-15'), 2)
    expect(b.map((x) => [ymd(x.from), ymd(x.to), ymd(x.countedTo), x.soFar])).toEqual([
      ['2026-09-01', '2026-09-30', '2026-09-15', true],
      ['2026-08-01', '2026-08-31', '2026-08-31', false],
      ['2026-07-01', '2026-07-31', '2026-07-31', false],
    ])
  })

  // Review Focus 2
  it('on the 1st, the current month is one day long and the previous is whole', () => {
    const [now, before] = periodBuckets('month', d('2026-10-01'), 1)
    expect([ymd(now.from), ymd(now.countedTo), now.soFar]).toEqual(['2026-10-01', '2026-10-01', true])
    expect([ymd(before.from), ymd(before.to)]).toEqual(['2026-09-01', '2026-09-30'])
  })

  // Review Focus 3
  it('keeps a week that crosses New Year whole', () => {
    const [week] = periodBuckets('week', d('2026-01-01'), 1)
    expect([ymd(week.from), ymd(week.to)]).toEqual(['2025-12-29', '2026-01-04'])
  })

  // Review Focus 4
  it('ends February on the 29th in a leap year', () => {
    const b = periodBuckets('month', d('2028-03-10'), 1)
    expect([ymd(b[1].from), ymd(b[1].to)]).toEqual(['2028-02-01', '2028-02-29'])
  })

  it('shows twelve periods by default', () => {
    expect(PERIODS).toBe(12)
  })
})

describe('periodLabel', () => {
  it('writes a week inside one month, across two months, and a month', () => {
    expect(periodLabel('2026-09-22', '2026-09-28', 'week')).toBe('22-28 Sep')
    expect(periodLabel('2025-12-29', '2026-01-04', 'week')).toBe('29 Dec - 4 Jan')
    expect(periodLabel('2026-09-01', '2026-09-30', 'month')).toBe('September 2026')
  })
})

describe('salesByPeriod', () => {
  const shops: EngineShop[] = [
    { id: 'no', name: 'Norway', currency: 'USD' },
    { id: 'fi', name: 'Finland', currency: 'USD' },
  ]
  const rates = buildRateTable([{ date: d('2026-01-01'), currency: 'USD', rate: 1 }])
  const costs: CostBook = new Map([
    ['p1', [{ costPerItem: 1000, handlingCost: 0, effectiveFrom: d('2026-01-01') }]],
  ])

  function order(id: string, placedAt: string, over: Partial<EngineOrder> = {}): EngineOrder {
    return {
      id, shopId: 'no', placedAt: new Date(placedAt), status: 'completed', currency: 'USD', costCurrency: 'USD',
      grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 2000, taxTotal: 3000, total: 15000,
      ambassadorId: null, commissionRate: 0,
      items: [{ productId: 'p1', sku: 'PANPIZPRO', quantity: 1, lineNetTotal: 10000 }],
      ...over,
    }
  }

  function input(orders: EngineOrder[]): MetricsInput {
    return {
      shops, orders, expenses: [], costs, rates, displayCurrency: 'USD',
      from: d('2026-09-01'), to: d('2026-09-30'),
      timezone: 'Europe/Oslo',
      shopTimezones: new Map([['fi', 'Europe/Helsinki']]),
    }
  }

  // Today is Wednesday 30 Sep 2026: current week 28 Sep - 4 Oct, then 21-27, then 14-20.
  const buckets = periodBuckets('week', d('2026-09-30'), 2)

  it('counts each week, newest first, and compares with the whole week before', () => {
    const rows = salesByPeriod(
      input([
        order('a', '2026-09-29T10:00:00Z'),
        order('b', '2026-09-22T10:00:00Z'),
        order('c', '2026-09-23T10:00:00Z'),
        order('d', '2026-09-15T10:00:00Z'),
      ]),
      buckets,
      { excludeZero: false },
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      from: '2026-09-28', to: '2026-10-04', soFar: true,
      orders: 1, sales: 12000, avgOrder: 12000, vsPrevious: -0.5,
    })
    expect(rows[1]).toEqual({
      from: '2026-09-21', to: '2026-09-27', soFar: false,
      orders: 2, sales: 24000, avgOrder: 12000, vsPrevious: 1,
    })
  })

  it('never counts a voided or unpaid order', () => {
    const rows = salesByPeriod(
      input([
        order('a', '2026-09-29T10:00:00Z'),
        order('r', '2026-09-29T11:00:00Z', { status: 'refunded' }),
        order('p', '2026-09-29T12:00:00Z', { status: 'pending' }),
      ]),
      buckets,
      { excludeZero: false },
    )
    expect(rows[0].orders).toBe(1)
  })

  it('leaves 0-amount orders out of every row and every comparison base, only when asked', () => {
    const free = { grossSales: 10000, discountTotal: 10000, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0 }
    const orders = [
      order('a', '2026-09-29T10:00:00Z'),
      order('z1', '2026-09-29T11:00:00Z', free),
      order('b', '2026-09-22T10:00:00Z'),
      order('z2', '2026-09-22T11:00:00Z', free),
    ]
    const kept = salesByPeriod(input(orders), buckets, { excludeZero: false })
    expect(kept.map((r) => r.orders)).toEqual([2, 2])
    expect(kept[0].avgOrder).toBe(6000)

    const dropped = salesByPeriod(input(orders), buckets, { excludeZero: true })
    expect(dropped.map((r) => r.orders)).toEqual([1, 1])
    expect(dropped[0].avgOrder).toBe(12000)
    expect(dropped[0].vsPrevious).toBe(0)
  })

  // Review Focus 1
  it('puts an order in its own shop\'s week, not the workspace\'s', () => {
    // Monday 28 Sep 00:30 in Helsinki is Sunday 27 Sep 23:30 in Oslo.
    const rows = salesByPeriod(
      input([order('f', '2026-09-27T21:30:00Z', { shopId: 'fi' })]),
      buckets,
      { excludeZero: false },
    )
    expect(rows[0].orders).toBe(1)
    expect(rows[1].orders).toBe(0)
  })

  // Review Focus 5
  it('reports no change, not a number, when there was nothing before', () => {
    const rows = salesByPeriod(input([order('a', '2026-09-29T10:00:00Z')]), buckets, { excludeZero: false })
    expect(rows[1]).toMatchObject({ orders: 0, sales: 0, avgOrder: 0, vsPrevious: null })
    expect(rows[0].vsPrevious).toBeNull()
  })

  it('agrees with the owner\'s dashboard for the same dates, to the unit', () => {
    const orders = [
      order('a', '2026-09-22T10:00:00Z'),
      order('b', '2026-09-24T18:00:00Z', { shopId: 'fi', netSales: 33333, shippingCharged: 1111 }),
      order('c', '2026-09-27T21:30:00Z'),
    ]
    const [, week] = salesByPeriod(input(orders), buckets, { excludeZero: false })
    const owner = computeMetrics({ ...input(orders), from: d('2026-09-21'), to: d('2026-09-27') }).total
    expect([week.orders, week.sales, week.avgOrder]).toEqual([owner.orders, owner.netRevenue, owner.avgOrderValue])
  })
})
