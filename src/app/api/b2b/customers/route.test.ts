import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, POST } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/b2b/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

const get = (qs = '') => GET(new Request(`http://localhost/api/b2b/customers${qs}`))

const TAG = '[b2b-cust-test]'
let shopId = ''
let otherShopId = ''
let productId = ''
let otherProductId = ''

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
})
afterEach(cleanup)

describe('GET /api/b2b/customers', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await get()).status).toBe(403)
  })

  it('reports the price count, order count and revenue', async () => {
    await asAdmin()
    await post({
      shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 0,
      prices: [{ productId, unitPrice: 89 }],
    })
    const created = await db.b2bCustomer.findFirstOrThrow({ where: { shopId } })

    // One earning order and one refunded: only the first counts, exactly as
    // the engine counts them.
    await db.order.createMany({
      data: [
        { shopId, externalId: 'b2b:B-0001', number: 'B-0001', placedAt: new Date('2026-07-01'),
          status: 'completed', currency: 'EUR', grossSales: 89000, discountTotal: 0,
          netSales: 89000, shippingCharged: 1000, taxTotal: 0, total: 90000,
          b2bCustomerId: created.id },
        { shopId, externalId: 'b2b:B-0002', number: 'B-0002', placedAt: new Date('2026-07-02'),
          status: 'refunded', currency: 'EUR', grossSales: 5000, discountTotal: 0,
          netSales: 5000, shippingCharged: 0, taxTotal: 0, total: 5000,
          b2bCustomerId: created.id },
      ],
    })

    const body = await (await get(`?shopId=${shopId}`)).json()
    const row = body.customers.find((c: { name: string }) => c.name === `Nordic ${TAG}`)
    expect(row.priceCount).toBe(1)
    expect(row.orderCount).toBe(1)
    expect(row.revenue).toBe(90000) // net sales + shipping; the refund earned nothing
    expect(row.shopName).toBe(`A ${TAG}`)
  })
})

describe('POST /api/b2b/customers', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({ shopId, name: 'X', currency: 'EUR' })).status).toBe(403)
  })

  it('stores the agreed prices in minor units', async () => {
    await asAdmin()
    expect((await post({
      shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 25,
      prices: [{ productId, unitPrice: 89.5 }],
    })).status).toBe(200)

    const saved = await db.b2bCustomer.findFirstOrThrow({
      where: { shopId }, include: { prices: true },
    })
    expect(saved.currency).toBe('EUR')
    expect(saved.vatPercent).toBe(25)
    expect(saved.prices[0].unitPrice).toBe(8950)
  })

  it('refuses a price for a product from another shop', async () => {
    // Otherwise a customer of shop A could be priced on shop B's catalogue,
    // and the order form would sell it without blinking.
    await asAdmin()
    const res = await post({
      shopId, name: `Wrong ${TAG}`, currency: 'EUR',
      prices: [{ productId: otherProductId, unitPrice: 10 }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That product does not belong to this shop')
    expect(await db.b2bCustomer.count({ where: { shopId } })).toBe(0)
  })

  it('rejects a VAT rate above 100', async () => {
    await asAdmin()
    expect((await post({ shopId, name: `Bad ${TAG}`, currency: 'EUR', vatPercent: 120 })).status).toBe(400)
  })

  it('rejects a duplicate name on the same shop with 409', async () => {
    await asAdmin()
    await post({ shopId, name: `Dupe ${TAG}`, currency: 'EUR' })
    expect((await post({ shopId, name: `Dupe ${TAG}`, currency: 'EUR' })).status).toBe(409)
  })

  it('allows the same name on a different shop', async () => {
    await asAdmin()
    expect((await post({ shopId, name: `Same ${TAG}`, currency: 'EUR' })).status).toBe(200)
    expect((await post({ shopId: otherShopId, name: `Same ${TAG}`, currency: 'SEK' })).status).toBe(200)
  })

  /**
   * The link that turns a Visma invoice into one of our orders. Stored trimmed,
   * because a trailing space typed into the form would match nothing and look
   * exactly like a customer who simply has no invoices.
   */
  it('stores the Visma customer number and hands it back', async () => {
    await asAdmin()
    expect((await post({
      shopId, name: `Linked ${TAG}`, currency: 'SEK', vismaCustomerNumber: ' 20012 ',
    })).status).toBe(200)

    const saved = await db.b2bCustomer.findFirstOrThrow({ where: { shopId } })
    expect(saved.vismaCustomerNumber).toBe('20012')

    const body = await (await get(`?shopId=${shopId}`)).json()
    const row = body.customers.find((c: { name: string }) => c.name === `Linked ${TAG}`)
    expect(row.vismaCustomerNumber).toBe('20012')
  })

  /**
   * Not linked is the default and must stay the default: an unlinked customer
   * is invisible to the sales import, which is the only thing standing between
   * us and every webshop order being counted twice.
   */
  it('leaves the Visma number null when the field was left blank', async () => {
    await asAdmin()
    await post({ shopId, name: `Unlinked ${TAG}`, currency: 'SEK', vismaCustomerNumber: '' })

    const saved = await db.b2bCustomer.findFirstOrThrow({ where: { shopId } })
    expect(saved.vismaCustomerNumber).toBeNull()
  })

  /**
   * Two customers on one Visma number would make every invoice for it arrive
   * as two orders. The unique index catches that; the message has to name the
   * real reason rather than the name clash the other 409 on this route means.
   */
  it('refuses a Visma number already linked to another customer, and says which clash it is', async () => {
    await asAdmin()
    await post({ shopId, name: `First ${TAG}`, currency: 'SEK', vismaCustomerNumber: '10681' })

    const res = await post({
      shopId: otherShopId, name: `Second ${TAG}`, currency: 'SEK', vismaCustomerNumber: '10681',
    })

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/Visma customer number/i)
  })
})
