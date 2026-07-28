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
let prodA = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: { contains: 'orders-test' } } })
  await db.processingFee.deleteMany({ where: { gateway: 'Dintero Checkout' } })
}

const order = (
  shopId: string,
  productId: string,
  number: string,
  on: string,
  items: { name: string; sku: string; quantity: number }[],
  extra: Partial<{ status: string; customerName: string; customerEmail: string; ambassadorId: string; couponCode: string }> = {},
) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(on), status: extra.status ?? 'completed', currency: 'DKK',
      grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 2000, taxTotal: 2500, total: 14500,
      customerName: extra.customerName, customerEmail: extra.customerEmail,
      ambassadorId: extra.ambassadorId, couponCode: extra.couponCode,
      items: { create: items.map((i) => ({ productId, name: i.name, sku: i.sku, quantity: i.quantity, unitPrice: 5000, lineNetTotal: 5000 })) },
    },
  })

beforeEach(async () => {
  await wipe()
  shopA = (await db.shop.create({ data: { name: `A ${MARK}`, currency: 'DKK' } })).id
  shopB = (await db.shop.create({ data: { name: `B ${MARK}`, currency: 'NOK' } })).id
  prodA = (await db.product.create({ data: { shopId: shopA, externalId: 'pa', sku: 'PA', name: 'PA', lastPrice: 5000, imageUrl: 'https://img.example/pa.jpg' } })).id
  const prodB = (await db.product.create({ data: { shopId: shopB, externalId: 'pb', sku: 'PB', name: 'PB', lastPrice: 5000 } })).id

  await order(shopA, prodA, 'A-mar20', '2026-03-20T12:00:00Z', [
    { name: 'Massage Chair', sku: 'CHAIR-1', quantity: 1 },
    { name: 'Massage Gun', sku: 'GUN-1', quantity: 2 },
  ], { customerName: 'Tino Skaarup', customerEmail: 'tino@x.dk' })
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

  it('lists orders in the range, newest first, with their products and customer', async () => {
    await asAdmin()
    const body = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}`)).json()

    expect(body.total).toBe(2) // feb15 excluded
    expect(body.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20', 'A-mar10'])

    const first = body.orders[0]
    expect(first.status).toBe('completed')
    expect(first.customerName).toBe('Tino Skaarup')
    expect(first.customerEmail).toBe('tino@x.dk')
    expect(first.itemCount).toBe(3) // 1 chair + 2 guns
    expect(first.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Massage Chair', sku: 'CHAIR-1', quantity: 1 }),
        expect.objectContaining({ name: 'Massage Gun', sku: 'GUN-1', quantity: 2 }),
      ]),
    )
    // Each line carries what the expanded row shows: price, total, photo.
    expect(first.products[0].unitPrice).toBe(5000)
    expect(first.products[0].lineNetTotal).toBe(5000)
    expect(first.products[0].imageUrl).toBe('https://img.example/pa.jpg')
    expect(first.total).toBe(14500) // what the customer paid, in the shop's own currency
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

  it('hides voided orders by default, shows them on includeVoided, and a named status wins outright', async () => {
    await asAdmin()
    await order(shopA, prodA, 'A-refund', '2026-03-15T12:00:00Z', [{ name: 'Back', sku: 'B-1', quantity: 1 }], { status: 'refunded' })

    const hidden = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}`)).json()
    expect(hidden.orders.map((o: { number: string }) => o.number)).not.toContain('A-refund')

    const shown = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&includeVoided=true`)).json()
    expect(shown.orders.map((o: { number: string }) => o.number)).toContain('A-refund')

    // Asking for refunded and getting nothing because refunds are hidden would be absurd.
    const named = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&status=refunded`)).json()
    expect(named.orders.map((o: { number: string }) => o.number)).toEqual(['A-refund'])
  })

  it('searches by order number, customer and product name', async () => {
    await asAdmin()
    const base = `from=2026-03-01&to=2026-03-31&shops=${shopA}`

    const byNumber = await (await get(`${base}&q=A-mar20`)).json()
    expect(byNumber.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20'])

    const byCustomer = await (await get(`${base}&q=tino`)).json()
    expect(byCustomer.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20'])

    const byProduct = await (await get(`${base}&q=chair`)).json()
    expect(byProduct.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20'])

    const nothing = await (await get(`${base}&q=zzz-not-there`)).json()
    expect(nothing.total).toBe(0)
  })

  it('computes each order figure at the rates in force on ITS date, exactly like the engine', async () => {
    await asAdmin()
    // Cost 30.00 + 2.00 handling per item from March 1st.
    await db.productCost.create({
      data: { productId: prodA, costPerItem: 3000, handlingCost: 200, effectiveFrom: new Date('2026-03-01') },
    })
    // Fulfillment 15.00 per order from March 1st.
    await db.fulfillmentRate.create({
      data: { shopId: shopA, perOrder: 1500, effectiveFrom: new Date('2026-03-01') },
    })
    // Gateway takes 2% of the charged total; the fixed part is zero so no FX is involved.
    await db.processingFee.create({
      data: { gateway: 'Dintero Checkout', percent: 2, fixedMinor: 0, currency: 'EUR' },
    })
    const amb = await db.ambassador.create({
      data: { name: 'Emma', email: 'emma-orders-test@x.local', commissionRate: 0.1 },
    })
    await order(shopA, prodA, 'A-figured', '2026-03-25T12:00:00Z', [{ name: 'Gun', sku: 'G', quantity: 2 }], {
      ambassadorId: amb.id, couponCode: 'EMMA10',
    })

    const body = await (await get(`from=2026-03-25&to=2026-03-25&shops=${shopA}`)).json()
    const o = body.orders.find((x: { number: string }) => x.number === 'A-figured')

    // netSales 10000, shipping 2000, total 14500 (fixtures above).
    expect(o.figures.cogs).toBe(2 * (3000 + 200)) // 6400
    expect(o.figures.fulfillment).toBe(1500)
    expect(o.figures.fee).toBe(Math.round((14500 * 2) / 100)) // 290, % of the charged total
    expect(o.figures.commission).toBe(1000) // 10% of net sales
    expect(o.figures.profit).toBe(10000 + 2000 - 6400 - 1500 - 290 - 1000) // 2810
    expect(o.figures.margin).toBeCloseTo(2810 / 12000, 5)
  })

  it('a voided order gets null figures — it earns nothing, and the list never pretends otherwise', async () => {
    await asAdmin()
    await order(shopA, prodA, 'A-void', '2026-03-18T12:00:00Z', [{ name: 'Back', sku: 'B-2', quantity: 1 }], { status: 'cancelled' })

    const body = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&includeVoided=true`)).json()
    const voided = body.orders.find((o: { number: string }) => o.number === 'A-void')
    const live = body.orders.find((o: { number: string }) => o.number === 'A-mar20')

    expect(voided.figures).toBeNull()
    expect(live.figures).not.toBeNull()
  })
})
