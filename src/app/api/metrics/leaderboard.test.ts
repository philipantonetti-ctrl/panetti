import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const SELLER = 'plan-lb-seller@example.local'
const QUIET = 'plan-lb-quiet@example.local'
const MARK = '[leaderboard-test]'
let shopId = ''

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: { in: [SELLER, QUIET] } } })
}

beforeEach(async () => {
  await wipe()
  // USD so nothing needs converting and no rate provider is touched.
  const shop = await db.shop.create({ data: { name: `Shop ${MARK}`, currency: 'USD' } })
  shopId = shop.id

  const seller = await db.ambassador.create({
    data: {
      name: 'Sells This Month', email: SELLER, commissionRate: 0.1,
      codes: { create: { code: 'LBSELLER500', shopId: shop.id } },
    },
  })
  await db.ambassador.create({
    data: {
      name: 'Sold Nothing Lately', email: QUIET, commissionRate: 0.1,
      codes: { create: { code: 'LBQUIET500', shopId: shop.id } },
    },
  })

  await db.order.create({
    data: {
      shopId: shop.id, externalId: 'lb-1', number: 'lb-1',
      placedAt: new Date('2026-03-10T12:00:00Z'), status: 'completed', currency: 'USD',
      grossSales: 100000, discountTotal: 0, netSales: 100000,
      shippingCharged: 0, taxTotal: 0, total: 100000, ambassadorId: seller.id,
    },
  })

  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
})

afterEach(wipe)

const metrics = () =>
  GET(new Request(`http://localhost/api/metrics?from=2026-03-01&to=2026-03-31&shops=${shopId}`))

describe('the Top ambassadors table', () => {
  it('ranks whoever sold in the period first', async () => {
    const body = await (await metrics()).json()
    expect(body.leaderboard[0].name).toBe('Sells This Month')
    expect(body.leaderboard[0].orders).toBe(1)
  })

  // The client saw a single row and asked "why only 1 ambassador here?".
  // A missing row reads as a bug; a zero row is information. Asserted by shape
  // rather than by name: this suite shares one database, so which quiet
  // ambassador lands inside the top ten is not ours to control.
  it('still lists ambassadors who sold nothing in the period', async () => {
    const body = await (await metrics()).json()

    expect(body.leaderboard.length).toBeGreaterThan(1)
    expect(body.leaderboard.some((r: { orders: number }) => r.orders === 0)).toBe(true)
  })
})
