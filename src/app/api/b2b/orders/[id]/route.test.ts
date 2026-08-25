import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, PATCH, DELETE } = await import('./route')
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
let otherCustomerId = ''

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
  otherCustomerId = (await db.b2bCustomer.create({
    data: { shopId: otherShopId, name: `Other ${TAG}`, currency: 'SEK', vatPercent: 0 },
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

  /**
   * The write half of the same rule POST follows. An edit - or a void, which
   * goes through this route too - must not turn "nobody costed this" into
   * "shipping was free", because a stored zero wins outright in the engine and
   * puts the order permanently beyond the per-SKU shipping rates.
   */
  it('leaves the fulfillment cost null when the edit does not name one', async () => {
    await asAdmin()
    const id = await createOrder()

    expect((await patch(id, {
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 2, unitPrice: 89 }],
    })).status).toBe(200)

    expect((await db.order.findUniqueOrThrow({ where: { id } })).fulfillmentCost).toBeNull()
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
    const before = await db.order.findUniqueOrThrow({ where: { id }, include: { items: true } })

    expect((await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'invoiced-ish',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(400)

    // A validation failure must write nothing - the original 10-line order,
    // not a half-applied rewrite with the rejected status ignored.
    const after = await db.order.findUniqueOrThrow({ where: { id }, include: { items: true } })
    expect(after.status).toBe(before.status)
    expect(after.items).toHaveLength(before.items.length)
    expect(after.items[0].quantity).toBe(before.items[0].quantity)
    expect(after.grossSales).toBe(before.grossSales)
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

    // Still exactly the webshop order it was - no B2B fields leaked onto it.
    const after = await db.order.findUniqueOrThrow({ where: { id: woo.id } })
    expect(after.b2bCustomerId).toBeNull()
    expect(after.grossSales).toBe(1000)
    expect(after.number).toBe('9001')
  })

  it('refuses to move an order to a customer on a different shop', async () => {
    // The update never writes shopId, so silently accepting this would strand
    // the order on its old shop while its customer belongs to another -
    // per-shop revenue is the whole point of this product.
    await asAdmin()
    const id = await createOrder()
    const before = await db.order.findUniqueOrThrow({ where: { id } })

    const res = await patch(id, {
      customerId: otherCustomerId, placedAt: '2026-07-01',
      lines: [{ productId: otherProductId, quantity: 1, unitPrice: 10 }],
    })
    expect(res.status).toBe(400)

    const after = await db.order.findUniqueOrThrow({ where: { id } })
    expect(after.shopId).toBe(before.shopId)
    expect(after.b2bCustomerId).toBe(before.b2bCustomerId)
    expect(after.grossSales).toBe(before.grossSales)
    expect(after.netSales).toBe(before.netSales)
    expect(after.total).toBe(before.total)
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
    // order deleted here would come back on the next sync - or worse, not.
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

describe('voidedAt on a hand-entered order', () => {
  it('stamps when the status is set to refunded', async () => {
    await asAdmin()
    const id = await createOrder()
    expect((await db.order.findUniqueOrThrow({ where: { id } })).voidedAt).toBeNull()

    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'refunded',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).voidedAt).toBeInstanceOf(Date)
  })

  it('clears the stamp when the order is set back to completed', async () => {
    // The edit form can un-void, so the reversal must be able to disappear.
    await asAdmin()
    const id = await createOrder()
    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'cancelled',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })
    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'completed',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).voidedAt).toBeNull()
  })

  it('does not move the stamp when a refunded order is edited again', async () => {
    await asAdmin()
    const id = await createOrder()
    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'refunded',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })
    const first = (await db.order.findUniqueOrThrow({ where: { id } })).voidedAt

    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'refunded',
      lines: [{ productId, quantity: 2, unitPrice: 89 }],
    })
    const second = (await db.order.findUniqueOrThrow({ where: { id } })).voidedAt
    expect(second?.getTime()).toBe(first?.getTime())
  })
})

describe('GET /api/b2b/orders/[id]', () => {
  it('returns the order in the shape the form needs to reopen it', async () => {
    await asAdmin()
    const id = await createOrder() // 10 x 89.00, 10% off

    const body = await (await GET(new Request('http://localhost/x'), params(id))).json()

    expect(body.order).toMatchObject({
      id, number: 'B-0001', status: 'completed',
      placedAt: '2026-07-01',
      customerId, currency: 'EUR',
    })
    // The line carries what the form cannot get from /api/orders: the
    // product's id and the discount as it was typed.
    expect(body.order.lines).toEqual([
      { productId, quantity: 10, unitPrice: 8900, discountValue: 10, discountKind: 'PERCENT' },
    ])
  })

  it('returns an AMOUNT discount in minor units, as stored', async () => {
    // PERCENT is a plain number, AMOUNT is money. Collapsing the two is the
    // 100x hazard this codebase guards at every other call site.
    await asAdmin()
    const res = await POST(new Request('http://localhost/api/b2b/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId, placedAt: '2026-07-02',
        lines: [{ productId, quantity: 4, unitPrice: 245, discountValue: 20, discountKind: 'AMOUNT' }],
      }),
    }))
    const { order } = await res.json()

    const body = await (await GET(new Request('http://localhost/x'), params(order.id))).json()
    expect(body.order.lines[0]).toMatchObject({ discountValue: 2000, discountKind: 'AMOUNT' })
  })

  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    const id = 'anything'
    expect((await GET(new Request('http://localhost/x'), params(id))).status).toBe(403)
  })

  it('404s a webshop order', async () => {
    await asAdmin()
    const woo = await db.order.create({
      data: {
        shopId, externalId: '9500', number: '9500', placedAt: new Date('2026-07-01'),
        status: 'completed', currency: 'NOK', grossSales: 1000, discountTotal: 0,
        netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
      },
    })
    expect((await GET(new Request('http://localhost/x'), params(woo.id))).status).toBe(404)
  })
})

/**
 * An order imported from Visma carries a b2bCustomerId, so it satisfied "an
 * order this app owns" and became editable the moment the sales import shipped.
 * It is not ours to rewrite: Visma is its source, and the next fifteen-minute
 * run rewrites its money and its lines from the invoice. An edit made here
 * would silently revert, and a delete would come straight back on the next
 * upsert - taking any fulfillmentCost typed onto it in the meantime.
 */
describe('an order imported from Visma', () => {
  const imported = () =>
    db.order.create({
      data: {
        shopId, externalId: 'visma-123194', number: '123194', placedAt: new Date('2026-08-14'),
        status: 'completed', currency: 'EUR', grossSales: 1000, discountTotal: 0,
        netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
        customerName: 'Nordic', customerEmail: '', b2bCustomerId: customerId,
      },
    })

  it('cannot be edited, because the next run would undo it anyway', async () => {
    await asAdmin()
    const order = await imported()

    const res = await patch(order.id, {
      customerId, placedAt: '2026-08-14',
      lines: [{ productId, quantity: 99, unitPrice: 1 }],
    })

    expect(res.status).toBe(404)
    // Proves the refusal, not merely a message: the order is untouched.
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.netSales).toBe(1000)
  })

  it('cannot be deleted, because the next run would bring it back', async () => {
    await asAdmin()
    const order = await imported()

    const res = await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params(order.id))

    expect(res.status).toBe(404)
    expect(await db.order.count({ where: { id: order.id } })).toBe(1)
  })
})
