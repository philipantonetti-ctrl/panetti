import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { matchByEmail } from './match'

// Unique to THIS file — see "Test data convention" in the Global Constraints.
const TAG = '[intake-match-test]'
const scoped = { shop: { name: { contains: TAG } } }

const RECEIVED = new Date('2026-08-11T18:00:00Z')

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
    await order(trackedShopId, 'M3a', 'twice@example.test', '2026-08-09T09:00:00Z')
    await order(trackedShopId, 'M3b', 'twice@example.test', '2026-08-10T09:00:00Z')
    const out = await matchByEmail('twice@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
    expect((out as { reason: string }).reason).toMatch(/2 orders/)
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

  it('ignores an order older than the window', async () => {
    await order(trackedShopId, 'M6', 'ancient@example.test', '2026-05-01T09:00:00Z')
    const out = await matchByEmail('ancient@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
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
})
