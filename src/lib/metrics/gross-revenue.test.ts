import { describe, it, expect } from 'vitest'
import { computeMetrics } from './engine'
import { buildRateTable } from './fx'
import type { CostBook, EngineOrder, EngineShop } from './types'

/**
 * Nordic merchants read "gross" as INCLUDING VAT (brutto). This system's "gross
 * sales" is the Shopify sense (before discount, EXCL. VAT), so the figure they
 * expect - what the customer actually paid - is its own metric: gross revenue.
 */

const shops: EngineShop[] = [{ id: 's1', name: 'Shop', currency: 'USD' }]
const rates = buildRateTable([{ date: new Date('2026-03-01'), currency: 'USD', rate: 1 }])
const costs: CostBook = new Map()

function order(): EngineOrder {
  return {
    id: 'o1', shopId: 's1', placedAt: new Date('2026-03-10'), status: 'completed', currency: 'USD',
    costCurrency: 'USD',
    grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 500,
    taxTotal: 2625, total: 13125, ambassadorId: null, commissionRate: 0, items: [],
  }
}

const input = {
  shops, orders: [order()], expenses: [], costs, rates, displayCurrency: 'USD',
  from: new Date('2026-03-01'), to: new Date('2026-03-31'),
}

describe('gross revenue', () => {
  it('is net revenue plus VAT - exactly what the customer paid', () => {
    const shop = computeMetrics(input).byShop[0]
    expect(shop.netRevenue).toBe(10500) // net sales + shipping, ex VAT
    expect(shop.taxes).toBe(2625) // 25% VAT
    expect(shop.grossRevenue).toBe(13125) // net + shipping + VAT = order total
  })

  it('totals across shops', () => {
    expect(computeMetrics(input).total.grossRevenue).toBe(13125)
  })
})
