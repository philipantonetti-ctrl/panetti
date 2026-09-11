import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { matchByEmail, matchByName, MATCH_WINDOW_DAYS, LONG_WINDOW_DAYS } from './match'
import { nameKey } from '@/lib/delivery/name-key'

// Unique to THIS file - see "Test data convention" in the Global Constraints.
const TAG = '[intake-match-test]'
const scoped = { shop: { name: { contains: TAG } } }

const RECEIVED = new Date('2026-08-11T18:00:00Z')
const DAY = 24 * 60 * 60 * 1000

let trackedShopId: string
let untrackedShopId: string

const order = (
  shopId: string,
  externalId: string,
  email: string,
  placedAt: string,
  extra: Record<string, unknown> = {},
) =>
  db.order.create({
    data: {
      shopId,
      externalId,
      number: externalId,
      placedAt: new Date(placedAt),
      status: 'completed',
      currency: 'NOK',
      grossSales: 1000, discountTotal: 0, netSales: 1000,
      shippingCharged: 0, taxTotal: 0, total: 1000,
      customerEmail: email,
      ...extra,
    },
  })

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'TNAME-' } } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeAll(async () => {
  await cleanup()
  const tracked = await db.shop.create({
    data: {
      name: `Tracked ${TAG}`, currency: 'NOK',
      deliveryTrackingFrom: new Date('2026-01-01'),
    },
  })
  const untracked = await db.shop.create({
    data: { name: `Untracked ${TAG}`, currency: 'NOK', deliveryTrackingFrom: null },
  })
  trackedShopId = tracked.id
  untrackedShopId = untracked.id
})

afterAll(cleanup)

describe('matchByEmail', () => {
  it('links the one order with that email', async () => {
    const o = await order(trackedShopId, 'M1', 'one@example.test', '2026-08-10T09:00:00Z')
    await expect(matchByEmail('one@example.test', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('ignores case, because Bring and Woo disagree about it', async () => {
    const o = await order(trackedShopId, 'M2', 'Mixed@Example.TEST', '2026-08-10T09:00:00Z')
    await expect(matchByEmail('mixed@example.test', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('refuses when two live orders share an email in the window, rather than guessing', async () => {
    const m3a = await order(trackedShopId, 'M3a', 'twice@example.test', '2026-08-09T09:00:00Z')
    const m3b = await order(trackedShopId, 'M3b', 'twice@example.test', '2026-08-10T09:00:00Z')
    try {
      const out = await matchByEmail('twice@example.test', RECEIVED)
      expect(out.orderId).toBeNull()
      expect((out as { reason: string }).reason).toMatch(/2 orders/)
    } finally {
      await db.order.deleteMany({ where: { id: { in: [m3a.id, m3b.id] } } })
    }
  })

  /**
   * A refusal that names nothing is a dead end. This is the message the client
   * actually saw on the 2026-08-18 file - "matched 2 orders in the last 30
   * days" - and having read it he still had no way to learn WHICH two, so the
   * only route to an answer was to ask us. Repeat customers are the ordinary
   * case here, not the exception, so this message gets read often.
   *
   * The orders are named oldest-first, which is also the order a human would
   * check them in.
   */
  it('names the orders it could not choose between', async () => {
    await order(trackedShopId, 'M9a', 'named@example.test', '2026-08-09T09:00:00Z')
    await order(trackedShopId, 'M9b', 'named@example.test', '2026-08-10T09:00:00Z')
    const out = await matchByEmail('named@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
    const { reason } = out as { reason: string }
    expect(reason).toMatch(/M9a/)
    expect(reason).toMatch(/M9b/)
    expect(reason.indexOf('M9a')).toBeLessThan(reason.indexOf('M9b'))
  })

  it('says so when no order has that email', async () => {
    const out = await matchByEmail('nobody@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
    expect((out as { reason: string }).reason).toMatch(/No order/i)
  })

  it('says so when Bring held no email at all', async () => {
    const out = await matchByEmail(null, RECEIVED)
    expect(out.orderId).toBeNull()
    expect((out as { reason: string }).reason).toMatch(/no email/i)
  })

  it('will not reach into a shop that is not delivery-tracked', async () => {
    await order(untrackedShopId, 'M4', 'untracked@example.test', '2026-08-10T09:00:00Z')
    const out = await matchByEmail('untracked@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
  })

  it('ignores an order placed after the file reached us', async () => {
    await order(trackedShopId, 'M5', 'later@example.test', '2026-08-12T09:00:00Z')
    const out = await matchByEmail('later@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
  })

  it('ignores an order older than the long window', async () => {
    await order(trackedShopId, 'M6', 'ancient@example.test', new Date(RECEIVED.getTime() - (LONG_WINDOW_DAYS + 1) * DAY).toISOString())
    const out = await matchByEmail('ancient@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
    expect((out as { reason: string }).reason).toBe('No order for ancient@example.test')
  })

  it('reaches into the long window only when the short one is empty, and still wants exactly one order there', async () => {
    // A chair ordered ten weeks before it shipped: the customer's only order.
    const chair = await order(trackedShopId, 'M6b', 'patient@example.test', new Date(RECEIVED.getTime() - 70 * DAY).toISOString())
    await expect(matchByEmail('patient@example.test', RECEIVED)).resolves.toEqual({ orderId: chair.id })

    // Two old orders and nothing recent: refused, and the reason names the long window.
    await order(trackedShopId, 'M6c', 'twoold@example.test', new Date(RECEIVED.getTime() - 60 * DAY).toISOString())
    await order(trackedShopId, 'M6d', 'twoold@example.test', new Date(RECEIVED.getTime() - 50 * DAY).toISOString())
    const out = await matchByEmail('twoold@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
    expect((out as { reason: string }).reason).toBe(`twoold@example.test matched 2 orders in the last ${LONG_WINDOW_DAYS} days: M6c, M6d`)
  })

  it('the short window wins: a recent order is linked even when an older one sits inside the long window', async () => {
    await order(trackedShopId, 'M6e', 'again@example.test', new Date(RECEIVED.getTime() - 60 * DAY).toISOString())
    const recent = await order(trackedShopId, 'M6f', 'again@example.test', new Date(RECEIVED.getTime() - 3 * DAY).toISOString())
    await expect(matchByEmail('again@example.test', RECEIVED)).resolves.toEqual({ orderId: recent.id })
  })

  it('ignores a voided order, so a repeat customer is not ambiguous because of one', async () => {
    await order(trackedShopId, 'M7a', 'repeat@example.test', '2026-08-08T09:00:00Z', {
      voidedAt: new Date('2026-08-09T09:00:00Z'),
    })
    const live = await order(trackedShopId, 'M7b', 'repeat@example.test', '2026-08-10T09:00:00Z')
    await expect(matchByEmail('repeat@example.test', RECEIVED)).resolves.toEqual({
      orderId: live.id,
    })
  })

  it('matches an order placed at exactly the upper bound (received time)', async () => {
    const upperBoundDate = new Date(RECEIVED.getTime())
    const o = await order(trackedShopId, 'B1', 'boundary-upper@example.test', upperBoundDate.toISOString())
    await expect(matchByEmail('boundary-upper@example.test', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('matches an order placed at exactly the lower bound (30 days before received)', async () => {
    const lowerBoundDate = new Date(RECEIVED.getTime() - MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const o = await order(trackedShopId, 'B2', 'boundary-lower@example.test', lowerBoundDate.toISOString())
    await expect(matchByEmail('boundary-lower@example.test', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('an order placed 1ms before the short lower bound is found by the long window when it is the only one', async () => {
    const tooEarlyDate = new Date(RECEIVED.getTime() - MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000 - 1)
    const o = await order(trackedShopId, 'B3', 'boundary-too-early@example.test', tooEarlyDate.toISOString())
    await expect(matchByEmail('boundary-too-early@example.test', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('does not match an order placed 1ms before the long lower bound', async () => {
    const tooEarlyDate = new Date(RECEIVED.getTime() - LONG_WINDOW_DAYS * 24 * 60 * 60 * 1000 - 1)
    await order(trackedShopId, 'B4', 'boundary-way-too-early@example.test', tooEarlyDate.toISOString())
    const out = await matchByEmail('boundary-way-too-early@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
  })

  it('ignores a cancelled order that was never voided, so a cancelled duplicate does not block the real one', async () => {
    await order(trackedShopId, 'M8a', 'dup@example.test', '2026-08-08T09:00:00Z', { status: 'cancelled' })
    await order(trackedShopId, 'M8b', 'dup@example.test', '2026-08-08T09:05:00Z', { status: 'trash' })
    const live = await order(trackedShopId, 'M8c', 'dup@example.test', '2026-08-08T09:10:00Z')
    await expect(matchByEmail('dup@example.test', RECEIVED)).resolves.toEqual({ orderId: live.id })
  })

  it('does not offer an order that already holds another consignment\'s parcel', async () => {
    const held = await order(trackedShopId, 'PM-HELD', 'twice@example.test', '2026-08-01T10:00:00Z')
    const open = await order(trackedShopId, 'PM-OPEN', 'twice@example.test', '2026-08-02T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: 'PMATCH-HELD-1', orderId: held.id, consignmentId: 'CONS-OLD', carrier: 'BRING' },
    })
    try {
      const r = await matchByEmail('twice@example.test', RECEIVED, { consignmentId: 'CONS-NEW' })
      expect(r.orderId).not.toBeNull()
      const linked = await db.order.findUnique({ where: { id: r.orderId! }, select: { number: true } })
      expect(linked?.number).toBe('PM-OPEN')
    } finally {
      await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'PMATCH-' } } })
      await db.order.deleteMany({ where: { id: { in: [held.id, open.id] } } })
    }
  })

  it('still offers the order when the parcel it holds is this same consignment - the second box', async () => {
    const same = await order(trackedShopId, 'PM-SAME', 'box@example.test', '2026-08-01T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: 'PMATCH-SAME-1', orderId: same.id, consignmentId: 'CONS-SAME', carrier: 'BRING' },
    })
    try {
      const r = await matchByEmail('box@example.test', RECEIVED, { consignmentId: 'CONS-SAME' })
      expect(r.orderId).toBe(same.id)
    } finally {
      await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'PMATCH-' } } })
      await db.order.deleteMany({ where: { id: same.id } })
    }
  })

  it('treats a held parcel with no consignment id as another consignment, so it can only refuse', async () => {
    const held = await order(trackedShopId, 'PM-NOID', 'noid@example.test', '2026-08-01T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: 'PMATCH-NOID-1', orderId: held.id, carrier: 'BRING' },
    })
    try {
      const r = await matchByEmail('noid@example.test', RECEIVED, { consignmentId: 'CONS-X' })
      expect(r.orderId).toBeNull()
      expect((r as { reason: string }).reason).toBe('No order for noid@example.test')
    } finally {
      await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'PMATCH-' } } })
      await db.order.deleteMany({ where: { id: held.id } })
    }
  })

  it('uses the booking time, not the file time, as the upper bound', async () => {
    const early = await order(trackedShopId, 'PM-EARLY', 'twins@example.test', '2026-08-10T08:00:00Z')
    const late = await order(trackedShopId, 'PM-LATE', 'twins@example.test', '2026-08-10T20:00:00Z')
    // Booked at noon: only the morning order existed then.
    try {
      const r = await matchByEmail('twins@example.test', RECEIVED, { bookedAt: new Date('2026-08-10T12:00:00Z') })
      expect(r.orderId).not.toBeNull()
      const linked = await db.order.findUnique({ where: { id: r.orderId! }, select: { number: true } })
      expect(linked?.number).toBe('PM-EARLY')
    } finally {
      await db.order.deleteMany({ where: { id: { in: [early.id, late.id] } } })
    }
  })
})

describe('matchByName', () => {
  const named = (shopId: string, number: string, name: string, placedAt: string, extra: Record<string, unknown> = {}) =>
    order(shopId, number, `${number.toLowerCase()}@example.test`, placedAt, {
      customerName: name, customerNameKey: nameKey(name), shippingCountry: 'NO', ...extra,
    })

  it('links the one order whose folded name equals the label, whatever the case, accents or order', async () => {
    const o = await named(trackedShopId, 'N-1', 'Martin R\u00f6thke', '2026-08-05T10:00:00Z')
    await expect(matchByName('ROTHKE, MARTIN', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('refuses two orders with that name, naming both, and refuses none', async () => {
    await named(trackedShopId, 'N-2A', 'Anna Hansen', '2026-08-01T10:00:00Z')
    await named(trackedShopId, 'N-2B', 'Anna Hansen', '2026-08-03T10:00:00Z')
    const r = await matchByName('Anna Hansen', RECEIVED)
    expect(r.orderId).toBeNull()
    expect((r as { reason: string }).reason).toBe(
      `The label says Anna Hansen and 2 orders in the last ${MATCH_WINDOW_DAYS} days have that name: N-2A, N-2B`,
    )
    const none = await matchByName('Nobody Here', RECEIVED)
    expect((none as { reason: string }).reason).toBe(
      `The label says Nobody Here and no order in the last ${LONG_WINDOW_DAYS} days has that name`,
    )
    expect(await matchByName('', RECEIVED)).toEqual({ orderId: null, reason: 'The label carries no name' })
    expect(await matchByName(null, RECEIVED)).toEqual({ orderId: null, reason: 'The label carries no name' })
  })

  it('applies the country only when given, and says so in the reason', async () => {
    const no = await named(trackedShopId, 'N-3', 'Kari Nordmann', '2026-08-05T10:00:00Z', { shippingCountry: 'NO' })
    await expect(matchByName('Kari Nordmann', RECEIVED, { country: 'no' })).resolves.toEqual({ orderId: no.id })
    const r = await matchByName('Kari Nordmann', RECEIVED, { country: 'DE' })
    expect((r as { reason: string }).reason).toBe(
      `The label says Kari Nordmann and no order in the last ${LONG_WINDOW_DAYS} days has that name in DE`,
    )
  })

  it('ignores untracked shops, voided orders, orders outside the window, and orders holding another consignment', async () => {
    await named(untrackedShopId, 'N-4U', 'Ola Nordmann', '2026-08-05T10:00:00Z')
    await named(trackedShopId, 'N-4V', 'Ola Nordmann', '2026-08-05T10:00:00Z', { voidedAt: new Date('2026-08-06') })
    await named(trackedShopId, 'N-4OLD', 'Ola Nordmann', new Date(RECEIVED.getTime() - (LONG_WINDOW_DAYS + 1) * DAY).toISOString())
    await named(trackedShopId, 'N-4AFTER', 'Ola Nordmann', new Date(RECEIVED.getTime() + DAY).toISOString())
    const held = await named(trackedShopId, 'N-4H', 'Ola Nordmann', '2026-08-04T10:00:00Z')
    await db.shipment.create({ data: { trackingNumber: 'TNAME-HELD-1', orderId: held.id, consignmentId: 'OTHER' } })
    const r = await matchByName('Ola Nordmann', RECEIVED, { consignmentId: 'MINE' })
    expect((r as { reason: string }).reason).toMatch(/no order in the last/)
    // The second box of the SAME consignment still finds the order.
    await expect(matchByName('Ola Nordmann', RECEIVED, { consignmentId: 'OTHER' })).resolves.toEqual({ orderId: held.id })
    await db.shipment.deleteMany({ where: { trackingNumber: 'TNAME-HELD-1' } })
  })
})
