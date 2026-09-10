import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'ops@example.test', role: 'OPERATIONS' })),
}))

const { PATCH } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')

const TAG = '[parcel-link-route-test]'
const TRACK = 'TLINK'
const scoped = { shop: { name: { contains: TAG } } }

let trackedId: string
let untrackedId: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  trackedId = (await db.shop.create({ data: { name: `Tracked ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') } })).id
  untrackedId = (await db.shop.create({ data: { name: `Untracked ${TAG}`, currency: 'NOK' } })).id
})

const order = (shopId: string, number: string) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    },
  })

const call = (trackingNumber: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/delivery/parcels/${trackingNumber}`, { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ trackingNumber }),
  })

describe('PATCH /api/delivery/parcels/[trackingNumber]', () => {
  it('links an unlinked parcel to an order and puts it in the poller\'s queue', async () => {
    const o = await order(trackedId, 'L1')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}1`, carrier: 'DHL', unlinkedReason: 'DHL parcel to DE: ...', nextPollAt: null } })

    const res = await call(`${TRACK}1`, { orderId: o.id })

    expect(res.status).toBe(200)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${TRACK}1` } })
    expect(row).toMatchObject({ orderId: o.id, linkSource: 'MANUAL', unlinkedReason: null, terminal: false })
    expect(row?.nextPollAt).not.toBeNull()
  })

  it('dismisses a parcel that is not a customer delivery, naming who did it', async () => {
    await db.shipment.create({ data: { trackingNumber: `${TRACK}2`, carrier: 'DHL' } })
    const res = await call(`${TRACK}2`, { dismiss: true })
    expect(res.status).toBe(200)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${TRACK}2` } })
    expect(row?.terminal).toBe(true)
    expect(row?.dismissedAt).not.toBeNull()
    expect(row?.unlinkedReason).toBe('Not a customer parcel (dismissed by ops@example.test)')
  })

  it('refuses a parcel that already has an order', async () => {
    const o = await order(trackedId, 'L3')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}3`, orderId: o.id } })
    const res = await call(`${TRACK}3`, { orderId: o.id })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This parcel is already linked to an order')
  })

  it('refuses an order in a shop that is not delivery-tracked', async () => {
    const o = await order(untrackedId, 'L4')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}4` } })
    const res = await call(`${TRACK}4`, { orderId: o.id })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That order belongs to a shop that is not delivery-tracked')
  })

  it('answers 404 for a parcel we do not hold and 400 for an order that does not exist', async () => {
    expect((await call(`${TRACK}none`, { dismiss: true })).status).toBe(404)
    await db.shipment.create({ data: { trackingNumber: `${TRACK}5` } })
    const res = await call(`${TRACK}5`, { orderId: 'no-such-order' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That order does not exist')
  })

  it('refuses a body that is neither a link nor a dismissal', async () => {
    await db.shipment.create({ data: { trackingNumber: `${TRACK}6` } })
    expect((await call(`${TRACK}6`, { hello: 1 })).status).toBe(400)
  })

  it('refuses anyone below operations', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'm@example.test', role: 'MARKETING' } as never)
    await db.shipment.create({ data: { trackingNumber: `${TRACK}7` } })
    expect((await call(`${TRACK}7`, { dismiss: true })).status).toBe(403)
  })
})
