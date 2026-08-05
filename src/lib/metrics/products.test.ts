import { describe, it, expect } from 'vitest'
import { productFigures, mergeKey } from './products'
import { buildRateTable } from './fx'
import type { CostBook, EngineShop } from './types'
import type { ProductMeta, ProductOrder } from './products'

const shops: EngineShop[] = [
  { id: 'de', name: 'Panetti Germany', currency: 'EUR' },
  { id: 'fi', name: 'Panetti Finland', currency: 'EUR' },
]

// 1 NOK = 0.10 USD, 1 EUR = 1.00 USD  -> 1 EUR = 10 NOK
const rates = buildRateTable([
  { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-01'), currency: 'EUR', rate: 1 },
])

// The same product listed in two stores, sharing one SKU.
const products = new Map<string, ProductMeta>([
  ['p-de', { productId: 'p-de', shopId: 'de', sku: 'PZ-PRO', externalId: '42', name: 'Elektrischer Pizzaofen', imageUrl: 'de.png' }],
  ['p-fi', { productId: 'p-fi', shopId: 'fi', sku: 'PZ-PRO', externalId: '77', name: 'Sahkoinen pizzauuni', imageUrl: null }],
])

// 30.00 EUR/item + 2.00 handling from 1 Jan 2026.
const costs: CostBook = new Map([
  ['p-de', [{ costPerItem: 3000, handlingCost: 200, effectiveFrom: new Date('2026-01-01') }]],
  ['p-fi', [{ costPerItem: 3000, handlingCost: 200, effectiveFrom: new Date('2026-01-01') }]],
])

function order(over: Partial<ProductOrder> = {}): ProductOrder {
  return {
    id: 'o1',
    shopId: 'de',
    placedAt: new Date('2026-07-01'),
    status: 'completed',
    voidedAt: null,
    currency: 'EUR',
    costCurrency: 'EUR',
    grossSales: 20000,
    discountTotal: 0,
    netSales: 20000,
    shippingCharged: 0,
    taxTotal: 0,
    total: 20000,
    ambassadorId: null,
    commissionRate: 0,
    items: [{ productId: 'p-de', sku: 'PZ-PRO', name: 'Elektrischer Pizzaofen', quantity: 2, unitPrice: 10000, lineNetTotal: 20000 }],
    ...over,
  }
}

const run = (orders: ProductOrder[], over: Partial<Parameters<typeof productFigures>[0]> = {}) =>
  productFigures({
    shops,
    orders,
    products,
    costs,
    rates,
    displayCurrency: 'EUR',
    from: new Date('2026-07-01'),
    to: new Date('2026-07-31'),
    ...over,
  })

describe('productFigures', () => {
  it('computes one product in one store', () => {
    const res = run([order()])
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row.sku).toBe('PZ-PRO')
    expect(row.orders).toBe(1)
    expect(row.quantity).toBe(2)
    expect(row.grossSales).toBe(20000) // 2 x 100.00
    expect(row.netSales).toBe(20000)
    expect(row.cogs).toBe(6400) // 2 x (3000 + 200)
    expect(row.profit).toBe(13600)
    expect(row.margin).toBeCloseTo(0.68)
  })

  it('merges the same SKU across two stores and the children sum to the parent', () => {
    const fi = order({
      id: 'o2',
      shopId: 'fi',
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Sahkoinen pizzauuni', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 }],
      netSales: 10000,
    })
    const res = run([order(), fi])

    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row.stores).toHaveLength(2)
    expect(row.quantity).toBe(3)
    expect(row.netSales).toBe(30000)
    expect(row.orders).toBe(2)
    expect(sumOf(row.stores, 'netSales')).toBe(row.netSales)
    expect(sumOf(row.stores, 'cogs')).toBe(row.cogs)
    expect(sumOf(row.stores, 'quantity')).toBe(row.quantity)
    expect(sumOf(row.stores, 'orders')).toBe(row.orders)
  })

  it('never merges products that have no real SKU', () => {
    // map.ts falls back to the Woo product id when a listing has no SKU, and
    // those ids are per-store sequential: two stores' product #42 are not one product.
    const noSku = new Map<string, ProductMeta>([
      ['p-de', { productId: 'p-de', shopId: 'de', sku: '42', externalId: '42', name: 'Ofen', imageUrl: null }],
      ['p-fi', { productId: 'p-fi', shopId: 'fi', sku: '42', externalId: '42', name: 'Uuni', imageUrl: null }],
    ])
    const fi = order({
      id: 'o2',
      shopId: 'fi',
      items: [{ productId: 'p-fi', sku: '42', name: 'Uuni', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 }],
    })
    const res = run([order(), fi], { products: noSku })
    expect(res.rows).toHaveLength(2)
  })

  it('removes a refunded order on the day the money went back', () => {
    const refunded = order({ status: 'refunded', placedAt: new Date('2026-07-01'), voidedAt: new Date('2026-07-05') })
    const whole = run([refunded])
    expect(whole.rows[0].netSales).toBe(0)
    expect(whole.rows[0].cogs).toBe(0)

    // The sale alone, before the refund landed.
    const before = run([refunded], { from: new Date('2026-07-01'), to: new Date('2026-07-03') })
    expect(before.rows[0].netSales).toBe(20000)
  })

  it('counts a reversal as no order at all', () => {
    const refunded = order({ status: 'refunded', placedAt: new Date('2026-07-01'), voidedAt: new Date('2026-07-05') })
    expect(run([refunded]).rows[0].orders).toBe(1) // the sale, not the reversal
  })

  it('counts an order listing the same product twice as one order', () => {
    const twice = order({
      items: [
        { productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 },
        { productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 },
      ],
    })
    const row = run([twice]).rows[0]
    expect(row.orders).toBe(1)
    expect(row.quantity).toBe(2)
  })

  it('reads the cost that was true on the order date, not the newest one', () => {
    const dated: CostBook = new Map([
      ['p-de', [
        { costPerItem: 3000, handlingCost: 0, effectiveFrom: new Date('2026-01-01') },
        { costPerItem: 9000, handlingCost: 0, effectiveFrom: new Date('2026-07-15') },
      ]],
    ])
    expect(run([order()], { costs: dated }).rows[0].cogs).toBe(6000) // 2 x 3000, the July 1st cost
  })

  it('converts a B2B order invoiced in another currency', () => {
    // A NOK-invoiced order from a EUR shop: 2000.00 NOK = 200.00 EUR.
    const b2b = order({ currency: 'NOK', costCurrency: 'EUR', netSales: 200000, grossSales: 200000,
      items: [{ productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 2, unitPrice: 100000, lineNetTotal: 200000 }] })
    const row = run([b2b]).rows[0]
    expect(row.netSales).toBe(20000) // converted to EUR
    expect(row.cogs).toBe(6400) // costs were already EUR, untouched
  })

  it('marks a product with no cost entered, and margins do not silently read as 100%', () => {
    const row = run([order()], { costs: new Map() }).rows[0]
    expect(row.hasCost).toBe(false)
    expect(row.cogs).toBe(0)
    expect(run([order()], { costs: new Map() }).uncosted).toBe(1)
  })

  it('yields no margin rather than Infinity when nothing was sold', () => {
    const free = order({ netSales: 0, grossSales: 0,
      items: [{ productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 0, lineNetTotal: 0 }] })
    const row = run([free]).rows[0]
    expect(row.margin).toBe(0)
    expect(Number.isFinite(row.margin)).toBe(true)
  })

  it('sums the total and recomputes its margin rather than averaging the rows', () => {
    const fi = order({ id: 'o2', shopId: 'fi',
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Uuni', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 }],
      netSales: 10000, grossSales: 10000 })
    const res = run([order(), fi])
    expect(res.total.netSales).toBe(30000)
    expect(res.total.cogs).toBe(9600)
    expect(res.total.margin).toBeCloseTo(res.total.profit / res.total.netSales)
  })

  it('sorts the best earner first', () => {
    const cheap = new Map(products)
    cheap.set('p2', { productId: 'p2', shopId: 'de', sku: 'CHEAP', externalId: '99', name: 'Brush', imageUrl: null })
    const small = order({ id: 'o2', netSales: 500, grossSales: 500,
      items: [{ productId: 'p2', sku: 'CHEAP', name: 'Brush', quantity: 1, unitPrice: 500, lineNetTotal: 500 }] })
    const res = run([order(), small], { products: cheap })
    expect(res.rows.map((r) => r.sku)).toEqual(['PZ-PRO', 'CHEAP'])
  })

  it('names a merged row after its biggest seller so it reads in one language', () => {
    const fi = order({ id: 'o2', shopId: 'fi', netSales: 90000, grossSales: 90000,
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Sahkoinen pizzauuni', quantity: 9, unitPrice: 10000, lineNetTotal: 90000 }] })
    expect(run([order(), fi]).rows[0].name).toBe('Sahkoinen pizzauuni')
  })

  it('ignores an unpaid order entirely', () => {
    expect(run([order({ status: 'pending' })]).rows).toEqual([])
  })
})

describe('mergeKey', () => {
  it('keys on the SKU when there is a real one', () => {
    expect(mergeKey({ productId: 'p', shopId: 's', sku: 'PZ-PRO', externalId: '42', name: 'x', imageUrl: null }))
      .toBe('sku:PZ-PRO')
  })

  it('keys on the product itself when the SKU is only the Woo id', () => {
    const key = mergeKey({ productId: 'p', shopId: 's', sku: '42', externalId: '42', name: 'x', imageUrl: null })
    expect(key).not.toBe('sku:42')
    expect(key).toContain('p')
  })
})

function sumOf<T>(rows: T[], field: keyof T): number {
  return rows.reduce((a, r) => a + (r[field] as number), 0)
}
