import { describe, expect, it } from 'vitest'
import type { ProductResult, ProductRow } from '@/lib/metrics/products'
import { productFacts } from './products'

const row = (over: Partial<ProductRow>): ProductRow =>
  ({
    key: 'sku:PIZ-PRO',
    sku: 'PIZ-PRO',
    name: 'Pizzetta Pro',
    imageUrl: null,
    orders: 10,
    quantity: 10,
    grossSales: 0,
    netSales: 0,
    cogs: 0,
    profit: 0,
    margin: 0,
    hasCost: true,
    stores: [],
    ...over,
  }) as ProductRow

const result = (rows: ProductRow[]): ProductResult => ({
  displayCurrency: 'NOK',
  rows,
  total: { orders: 0, quantity: 0, grossSales: 0, netSales: 0, cogs: 0, profit: 0, margin: 0 },
  uncosted: 0,
})

const store = (netSales: number, quantity: number) => ({
  shopId: 'shop_no',
  shopName: 'Panetti Norway',
  productId: 'prod_1',
  name: 'Pizzetta Pro',
  hasCost: true,
  orders: 10,
  quantity,
  grossSales: netSales,
  netSales,
  cogs: 0,
  profit: netSales,
  margin: 1,
})

const args = {
  shopNames: new Map([['shop_no', 'Panetti Norway']]),
  // Panetti Norway did 500_000 NOK last window, and is 30% of a 1_000_000 USD business.
  shopBaselines: new Map([['shop_no', 500_000]]),
  shopShares: new Map([['shop_no', 0.3]]),
}

describe('productFacts', () => {
  it('reports a product whose sales collapsed in one shop', () => {
    const facts = productFacts({
      ...args,
      now: result([row({ stores: [store(100_000, 20)] })]),
      before: result([row({ stores: [store(250_000, 50)] })]),
    })

    const fact = facts[0]
    expect(fact.kind).toBe('PRODUCT_RATE_MOVE')
    expect(fact.subject).toBe('Pizzetta Pro')
    expect(fact.shopName).toBe('Panetti Norway')
    expect(fact.id).toBe('product:shop_no:sku:PIZ-PRO')
    expect(fact.currency).toBe('NOK')
    expect(fact.deltaPct).toBeCloseTo(-0.6)
  })

  it('says nothing about a product that barely moved', () => {
    const facts = productFacts({
      ...args,
      now: result([row({ stores: [store(248_000, 49)] })]),
      before: result([row({ stores: [store(250_000, 50)] })]),
    })
    expect(facts).toEqual([])
  })

  it('says nothing about a big swing on a trivial product', () => {
    const facts = productFacts({
      ...args,
      now: result([row({ stores: [store(100, 1)] })]),
      before: result([row({ stores: [store(400, 4)] })]),
    })
    expect(facts).toEqual([])
  })

  it('ignores a shop it has no baseline for', () => {
    const facts = productFacts({
      ...args,
      shopBaselines: new Map(),
      shopShares: new Map(),
      now: result([row({ stores: [store(100_000, 20)] })]),
      before: result([row({ stores: [store(250_000, 50)] })]),
    })
    expect(facts).toEqual([])
  })
})
