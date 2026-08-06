import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'

// See "Test data convention" in the Global Constraints. Both of these are
// unique to THIS file: test files run in parallel against one database, so a
// tag shared with another delivery suite would have them deleting each other's
// fixtures mid-assertion.
const TAG = '[delivery-schema-test]'
const TRACK = 'TSCHEMA' // every tracking number this suite creates starts with it

let seq = 0
const trackingNumber = () => `${TRACK}${Date.now()}${seq++}`

async function makeShop() {
  return db.shop.create({ data: { name: `Schema ${TAG}`, currency: 'NOK' } })
}

async function cleanup() {
  // Events first: they hang off shipments, and the tag reaches them only
  // through a shipment that still exists.
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: TRACK } } } })
  // By prefix, not by `orderId: null` — an unlinked parcel belongs to no shop,
  // so `orderId: null` would delete another file's parcels too.
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.orderItem.deleteMany({ where: { order: { shop: { name: { contains: TAG } } } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

describe('delivery schema', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  it('holds a shipment with no order, so a parcel can arrive before its link', async () => {
    const s = await db.shipment.create({ data: { trackingNumber: trackingNumber() } })
    expect(s.orderId).toBeNull()
    expect(s.terminal).toBe(false)
    expect(s.carrier).toBe('BRING')
  })

  it('refuses two shipments with the same tracking number', async () => {
    const n = trackingNumber()
    await db.shipment.create({ data: { trackingNumber: n } })
    await expect(db.shipment.create({ data: { trackingNumber: n } })).rejects.toThrow()
  })

  it('refuses a duplicate event, which is what makes re-ingest a no-op', async () => {
    const s = await db.shipment.create({ data: { trackingNumber: trackingNumber() } })
    const at = new Date('2026-08-01T10:00:00Z')
    await db.shipmentEvent.create({ data: { shipmentId: s.id, status: 'HANDED_IN', occurredAt: at } })
    await expect(
      db.shipmentEvent.create({ data: { shipmentId: s.id, status: 'HANDED_IN', occurredAt: at } }),
    ).rejects.toThrow()
  })

  it('keeps the parcel when its order is deleted, rather than losing the record', async () => {
    const shop = await makeShop()
    const order = await db.order.create({
      data: {
        shopId: shop.id, externalId: `E${Date.now()}`, number: '1001',
        placedAt: new Date(), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })
    const s = await db.shipment.create({
      data: { trackingNumber: trackingNumber(), orderId: order.id, linkSource: 'FILE' },
    })
    await db.order.delete({ where: { id: order.id } })
    expect((await db.shipment.findUnique({ where: { id: s.id } }))?.orderId).toBeNull()
  })

  it('defaults a shop to untracked', async () => {
    expect((await makeShop()).deliveryTrackingFrom).toBeNull()
  })
})
