import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { nameKey } from './name-key'
import { attach, decideAttach, sweepUnlinked, SWEEP_LIMIT } from './attach'

const TAG = '[attach-test]'
const TRACK = 'TATT'
const scoped = { shop: { name: { contains: TAG } } }
const now = new Date('2026-09-11T12:00:00Z')
const HOUR = 60 * 60 * 1000
let shopId: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Shop ${TAG}`, currency: 'EUR', deliveryTrackingFrom: new Date('2026-01-01') } })).id
})

const order = (number: string, name: string, email: string, placedAt = '2026-09-08T10:00:00Z', country = 'DE') =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status: 'completed', currency: 'EUR',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: name, customerNameKey: nameKey(name), customerEmail: email, shippingCountry: country,
    },
  })

const row = (n: string, over: Record<string, unknown> = {}) =>
  db.shipment.create({
    data: { trackingNumber: `${TRACK}${n}`, carrier: 'DHL', createdAt: now, ...over },
    select: { id: true, trackingNumber: true, orderId: true, recipientEmail: true, recipientName: true, bookedAt: true, createdAt: true, consignmentId: true, destinationCountry: true, updatedAt: true },
  })

describe('decideAttach and attach', () => {
  it('prefers the email, falls back to the name, and writes the link with its source', async () => {
    const byMail = await order('A-MAIL', 'Some Body', 'mail@example.test')
    const byName = await order('A-NAME', 'Martin R\u00f6thke', 'other@example.test')
    const r1 = await row('1', { recipientEmail: 'mail@example.test', recipientName: 'Martin R\u00f6thke', destinationCountry: 'DE' })
    await expect(decideAttach(r1)).resolves.toEqual({ orderId: byMail.id, source: 'BRING_EMAIL' })
    const r2 = await row('2', { recipientName: 'ROTHKE MARTIN', destinationCountry: 'DE' })
    await expect(attach(r2)).resolves.toEqual({ linked: true, source: 'FILE_NAME' })
    const after = await db.shipment.findUnique({ where: { id: r2.id } })
    expect(after?.orderId).toBe(byName.id)
    expect(after?.linkSource).toBe('FILE_NAME')
    expect(after?.unlinkedReason).toBeNull()
  })

  it('keeps the email reason when Bring gave an email, else the name reason, and never writes a null reason over a real one', async () => {
    await order('A-2A', 'Anna Hansen', 'anna@example.test', '2026-09-01T10:00:00Z')
    await order('A-2B', 'Anna Hansen', 'anna@example.test', '2026-09-02T10:00:00Z')
    const both = await row('3', { recipientEmail: 'anna@example.test', recipientName: 'Anna Hansen', destinationCountry: 'DE' })
    const d = await decideAttach(both)
    expect(d.orderId).toBeNull()
    expect((d as { reason: string }).reason).toMatch(/^anna@example.test matched 2 orders/)
    const nameOnly = await row('4', { recipientName: 'Anna Hansen', destinationCountry: 'DE' })
    const r = await attach(nameOnly)
    expect(r.linked).toBe(false)
    expect((r as { reason: string | null }).reason).toMatch(/^The label says Anna Hansen and 2 orders/)
    const kept = await row('5', { unlinkedReason: 'kept' })
    await expect(attach(kept)).resolves.toEqual({ linked: false, source: null, reason: null })
    expect((await db.shipment.findUnique({ where: { id: kept.id } }))?.unlinkedReason).toBe('kept')
  })

  it('never moves a row that already has an order', async () => {
    const a = await order('A-3A', 'Ola Nordmann', 'ola@example.test')
    const b = await order('A-3B', 'Someone Else', 'else@example.test')
    const linked = await row('6', { orderId: b.id, linkSource: 'MANUAL', recipientName: 'Ola Nordmann' })
    await expect(attach(linked)).resolves.toEqual({ linked: false, source: null, reason: null })
    expect((await db.shipment.findUnique({ where: { id: linked.id } }))?.orderId).toBe(b.id)
    expect(a.id).not.toBe(b.id)
  })

  it('uses the booking time, else the row creation time, as the upper bound', async () => {
    const late = await order('A-4', 'Kari Nordmann', 'kari@example.test', '2026-09-10T10:00:00Z')
    const r = await row('7', { recipientName: 'Kari Nordmann', createdAt: new Date('2026-09-09T18:00:00Z') })
    const d = await decideAttach(r)
    expect(d.orderId).toBeNull()
    expect(late.placedAt.getTime()).toBeGreaterThan(r.createdAt.getTime())
  })
})

describe('sweepUnlinked', () => {
  it('retries only unlinked, undismissed rows older than an hour that carry an email or a name, at most SWEEP_LIMIT', async () => {
    const o = await order('S-1', 'Petri Niskanen', 'petri@example.test')
    const old = new Date(now.getTime() - 2 * HOUR)
    await row('S1', { recipientName: 'Petri Niskanen', updatedAt: old })
    await row('S2', { recipientName: 'Nobody Known', updatedAt: old })
    await row('S3', { recipientName: 'Petri Niskanen', updatedAt: now })
    await row('S4', { updatedAt: old })
    await row('S5', { recipientName: 'Petri Niskanen', dismissedAt: now, updatedAt: old })
    const r = await sweepUnlinked(now)
    expect(r).toEqual({ tried: 2, linked: 1 })
    const rows = await db.shipment.findMany({ where: { trackingNumber: { startsWith: `${TRACK}S` } }, orderBy: { trackingNumber: 'asc' } })
    expect(rows[0].orderId).toBe(o.id)
    expect(rows[1].orderId).toBeNull()
    expect(rows[1].unlinkedReason).toMatch(/Nobody Known/)
    expect(rows[2].orderId).toBeNull()
    expect(rows[2].unlinkedReason).toBeNull()
    expect(SWEEP_LIMIT).toBe(50)
  })
})
