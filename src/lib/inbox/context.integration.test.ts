import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { customerContext } from './context'

const TAG = '[inbox-test-context]'
const KARI = 'kari.ctx@example.com'
const NOW = new Date('2026-08-20T12:00:00Z')
let shopId: string, mailboxId: string

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: 'context.inbox-test.invalid' } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: 'context.inbox-test.invalid' } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'TCTX' } } })
  await db.orderItem.deleteMany({ where: { order: { shop: { name: { contains: TAG } } } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.product.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') } })).id
  mailboxId = (await db.mailbox.create({ data: { address: 'support@context.inbox-test.invalid', name: 'ctx', shopId } })).id
  const product = await db.product.create({ data: { shopId, externalId: 'p1', sku: 'MPX-001', name: 'Massasjepistol Pro X' } })
  const o1 = await db.order.create({
    data: {
      shopId, externalId: 'c1', number: '#2001', placedAt: new Date('2026-08-10T10:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: 249900, discountTotal: 0, netSales: 249900, shippingCharged: 0, taxTotal: 62475, total: 312375,
      customerName: 'Kari Olsen', customerEmail: KARI, customerPhone: '+47 976 54 321', shippingCountry: 'NO',
      items: { create: [{ productId: product.id, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 1, unitPrice: 249900, lineNetTotal: 249900 }] },
    },
  })
  await db.shipment.create({ data: { trackingNumber: 'TCTX1', carrier: 'BRING', orderId: o1.id, handedInAt: new Date('2026-08-11T10:00:00Z') } })
  await db.order.create({
    data: {
      shopId, externalId: 'c2', number: '#1990', placedAt: new Date('2026-06-01T10:00:00Z'), status: 'refunded', currency: 'NOK',
      grossSales: 100000, discountTotal: 0, netSales: 100000, shippingCharged: 0, taxTotal: 25000, total: 125000,
      customerName: 'Kari Olsen', customerEmail: KARI.toUpperCase(), customerPhone: '',
    },
  })
  await db.ticket.create({
    data: { mailboxId, subject: 'Old question', customerEmail: KARI, status: 'CLOSED',
      firstMessageAt: new Date('2026-07-01'), lastMessageAt: new Date('2026-07-02') },
  })
})

describe('customerContext', () => {
  it('assembles the customer, their orders newest first with products, parcels, refund state and delivery, and past tickets', async () => {
    const ctx = await customerContext(KARI, 'not-a-ticket', NOW)
    expect(ctx.customer).toEqual({ name: 'Kari Olsen', email: KARI, phone: '+47 976 54 321', country: 'NO' })
    expect(ctx.orders.map((o) => o.number)).toEqual(['#2001', '#1990'])
    const [o1, o2] = ctx.orders
    expect(o1.products).toEqual([{ name: 'Massasjepistol Pro X', quantity: 1 }])
    expect(o1.total).toBe(312375)
    expect(o1.currency).toBe('NOK')
    expect(o1.refunded).toBe(false)
    expect(o1.parcels[0].number).toBe('TCTX1')
    expect(o1.delivery.state).toBe('IN_TRANSIT')
    expect(o1.deliveryPhrase).toMatch(/^in transit/)
    expect(o2.refunded).toBe(true)
    expect(o2.deliveryPhrase).toBeNull()
    expect(ctx.previousTickets.map((t) => t.subject)).toEqual(['Old question'])
  })
  it('is empty-handed, not wrong, for an unknown address', async () => {
    const ctx = await customerContext('stranger.ctx@example.com', 'x', NOW)
    expect(ctx).toEqual({ customer: null, orders: [], previousTickets: [] })
  })
})
