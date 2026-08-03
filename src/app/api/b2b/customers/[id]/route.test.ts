import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, PATCH, DELETE } = await import('./route')
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
    new Request(`http://localhost/api/b2b/customers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id),
  )

const b2bOrder = (customerId: string) =>
  db.order.create({
    data: {
      shopId, externalId: 'b2b:B-0001', number: 'B-0001', placedAt: new Date('2026-07-01'),
      status: 'completed', currency: 'EUR', grossSales: 1000, discountTotal: 0,
      netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
      customerName: 'x', customerEmail: '', b2bCustomerId: customerId,
    },
  })

const TAG = '[b2b-cust-id-test]'
let shopId = ''
let otherShopId = ''
let productId = ''
let otherProductId = ''

// Shops cascade to their products, customers and orders, so one delete is enough.
async function cleanup() {
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
})
afterEach(cleanup)

describe('GET /api/b2b/customers/[id]', () => {
  it('returns the price list with our own cost beside the agreed price', async () => {
    await asAdmin()
    const c = await db.b2bCustomer.create({
      data: {
        shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 0,
        prices: { create: [{ productId, unitPrice: 8900 }] },
      },
    })
    await db.productCost.create({
      data: { productId, costPerItem: 4000, handlingCost: 500, effectiveFrom: new Date('2026-01-01') },
    })

    const body = await (await GET(new Request('http://localhost/x'), params(c.id))).json()
    expect(body.customer.prices[0]).toMatchObject({
      productId, sku: 'SKU-1', name: 'Massage gun',
      unitPrice: 8900,   // EUR — the customer's currency
      costPerItem: 4000, // NOK — the shop's
      handlingCost: 500,
    })
    expect(body.customer.shopCurrency).toBe('NOK')
    expect(body.customer.canChangeShop).toBe(true) // no orders yet
  })

  it('404s for a customer that does not exist', async () => {
    await asAdmin()
    expect((await GET(new Request('http://localhost/x'), params('nope'))).status).toBe(404)
  })
})

describe('PATCH /api/b2b/customers/[id]', () => {
  it('replaces the whole price list rather than merging into it', async () => {
    await asAdmin()
    const second = await db.product.create({
      data: { shopId, externalId: '3', sku: 'SKU-3', name: 'Belt' },
    })
    const c = await db.b2bCustomer.create({
      data: {
        shopId, name: `Nordic ${TAG}`, currency: 'EUR',
        prices: { create: [{ productId, unitPrice: 8900 }] },
      },
    })

    expect((await patch(c.id, {
      name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 0,
      prices: [{ productId: second.id, unitPrice: 12 }],
    })).status).toBe(200)

    const after = await db.b2bPrice.findMany({ where: { customerId: c.id } })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ productId: second.id, unitPrice: 1200 })
  })

  it('refuses to move a customer who already has orders to another shop', async () => {
    // Their price list points at this shop's products and their revenue has
    // already been reported under it. Moving them would rewrite both.
    await asAdmin()
    const c = await db.b2bCustomer.create({
      data: { shopId, name: `Settled ${TAG}`, currency: 'EUR' },
    })
    await b2bOrder(c.id)

    expect((await patch(c.id, {
      shopId: otherShopId, name: `Settled ${TAG}`, currency: 'EUR', vatPercent: 0, prices: [],
    })).status).toBe(400)
    expect((await db.b2bCustomer.findUniqueOrThrow({ where: { id: c.id } })).shopId).toBe(shopId)
  })

  it('deactivates without touching anything they bought', async () => {
    await asAdmin()
    const c = await db.b2bCustomer.create({ data: { shopId, name: `Gone ${TAG}`, currency: 'EUR' } })
    await b2bOrder(c.id)

    expect((await patch(c.id, {
      name: `Gone ${TAG}`, currency: 'EUR', vatPercent: 0, active: false, prices: [],
    })).status).toBe(200)
    expect((await db.b2bCustomer.findUniqueOrThrow({ where: { id: c.id } })).active).toBe(false)
    expect(await db.order.count({ where: { b2bCustomerId: c.id } })).toBe(1)
  })
})

describe('DELETE /api/b2b/customers/[id]', () => {
  it('deletes a customer who never ordered', async () => {
    await asAdmin()
    const c = await db.b2bCustomer.create({ data: { shopId, name: `Unused ${TAG}`, currency: 'EUR' } })
    expect((await DELETE(new Request('http://localhost/x'), params(c.id))).status).toBe(200)
    expect(await db.b2bCustomer.findUnique({ where: { id: c.id } })).toBeNull()
  })

  it('refuses to delete one who has orders, and says what to do instead', async () => {
    await asAdmin()
    const c = await db.b2bCustomer.create({ data: { shopId, name: `Busy ${TAG}`, currency: 'EUR' } })
    await b2bOrder(c.id)

    const res = await DELETE(new Request('http://localhost/x'), params(c.id))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This customer has orders. Deactivate them instead.')
    expect(await db.order.count({ where: { b2bCustomerId: c.id } })).toBe(1)
  })
})
