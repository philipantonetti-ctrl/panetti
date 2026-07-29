import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./stats/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const SELLER = 'plan-stats-seller@example.local'
const MARK = '[amb-stats-test]'
let shopId = ''

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: SELLER } })
}

beforeEach(async () => {
  await wipe()
  const shop = await db.shop.create({ data: { name: `Shop ${MARK}`, currency: 'USD' } })
  shopId = shop.id
  const seller = await db.ambassador.create({
    data: {
      name: 'Stats Seller', email: SELLER, commissionRate: 0.1,
      codes: { create: { code: 'STATS500', shopId: shop.id } },
    },
  })
  await db.order.create({
    data: {
      shopId: shop.id, externalId: 'stats-1', number: 'stats-1',
      placedAt: new Date('2026-03-10T12:00:00Z'), status: 'completed', currency: 'USD',
      grossSales: 50000, discountTotal: 0, netSales: 50000,
      shippingCharged: 0, taxTotal: 0, total: 50000, ambassadorId: seller.id,
    },
  })
  cookieValue.current = await signSession({
    userId: 'mkt-stats', email: 'mkt@test.local', role: 'MARKETING', ambassadorId: null,
  })
})

afterEach(wipe)

const stats = () =>
  GET(new Request(`http://localhost/api/ambassadors/stats?from=2026-03-01&to=2026-03-31&shops=${shopId}`))

describe('ambassador statistics for staff', () => {
  it('gives marketing the leaderboard with named shops, and the shop options', async () => {
    const res = await stats()
    expect(res.status).toBe(200)
    const body = await res.json()
    const seller = body.leaderboard.find((r: { name: string }) => r.name === 'Stats Seller')
    expect(seller.orders).toBe(1)
    expect(seller.shops).toEqual([`Shop ${MARK}`])
    expect(body.shopOptions.some((s: { id: string }) => s.id === shopId)).toBe(true)
    expect(body.displayCurrency).toBe('USD')
  })

  it('carries no revenue, profit or spend — those words never leave this endpoint', async () => {
    const text = JSON.stringify(await (await stats()).json())
    expect(text).not.toContain('profit')
    expect(text).not.toContain('revenue')
    expect(text).not.toContain('adSpend')
  })

  it('answers an ambassador with 403', async () => {
    cookieValue.current = await signSession({
      userId: 'amb-x', email: 'amb@test.local', role: 'AMBASSADOR', ambassadorId: 'a-x',
    })
    expect((await stats()).status).toBe(403)
  })
})
