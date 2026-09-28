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

// Placed yesterday and eight days ago, so one lands in this week or last and
// the other a week further back, whatever day the suite runs on.
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

async function order(externalId: string, placedAt: Date, total: number) {
  await db.order.create({
    data: {
      shopId, externalId, number: externalId, placedAt, status: 'completed', currency: 'NOK',
      grossSales: 400000, discountTotal: total === 0 ? 400000 : 0,
      netSales: total === 0 ? 0 : 400000, shippingCharged: 0, taxTotal: total === 0 ? 0 : 100000, total,
    },
  })
}

beforeEach(async () => {
  await cleanup()
  state.role = 'OPERATIONS'
  shopId = (await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK', active: true } })).id
  await order('p-1', daysAgo(1), 500000)
  await order('z-1', daysAgo(1), 0)
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
    expect(Object.keys(body).sort()).toEqual(['currency', 'excludeZero', 'grain', 'rows'])
    expect(Object.keys(body.rows[0]).sort()).toEqual(
      ['avgOrder', 'from', 'orders', 'sales', 'soFar', 'to', 'vsPrevious'],
    )
  })

  it('refuses marketing and ambassadors', async () => {
    for (const role of ['MARKETING', 'AMBASSADOR'] as const) {
      state.role = role
      expect((await get(`grain=week&shops=${shopId}`)).status).toBe(403)
    }
  })
})
