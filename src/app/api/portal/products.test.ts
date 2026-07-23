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
const CHAIR_NET = 100000
const GUN_NET = 25000

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
}

const portal = () => GET(new Request('http://localhost/api/portal?from=2026-03-01&to=2026-03-31'))

beforeEach(async () => {
  await wipe()
  const shop = await db.shop.create({ data: { name: `Norway ${MARK}`, currency: 'NOK' } })

  const chair = await db.product.create({
    data: {
      shopId: shop.id, externalId: 'p-chair', sku: 'CHAIR-1', name: 'Massage Chair',
      imageUrl: 'https://img.example/chair.png', lastPrice: CHAIR_NET,
    },
  })
  const gun = await db.product.create({
    data: {
      shopId: shop.id, externalId: 'p-gun', sku: 'GUN-1', name: 'Massage Gun',
      imageUrl: 'https://img.example/gun.png', lastPrice: GUN_NET,
    },
  })

  const amb = await db.ambassador.create({
    data: {
      name: 'Seller', email: EMAIL, commissionRate: 0.1,
      codes: { create: { code: 'SELLER500', shopId: shop.id } },
    },
  })

  // 11 chair orders — more than the old ten-row ceiling.
  for (let i = 0; i < 11; i++) {
    await db.order.create({
      data: {
        shopId: shop.id, externalId: `chair-${i}`, number: `chair-${i}`,
        placedAt: new Date(`2026-03-${String(i + 2).padStart(2, '0')}T12:00:00Z`),
        status: 'completed', currency: 'NOK',
        grossSales: CHAIR_NET, discountTotal: 0, netSales: CHAIR_NET,
        shippingCharged: 0, taxTotal: 0, total: CHAIR_NET, ambassadorId: amb.id,
        items: {
          create: [{ productId: chair.id, sku: 'CHAIR-1', name: 'Massage Chair', quantity: 1, unitPrice: CHAIR_NET, lineNetTotal: CHAIR_NET }],
        },
      },
    })
  }

  // One order with three guns, so ranking by units is unambiguous.
  await db.order.create({
    data: {
      shopId: shop.id, externalId: 'gun-1', number: 'gun-1',
      placedAt: new Date('2026-03-20T12:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: GUN_NET * 3, discountTotal: 0, netSales: GUN_NET * 3,
      shippingCharged: 0, taxTotal: 0, total: GUN_NET * 3, ambassadorId: amb.id,
      items: {
        create: [{ productId: gun.id, sku: 'GUN-1', name: 'Massage Gun', quantity: 3, unitPrice: GUN_NET, lineNetTotal: GUN_NET * 3 }],
      },
    },
  })

  cookieValue.current = await signSession({
    userId: 'u-prod', email: EMAIL, role: 'AMBASSADOR', ambassadorId: amb.id,
  })
})

afterEach(wipe)

describe('what an ambassador sold', () => {
  it('shows the products on each order, with quantity and picture', async () => {
    const body = await (await portal()).json()
    const gunOrder = body.recent.find((o: { products: { name: string }[] }) =>
      o.products.some((p) => p.name === 'Massage Gun'),
    )
    expect(gunOrder.products[0]).toEqual({
      name: 'Massage Gun',
      quantity: 3,
      imageUrl: 'https://img.example/gun.png',
    })
  })

  // The client saw "86 orders" but only ten rows.
  it('returns every order in the period, not just the first ten', async () => {
    const body = await (await portal()).json()
    expect(body.orders).toBe(12)
    expect(body.recent).toHaveLength(12)
  })

  it('totals each product ever sold, ranked by units sold', async () => {
    const body = await (await portal()).json()
    expect(body.productTotals.map((p: { name: string }) => p.name)).toEqual([
      'Massage Chair', // 11 units
      'Massage Gun', // 3 units
    ])
  })

  it('gives each product its units, revenue, commission and picture', async () => {
    const body = await (await portal()).json()
    const [chair, gun] = body.productTotals

    expect(chair).toMatchObject({
      name: 'Massage Chair',
      imageUrl: 'https://img.example/chair.png',
      units: 11,
      revenue: CHAIR_NET * 11,
      commission: Math.round(CHAIR_NET * 11 * 0.1),
    })
    expect(gun).toMatchObject({
      name: 'Massage Gun',
      units: 3,
      revenue: GUN_NET * 3,
      commission: Math.round(GUN_NET * 3 * 0.1),
    })
  })
})
