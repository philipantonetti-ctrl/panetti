import { describe, it, expect } from 'vitest'
import { productFigures, mergeKey } from './products'
import { buildRateTable } from './fx'
import type { CostBook, EngineShop } from './types'
import type { ProductMeta, ProductOrder } from './products'

const shops: EngineShop[] = [
  { id: 'de', name: 'Panetti Germany', currency: 'EUR' },
  { id: 'fi', name: 'Panetti Finland', currency: 'EUR' },
]

// 1 NOK = 0.10 USD, 1 EUR = 1.10 USD  ->  1 EUR = 11 NOK.
// The EUR rate is deliberately NOT 1.00: at 1.00, NOK->EUR and NOK->USD are
// numerically identical, which let a `convert`-vs-`crossConvert` currency bug
// pass every test silently. It must stay off 1.00.
const rates = buildRateTable([
  { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-01'), currency: 'EUR', rate: 1.1 },
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

    // Assert the actual expected per-store figures, not just that the
    // children sum to the parent — the merge arithmetic guarantees that
    // structurally, so it would pass even if every per-store figure were
    // individually wrong.
    const de = row.stores.find((s) => s.shopId === 'de')!
    const fiStore = row.stores.find((s) => s.shopId === 'fi')!
    expect(de.netSales).toBe(20000)
    expect(de.cogs).toBe(6400)
    expect(de.quantity).toBe(2)
    expect(de.orders).toBe(1)
    expect(fiStore.netSales).toBe(10000)
    expect(fiStore.cogs).toBe(3200)
    expect(fiStore.quantity).toBe(1)
    expect(fiStore.orders).toBe(1)
  })

  it('merges a refunded store with an un-refunded one and the parent tally still sums the (possibly negative) children', () => {
    const deRefunded = order({ status: 'refunded', placedAt: new Date('2026-07-01'), voidedAt: new Date('2026-07-05') })
    const fi = order({
      id: 'o2',
      shopId: 'fi',
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Sahkoinen pizzauuni', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 }],
      netSales: 10000,
    })
    const res = run([deRefunded, fi])

    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    const de = row.stores.find((s) => s.shopId === 'de')!
    const fiStore = row.stores.find((s) => s.shopId === 'fi')!
    expect(de.orders).toBe(0) // placed and refunded, both in range: nets to 0
    expect(fiStore.orders).toBe(1)
    expect(row.orders).toBe(1)
    expect(de.orders + fiStore.orders).toBe(row.orders)
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
    // Placed (+1) and reversed (-1) both land in range, netting to 0 -- the
    // same "sum of signs" convention the Dashboard uses. This was the bug:
    // it used to read 1, because only the sale side was ever counted.
    expect(whole.rows[0].orders).toBe(0)

    // The sale alone, before the refund landed.
    const before = run([refunded], { from: new Date('2026-07-01'), to: new Date('2026-07-03') })
    expect(before.rows[0].netSales).toBe(20000)
  })

  it('reverses quantity and grossSales too, not only netSales and cogs', () => {
    const refunded = order({ status: 'refunded', placedAt: new Date('2026-07-01'), voidedAt: new Date('2026-07-05') })
    const row = run([refunded]).rows[0]
    expect(row.quantity).toBe(0)
    expect(row.grossSales).toBe(0)
  })

  it('a reversal alone leaves a negative tally, the way the Dashboard does', () => {
    const refunded = order({ status: 'refunded', placedAt: new Date('2026-07-01'), voidedAt: new Date('2026-07-05') })
    // The range starts AFTER the sale but still covers the refund, so only
    // the reversal entry (sign -1) falls inside. Under the "sum of signs"
    // convention this must read -1, not 0 -- a period containing only a
    // refund is meant to look negative, not empty, exactly as the Dashboard
    // (sum(shopOrders.map(e => e.sign))) now reads it.
    const res = run([refunded], { from: new Date('2026-07-03'), to: new Date('2026-07-31') })
    expect(res.rows[0].orders).toBe(-1)
    expect(res.rows[0].netSales).toBe(-20000)
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

  it('counts an order once even when it contains two different products', () => {
    const cheap = new Map(products)
    cheap.set('p2', { productId: 'p2', shopId: 'de', sku: 'CHEAP', externalId: '99', name: 'Brush', imageUrl: null })
    const both = order({
      items: [
        { productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 },
        { productId: 'p2', sku: 'CHEAP', name: 'Brush', quantity: 1, unitPrice: 500, lineNetTotal: 500 },
      ],
    })
    const res = run([both], { products: cheap })
    expect(res.rows).toHaveLength(2)
    expect(res.rows.every((r) => r.orders === 1)).toBe(true)
    // The order itself is still ONE order, no matter how many product rows
    // it touches — summing the per-row counts would report 2.
    expect(res.total.orders).toBe(1)
  })

  it('reverses the total too: one order across two products, refunded in range, totals zero', () => {
    const cheap = new Map(products)
    cheap.set('p2', { productId: 'p2', shopId: 'de', sku: 'CHEAP', externalId: '99', name: 'Brush', imageUrl: null })
    const both = order({
      status: 'refunded',
      placedAt: new Date('2026-07-01'),
      voidedAt: new Date('2026-07-05'),
      items: [
        { productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 },
        { productId: 'p2', sku: 'CHEAP', name: 'Brush', quantity: 1, unitPrice: 500, lineNetTotal: 500 },
      ],
    })
    const res = run([both], { products: cheap })
    expect(res.rows).toHaveLength(2)
    expect(res.rows.every((r) => r.orders === 0)).toBe(true)
    expect(res.total.orders).toBe(0)
  })

  it('excludes an order from the total when none of its lines resolve to a loaded product', () => {
    // A shipping-only order, or one referencing a product this page never
    // loaded, must not inflate the total any more than it inflates the rows.
    const unknown = order({
      items: [{ productId: 'ghost', sku: 'GHOST', name: 'Ghost', quantity: 1, unitPrice: 1000, lineNetTotal: 1000 }],
    })
    const res = run([unknown])
    expect(res.rows).toEqual([])
    expect(res.total.orders).toBe(0)
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
    // A NOK-invoiced order from a EUR shop: 2000.00 NOK = 200000 minor NOK.
    // NOK->EUR crosses via USD: fromUsd 0.1, toUsd 1.1 -> ratio 0.1/1.1 =
    // 0.090909...; mulRate(200000, 0.090909...) rounds to 18182.
    const b2b = order({ currency: 'NOK', costCurrency: 'EUR', netSales: 200000, grossSales: 200000,
      items: [{ productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 2, unitPrice: 100000, lineNetTotal: 200000 }] })
    const row = run([b2b]).rows[0]
    expect(row.netSales).toBe(18182) // converted to EUR via crossConvert
    expect(row.cogs).toBe(6400) // costs were already EUR, untouched
  })

  it('converts COGS from a shop cost currency that differs from the display currency', () => {
    // Today's loader never produces this — every shop in a store group
    // shares the group's display currency — but productFigures is pure and
    // must never read one currency as another if that assumption changes.
    // 2 x (3000 + 200) = 6400 minor NOK; at 0.1/1.1 -> 581.818... -> 582 EUR.
    const nokCosted = order({ currency: 'EUR', costCurrency: 'NOK' })
    const row = run([nokCosted]).rows[0]
    expect(row.netSales).toBe(20000) // order currency EUR == display, untouched
    expect(row.cogs).toBe(582)
  })

  it('marks a product with no cost entered, and margins do not silently read as 100%', () => {
    const row = run([order()], { costs: new Map() }).rows[0]
    expect(row.hasCost).toBe(false)
    expect(row.cogs).toBe(0)
    expect(run([order()], { costs: new Map() }).uncosted).toBe(1)
  })

  it('flags a genuine zero cost as costed, not uncosted', () => {
    // {costPerItem: 0, handlingCost: 500} is a real cost point someone
    // entered, not an absence of one. Flagging it uncosted would tell the
    // client to enter a cost they already entered.
    const zeroCosted: CostBook = new Map([
      ['p-de', [{ costPerItem: 0, handlingCost: 500, effectiveFrom: new Date('2026-01-01') }]],
    ])
    const res = run([order()], { costs: zeroCosted })
    expect(res.rows[0].hasCost).toBe(true)
    expect(res.uncosted).toBe(0)
  })

  it('yields no margin rather than Infinity when nothing was sold', () => {
    const free = order({ netSales: 0, grossSales: 0,
      items: [{ productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 0, lineNetTotal: 0 }] })
    const row = run([free]).rows[0]
    expect(row.margin).toBe(0)
    expect(Number.isFinite(row.margin)).toBe(true)
  })

  it('sums the total and recomputes its margin rather than averaging the rows', () => {
    // Two DIFFERENT products with very different margins, so an averaged
    // answer and a recomputed one actually diverge (merging the same SKU
    // across two stores of equal margin, as an earlier version of this test
    // did, cannot tell the two approaches apart).
    const cheap = new Map(products)
    cheap.set('p2', { productId: 'p2', shopId: 'de', sku: 'CHEAP', externalId: '99', name: 'Brush', imageUrl: null })
    const small = order({ id: 'o2', netSales: 500, grossSales: 500,
      items: [{ productId: 'p2', sku: 'CHEAP', name: 'Brush', quantity: 1, unitPrice: 500, lineNetTotal: 500 }] })
    const res = run([order(), small], { products: cheap })

    // p-de: netSales 20000, cogs 6400, margin 0.68. p2 has no cost entry in
    // this cost book: netSales 500, cogs 0, margin 1.00. Averaging the two
    // row margins gives (0.68 + 1.00) / 2 = 0.84 — the wrong answer.
    // Recomputing from the summed totals gives
    // (20000 + 500 - 6400 - 0) / (20000 + 500) = 14100 / 20500 = 0.6878.
    expect(res.total.netSales).toBe(20500)
    expect(res.total.cogs).toBe(6400)
    expect(res.total.profit).toBe(14100)
    expect(res.total.margin).toBeCloseTo(0.6878, 4)
    expect(res.total.margin).not.toBeCloseTo(0.84, 2)
  })

  it("recomputes a merged row's own margin from its summed figures rather than averaging its stores", () => {
    const fi = order({
      id: 'o2',
      shopId: 'fi',
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Sahkoinen pizzauuni', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 }],
      netSales: 10000,
    })
    // p-fi has no cost entry in this cost book, so its own margin is 1.00
    // while p-de's is 0.68 — averaging the two stores would give 0.84.
    const deOnlyCosts: CostBook = new Map([['p-de', costs.get('p-de')!]])
    const res = run([order(), fi], { costs: deOnlyCosts })
    const row = res.rows[0]

    // (20000 + 10000 - 6400 - 0) / (20000 + 10000) = 23600 / 30000 = 0.7867
    expect(row.margin).toBeCloseTo(0.7867, 4)
    expect(row.margin).not.toBeCloseTo(0.84, 2)
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

  it('names a merged row deterministically when two stores tie on netSales', () => {
    const fi = order({
      id: 'o2',
      shopId: 'fi',
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Sahkoinen pizzauuni', quantity: 2, unitPrice: 10000, lineNetTotal: 20000 }],
      netSales: 20000,
      grossSales: 20000,
    })
    // Germany and Finland now tie on netSales (20000 each); the shopId
    // tiebreaker makes "de" win regardless of which order the caller lists
    // its orders in.
    const forward = run([order(), fi])
    const reversed = run([fi, order()])
    expect(forward.rows[0].name).toBe('Elektrischer Pizzaofen')
    expect(reversed.rows[0].name).toBe('Elektrischer Pizzaofen')
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
    expect(mergeKey({ productId: 'p', shopId: 's', sku: '42', externalId: '42', name: 'x', imageUrl: null }))
      .toBe('product:p')
  })
})
