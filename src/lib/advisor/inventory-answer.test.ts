import { describe, expect, it } from 'vitest'
import type { InventoryRow, InventoryView } from '@/lib/inventory/load'
import { shapeInventory } from './inventory-answer'

const day = (s: string) => new Date(`${s}T00:00:00.000Z`)

const row = (over: Partial<InventoryRow> = {}): InventoryRow => ({
  sku: 'PIZZA-1',
  name: 'Pizzaovn Pro',
  imageUrl: null,
  supplierName: 'Ningbo Works',
  stock: {
    quantity: 120,
    disagrees: false,
    byShop: [{ shopName: 'Panetti Norway', quantity: 120, updatedAt: day('2026-08-24') }],
    source: 'visma',
    visma: { quantity: 120, measuredAt: day('2026-08-23') },
  },
  burn: 4.2,
  trend: 0.35,
  seasonal: true,
  forecast: {
    runsOutOn: day('2026-10-01'),
    gap: null,
    overdueArrivals: null,
    orderBy: day('2026-09-05'),
    daysLate: null,
    quantity: 600,
    needed: 430,
    raisedBy: 'container',
    onOrderWithoutEta: 0,
    note: null,
  },
  byCountry: [{ country: 'NO', units: 90 }],
  ...over,
})

const view = (rows: InventoryRow[]): InventoryView => ({
  rows,
  unusable: [],
  stockFrom: ['Panetti Norway'],
  shopCount: 9,
})

describe('shapeInventory', () => {
  it('carries the whole working of a suggestion, so the answer can show it', () => {
    const shaped = shapeInventory(view([row()]), day('2026-08-25'))
    const p = shaped.products[0]

    expect(p).toMatchObject({
      sku: 'PIZZA-1',
      name: 'Pizzaovn Pro',
      supplier: 'Ningbo Works',
      dailySales: 4.2,
      trendVsLastYear: 0.35,
      seasonalHistory: true,
      runsOutOn: '2026-10-01',
      orderBy: '2026-09-05',
      quantity: 600,
      needed: 430,
      raisedBy: 'container',
    })
    expect(p.stock).toMatchObject({ units: 120, source: 'visma', shopsDisagree: false })
  })

  it('lists what to order now, soonest first, with days until', () => {
    const soon = row({ sku: 'A', forecast: { ...row().forecast, orderBy: day('2026-08-28') } })
    const later = row({ sku: 'B', forecast: { ...row().forecast, orderBy: day('2026-09-10') } })
    const shaped = shapeInventory(view([later, soon]), day('2026-08-25'))

    expect(shaped.orderNow.map((t) => t.sku)).toEqual(['A', 'B'])
    expect(shaped.orderNow[0].daysUntil).toBe(3)
  })

  it('leaves a product with no order-by date out of the suggestions but keeps it in the table', () => {
    const noDates = row({
      sku: 'NOLEAD',
      forecast: { ...row().forecast, orderBy: null, quantity: null, needed: null, note: 'set lead times' },
    })
    const shaped = shapeInventory(view([noDates]), day('2026-08-25'))

    expect(shaped.orderNow).toEqual([])
    expect(shaped.products[0]).toMatchObject({ sku: 'NOLEAD', orderBy: null, whyBlank: 'set lead times' })
  })

  it('says where the stock reading came from and how many shops fed the sales', () => {
    const shaped = shapeInventory(view([row()]), day('2026-08-25'))
    expect(shaped.stockReadFrom).toEqual(['Panetti Norway'])
    expect(shaped.salesFromShopCount).toBe(9)
  })

  it('reports a gap and overdue arrivals rather than hiding them', () => {
    const troubled = row({
      forecast: {
        ...row().forecast,
        gap: { from: day('2026-09-01'), until: day('2026-09-20') },
        overdueArrivals: { quantity: 41, since: day('2026-06-01') },
        onOrderWithoutEta: 12,
      },
    })
    const p = shapeInventory(view([troubled]), day('2026-08-25')).products[0]

    expect(p.emptyBetween).toEqual({ from: '2026-09-01', until: '2026-09-20' })
    expect(p.overdueOnOrder).toEqual({ quantity: 41, since: '2026-06-01' })
    expect(p.onOrderWithoutEta).toBe(12)
  })

  it('states the method in words, so the answer explains rather than asserts', () => {
    const shaped = shapeInventory(view([row()]), day('2026-08-25'))
    expect(shaped.method).toMatch(/day by day/i)
    expect(shaped.method).toMatch(/cover/i)
  })
})
