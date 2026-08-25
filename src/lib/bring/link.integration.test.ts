import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { linkRows } from './link'

let shopA: string
let shopB: string

async function order(shopId: string, number: string) {
  return db.order.create({
    data: {
      shopId, externalId: `${shopId}-${number}`, number,
      placedAt: new Date('2026-08-01T10:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    },
  })
}

// Both unique to THIS file - see "Test data convention" in the Global
// Constraints. Test files run in parallel against one database.
const TAG = '[delivery-link-test]'
const TRACK = 'TLINK' // every tracking number below starts with it
const scoped = { shop: { name: { contains: TAG } } }
const mine = { trackingNumber: { startsWith: TRACK } }

// IMPLEMENTER: the tests below are written with 'T1' and 'T2' for readability.
// Use these two constants instead of those string literals everywhere they
// appear - a bare 'T1' has no prefix, so cleanup() would leave it behind and
// the next run's unique-constraint check would fail against a stale row.
const T1 = `${TRACK}1`
const T2 = `${TRACK}2`

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: mine } })
  // By prefix, not by `orderId: null` - an unlinked parcel belongs to no shop,
  // so `orderId: null` would delete another file's parcels too.
  await db.shipment.deleteMany({ where: mine })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeEach(async () => {
  await cleanup()
  // deliveryTrackingFrom must be set: linkRows only ever matches orders in a
  // delivery-tracked shop, so an untracked fixture links nothing and every
  // assertion below reads zero.
  const tracked = { deliveryTrackingFrom: new Date('2026-01-01') }
  shopA = (await db.shop.create({ data: { name: `A ${TAG}`, currency: 'NOK', ...tracked } })).id
  shopB = (await db.shop.create({ data: { name: `B ${TAG}`, currency: 'SEK', ...tracked } })).id
})

afterAll(cleanup)

describe('linkRows', () => {
  it('links a row to its order and records where the link came from', async () => {
    const o = await order(shopA, '1001')
    const result = await linkRows([{ orderNumber: '1001', trackingNumber: T1 }])

    expect(result.linked).toBe(1)
    const s = await db.shipment.findUnique({ where: { trackingNumber: T1 } })
    expect(s?.orderId).toBe(o.id)
    expect(s?.linkSource).toBe('FILE')
    // Due for its first poll straight away, so the next cron picks it up.
    expect(s?.nextPollAt).not.toBeNull()
    expect(s?.terminal).toBe(false)
  })

  it('refuses an order number two shops both hold, rather than guessing', async () => {
    await order(shopA, '1001')
    await order(shopB, '1001')

    const result = await linkRows([{ orderNumber: '1001', trackingNumber: T1 }])
    expect(result.linked).toBe(0)
    expect(result.unmatched[0].reason).toMatch(/2 orders/)
    // Nothing is written: a wrong link would poison a delivery figure forever.
    expect(await db.shipment.findUnique({ where: { trackingNumber: T1 } })).toBeNull()
  })

  it('reports an order number we do not hold', async () => {
    const result = await linkRows([{ orderNumber: '9999', trackingNumber: T1 }])
    expect(result.linked).toBe(0)
    expect(result.unmatched[0].reason).toMatch(/No order/)
  })

  it('is idempotent, so re-importing yesterday duplicates nothing', async () => {
    await order(shopA, '1001')
    await linkRows([{ orderNumber: '1001', trackingNumber: T1 }])
    await linkRows([{ orderNumber: '1001', trackingNumber: T1 }])
    expect(await db.shipment.count({ where: { trackingNumber: T1 } })).toBe(1)
  })

  it('adopts a parcel that arrived before its link, without resetting its progress', async () => {
    const o = await order(shopA, '1001')
    await db.shipment.create({
      data: {
        trackingNumber: T1, lastStatus: 'IN_TRANSIT',
        handedInAt: new Date('2026-08-01T16:00:00Z'), terminal: false,
      },
    })

    await linkRows([{ orderNumber: '1001', trackingNumber: T1 }])

    const s = await db.shipment.findUnique({ where: { trackingNumber: T1 } })
    expect(s?.orderId).toBe(o.id)
    expect(s?.handedInAt).toEqual(new Date('2026-08-01T16:00:00Z'))
    expect(s?.lastStatus).toBe('IN_TRANSIT')
  })

  it('lets one order carry several parcels', async () => {
    const o = await order(shopA, '1001')
    await linkRows([
      { orderNumber: '1001', trackingNumber: T1 },
      { orderNumber: '1001', trackingNumber: T2 },
    ])
    expect(await db.shipment.count({ where: { orderId: o.id } })).toBe(2)
  })
})
