import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { applyIdentification, applyUnknown, rematchByEmail, type CarrierFacts } from './identify'
import { milestonesFrom } from './milestones'

const TAG = '[parcel-identify-test]'
const TRACK = 'TIDENT'
const scoped = { shop: { name: { contains: TAG } } }
const now = new Date('2026-09-10T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

let shopId: string

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: TRACK } } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({
    data: { name: `Shop ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') },
  })).id
})

const order = (number: string, email: string, placedAt: string) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerEmail: email, shippingCountry: 'NO',
    },
  })

const unknownRow = (trackingNumber: string, createdAt = now) =>
  db.shipment.create({ data: { trackingNumber, carrier: 'UNKNOWN', nextPollAt: now, createdAt } })

const events = [
  { status: 'PRE_NOTIFIED', occurredAt: new Date('2026-09-07T08:17:14Z'), description: 'Pre-notified', location: null },
  { status: 'IN_TRANSIT', occurredAt: new Date('2026-09-08T06:00:00Z'), description: 'On its way', location: 'Oslo, NO' },
]

const bringFacts = (over: Partial<CarrierFacts> = {}): CarrierFacts => ({
  carrier: 'BRING', consignmentId: 'CONS-1', destinationCountry: 'NO', weightKg: 16,
  recipientEmail: 'one@example.test', recipientName: 'One Person', references: [],
  package: { trackingNumber: `${TRACK}1`, events, milestones: milestonesFrom(events) },
  ...over,
})

describe('applyIdentification', () => {
  it('writes the facts and the events, sets the carrier, and links by email when one order fits', async () => {
    const o = await order('ID-1', 'one@example.test', '2026-09-06T10:00:00Z')
    const row = await unknownRow(`${TRACK}1`)

    const r = await applyIdentification(row, bringFacts(), now)

    expect(r.linked).toBe(true)
    const after = await db.shipment.findUnique({ where: { id: row.id }, include: { events: true } })
    expect(after).toMatchObject({
      carrier: 'BRING', orderId: o.id, linkSource: 'BRING_EMAIL', consignmentId: 'CONS-1',
      destinationCountry: 'NO', weightKg: 16, recipientEmail: 'one@example.test', recipientName: 'One Person',
      unlinkedReason: null, lastError: null,
    })
    expect(after?.identifiedAt).toEqual(now)
    expect(after?.bookedAt).toEqual(new Date('2026-09-07T08:17:14Z'))
    expect(after?.events).toHaveLength(2)
    expect(after?.nextPollAt).not.toBeNull()
  })

  it('keeps the row unlinked with the refusal as its reason when the email fits nobody', async () => {
    const row = await unknownRow(`${TRACK}2`)
    const r = await applyIdentification(row, bringFacts({ recipientEmail: 'nobody@example.test' }), now)
    expect(r.linked).toBe(false)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.carrier).toBe('BRING')
    expect(after?.orderId).toBeNull()
    expect(after?.unlinkedReason).toBe('No order for nobody@example.test')
  })

  it('links a DHL Freight piece to the order its consignment number already belongs to', async () => {
    const o = await order('ID-3', 'three@example.test', '2026-09-06T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: `${TRACK}6109278751`, carrier: 'DHL', orderId: o.id, linkSource: 'DHL_FILE' },
    })
    const row = await unknownRow(`${TRACK}3`)
    const r = await applyIdentification(
      row,
      bringFacts({
        carrier: 'DHL', consignmentId: 'JKG-HI-0001643', destinationCountry: 'FI', weightKg: 154,
        recipientEmail: null, recipientName: null, references: [`${TRACK}6109278751`],
      }),
      now,
    )
    expect(r.linked).toBe(true)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after).toMatchObject({ carrier: 'DHL', orderId: o.id, linkSource: 'DHL_REF', unlinkedReason: null })
  })

  it('says plainly why a DHL parcel with no reference cannot be matched by itself', async () => {
    const row = await unknownRow(`${TRACK}4`)
    const r = await applyIdentification(
      row,
      bringFacts({ carrier: 'DHL', consignmentId: '00473', destinationCountry: 'DE', weightKg: 18.2, recipientEmail: null, recipientName: null }),
      now,
    )
    expect(r.linked).toBe(false)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.carrier).toBe('DHL')
    expect(after?.unlinkedReason).toBe('DHL parcel to DE: DHL gives no name or email, so no order could be matched by itself')
  })

  it('never touches the link of a row that already has an order', async () => {
    const o = await order('ID-5', 'five@example.test', '2026-09-06T10:00:00Z')
    const row = await db.shipment.create({
      data: { trackingNumber: `${TRACK}5`, carrier: 'UNKNOWN', orderId: o.id, linkSource: 'MANUAL', nextPollAt: now },
    })
    await applyIdentification({ ...row, orderId: o.id }, bringFacts({ recipientEmail: 'nobody@example.test' }), now)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.orderId).toBe(o.id)
    expect(after?.linkSource).toBe('MANUAL')
    expect(after?.carrier).toBe('BRING')
  })
})

describe('applyUnknown', () => {
  it('asks again tomorrow', async () => {
    const row = await unknownRow(`${TRACK}7`)
    await applyUnknown(row, now)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.terminal).toBe(false)
    expect(after?.nextPollAt).toEqual(new Date(now.getTime() + DAY))
    expect(after?.lastError).toBe('Neither Bring nor DHL knows this number')
  })

  it('gives up after 14 days but leaves the row listed with its reason', async () => {
    const row = await unknownRow(`${TRACK}8`, new Date(now.getTime() - 15 * DAY))
    await applyUnknown(row, now)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.terminal).toBe(true)
    expect(after?.unlinkedReason).toBe('No carrier knew this number in 14 days')
    expect(after?.dismissedAt).toBeNull()
  })
})

describe('rematchByEmail', () => {
  it('links a refused Bring row once the rules resolve it', async () => {
    const o = await order('ID-9', 'late@example.test', '2026-09-06T10:00:00Z')
    const row = await db.shipment.create({
      data: {
        trackingNumber: `${TRACK}9`, carrier: 'BRING', recipientEmail: 'late@example.test',
        consignmentId: 'CONS-9', bookedAt: new Date('2026-09-07T08:00:00Z'),
        unlinkedReason: 'late@example.test matched 2 orders in the last 30 days: ID-8, ID-9', nextPollAt: now,
      },
    })
    const r = await rematchByEmail(row, now)
    expect(r.linked).toBe(true)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after).toMatchObject({ orderId: o.id, linkSource: 'BRING_EMAIL', unlinkedReason: null })
  })

  it('updates the reason when still refused', async () => {
    const row = await db.shipment.create({
      data: { trackingNumber: `${TRACK}10`, carrier: 'BRING', recipientEmail: 'gone@example.test', nextPollAt: now, unlinkedReason: 'old words' },
    })
    const r = await rematchByEmail(row, now)
    expect(r.linked).toBe(false)
    expect((await db.shipment.findUnique({ where: { id: row.id } }))?.unlinkedReason).toBe('No order for gone@example.test')
  })
})
