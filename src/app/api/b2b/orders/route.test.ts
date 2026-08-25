import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { POST } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/b2b/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

const TAG = '[b2b-order-test]'
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

describe('POST /api/b2b/orders', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(403)
  })

  it('computes every total itself and ignores anything the browser sends', async () => {
    await asAdmin()
    expect((await post({
      customerId, placedAt: '2026-07-01', shippingCharged: 50, fulfillmentCost: 420,
      lines: [{ productId, quantity: 10, unitPrice: 89, discountValue: 10, discountKind: 'PERCENT' }],
      // A stale or hostile client. None of these may reach the database.
      grossSales: 1, netSales: 1, total: 1, taxTotal: 0,
    })).status).toBe(200)

    const saved = await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })
    expect(saved.grossSales).toBe(89000)
    expect(saved.discountTotal).toBe(8900)
    expect(saved.netSales).toBe(80100)
    expect(saved.shippingCharged).toBe(5000)
    expect(saved.taxTotal).toBe(21275) // 25% of (801.00 + 50.00)
    expect(saved.total).toBe(106375)
    expect(saved.fulfillmentCost).toBe(42000) // minor units, SHOP currency
  })

  /**
   * "Shipping was free" and "nobody said" must not be the same value.
   *
   * A stored 0 wins outright in the engine - `fulfillmentCost ?? perSku`
   * short-circuits on it - so an order saved with the box left blank could
   * never be costed by the per-SKU shipping rates, while a Visma-imported order
   * leaves the column null and is. This branch is what creates that pair, and
   * with a zod default of 0 there was nothing anywhere to tell them apart.
   */
  it('stores no fulfillment cost at all when the field was left blank', async () => {
    await asAdmin()
    expect((await post({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(200)

    const saved = await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })
    expect(saved.fulfillmentCost).toBeNull()
  })

  /** An explicit zero still means free, and must survive as a real figure. */
  it('keeps a fulfillment cost of zero that somebody actually typed', async () => {
    await asAdmin()
    await post({
      customerId, placedAt: '2026-07-01', fulfillmentCost: 0,
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })

    const saved = await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })
    expect(saved.fulfillmentCost).toBe(0)
  })

  it('stores the order in the CUSTOMER’S currency, not the shop’s', async () => {
    await asAdmin()
    await post({ customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }] })
    expect((await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })).currency).toBe('EUR')
  })

  it('numbers B2B orders in their own sequence and namespaces the external id', async () => {
    await asAdmin()
    const one = await post({ customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }] })
    const two = await post({ customerId, placedAt: '2026-07-02', lines: [{ productId, quantity: 1, unitPrice: 89 }] })

    expect((await one.json()).order.number).toBe('B-0001')
    expect((await two.json()).order.number).toBe('B-0002')
    expect((await db.order.findFirstOrThrow({ where: { number: 'B-0002' } })).externalId).toBe('b2b:B-0002')
  })

  it('meets a real collision with a clean 409, not a crash', async () => {
    // nextB2bNumber() is a pure function of committed rows, so a collision it
    // cannot see its way past will be proposed again, unchanged, on the
    // retry - this deterministically exhausts both attempts, no mocking and
    // no timing-dependent race required to trigger a real P2002.
    //
    // This row occupies "b2b:B-0001" without registering as a B2B order to
    // nextB2bNumber(), which reads the `number` column, not externalId: an
    // unparseable number contributes nothing to its max-scan, so it still
    // computes "B-0001" - landing the real POST below on a genuine unique
    // constraint collision on attempt 0, and again, identically, on attempt 1.
    await asAdmin()
    await db.order.create({
      data: {
        shopId, externalId: 'b2b:B-0001', number: 'CUSTOM-1', placedAt: new Date('2026-06-01'),
        status: 'completed', currency: 'EUR', grossSales: 0, discountTotal: 0, netSales: 0,
        shippingCharged: 0, taxTotal: 0, total: 0, b2bCustomerId: customerId,
      },
    })

    const res = await post({ customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }] })

    // Gating the P2002 catch to attempt === 0 would let this exact second
    // collision escape uncaught into the generic 500 below - this is the
    // scenario that turns that dead branch live.
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Could not pick an order number. Try again.')
    // Both attempts failed cleanly: nothing besides the phantom row exists.
    expect(await db.order.count({ where: { b2bCustomerId: customerId } })).toBe(1)
  })

  it('fills in the customer name so the WooCommerce backfill never chases it', async () => {
    // backfillCustomers() hunts every order with customerName null and asks
    // WooCommerce who it was. For a b2b: id it would ask forever.
    await asAdmin()
    await post({ customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }] })

    const saved = await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })
    expect(saved.customerName).toBe(`Nordic ${TAG}`)
    expect(saved.customerEmail).toBe('buyer@nordic.test')
    expect(saved.status).toBe('completed')
    expect(saved.couponCode).toBeNull()
    expect(saved.ambassadorId).toBeNull()
  })

  it('keeps what was typed, so re-opening the order still says "10%"', async () => {
    await asAdmin()
    await post({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 10, unitPrice: 89, discountValue: 10, discountKind: 'PERCENT' }],
    })

    const item = await db.orderItem.findFirstOrThrow({ where: { productId } })
    expect(item.discountValue).toBe(10)
    expect(item.discountKind).toBe('PERCENT')
    expect(item.unitPrice).toBe(8900)     // BEFORE discount, as mapOrder() stores it
    expect(item.lineNetTotal).toBe(80100) // after
    expect(item.sku).toBe('SKU-1')        // snapshot, from the product
  })

  it('converts an AMOUNT discount to minor units, same as every other money field', async () => {
    // Every other accepted-order test here uses PERCENT, which never touches
    // toMinor at all (it is a plain number, not money). If the AMOUNT branch
    // of that ternary lost its toMinor - storing 20 instead of 2000 - this is
    // the only test that would notice.
    await asAdmin()
    await post({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 4, unitPrice: 245, discountValue: 20, discountKind: 'AMOUNT' }],
    })

    const saved = await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })
    expect(saved.grossSales).toBe(98000)   // 4 x 245.00
    expect(saved.discountTotal).toBe(8000) // 4 x 20.00 off each unit
    expect(saved.netSales).toBe(90000)

    const item = await db.orderItem.findFirstOrThrow({ where: { productId } })
    expect(item.discountValue).toBe(2000) // minor units - 20.00, not 20
    expect(item.discountKind).toBe('AMOUNT')
  })

  it('saves a new agreed price only when asked to', async () => {
    await asAdmin()
    const belt = await db.product.create({
      data: { shopId, externalId: '9', sku: 'SKU-9', name: 'Belt' },
    })

    await post({
      customerId, placedAt: '2026-07-01',
      lines: [
        { productId: belt.id, quantity: 1, unitPrice: 12, savePrice: true },
        { productId, quantity: 1, unitPrice: 999 }, // a one-off; must not stick
      ],
    })

    const prices = await db.b2bPrice.findMany({ where: { customerId } })
    expect(prices).toHaveLength(2)
    expect(prices.find((p) => p.productId === belt.id)!.unitPrice).toBe(1200)
    expect(prices.find((p) => p.productId === productId)!.unitPrice).toBe(8900)
  })

  it('refuses a product from another shop', async () => {
    await asAdmin()
    expect((await post({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId: otherProductId, quantity: 1, unitPrice: 10 }],
    })).status).toBe(400)
    expect(await db.order.count({ where: { b2bCustomerId: customerId } })).toBe(0)
  })

  it('refuses the impossible, and writes nothing when it does', async () => {
    await asAdmin()
    const bad = async (over: object) =>
      (await post({
        customerId, placedAt: '2026-07-01',
        lines: [{ productId, quantity: 1, unitPrice: 89, ...over }],
      })).status

    expect((await post({ customerId, placedAt: '2026-07-01', lines: [] })).status).toBe(400)
    expect(await bad({ quantity: 0 })).toBe(400)
    expect(await bad({ discountValue: 101, discountKind: 'PERCENT' })).toBe(400)
    expect(await bad({ discountValue: 90, discountKind: 'AMOUNT' })).toBe(400) // above 89.00
    expect((await post({
      customerId, placedAt: 'the other tuesday',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(400)

    expect(await db.order.count({ where: { b2bCustomerId: customerId } })).toBe(0)
  })
})
