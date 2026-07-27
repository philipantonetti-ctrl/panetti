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

const MARK = '[orders-test]'
let shopA = ''
let shopB = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

const order = (
  shopId: string,
  productId: string,
  number: string,
  on: string,
  items: { name: string; sku: string; quantity: number }[],
) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(on), status: 'completed', currency: 'DKK',
      grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0, taxTotal: 2500, total: 12500,
      items: { create: items.map((i) => ({ productId, name: i.name, sku: i.sku, quantity: i.quantity, unitPrice: 5000, lineNetTotal: 5000 })) },
    },
  })

beforeEach(async () => {
  await wipe()
  shopA = (await db.shop.create({ data: { name: `A ${MARK}`, currency: 'DKK' } })).id
  shopB = (await db.shop.create({ data: { name: `B ${MARK}`, currency: 'NOK' } })).id
  const prodA = (await db.product.create({ data: { shopId: shopA, externalId: 'pa', sku: 'PA', name: 'PA', lastPrice: 5000 } })).id
  const prodB = (await db.product.create({ data: { shopId: shopB, externalId: 'pb', sku: 'PB', name: 'PB', lastPrice: 5000 } })).id

  await order(shopA, prodA, 'A-mar20', '2026-03-20T12:00:00Z', [
    { name: 'Massage Chair', sku: 'CHAIR-1', quantity: 1 },
    { name: 'Massage Gun', sku: 'GUN-1', quantity: 2 },
  ])
  await order(shopA, prodA, 'A-mar10', '2026-03-10T12:00:00Z', [{ name: 'Massage Gun', sku: 'GUN-1', quantity: 1 }])
  await order(shopA, prodA, 'A-feb15', '2026-02-15T12:00:00Z', [{ name: 'Old', sku: 'OLD', quantity: 1 }]) // out of range
  await order(shopB, prodB, 'B-mar12', '2026-03-12T12:00:00Z', [{ name: 'Other', sku: 'OTH', quantity: 1 }])
})

afterEach(wipe)

const get = (qs: string) => GET(new Request(`http://localhost/api/orders?${qs}`))

describe('GET /api/orders', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await get('from=2026-03-01&to=2026-03-31')).status).toBe(403)
  })

  it('lists orders in the range, newest first, with their products', async () => {
    await asAdmin()
    const body = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}`)).json()

    expect(body.total).toBe(2) // feb15 excluded
    expect(body.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20', 'A-mar10'])

    const first = body.orders[0]
    expect(first.status).toBe('completed')
    expect(first.itemCount).toBe(3) // 1 chair + 2 guns
    expect(first.products).toEqual(
      expect.arrayContaining([
        { name: 'Massage Chair', sku: 'CHAIR-1', quantity: 1 },
        { name: 'Massage Gun', sku: 'GUN-1', quantity: 2 },
      ]),
    )
    expect(first.total).toBe(12500) // what the customer paid, in the shop's own currency
    expect(first.currency).toBe('DKK')
    expect(first.shop).toContain('A ')
  })

  it('filters to the chosen shop only', async () => {
    await asAdmin()
    const body = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopB}`)).json()
    expect(body.orders.map((o: { number: string }) => o.number)).toEqual(['B-mar12'])
  })

  it('paginates and reports the total', async () => {
    await asAdmin()
    const page1 = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&limit=1&offset=0`)).json()
    expect(page1.total).toBe(2)
    expect(page1.orders).toHaveLength(1)
    expect(page1.orders[0].number).toBe('A-mar20')

    const page2 = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&limit=1&offset=1`)).json()
    expect(page2.orders[0].number).toBe('A-mar10')
  })
})
