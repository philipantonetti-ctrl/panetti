import { describe, it, expect } from 'vitest'
import { periodBuckets, periodLabel, salesByPeriod, unitsByPeriod, PERIODS, type ProductName } from './periods'
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
      orders: 1, sales: 12000, avgOrder: 12000, units: 1, vsPrevious: -0.5,
    })
    expect(rows[1]).toEqual({
      from: '2026-09-21', to: '2026-09-27', soFar: false,
      orders: 2, sales: 24000, avgOrder: 12000, units: 2, vsPrevious: 1,
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
    expect(rows[1]).toMatchObject({ orders: 0, sales: 0, avgOrder: 0, units: 0, vsPrevious: null })
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

  it('counts every unit of every counted order, not lines or orders', () => {
    const rows = salesByPeriod(
      input([
        order('a', '2026-09-29T10:00:00Z', {
          items: [
            { productId: 'p1', sku: 'PANPIZPRO', quantity: 2, lineNetTotal: 8000 },
            { productId: 'p2', sku: 'BRUSH', quantity: 3, lineNetTotal: 2000 },
          ],
        }),
        order('r', '2026-09-29T11:00:00Z', { status: 'refunded' }),
      ]),
      buckets,
      { excludeZero: false },
    )
    expect(rows[0].units).toBe(5)
  })
})

describe('unitsByPeriod', () => {
  const shops: EngineShop[] = [
    { id: 'fi', name: 'Finland', currency: 'USD' },
    { id: 'no', name: 'Norway', currency: 'USD' },
  ]
  const rates = buildRateTable([{ date: d('2026-01-01'), currency: 'USD', rate: 1 }])
  const costs: CostBook = new Map()

  // The same oven listed in two shops under one SKU, and gift cards whose
  // listings had no SKU at all (map.ts then stores the Woo product id as both).
  const products = new Map<string, ProductName>([
    ['oven-no', { productId: 'oven-no', shopId: 'no', sku: 'PANPIZPRO', externalId: '11', name: 'Pizzaovn Pro' }],
    ['oven-fi', { productId: 'oven-fi', shopId: 'fi', sku: 'PANPIZPRO', externalId: '7', name: 'Pizzauuni Pro' }],
    ['card-no', { productId: 'card-no', shopId: 'no', sku: '42', externalId: '42', name: 'Gavekort' }],
    ['card-fi', { productId: 'card-fi', shopId: 'fi', sku: '9', externalId: '9', name: 'Lahjakortti' }],
  ])

  type Line = { productId: string; quantity: number }
  function order(id: string, placedAt: string, shopId: string, lines: Line[], over: Partial<EngineOrder> = {}): EngineOrder {
    return {
      id, shopId, placedAt: new Date(placedAt), status: 'completed', currency: 'USD', costCurrency: 'USD',
      grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0, taxTotal: 2500, total: 12500,
      ambassadorId: null, commissionRate: 0,
      items: lines.map((l) => ({
        productId: l.productId, sku: products.get(l.productId)?.sku ?? '', quantity: l.quantity, lineNetTotal: 5000,
      })),
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

  // Today is Wednesday 30 Sep 2026: shown weeks 28 Sep - 4 Oct and 21-27 Sep.
  const buckets = periodBuckets('week', d('2026-09-30'), 2)

  const orders = [
    order('a', '2026-09-29T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 2 }]),
    order('b', '2026-09-29T11:00:00Z', 'no', [{ productId: 'oven-no', quantity: 1 }, { productId: 'card-no', quantity: 1 }]),
    order('c', '2026-09-22T10:00:00Z', 'fi', [{ productId: 'oven-fi', quantity: 5 }]),
    order('d', '2026-09-23T10:00:00Z', 'no', [{ productId: 'card-no', quantity: 3 }]),
    // An oven in the oldest, unshown bucket: it must not appear anywhere.
    order('e', '2026-09-15T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 9 }]),
  ]

  it('counts units, not orders or lines, per shop per shown period, shops in the order given', () => {
    const { byShop } = unitsByPeriod(input(orders), buckets, { excludeZero: false, products })
    expect(byShop).toEqual([
      { id: 'fi', name: 'Finland', units: [0, 5] },
      { id: 'no', name: 'Norway', units: [4, 3] },
    ])
  })

  it('makes one product of the same SKU across shops, named by the shop that sold most, biggest first', () => {
    const { byProduct } = unitsByPeriod(input(orders), buckets, { excludeZero: false, products })
    expect(byProduct).toEqual([
      { id: 'sku:PANPIZPRO', name: 'Pizzauuni Pro', units: [3, 5] },
      { id: 'product:card-no', name: 'Gavekort', units: [1, 3] },
    ])
  })

  it('keeps a product with no SKU to its own shop rather than merging on the Woo id', () => {
    const { byProduct } = unitsByPeriod(
      input([
        order('a', '2026-09-29T10:00:00Z', 'no', [{ productId: 'card-no', quantity: 1 }]),
        order('b', '2026-09-29T10:00:00Z', 'fi', [{ productId: 'card-fi', quantity: 1 }]),
      ]),
      buckets,
      { excludeZero: false, products },
    )
    expect(byProduct.map((r) => r.id).sort()).toEqual(['product:card-fi', 'product:card-no'])
  })

  it('never counts a voided or unpaid order, and leaves 0-amount orders out only when asked', () => {
    const free = { grossSales: 10000, discountTotal: 10000, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0 }
    const mixed = [
      order('a', '2026-09-29T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 1 }]),
      order('r', '2026-09-29T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 1 }], { status: 'refunded' }),
      order('p', '2026-09-29T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 1 }], { status: 'pending' }),
      order('z', '2026-09-29T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 1 }], free),
    ]
    const kept = unitsByPeriod(input(mixed), buckets, { excludeZero: false, products })
    expect(kept.byShop.find((s) => s.id === 'no')?.units).toEqual([2, 0])
    const dropped = unitsByPeriod(input(mixed), buckets, { excludeZero: true, products })
    expect(dropped.byShop.find((s) => s.id === 'no')?.units).toEqual([1, 0])
    expect(dropped.byProduct[0].units).toEqual([1, 0])
  })

  it('puts an order in its own shop\'s week, like the sales table', () => {
    // Monday 28 Sep 00:30 in Helsinki is Sunday 27 Sep 23:30 in Oslo.
    const { byShop } = unitsByPeriod(
      input([order('f', '2026-09-27T21:30:00Z', 'fi', [{ productId: 'oven-fi', quantity: 1 }])]),
      buckets,
      { excludeZero: false, products },
    )
    expect(byShop.find((s) => s.id === 'fi')?.units).toEqual([1, 0])
  })

  it('names a line whose product is unknown by its SKU rather than dropping its units', () => {
    const { byProduct, byShop } = unitsByPeriod(
      input([
        order('a', '2026-09-29T10:00:00Z', 'no', [], {
          items: [{ productId: 'ghost', sku: 'OLD-SKU', quantity: 2, lineNetTotal: 5000 }],
        }),
      ]),
      buckets,
      { excludeZero: false, products },
    )
    expect(byProduct).toEqual([{ id: 'product:ghost', name: 'OLD-SKU', units: [2, 0] }])
    expect(byShop.find((s) => s.id === 'no')?.units).toEqual([2, 0])
  })

  it('keeps a shop that sold nothing as a row of zeros rather than dropping it', () => {
    const { byShop } = unitsByPeriod(
      input([order('a', '2026-09-29T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 1 }])]),
      buckets,
      { excludeZero: false, products },
    )
    expect(byShop).toEqual([
      { id: 'fi', name: 'Finland', units: [0, 0] },
      { id: 'no', name: 'Norway', units: [1, 0] },
    ])
  })

  it('breaks a tie on units by name, and a tie on sellers by shop id, the same way every time', () => {
    const tied = [
      order('a', '2026-09-29T10:00:00Z', 'no', [{ productId: 'card-no', quantity: 2 }]),
      order('b', '2026-09-29T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 1 }]),
      order('c', '2026-09-29T10:00:00Z', 'fi', [{ productId: 'oven-fi', quantity: 1 }]),
    ]
    const { byProduct } = unitsByPeriod(input(tied), buckets, { excludeZero: false, products })
    // Both products sold 2: "Gavekort" sorts before the oven; and the oven's
    // two shops sold 1 each, so 'fi' names it, being the lower shop id.
    expect(byProduct.map((r) => r.name)).toEqual(['Gavekort', 'Pizzauuni Pro'])
    const reversed = unitsByPeriod(input([...tied].reverse()), buckets, { excludeZero: false, products })
    expect(reversed.byProduct.map((r) => r.name)).toEqual(['Gavekort', 'Pizzauuni Pro'])
  })

  it('counts no unit of an order whose shop the engine does not count either', () => {
    // An order from a shop that is not in input.shops earns nothing on the
    // sales rows (computeMetrics only sums the shops it is given), so its
    // units must not appear on the rows, by shop, or by product.
    const stranger = order('s', '2026-09-29T10:00:00Z', 'se', [{ productId: 'oven-no', quantity: 5 }])
    const mine = order('a', '2026-09-29T10:00:00Z', 'no', [{ productId: 'oven-no', quantity: 2 }])
    const rows = salesByPeriod(input([mine, stranger]), buckets, { excludeZero: false })
    const { byShop, byProduct } = unitsByPeriod(input([mine, stranger]), buckets, { excludeZero: false, products })
    expect([rows[0].orders, rows[0].units]).toEqual([1, 2])
    expect(byShop.map((s) => s.units[0])).toEqual([0, 2])
    expect(byProduct.map((p) => p.units[0])).toEqual([2])
  })

  it('adds up to the sales table\'s units column, by shop and by product alike', () => {
    const rows = salesByPeriod(input(orders), buckets, { excludeZero: false })
    const { byShop, byProduct } = unitsByPeriod(input(orders), buckets, { excludeZero: false, products })
    const column = (list: { units: number[] }[], i: number) => list.reduce((n, r) => n + r.units[i], 0)
    expect(rows.map((r) => r.units)).toEqual([4, 8])
    expect(rows.map((_, i) => column(byShop, i))).toEqual([4, 8])
    expect(rows.map((_, i) => column(byProduct, i))).toEqual([4, 8])
  })
})
