import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role } from '@/lib/auth/session'

const state = vi.hoisted(() => ({ role: 'OPERATIONS' as Role }))
vi.mock('@/lib/auth/current-user', () => ({
  currentUser: async () => ({ userId: 'u1', email: 'ops@ecom.test', role: state.role, ambassadorId: null }),
}))

const { db } = await import('@/lib/db')
const { GET } = await import('./route')

const MARK = 'sales-periods-test'
let shopId = ''

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.order.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
}
afterAll(cleanup)

// Both orders below are placed daysAgo(1) - yesterday - so they land in the
// same bucket whatever day the suite runs on.
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

async function order(externalId: string, placedAt: Date, total: number, quantity: number) {
  await db.order.create({
    data: {
      shopId, externalId, number: externalId, placedAt, status: 'completed', currency: 'NOK',
      grossSales: 400000, discountTotal: total === 0 ? 400000 : 0,
      netSales: total === 0 ? 0 : 400000, shippingCharged: 0, taxTotal: total === 0 ? 0 : 100000, total,
      items: {
        create: {
          productId, sku: `${MARK}-OVEN`, name: 'Pizza oven', quantity, unitPrice: 400000, lineNetTotal: 400000,
        },
      },
    },
  })
}

let productId = ''

beforeEach(async () => {
  await cleanup()
  state.role = 'OPERATIONS'
  shopId = (await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK', active: true } })).id
  productId = (
    await db.product.create({ data: { shopId, externalId: '11', sku: `${MARK}-OVEN`, name: 'Pizza oven' } })
  ).id
  await order('p-1', daysAgo(1), 500000, 2)
  await order('z-1', daysAgo(1), 0, 1)
})

const get = (qs: string) => GET(new Request(`http://localhost/api/sales/periods?${qs}`))

describe('GET /api/sales/periods', () => {
  it('gives the operations manager twelve weeks in his shop currency, never cached', async () => {
    const res = await get(`grain=week&shops=${shopId}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await res.json()
    expect(body.grain).toBe('week')
    expect(body.currency).toBe('NOK')
    expect(body.excludeZero).toBe(false)
    expect(body.rows).toHaveLength(12)
    expect(body.rows[0].soFar).toBe(true)
    const counted = body.rows.reduce((n: number, r: { orders: number }) => n + r.orders, 0)
    expect(counted).toBe(2)
  })

  it('leaves out the 0-amount order when asked', async () => {
    const body = await (await get(`grain=week&shops=${shopId}&excludeZero=1`)).json()
    expect(body.excludeZero).toBe(true)
    const counted = body.rows.reduce((n: number, r: { orders: number }) => n + r.orders, 0)
    expect(counted).toBe(1)
  })

  it('gives twelve calendar months on grain=month and falls back to weeks on nonsense', async () => {
    const months = await (await get(`grain=month&shops=${shopId}`)).json()
    expect(months.grain).toBe('month')
    expect(months.rows).toHaveLength(12)
    expect(months.rows[0].from.endsWith('-01')).toBe(true)

    const junk = await (await get(`grain=fortnight&shops=${shopId}`)).json()
    expect(junk.grain).toBe('week')
  })

  it('sends each row with exactly the allowed fields', async () => {
    const body = await (await get(`grain=week&shops=${shopId}`)).json()
    expect(Object.keys(body).sort()).toEqual(['byProduct', 'byShop', 'currency', 'excludeZero', 'grain', 'rows'])
    expect(Object.keys(body.rows[0]).sort()).toEqual(
      ['avgOrder', 'from', 'orders', 'sales', 'soFar', 'to', 'units', 'vsPrevious'],
    )
    expect(Object.keys(body.byShop[0]).sort()).toEqual(['id', 'name', 'units'])
    expect(Object.keys(body.byProduct[0]).sort()).toEqual(['id', 'name', 'units'])
  })

  it('counts the units of each period by shop and by product, and they add up to the rows', async () => {
    type Units = { id: string; name: string; units: number[] }
    const sum = (list: number[]) => list.reduce((n, u) => n + u, 0)

    const body = await (await get(`grain=week&shops=${shopId}`)).json()
    expect(sum(body.rows.map((r: { units: number }) => r.units))).toBe(3)
    expect(body.byShop.map((s: Units) => [s.name, sum(s.units), s.units.length])).toEqual([[`${MARK} NO`, 3, 12]])
    expect(body.byProduct.map((p: Units) => [p.name, sum(p.units), p.units.length])).toEqual([['Pizza oven', 3, 12]])

    const dropped = await (await get(`grain=week&shops=${shopId}&excludeZero=1`)).json()
    expect(sum(dropped.rows.map((r: { units: number }) => r.units))).toBe(2)
    expect(sum(dropped.byShop[0].units)).toBe(2)
    expect(sum(dropped.byProduct[0].units)).toBe(2)
  })

  it('puts the units in the same period column as the orders, under the product\'s SKU', async () => {
    const body = await (await get(`grain=week&shops=${shopId}`)).json()
    const i = body.rows.findIndex((r: { orders: number }) => r.orders > 0)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(body.rows[i].units).toBe(3)
    expect(body.byProduct[0].id).toBe(`sku:${MARK}-OVEN`)
    const only = body.rows.map((_: unknown, j: number) => (j === i ? 3 : 0))
    expect(body.byProduct[0].units).toEqual(only)
    expect(body.byShop[0].units).toEqual(only)
  })

  it('answers "no shops" with empty breakdowns and rows of zeros, not every shop', async () => {
    const body = await (await get(`grain=week&shops=none`)).json()
    expect(body.rows).toHaveLength(12)
    expect(body.rows.every((r: { orders: number; units: number }) => r.orders === 0 && r.units === 0)).toBe(true)
    expect(body.byShop).toEqual([])
    expect(body.byProduct).toEqual([])
  })

  it('refuses marketing and ambassadors', async () => {
    for (const role of ['MARKETING', 'AMBASSADOR'] as const) {
      state.role = role
      expect((await get(`grain=week&shops=${shopId}`)).status).toBe(403)
    }
  })
})
