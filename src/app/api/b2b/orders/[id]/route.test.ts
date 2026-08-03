import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { PATCH, DELETE } = await import('./route')
const { POST } = await import('../route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/b2b/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id),
  )

const TAG = '[b2b-edit-test]'
let shopId = ''
let otherShopId = ''
let productId = ''
let otherProductId = ''
let customerId = ''

// FK-safe order: Order.b2bCustomer is onDelete: Restrict, so orders must go
// before their B2B customers, which must go before the shops they belong to.
async function cleanup() {
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.b2bCustomer.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `A ${TAG}`, currency: 'NOK' } })).id
  otherShopId = (await db.shop.create({ data: { name: `B ${TAG}`, currency: 'SEK' } })).id
  productId = (await db.product.create({
    data: { shopId, externalId: '1', sku: 'SKU-1', name: 'Massage gun' },
  })).id
  otherProductId = (await db.product.create({
    data: { shopId: otherShopId, externalId: '2', sku: 'SKU-2', name: 'Chair' },
  })).id

  customerId = (await db.b2bCustomer.create({
    data: {
      shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 25,
      email: 'buyer@nordic.test',
      prices: { create: [{ productId, unitPrice: 8900 }] },
    },
  })).id
})
afterEach(cleanup)

/** 10 x 89.00 with 10% off, through the real create route. */
async function createOrder(): Promise<string> {
  const res = await POST(new Request('http://localhost/api/b2b/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 10, unitPrice: 89, discountValue: 10, discountKind: 'PERCENT' }],
    }),
  }))
  return (await res.json()).order.id
}

describe('PATCH /api/b2b/orders/[id]', () => {
  it('rewrites the lines and recomputes the totals', async () => {
    await asAdmin()
    const id = await createOrder()

    expect((await patch(id, {
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 2, unitPrice: 89 }],
    })).status).toBe(200)

    const after = await db.order.findUniqueOrThrow({ where: { id }, include: { items: true } })
    expect(after.items).toHaveLength(1)
    expect(after.items[0].quantity).toBe(2)
    expect(after.grossSales).toBe(17800)
    expect(after.netSales).toBe(17800)
    // Identity never moves: an edit is the same order, not a new one.
    expect(after.number).toBe('B-0001')
    expect(after.externalId).toBe('b2b:B-0001')
  })

  it('can void an order', async () => {
    await asAdmin()
    const id = await createOrder()
    expect((await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'refunded',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(200)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('refunded')
  })

  it('refuses a status it does not recognise', async () => {
    // Anything the engine does not know is in EXCLUDED_STATUSES counts as
    // earning, so free text here would quietly earn forever.
    await asAdmin()
    const id = await createOrder()
    expect((await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'invoiced-ish',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(400)
  })

  it('refuses to touch a webshop order', async () => {
    await asAdmin()
    const woo = await db.order.create({
      data: {
        shopId, externalId: '9001', number: '9001', placedAt: new Date('2026-07-01'),
        status: 'completed', currency: 'NOK', grossSales: 1000, discountTotal: 0,
        netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
      },
    })
    expect((await patch(woo.id, {
      customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(404)
  })
})

describe('DELETE /api/b2b/orders/[id]', () => {
  it('removes the order and its lines', async () => {
    await asAdmin()
    const id = await createOrder()
    expect((await DELETE(new Request('http://localhost/x'), params(id))).status).toBe(200)
    expect(await db.order.findUnique({ where: { id } })).toBeNull()
    expect(await db.orderItem.count({ where: { orderId: id } })).toBe(0)
  })

  it('refuses to delete a webshop order through this route', async () => {
    // This endpoint exists to fix a typo in something typed by hand. A synced
    // order deleted here would come back on the next sync — or worse, not.
    await asAdmin()
    const woo = await db.order.create({
      data: {
        shopId, externalId: '9002', number: '9002', placedAt: new Date('2026-07-01'),
        status: 'completed', currency: 'NOK', grossSales: 1000, discountTotal: 0,
        netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
      },
    })
    expect((await DELETE(new Request('http://localhost/x'), params(woo.id))).status).toBe(404)
    expect(await db.order.findUnique({ where: { id: woo.id } })).not.toBeNull()
  })
})
