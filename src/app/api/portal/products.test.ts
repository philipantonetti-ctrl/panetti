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

const EMAIL = 'plan-products-amb@example.local'
const MARK = '[products-test]'

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
}

const portal = () => GET(new Request('http://localhost/api/portal?from=2026-03-01&to=2026-03-31'))

beforeEach(async () => {
  await wipe()
  const shop = await db.shop.create({ data: { name: `Norway ${MARK}`, currency: 'NOK' } })

  const chair = await db.product.create({
    data: { shopId: shop.id, externalId: 'p-chair', sku: 'CHAIR-1', name: 'Massage Chair', lastPrice: 100000 },
  })
  const gun = await db.product.create({
    data: { shopId: shop.id, externalId: 'p-gun', sku: 'GUN-1', name: 'Massage Gun', lastPrice: 25000 },
  })

  const amb = await db.ambassador.create({
    data: {
      name: 'Seller', email: EMAIL, commissionRate: 0.1,
      codes: { create: { code: 'SELLER500', shopId: shop.id } },
    },
  })

  await db.order.create({
    data: {
      shopId: shop.id, externalId: 'prod-1', number: 'prod-1',
      placedAt: new Date('2026-03-10T12:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: 150000, discountTotal: 0, netSales: 150000,
      shippingCharged: 0, taxTotal: 0, total: 150000, ambassadorId: amb.id,
      items: {
        create: [
          { productId: chair.id, sku: 'CHAIR-1', name: 'Massage Chair', quantity: 1, unitPrice: 100000, lineNetTotal: 100000 },
          { productId: gun.id, sku: 'GUN-1', name: 'Massage Gun', quantity: 2, unitPrice: 25000, lineNetTotal: 50000 },
        ],
      },
    },
  })

  cookieValue.current = await signSession({
    userId: 'u-prod', email: EMAIL, role: 'AMBASSADOR', ambassadorId: amb.id,
  })
})

afterEach(wipe)

describe('an ambassador can see what was sold in each order', () => {
  it('lists the products and quantities on each recent order', async () => {
    const res = await portal()
    expect(res.status).toBe(200)
    const body = await res.json()

    const order = body.recent[0]
    expect(order.products).toEqual(
      expect.arrayContaining([
        { name: 'Massage Chair', quantity: 1 },
        { name: 'Massage Gun', quantity: 2 },
      ]),
    )
    expect(order.products).toHaveLength(2)
  })

  it('still reports the order total alongside the products', async () => {
    const body = await (await portal()).json()
    expect(body.recent[0].sales).toBe(150000)
    expect(body.recent[0].shop).toContain('Norway')
  })
})
