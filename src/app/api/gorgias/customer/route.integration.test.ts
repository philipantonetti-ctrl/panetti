import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'
import { GET } from './route'

/**
 * The endpoint Gorgias calls to fill its sidebar. Tagged rows only, cleaned up
 * after: the local database is shared and holds real data.
 */

const TAG = '[gorgias-test]'
const KARI = 'kari.gorgias@example.invalid'
let shopId: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'TGOR' } } })
  await db.orderItem.deleteMany({ where: { order: { shop: { name: { contains: TAG } } } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.product.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
afterEach(() => vi.unstubAllEnvs())

beforeEach(async () => {
  await cleanup()
  vi.stubEnv('GORGIAS_WIDGET_SECRET', 's3cret')

  shopId = (
    await db.shop.create({
      data: { name: `Panetti Norway ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') },
    })
  ).id
  const product = await db.product.create({
    data: { shopId, externalId: 'g1', sku: 'MPX-001', name: 'Massasjepistol Pro X' },
  })
  const order = await db.order.create({
    data: {
      shopId, externalId: 'g-1042', number: '#1042', placedAt: new Date('2026-08-20T10:00:00Z'),
      status: 'completed', currency: 'NOK', grossSales: 249900, discountTotal: 0, netSales: 249900,
      shippingCharged: 0, taxTotal: 62475, total: 312375,
      customerName: 'Kari Olsen', customerEmail: KARI, customerPhone: '+47 912 34 567', shippingCountry: 'NO',
      items: { create: [{ productId: product.id, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 1, unitPrice: 249900, lineNetTotal: 249900 }] },
    },
  })
  await db.shipment.create({
    data: { trackingNumber: 'TGOR1', carrier: 'BRING', orderId: order.id, handedInAt: new Date('2026-08-21T09:00:00Z') },
  })
})

const call = (email: string, secret = 's3cret') =>
  GET(
    new Request(`http://localhost/api/gorgias/customer?email=${encodeURIComponent(email)}`, {
      headers: { 'X-Panetti-Secret': secret },
    }),
  )

describe('GET /api/gorgias/customer', () => {
  it('gives the agent the customer, their order and where the parcel is', async () => {
    const body = await (await call(KARI)).json()

    expect(body.found).toBe(true)
    expect(body.customer).toMatchObject({
      name: 'Kari Olsen',
      email: KARI,
      phone: '+47 912 34 567',
      country: 'NO',
    })
    expect(body.customer.conversations).toBe(0)

    const [order] = body.orders
    expect(order).toMatchObject({
      number: '#1042',
      shop: `Panetti Norway ${TAG}`,
      placedAt: '2026-08-20',
      status: 'completed',
      refunded: false,
      products: '1 x Massasjepistol Pro X',
      tracking: 'TGOR1',
      carrier: 'Bring',
    })
    // Money as a person reads it, not as minor units: an agent should never
    // have to divide by a hundred while a customer waits. 312375 ore is the
    // 2 499 goods plus its VAT, which is what the customer actually paid.
    expect(order.total).toContain('3,123.75')
    expect(order.total).toMatch(/NOK|kr/)
    expect(order.delivery).toMatch(/transit/i)
    expect(order.trackingUrl).toMatch(/^https?:\/\//)
  })

  it('is case-insensitive about the address, because mail is', async () => {
    const body = await (await call(KARI.toUpperCase())).json()
    expect(body.found).toBe(true)
  })

  /**
   * Gorgias hides a widget whose response carries nothing. An error here would
   * read to the agent as a broken integration rather than as a customer who
   * has never ordered.
   */
  it('answers 200 and found:false for someone we have never sold to', async () => {
    const res = await call('stranger@example.invalid')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ found: false, customer: null, orders: [] })
  })

  it('refuses without the shared secret, and when no secret is configured', async () => {
    expect((await call(KARI, 'wrong')).status).toBe(401)
    vi.stubEnv('GORGIAS_WIDGET_SECRET', '')
    expect((await call(KARI)).status).toBe(401)
  })

  it('asks for an email when none was given', async () => {
    const res = await GET(
      new Request('http://localhost/api/gorgias/customer', { headers: { 'X-Panetti-Secret': 's3cret' } }),
    )
    expect(res.status).toBe(400)
  })
})
