import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { matchOrder } from './match'

const TAG = '[inbox-test-match]'
let shopA: string, shopB: string
let orderA1042: string, orderA1050: string, orderB1042: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'TMATCH' } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

const order = (shopId: string, number: string, placedAt: string, email: string, phone = '') =>
  db.order.create({
    data: {
      shopId, externalId: `m-${shopId}-${number}`, number, placedAt: new Date(placedAt), status: 'completed',
      currency: 'NOK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: 'Kari Olsen', customerEmail: email, customerPhone: phone,
    },
  })

beforeEach(async () => {
  await cleanup()
  shopA = (await db.shop.create({ data: { name: `Panetti A ${TAG}`, currency: 'NOK' } })).id
  shopB = (await db.shop.create({ data: { name: `Mazzetti B ${TAG}`, currency: 'NOK' } })).id
  orderA1042 = (await order(shopA, '#991042', '2026-05-01', 'kari@example.com', '+47 912 34 567')).id
  orderA1050 = (await order(shopA, '#991050', '2026-06-01', 'kari@example.com')).id
  orderB1042 = (await order(shopB, '#991042', '2026-05-15', 'other@example.com')).id
  await db.shipment.create({ data: { trackingNumber: 'TMATCH373000000000000001', carrier: 'BRING', orderId: orderA1042 } })
})

describe('matchOrder', () => {
  it("an order number in the text wins, scoped to the mailbox's own shop", async () => {
    const m = await matchOrder({ email: 'kari@example.com', text: 'hvor er ordre #991042?', shopId: shopA })
    expect(m).toEqual({ orderId: orderA1042, via: 'order_number' })
  })
  it("the same number on another shop is not this shop's order", async () => {
    const m = await matchOrder({ email: 'nobody@example.com', text: 'order 991042', shopId: shopB })
    expect(m).toEqual({ orderId: orderB1042, via: 'order_number' })
  })
  it('with no shop scope, a number is only trusted when it is unique across shops', async () => {
    expect(await matchOrder({ email: 'nobody@example.com', text: 'order 991042', shopId: null })).toBeNull()
    expect(await matchOrder({ email: 'nobody@example.com', text: 'order 991050', shopId: null })).toEqual({ orderId: orderA1050, via: 'order_number' })
  })
  it('a tracking number lands on its order', async () => {
    const m = await matchOrder({ email: 'nobody@example.com', text: 'parcel TMATCH373000000000000001 is lost', shopId: null })
    expect(m).toEqual({ orderId: orderA1042, via: 'tracking' })
  })
  it("otherwise the sender's newest order, by email, case-insensitively", async () => {
    const m = await matchOrder({ email: 'Kari@Example.com', text: 'hello', shopId: null })
    expect(m).toEqual({ orderId: orderA1050, via: 'email' })
  })
  it('then a phone number in the text', async () => {
    const m = await matchOrder({ email: 'husband@example.com', text: "my wife's number is 912 34 567", shopId: null })
    expect(m).toEqual({ orderId: orderA1042, via: 'phone' })
  })
  it('and null when nothing fits - never a guess', async () => {
    expect(await matchOrder({ email: 'stranger@example.com', text: 'hi', shopId: null })).toBeNull()
  })
})
