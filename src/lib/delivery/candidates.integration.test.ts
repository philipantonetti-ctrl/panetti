import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { candidatesFor, CANDIDATE_LIMIT } from './candidates'
import { nameKey } from './name-key'

const TAG = '[parcel-candidates-test]'
const TRACK = 'TCAND'
const scoped = { shop: { name: { contains: TAG } } }
const DAY = 24 * 60 * 60 * 1000
const booked = new Date('2026-09-09T13:05:00Z')

let trackedId: string
let untrackedId: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.product.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  trackedId = (await db.shop.create({ data: { name: `Panetti Germany ${TAG}`, currency: 'EUR', deliveryTrackingFrom: new Date('2026-01-01') } })).id
  untrackedId = (await db.shop.create({ data: { name: `Untracked ${TAG}`, currency: 'EUR' } })).id
})

async function order(shopId: string, number: string, over: Record<string, unknown> = {}, items: { name: string; quantity: number }[] = []) {
  const o = await db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(booked.getTime() - 2 * DAY), status: 'completed', currency: 'EUR',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      shippingCountry: 'DE', customerName: 'Tobias K', customerEmail: `${number.toLowerCase()}@example.test`,
      ...over,
    },
  })
  for (const it of items) {
    const p = await db.product.create({ data: { shopId, externalId: `${number}-${it.name}`, sku: it.name, name: it.name } })
    await db.orderItem.create({ data: { orderId: o.id, productId: p.id, sku: it.name, name: it.name, quantity: it.quantity, unitPrice: 0, lineNetTotal: 0 } })
  }
  return o
}

describe('candidatesFor', () => {
  it('lists orders with the parcel\'s email, flagging one that already holds another consignment\'s parcel', async () => {
    const held = await order(trackedId, 'C-HELD', { customerEmail: 'same@example.test' })
    const open = await order(trackedId, 'C-OPEN', { customerEmail: 'same@example.test', placedAt: new Date(booked.getTime() - DAY) }, [{ name: 'Panetti ProMix', quantity: 1 }])
    await db.shipment.create({ data: { trackingNumber: `${TRACK}1`, orderId: held.id, consignmentId: 'OTHER' } })

    const r = await candidatesFor({ recipientEmail: 'same@example.test', recipientName: null, destinationCountry: 'DE', bookedAt: booked, createdAt: booked, consignmentId: 'THIS' })

    expect(r.total).toBe(2)
    expect(r.candidates.map((c) => c.number)).toEqual(['C-OPEN', 'C-HELD']) // newest first
    expect(r.candidates[0]).toMatchObject({ orderId: open.id, items: '1 x Panetti ProMix', holdsParcel: false, shop: `Panetti Germany ${TAG}` })
    expect(r.candidates[1]).toMatchObject({ orderId: held.id, holdsParcel: true })
  })

  it('falls back to the destination country when there is no email, and skips orders that hold any parcel', async () => {
    const free = await order(trackedId, 'C-DE1', {}, [{ name: 'Pizza oven', quantity: 1 }, { name: 'Peel', quantity: 2 }])
    const taken = await order(trackedId, 'C-DE2')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}2`, orderId: taken.id } })
    await order(trackedId, 'C-NO', { shippingCountry: 'NO' })
    await order(untrackedId, 'C-UNTRACKED')
    await order(trackedId, 'C-AFTER', { placedAt: new Date(booked.getTime() + DAY) })
    await order(trackedId, 'C-OLD', { placedAt: new Date(booked.getTime() - 40 * DAY) })

    const r = await candidatesFor({ recipientEmail: null, recipientName: null, destinationCountry: 'de', bookedAt: booked, createdAt: booked, consignmentId: null })

    expect(r.total).toBe(1)
    expect(r.candidates[0]).toMatchObject({ orderId: free.id, items: '1 x Pizza oven, 2 x Peel' })
  })

  it('caps the list and reports the true total', async () => {
    for (let i = 0; i < CANDIDATE_LIMIT + 3; i++) await order(trackedId, `C-MANY${i}`, { placedAt: new Date(booked.getTime() - i * 60_000) })
    const r = await candidatesFor({ recipientEmail: null, recipientName: null, destinationCountry: 'DE', bookedAt: booked, createdAt: booked, consignmentId: null })
    expect(r.candidates).toHaveLength(CANDIDATE_LIMIT)
    expect(r.total).toBe(CANDIDATE_LIMIT + 3)
  })

  it('offers nothing when it knows neither email nor country', async () => {
    await order(trackedId, 'C-ANY')
    const r = await candidatesFor({ recipientEmail: null, recipientName: null, destinationCountry: null, bookedAt: null, createdAt: booked, consignmentId: null })
    expect(r).toEqual({ candidates: [], total: 0 })
  })

  it('lists orders with the label\u2019s name first, flagged, then the country set, without repeating one', async () => {
    const same = await order(trackedId, 'C-SAME', { customerName: 'Tobias Kohlmeyer', customerNameKey: nameKey('Tobias Kohlmeyer'), shippingCountry: 'DE' })
    const sameElsewhere = await order(trackedId, 'C-SAME-FI', { customerName: 'Tobias Kohlmeyer', customerNameKey: nameKey('Tobias Kohlmeyer'), shippingCountry: 'FI' })
    const other = await order(trackedId, 'C-OTHER', { customerName: 'Someone Else', customerNameKey: nameKey('Someone Else'), shippingCountry: 'DE' })
    const r = await candidatesFor({ recipientEmail: null, recipientName: 'KOHLMEYER, Tobias', destinationCountry: 'DE', bookedAt: booked, createdAt: booked, consignmentId: null })
    expect(r.candidates.slice(0, 2).map((c) => c.sameName)).toEqual([true, true])
    expect(r.candidates.slice(0, 2).map((c) => c.orderId).sort()).toEqual([same.id, sameElsewhere.id].sort())
    expect(r.candidates[2]).toMatchObject({ number: 'C-OTHER', sameName: false })
    expect(r.candidates.filter((c) => c.orderId === other.id)).toHaveLength(1)
    expect(r.total).toBe(3)
    expect(CANDIDATE_LIMIT).toBe(30)
  })
})

describe('candidatesFor, the long window', () => {
  it('offers the orders of the last 120 days when nothing sits in the last 30, and never a cancelled one', async () => {
    const chair = await order(trackedId, 'C-CHAIR', { customerEmail: 'patient@example.test', placedAt: new Date(booked.getTime() - 70 * DAY) })
    await order(trackedId, 'C-DEAD', { customerEmail: 'patient@example.test', placedAt: new Date(booked.getTime() - 60 * DAY), status: 'cancelled' })
    await order(trackedId, 'C-ANCIENT', { customerEmail: 'patient@example.test', placedAt: new Date(booked.getTime() - 130 * DAY) })

    const r = await candidatesFor({ recipientEmail: 'patient@example.test', recipientName: null, destinationCountry: 'NO', bookedAt: booked, createdAt: booked, consignmentId: 'THIS' })

    expect(r.candidates.map((c) => c.number)).toEqual(['C-CHAIR'])
    expect(r.candidates[0].orderId).toBe(chair.id)
  })

  it('stays with the short window when it holds anything at all', async () => {
    await order(trackedId, 'C-OLD', { customerEmail: 'recent@example.test', placedAt: new Date(booked.getTime() - 60 * DAY) })
    const recent = await order(trackedId, 'C-NEW', { customerEmail: 'recent@example.test', placedAt: new Date(booked.getTime() - 3 * DAY) })

    const r = await candidatesFor({ recipientEmail: 'recent@example.test', recipientName: null, destinationCountry: 'NO', bookedAt: booked, createdAt: booked, consignmentId: 'THIS' })

    expect(r.candidates.map((c) => c.orderId)).toEqual([recent.id])
  })
})
