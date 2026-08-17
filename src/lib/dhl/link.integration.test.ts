import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { shopNameForSite, linkDhlShipments } from './link'
import type { DhlShipment } from './parse'

// Unique to THIS file — shops and orders are shared with every other test.
const TAG = '[dhl-link-test]'
const PREFIX = '95DHL'
const scoped = { shop: { name: { contains: TAG } } }

const NOW = new Date('2026-08-15T10:00:00Z')

let germanyId: string
let swedenId: string
let untrackedId: string

const parcel = (over: Partial<DhlShipment> = {}): DhlShipment => ({
  trackingNumber: `${PREFIX}00001`,
  site: 'panetti.de',
  orderNumber: '15537',
  status: 'ORDERSENT',
  createdAt: new Date('2026-08-11T09:00:00Z'),
  pickupAt: new Date('2026-08-12T00:00:00Z'),
  ...over,
})

const order = (shopId: string, number: string) =>
  db.order.create({
    data: {
      shopId, externalId: number, number,
      placedAt: new Date('2026-08-10T09:00:00Z'),
      status: 'completed', currency: 'EUR',
      grossSales: 1000, discountTotal: 0, netSales: 1000,
      shippingCharged: 0, taxTotal: 0, total: 1000,
      customerEmail: `${number}@example.test`,
    },
  })

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: PREFIX } } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: PREFIX } } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeAll(async () => {
  await cleanup()
  const tracked = { currency: 'EUR', deliveryTrackingFrom: new Date('2026-01-01') }
  germanyId = (await db.shop.create({ data: { name: `Panetti Germany ${TAG}`, ...tracked } })).id
  swedenId = (await db.shop.create({ data: { name: `Panetti Sweden ${TAG}`, ...tracked } })).id
  untrackedId = (await db.shop.create({
    data: { name: `Mazzetti Denmark ${TAG}`, currency: 'DKK', deliveryTrackingFrom: null },
  })).id

  await order(germanyId, '15537')
  await order(swedenId, '13358')
  await order(untrackedId, '99001')
  // Same NUMBER in a different shop. Order numbers are not globally unique, so
  // resolving the shop from the site is what stops a German parcel attaching to
  // a Swedish order that happens to share its number.
  await order(swedenId, '15537')
})

afterAll(cleanup)

describe('shopNameForSite', () => {
  it.each([
    ['panetti.de', 'Panetti Germany'],
    ['panetti.se', 'Panetti Sweden'],
    ['mazzetti.dk', 'Mazzetti Denmark'],
    ['mazzetti.fi', 'Mazzetti Finland'],
    ['panetti.no', 'Panetti Norway'],
  ])('turns %s into %s', (site, expected) => {
    expect(shopNameForSite(site)).toBe(expected)
  })

  it('refuses a country code it does not know, rather than guessing a shop', () => {
    expect(shopNameForSite('panetti.xx')).toBeNull()
  })
})

describe('linkDhlShipments', () => {
  it('links a parcel to the order named in its reference', async () => {
    const r = await linkDhlShipments([parcel()], NOW)
    expect(r.linked).toBe(1)

    const row = await db.shipment.findUniqueOrThrow({
      where: { trackingNumber: `${PREFIX}00001` },
      include: { order: { select: { number: true, shopId: true } } },
    })
    expect(row.carrier).toBe('DHL')
    expect(row.linkSource).toBe('DHL_FILE')
    // The file gives a parcel its FIRST due date; without one the poller never
    // sees it, which is the state DHL parcels sat in while nothing could track
    // them. It selects on `nextPollAt: { lte: now }`, so a date already reached
    // is what puts the parcel in the next run.
    expect(row.nextPollAt).not.toBeNull()
    expect(row.nextPollAt!.getTime()).toBeLessThanOrEqual(NOW.getTime())
    expect(row.order?.number).toBe('15537')
    // The German order, not the Swedish one that shares the number.
    expect(row.order?.shopId).toBe(germanyId)
    expect(row.bookedAt).toEqual(new Date('2026-08-11T09:00:00Z'))
    expect(row.handedInAt).toEqual(new Date('2026-08-12T00:00:00Z'))
  })

  it('records a parcel already delivered without inventing a delivery date', async () => {
    // We know THAT it arrived, not WHEN. A guessed date would go straight into
    // the delivery-time median and stay wrong forever.
    const r = await linkDhlShipments(
      [parcel({ trackingNumber: `${PREFIX}00002`, status: 'DELIVERED' })],
      NOW,
    )
    expect(r.linked).toBe(1)
    const row = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: `${PREFIX}00002` } })
    expect(row.availableAt).toBeNull()
    expect(row.outcome).toBe('DELIVERED')
    expect(row.terminal).toBe(true)
  })

  it('stamps the delivery moment when a parcel we already hold turns delivered', async () => {
    const t = `${PREFIX}00003`
    await linkDhlShipments([parcel({ trackingNumber: t, status: 'INTRANSIT' })], NOW)
    expect((await db.shipment.findUniqueOrThrow({ where: { trackingNumber: t } })).availableAt).toBeNull()

    const later = new Date('2026-08-16T10:00:00Z')
    await linkDhlShipments([parcel({ trackingNumber: t, status: 'DELIVERED' })], later)

    const row = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: t } })
    expect(row.availableAt).toEqual(later)
    expect(row.outcome).toBe('DELIVERED')
  })

  it('never moves a delivery date once it has one', async () => {
    const t = `${PREFIX}00004`
    await linkDhlShipments([parcel({ trackingNumber: t, status: 'INTRANSIT' })], NOW)
    const first = new Date('2026-08-16T10:00:00Z')
    await linkDhlShipments([parcel({ trackingNumber: t, status: 'DELIVERED' })], first)
    await linkDhlShipments([parcel({ trackingNumber: t, status: 'DELIVERED' })], new Date('2026-08-20T10:00:00Z'))

    const row = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: t } })
    expect(row.availableAt).toEqual(first)
  })

  it('refuses a shop that is not delivery-tracked, and says which', async () => {
    const r = await linkDhlShipments(
      [parcel({ trackingNumber: `${PREFIX}00005`, site: 'mazzetti.dk', orderNumber: '99001' })],
      NOW,
    )
    expect(r.linked).toBe(0)
    expect(r.unmatched[0].reason).toMatch(/not.*tracked|no order/i)
    expect(await db.shipment.findUnique({ where: { trackingNumber: `${PREFIX}00005` } })).toBeNull()
  })

  it('refuses an order number that does not exist, naming it', async () => {
    const r = await linkDhlShipments(
      [parcel({ trackingNumber: `${PREFIX}00006`, orderNumber: '90909' })],
      NOW,
    )
    expect(r.linked).toBe(0)
    expect(r.unmatched[0].reason).toMatch(/90909/)
  })

  it('refuses a site whose country code we do not know', async () => {
    const r = await linkDhlShipments(
      [parcel({ trackingNumber: `${PREFIX}00007`, site: 'panetti.xx' })],
      NOW,
    )
    expect(r.linked).toBe(0)
    expect(r.unmatched[0].reason).toMatch(/panetti\.xx/i)
  })

  it('is safe to run twice — the second import adopts rather than rebuilds', async () => {
    const t = `${PREFIX}00008`
    await linkDhlShipments([parcel({ trackingNumber: t })], NOW)
    const before = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: t } })
    await linkDhlShipments([parcel({ trackingNumber: t })], NOW)
    const after = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: t } })
    expect(after.createdAt).toEqual(before.createdAt)
    expect(await db.shipment.count({ where: { trackingNumber: t } })).toBe(1)
  })
})
