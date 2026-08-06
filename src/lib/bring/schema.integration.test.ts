import { describe, expect, it, beforeEach } from 'vitest'
import { db } from '@/lib/db'

async function makeShop() {
  return db.shop.create({ data: { name: `Test ${Math.random()}`, currency: 'NOK' } })
}

describe('delivery schema', () => {
  beforeEach(async () => {
    await db.shipmentEvent.deleteMany()
    await db.shipment.deleteMany()
  })

  it('holds a shipment with no order, so a parcel can arrive before its link', async () => {
    const s = await db.shipment.create({ data: { trackingNumber: `T${Date.now()}` } })
    expect(s.orderId).toBeNull()
    expect(s.terminal).toBe(false)
    expect(s.carrier).toBe('BRING')
  })

  it('refuses two shipments with the same tracking number', async () => {
    const n = `T${Date.now()}`
    await db.shipment.create({ data: { trackingNumber: n } })
    await expect(db.shipment.create({ data: { trackingNumber: n } })).rejects.toThrow()
  })

  it('refuses a duplicate event, which is what makes re-ingest a no-op', async () => {
    const s = await db.shipment.create({ data: { trackingNumber: `T${Date.now()}` } })
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
      data: { trackingNumber: `T${Date.now()}`, orderId: order.id, linkSource: 'FILE' },
    })
    await db.order.delete({ where: { id: order.id } })
    expect((await db.shipment.findUnique({ where: { id: s.id } }))?.orderId).toBeNull()
  })

  it('defaults a shop to untracked', async () => {
    expect((await makeShop()).deliveryTrackingFrom).toBeNull()
  })
})
