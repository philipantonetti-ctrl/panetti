import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { importTrackingFile } from './import'

let shopId: string

// Unique to THIS file — see "Test data convention" in the Global Constraints.
const TAG = '[delivery-import-test]'
const scoped = { shop: { name: { contains: TAG } } }

async function cleanup() {
  // Every parcel this suite creates is linked to one of its own tagged orders
  // (they come from the file being imported), so the order scope reaches them
  // all and no tracking-number prefix is needed here.
  await db.shipmentEvent.deleteMany({ where: { shipment: { order: scoped } } })
  await db.shipment.deleteMany({ where: { order: scoped } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  // TrackingImport has no shop to tag and no natural key. Scope by the
  // filenames this suite uses so a parallel file's imports survive.
  await db.trackingImport.deleteMany({ where: { filename: { in: ['today.csv', 'notes.docx'] } } })
}

afterAll(cleanup)

// DEVIATION FROM BRIEF: the brief's fixtures number this order '1001' — the
// same literal number link.integration.test.ts uses for most of its own
// tests. knownOrderNumbers()/linkRows() match by number ACROSS ALL SHOPS
// (deliberately — that's how a cross-shop-ambiguous number gets caught), and
// vitest runs test FILES in parallel against the one shared database. So
// whenever both files' fixtures are alive at once, this suite's order and
// link's shopA order are two same-numbered orders in two different
// delivery-tracked shops — indistinguishable, to linkRows, from a genuine
// ambiguous number — and linkRows refuses to link either one. That produced
// real, reproducible failures on both sides under `npm run test` (this
// suite's "links what it can" got linked:0; link's "adopts a parcel" got
// orderId:null). A number unique to this file, like the tag already is for
// shop names and the TRACK prefix already is for tracking numbers in
// link.integration.test.ts, removes the collision entirely.
const ORDER1 = 'IMPT1001'
const ORDER2 = 'IMPT9999'

beforeEach(async () => {
  await cleanup()
  shopId = (
    await db.shop.create({
      data: { name: `A ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') },
    })
  ).id
  await db.order.create({
    data: {
      shopId, externalId: 'E1', number: ORDER1,
      placedAt: new Date('2026-08-01T10:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    },
  })
})

const csv = (body: string) => Buffer.from(body, 'utf8')

describe('importTrackingFile', () => {
  it('links what it can and records the run', async () => {
    const r = await importTrackingFile(
      csv(`order,tracking\n${ORDER1},370724403790000123\n`), 'today.csv', 'UPLOAD',
    )
    expect(r.parsed).toBe(1)
    expect(r.linked).toBe(1)

    const row = await db.trackingImport.findUniqueOrThrow({ where: { id: r.importId } })
    expect(row.filename).toBe('today.csv')
    expect(row.source).toBe('UPLOAD')
    expect(row.rowsLinked).toBe(1)
    expect(row.rowsUnmatched).toBe(0)
  })

  it('records what it could not match, so a shortfall is visible rather than silent', async () => {
    // DEVIATION FROM BRIEF: the brief's version of this test paired '1001'
    // with a wholly invented order number ('9999', belonging to no order
    // anywhere) and expected it to come back as `unmatched`. It cannot:
    // parseTrackingFile (Task 5) only ever extracts a pair for an order
    // number already in `knownOrderNumbers` — a number that matches no
    // order in the database is not a "row that failed to link", it is noise
    // the extractor never turns into a row at all, so it can't reach
    // linkRows' "No order numbered" branch through this pipeline. That
    // branch is only reachable by calling linkRows directly with a
    // fabricated row, which is exactly what link.integration.test.ts does.
    //
    // The one shortfall reachable through the FULL pipeline is an order
    // number that IS known (so the parser extracts it) but ambiguous — held
    // by two shops at once — which linkRows then refuses. So: a second
    // delivery-tracked shop, both numbering an order ORDER2.
    const shopB = (
      await db.shop.create({
        data: { name: `B ${TAG}`, currency: 'SEK', deliveryTrackingFrom: new Date('2026-01-01') },
      })
    ).id
    await db.order.create({
      data: {
        shopId, externalId: 'E2A', number: ORDER2,
        placedAt: new Date('2026-08-01T10:00:00Z'), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })
    await db.order.create({
      data: {
        shopId: shopB, externalId: 'E2B', number: ORDER2,
        placedAt: new Date('2026-08-01T10:00:00Z'), status: 'completed', currency: 'SEK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })

    const r = await importTrackingFile(
      csv(`${ORDER1},370724403790000123\n${ORDER2},370724403790000124\n`), 'today.csv', 'UPLOAD',
    )
    expect(r.linked).toBe(1)
    expect(r.unmatched).toHaveLength(1)

    const row = await db.trackingImport.findUniqueOrThrow({ where: { id: r.importId } })
    expect(row.rowsUnmatched).toBe(1)
    expect(JSON.parse(row.unmatched!)[0].orderNumber).toBe(ORDER2)
  })

  it('records a file it could not read at all, instead of losing the attempt', async () => {
    await expect(importTrackingFile(csv('x'), 'notes.docx', 'UPLOAD')).rejects.toThrow()
    const row = await db.trackingImport.findFirst({ orderBy: { receivedAt: 'desc' } })
    expect(row?.error).toMatch(/Only PDF and CSV/)
    expect(row?.rowsParsed).toBe(0)
  })

  it('ignores a shop that is not delivery-tracked', async () => {
    await db.shop.update({ where: { id: shopId }, data: { deliveryTrackingFrom: null } })
    const r = await importTrackingFile(csv(`${ORDER1},370724403790000123\n`), 'today.csv', 'UPLOAD')
    expect(r.linked).toBe(0)
  })
})
