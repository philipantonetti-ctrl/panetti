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

const EMAIL = 'plan-empty-amb@example.local'
const QUIET = 'plan-empty-quiet@example.local'
const MARK = '[empty-test]'

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: { in: [EMAIL, QUIET] } } })
}

// June is deliberately AFTER their only sale, so the period is empty.
const emptyPeriod = () => GET(new Request('http://localhost/api/portal?from=2026-06-01&to=2026-06-30'))

let shopId = ''

beforeEach(async () => {
  await wipe()
  const shop = await db.shop.create({ data: { name: `Norway ${MARK}`, currency: 'NOK' } })
  shopId = shop.id

  const amb = await db.ambassador.create({
    data: {
      name: 'Seasoned', email: EMAIL, commissionRate: 0.1,
      codes: { create: { code: 'SEASONED500', shopId: shop.id } },
    },
  })

  await db.order.create({
    data: {
      shopId: shop.id, externalId: 'old-1', number: 'old-1',
      placedAt: new Date('2026-03-10T12:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: 250000, discountTotal: 0, netSales: 250000,
      shippingCharged: 0, taxTotal: 0, total: 250000, ambassadorId: amb.id,
    },
  })

  cookieValue.current = await signSession({
    userId: 'u-empty', email: EMAIL, role: 'AMBASSADOR', ambassadorId: amb.id,
  })
})

afterEach(wipe)

describe('a period with no sales', () => {
  // The client saw "No sales yet" while holding 476 real orders.
  it('still reports the sales they have made outside the period', async () => {
    const body = await (await emptyPeriod()).json()

    expect(body.orders).toBe(0)
    expect(body.recent).toHaveLength(0)

    // The truth that stops "no sales yet" being a lie.
    expect(body.lifetimeOrders).toBe(1)
    expect(body.lastSaleAt).toContain('2026-03-10')
    expect(body.firstSaleAt).toContain('2026-03-10')
  })

  it('reports nothing at all for an ambassador who has genuinely never sold', async () => {
    const quiet = await db.ambassador.create({
      data: {
        name: 'Brand New', email: QUIET, commissionRate: 0.1,
        codes: { create: { code: 'BRANDNEW500', shopId } },
      },
    })
    cookieValue.current = await signSession({
      userId: 'u-quiet', email: QUIET, role: 'AMBASSADOR', ambassadorId: quiet.id,
    })

    const body = await (await emptyPeriod()).json()
    expect(body.lifetimeOrders).toBe(0)
    expect(body.lastSaleAt).toBeNull()
    expect(body.firstSaleAt).toBeNull()
  })
})
