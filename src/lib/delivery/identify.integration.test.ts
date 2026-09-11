import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'
import { applyIdentification, applyUnknown, identifyBringStrays, type CarrierFacts } from './identify'
import { milestonesFrom } from './milestones'
import { nameKey } from './name-key'

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

const named = (number: string, name: string, placedAt: string, country = 'DE') =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status: 'completed', currency: 'EUR',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: name, customerNameKey: nameKey(name), customerEmail: `${number.toLowerCase()}@example.test`, shippingCountry: country,
    },
  })

const unknownRow = (trackingNumber: string, createdAt = now, recipientName: string | null = null) =>
  db.shipment.create({ data: { trackingNumber, carrier: 'UNKNOWN', nextPollAt: now, createdAt, recipientName } })

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

  it('refuses to link, rather than guess, when its references belong to two different orders', async () => {
    const o1 = await order('ID-3A', 'threeA@example.test', '2026-09-06T10:00:00Z')
    const o2 = await order('ID-3B', 'threeB@example.test', '2026-09-06T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: `${TRACK}6109278751`, carrier: 'DHL', orderId: o1.id, linkSource: 'DHL_FILE' },
    })
    await db.shipment.create({
      data: { trackingNumber: `${TRACK}6109278752`, carrier: 'DHL', orderId: o2.id, linkSource: 'DHL_FILE' },
    })
    const row = await unknownRow(`${TRACK}3B`)
    const r = await applyIdentification(
      row,
      bringFacts({
        carrier: 'DHL', consignmentId: 'JKG-HI-0001999', destinationCountry: 'FI', weightKg: 154,
        recipientEmail: null, recipientName: null,
        references: [`${TRACK}6109278751`, `${TRACK}6109278752`],
      }),
      now,
    )
    expect(r.linked).toBe(false)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.carrier).toBe('DHL')
    expect(after?.orderId).toBeNull()
    expect(after?.unlinkedReason).toBe(
      'DHL parcel to FI: its consignment numbers belong to 2 different orders, so a person must choose',
    )
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
    expect(after?.unlinkedReason).toBe(
      'DHL parcel to DE: DHL gives no name or email, and no warehouse file has named this parcel yet. Upload the file for its day and it will match itself.',
    )
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

  it('links a DHL parcel by the name the warehouse file gave, and keeps that name', async () => {
    const o = await named('ID-N1', 'Martin R\u00f6thke', '2026-09-06T10:00:00Z')
    const row = await unknownRow(`${TRACK}7`, now, 'ROTHKE MARTIN')
    const facts: CarrierFacts = {
      carrier: 'DHL', consignmentId: 'JKG-1', destinationCountry: 'DE', weightKg: 16.4,
      recipientEmail: null, recipientName: null, references: [],
      package: { trackingNumber: `${TRACK}7`, events, milestones: milestonesFrom(events) },
    }
    await expect(applyIdentification(row, facts, now)).resolves.toEqual({ linked: true })
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.orderId).toBe(o.id)
    expect(after?.linkSource).toBe('FILE_NAME')
    expect(after?.recipientName).toBe('ROTHKE MARTIN')
    expect(after?.carrier).toBe('DHL')
  })

  it('a DHL parcel with no name says what would make it match', async () => {
    const row = await unknownRow(`${TRACK}8`)
    const facts: CarrierFacts = {
      carrier: 'DHL', consignmentId: 'JKG-2', destinationCountry: 'FI', weightKg: 154,
      recipientEmail: null, recipientName: null, references: [], package: null,
    }
    await expect(applyIdentification(row, facts, now)).resolves.toEqual({ linked: false })
    expect((await db.shipment.findUnique({ where: { id: row.id } }))?.unlinkedReason).toBe(
      'DHL parcel to FI: DHL gives no name or email, and no warehouse file has named this parcel yet. Upload the file for its day and it will match itself.',
    )
  })

  it('a DHL parcel whose references point at two orders still needs a person, name or not', async () => {
    const a = await named('ID-R1', 'Lotta Sillanp\u00e4\u00e4', '2026-09-06T10:00:00Z')
    const b = await named('ID-R2', 'Jouni Myllykangas', '2026-09-06T10:00:00Z')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}R1`, carrier: 'DHL', orderId: a.id } })
    await db.shipment.create({ data: { trackingNumber: `${TRACK}R2`, carrier: 'DHL', orderId: b.id } })
    const row = await unknownRow(`${TRACK}9`, now, 'Lotta Sillanp\u00e4\u00e4')
    const facts: CarrierFacts = {
      carrier: 'DHL', consignmentId: 'JKG-3', destinationCountry: 'FI', weightKg: 154,
      recipientEmail: null, recipientName: null, references: [`${TRACK}R1`, `${TRACK}R2`], package: null,
    }
    await expect(applyIdentification(row, facts, now)).resolves.toEqual({ linked: false })
    expect((await db.shipment.findUnique({ where: { id: row.id } }))?.unlinkedReason).toMatch(/2 different orders, so a person must choose/)
  })

  it('a Bring parcel whose email matches nothing falls through to the name', async () => {
    const o = await named('ID-B1', 'Anitta Airi', '2026-09-06T10:00:00Z', 'FI')
    const row = await unknownRow(`${TRACK}10`, now, 'Airi Anitta')
    await expect(applyIdentification(row, bringFacts({ recipientEmail: 'unknown@example.test', recipientName: null, destinationCountry: 'FI' }), now)).resolves.toEqual({ linked: true })
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.orderId).toBe(o.id)
    expect(after?.linkSource).toBe('FILE_NAME')
  })

  it('a Bring parcel with neither email nor name says so', async () => {
    const row = await unknownRow(`${TRACK}11`)
    await expect(applyIdentification(row, bringFacts({ recipientEmail: null, recipientName: null }), now)).resolves.toEqual({ linked: false })
    expect((await db.shipment.findUnique({ where: { id: row.id } }))?.unlinkedReason).toBe(
      'Bring holds no email for this parcel and no warehouse file has named it',
    )
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

describe('identifyBringStrays', () => {
  // The wall clock, not the suite's fixed `now`: the stage only looks at rows
  // older than a day, measured from the clock it is handed, and these rows
  // are created with real timestamps.
  const real = new Date()
  const daysAgo = (n: number) => new Date(real.getTime() - n * DAY)
  const creds = { uid: 'ops@example.test', key: 'k', clientUrl: 'https://example.test' }
  const stray = (trackingNumber: string, over: Record<string, unknown> = {}) =>
    db.shipment.create({
      data: { trackingNumber, carrier: 'BRING', createdAt: daysAgo(12), terminal: true, lastStatus: 'DELIVERED', ...over },
    })
  const bringAnswer = (n: string, email: string) =>
    JSON.stringify({
      consignmentSet: [{
        consignmentId: `C-${n}`, recipientName: 'Stray Person',
        packageSet: [{
          packageNumber: n, recipientEmailAddress: email, recipientAddress: { countryCode: 'NO' },
          eventSet: [{ status: 'DELIVERED', dateIso: daysAgo(10).toISOString() }],
        }],
      }],
    })
  const notFound = JSON.stringify({ consignmentSet: [{ error: { code: 404, message: 'No shipments found' } }] })

  afterEach(() => vi.unstubAllGlobals())

  it('asks Bring about an old Bring row nobody ever identified, stores the answer, and links it by email', async () => {
    const o = await order('S1', 'stray@example.test', daysAgo(14).toISOString())
    await stray(`${TRACK}S1`)
    const fetchMock = vi.fn(async (url: string) =>
      new Response(String(url).includes(`${TRACK}S1`) ? bringAnswer(`${TRACK}S1`, 'stray@example.test') : notFound, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await identifyBringStrays(creds, real)

    expect(r.identified).toBe(1)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${TRACK}S1` } })
    expect(row?.carrier).toBe('BRING')
    expect(row?.recipientEmail).toBe('stray@example.test')
    expect(row?.recipientName).toBe('Stray Person')
    expect(row?.identifiedAt).toEqual(real)
    expect(row?.orderId).toBe(o.id)
    expect(row?.linkSource).toBe('BRING_EMAIL')
  })

  it('leaves a row Bring does not know as it is, and never asks about a dismissed, linked or fresh row', async () => {
    const o = await order('S2', 'linked@example.test', daysAgo(14).toISOString())
    await stray(`${TRACK}S2`)
    await stray(`${TRACK}S3`, { dismissedAt: real })
    await stray(`${TRACK}S4`, { orderId: o.id })
    await stray(`${TRACK}S5`, { createdAt: real })
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(notFound, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await identifyBringStrays(creds, real)

    expect(r.identified).toBe(0)
    const asked = fetchMock.mock.calls.map(([u]) => String(u))
    expect(asked.some((u) => u.includes(`${TRACK}S2`))).toBe(true)
    for (const n of ['S3', 'S4', 'S5']) expect(asked.some((u) => u.includes(`${TRACK}${n}`))).toBe(false)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${TRACK}S2` } })
    expect(row?.carrier).toBe('BRING')
    expect(row?.identifiedAt).toBeNull()
    expect(row?.orderId).toBeNull()
  })

  it('stops at the deadline', async () => {
    await stray(`${TRACK}S6`)
    const fetchMock = vi.fn(async () => new Response(notFound, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await identifyBringStrays(creds, real, { deadline: Date.now() - 1 })

    expect(r).toEqual({ tried: 0, identified: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
