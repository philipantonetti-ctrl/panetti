import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

const resolveConsignments = vi.fn()
vi.mock('./consignments', () => ({
  resolveConsignments: (...a: unknown[]) => resolveConsignments(...a),
}))

const { db } = await import('@/lib/db')
const { importWarehouseFile } = await import('./import')
const { encryptSecret } = await import('@/lib/secrets')

const TAG = '[intake-import-test]'
const PREFIX = 'IMIMP'
const scoped = { shop: { name: { contains: TAG } } }
const FILES = ['eod.xlsx', 'broken.docx']

let shopId: string

async function cleanup() {
  await db.shipmentEvent.deleteMany({
    where: { shipment: { trackingNumber: { startsWith: PREFIX } } },
  })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: PREFIX } } })
  // Real-shaped Bring numbers, cleaned by exact value: the too-early-parcel
  // fix keys on the number's SHAPE (373/473 + 15 digits), so these cannot
  // carry the test prefix. x739999... is a range Bring will never issue.
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: '373999999' } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: '473999999' } } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.trackingImport.deleteMany({ where: { filename: { in: FILES } } })
}

const book = (values: string[]) =>
  Buffer.from(
    zipSync({
      'xl/worksheets/sheet1.xml': strToU8(
        values.map((v) => `<c><v>${v}</v></c>`).join(''),
      ),
    }),
  )

beforeAll(async () => {
  await cleanup()

  // importWarehouseFile refuses to run when Bring is not connected, so the
  // singleton must hold readable credentials. UPSERT, never delete-then-create:
  // it is a fixed-id row no tag can isolate - see the Global Constraints.
  const connected = {
    bringApiUid: 'test@example.test',
    bringApiKey: encryptSecret('test-key'),
    bringClientUrl: 'https://example.test/',
  }
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...connected },
    update: connected,
  })

  const shop = await db.shop.create({
    data: {
      name: `Shop ${TAG}`, currency: 'NOK',
      deliveryTrackingFrom: new Date('2026-01-01'),
    },
  })
  shopId = shop.id
  await db.order.create({
    data: {
      shopId, externalId: 'I1', number: 'I1',
      placedAt: new Date(), status: 'completed', currency: 'NOK',
      grossSales: 1000, discountTotal: 0, netSales: 1000,
      shippingCharged: 0, taxTotal: 0, total: 1000,
      customerEmail: 'buyer@example.test',
    },
  })
})

// A block body on purpose: mockReset() returns the mock itself, and an arrow
// function that RETURNS a function has that function run by Vitest as this
// test's own cleanup, after the test - so an expression body here would call
// resolveConsignments() a second time post-test, unhandled, against whatever
// rejection or resolution the test just configured.
beforeEach(() => {
  resolveConsignments.mockReset()
})

afterAll(async () => {
  await cleanup()
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  })
})

describe('importWarehouseFile', () => {
  it('writes one shipment per package and links them all to the one order', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C1`,
          packageNumbers: [`${PREFIX}0001`, `${PREFIX}0002`],
          recipientEmail: 'buyer@example.test',
          recipientName: 'Buyer',
        },
      ],
      unresolved: [],
    })
    const result = await importWarehouseFile(
      book(['373325386490923366']), 'eod.xlsx', 'EMAIL',
    )
    // linked counts CONSIGNMENTS, not packages: one matched consignment with
    // two packages counts once, even though it writes two Shipment rows below.
    expect(result.linked).toBe(1)
    expect(result.parsed).toBe(1) // 1 consignment + 0 unresolved
    expect(result.unaccounted).toBe(0)
    expect(result.parsed).toBe(result.linked + result.unaccounted)

    const rows = await db.shipment.findMany({
      where: { trackingNumber: { startsWith: PREFIX } },
      orderBy: { trackingNumber: 'asc' },
    })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.orderId !== null)).toBe(true)
    expect(rows[0].linkSource).toBe('BRING_EMAIL')
    expect(rows[0].nextPollAt).not.toBeNull()
  })

  it('records the run, with the source, so a silent morning is visible', async () => {
    const row = await db.trackingImport.findFirst({
      where: { filename: 'eod.xlsx' },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row?.source).toBe('EMAIL')
    // One consignment linked, not two packages - see the `linked` assertion above.
    expect(row?.rowsLinked).toBe(1)
  })

  it('is safe to run twice - the second import adopts, never rebuilds', async () => {
    const before = await db.shipment.findFirst({
      where: { trackingNumber: `${PREFIX}0001` },
    })
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C1`,
          packageNumbers: [`${PREFIX}0001`, `${PREFIX}0002`],
          recipientEmail: 'buyer@example.test',
          recipientName: 'Buyer',
        },
      ],
      unresolved: [],
    })
    await importWarehouseFile(book(['373325386490923366']), 'eod.xlsx', 'EMAIL')
    const after = await db.shipment.findMany({
      where: { trackingNumber: { startsWith: PREFIX } },
    })
    expect(after).toHaveLength(2)
    expect(after.find((r) => r.trackingNumber === `${PREFIX}0001`)?.createdAt).toEqual(
      before?.createdAt,
    )
  })

  it('states why a parcel did not link instead of dropping it silently', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C9`,
          packageNumbers: [`${PREFIX}9999`],
          recipientEmail: 'stranger@example.test',
          recipientName: 'Stranger',
        },
      ],
      unresolved: [{ number: '888888888888888', reason: 'Bring has no parcel with this number' }],
    })
    const result = await importWarehouseFile(
      book(['373325386490923366']), 'eod.xlsx', 'EMAIL',
    )
    expect(result.linked).toBe(0)
    expect(result.unmatched.some((u) => /stranger@example.test/.test(u.reason))).toBe(true)
    expect(result.unaccounted).toBeGreaterThan(0)
    expect(result.parsed).toBe(result.linked + result.unaccounted)
  })

  /**
   * The 2026-08-18 warehouse file, reported by the client: 51 parsed, 46
   * linked, 5 unmatched - and only TWO of the five said anything about
   * themselves. The other three were numbers Bring did not resolve, and this
   * function counted them into `rowsUnmatched` while writing only the refusals
   * into `unmatched`. So three parcels went missing with the count as the sole
   * evidence they ever existed, and nobody could find out which numbers they
   * were, because the numbers were never stored anywhere.
   *
   * Every entry behind the count now names itself. The number is the whole
   * point: without it there is nothing to take back to the warehouse.
   */
  it('stores the unresolved numbers themselves, not just a count of them', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [
        { number: '888888888888888', reason: 'Bring has no parcel with this number' },
        { number: '777777777777777', reason: 'Ran out of time before Bring could be asked' },
      ],
    })
    const result = await importWarehouseFile(
      book(['373325386490923366']), 'eod.xlsx', 'EMAIL',
    )

    expect(result.unaccounted).toBe(2)
    // Every unaccounted entry is described, so the two totals can never drift
    // apart again the way they did on the 18th.
    expect(result.unmatched).toHaveLength(result.unaccounted)

    const row = await db.trackingImport.findFirst({
      where: { filename: 'eod.xlsx' },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row?.rowsUnmatched).toBe(2)
    const stored = JSON.parse(row?.unmatched ?? '[]') as { trackingNumber: string; reason: string }[]
    expect(stored.map((s) => s.trackingNumber).sort()).toEqual([
      '777777777777777',
      '888888888888888',
    ])
    expect(stored.find((s) => s.trackingNumber === '888888888888888')?.reason).toMatch(
      /no parcel with this number/i,
    )
    expect(stored.find((s) => s.trackingNumber === '777777777777777')?.reason).toMatch(
      /ran out of time/i,
    )
  })

  it('records a file it cannot read at all, then throws for the uploader', async () => {
    await expect(
      importWarehouseFile(Buffer.from('x'), 'broken.docx', 'UPLOAD'),
    ).rejects.toThrow(/\.docx/)
    const row = await db.trackingImport.findFirst({ where: { filename: 'broken.docx' } })
    expect(row?.error).toMatch(/\.docx/)
  })

  // A file can be taken this far - parsed, past the Bring-connected check -
  // and still fail: Bring timing out, a dropped database connection. Nothing
  // after the parse step was guarded before this test, so the throw escaped
  // unrecorded: no TrackingImport row, and because the route answers 200
  // regardless of what importWarehouseFile does, Postmark never redelivers
  // either. A silent morning is exactly what this feature exists to prevent.
  it('records the run before rethrowing, even when the failure happens after parsing', async () => {
    resolveConsignments.mockRejectedValue(new Error('Bring timed out'))
    await expect(
      importWarehouseFile(book(['373325386490923366']), 'eod.xlsx', 'EMAIL'),
    ).rejects.toThrow(/Bring timed out/)

    const row = await db.trackingImport.findFirst({
      where: { filename: 'eod.xlsx', error: { contains: 'Bring timed out' } },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row).not.toBeNull()
    expect(row?.source).toBe('EMAIL')
  })

  it('stores a refused consignment as unlinked rows that say why', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C-REF`,
          packageNumbers: [`${PREFIX}0301`, `${PREFIX}0302`],
          recipientEmail: 'nobody@example.test',
          recipientName: 'No Body',
          destinationCountry: 'NO',
          weightKg: 16.5,
          bookedAt: new Date('2026-08-11T08:19:24Z'),
        },
      ],
      unresolved: [],
    })
    const r = await importWarehouseFile(book([`${PREFIX}0301`]), 'eod.xlsx', 'EMAIL')
    expect(r.linked).toBe(0)
    expect(r.unmatched).toHaveLength(1)

    const rows = await db.shipment.findMany({
      where: { trackingNumber: { in: [`${PREFIX}0301`, `${PREFIX}0302`] } },
      orderBy: { trackingNumber: 'asc' },
    })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.orderId).toBeNull()
      expect(row.carrier).toBe('BRING')
      expect(row.recipientEmail).toBe('nobody@example.test')
      expect(row.recipientName).toBe('No Body')
      expect(row.destinationCountry).toBe('NO')
      expect(row.weightKg).toBe(16.5)
      expect(row.consignmentId).toBe(`${PREFIX}C-REF`)
      expect(row.unlinkedReason).toBe('No order for nobody@example.test')
      expect(row.identifiedAt).not.toBeNull()
      expect(row.nextPollAt).not.toBeNull()
    }
  })

  it('writes the carrier facts on a linked row too', async () => {
    // Its own order, on its own email - not the shared buyer@example.test
    // fixture: by this point in the file that order already holds a parcel
    // from consignment IMIMPC1 (the first test above), and matchByEmail
    // correctly refuses to add a SECOND consignment to an order that already
    // holds one from another. That rule is real and is not what this test is
    // about, so it gets a customer of its own instead of tripping it.
    const order = await db.order.create({
      data: {
        shopId, externalId: 'I-LINKED-FACTS', number: `${PREFIX}9002`,
        placedAt: new Date(), status: 'completed', currency: 'NOK',
        grossSales: 500, discountTotal: 0, netSales: 500,
        shippingCharged: 0, taxTotal: 0, total: 500,
        customerEmail: 'linked-facts@example.test',
      },
    })
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C-OK`,
          packageNumbers: [`${PREFIX}0401`],
          recipientEmail: 'linked-facts@example.test',
          recipientName: 'Buyer',
          destinationCountry: 'NO',
          weightKg: 2,
          // Now, not a fixed past date: bookedAt is matchByEmail's upper
          // bound on placedAt, and the order above is placed now too.
          bookedAt: new Date(),
        },
      ],
      unresolved: [],
    })
    await importWarehouseFile(book([`${PREFIX}0401`]), 'eod.xlsx', 'EMAIL')
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${PREFIX}0401` } })
    expect(row?.orderId).toBe(order.id)
    expect(row?.consignmentId).toBe(`${PREFIX}C-OK`)
    expect(row?.destinationCountry).toBe('NO')
    expect(row?.unlinkedReason).toBeNull()
  })

  it('stores a number Bring does not know as carrier UNKNOWN, for the poller to identify', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [{ number: '473999999000000001', reason: 'Bring has no parcel with this number' }],
    })
    const r = await importWarehouseFile(book(['473999999000000001']), 'eod.xlsx', 'EMAIL')
    expect(r.unmatched[0].reason).toMatch(/not heard of this parcel yet/)
    const row = await db.shipment.findUnique({ where: { trackingNumber: '473999999000000001' } })
    expect(row?.carrier).toBe('UNKNOWN')
    expect(row?.orderId).toBeNull()
    expect(row?.identifiedAt).toBeNull()
    expect(row?.nextPollAt).not.toBeNull()
  })

  it('no longer retries stored numbers itself - that is the poller\'s job now', async () => {
    await db.shipment.create({
      data: { trackingNumber: '473999999000000002', carrier: 'UNKNOWN', nextPollAt: new Date() },
    })
    resolveConsignments.mockResolvedValue({ consignments: [], unresolved: [] })
    // A real-shaped number: the reader keeps only runs of 15 or more digits.
    await importWarehouseFile(book(['473999999000000003']), 'eod.xlsx', 'EMAIL')
    // One call, for the file's own numbers. A second call would be the old retry stage.
    expect(resolveConsignments).toHaveBeenCalledTimes(1)
    expect(resolveConsignments.mock.calls[0][1]).toEqual(['473999999000000003'])
  })
})

/**
 * Parcels the warehouse file names BEFORE Bring's own system has heard of
 * them. Measured in production on 2026-08-21: six real 373-numbers across the
 * 19th and 20th's files were refused as "Bring has no parcel with this
 * number", and every one of them was KNOWN to Bring by the next day - the
 * midnight import races Bring's data feed and was treating a lost race as a
 * verdict. Refused meant never stored and never retried, so those parcels'
 * orders would have sat "no tracking" until someone alerted on them.
 */
describe('a parcel Bring does not know yet', () => {
  // Each test owns the mock and the shaped rows outright: an earlier test's
  // persistent rejection would otherwise bleed in, and a parcel stored by one
  // test would trigger the retry stage in the next and eat its one-shot mock.
  beforeEach(async () => {
    resolveConsignments.mockReset()
    await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: '373999999' } } })
    await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: '473999999' } } })
  })

  const EARLY = '373999999000000001'
  const EARLY2 = '373999999000000002'
  const EARLY3 = '473999999000000003' // the warehouse's newer 473 series
  const FOREIGN = '28144019968359654386' // 20 digits: another carrier's number

  it('is stored anyway when its number is Bring-shaped, so it can be retried', async () => {
    resolveConsignments.mockResolvedValueOnce({
      consignments: [],
      unresolved: [{ number: EARLY, reason: 'Bring has no parcel with this number' }],
    })

    const result = await importWarehouseFile(book([EARLY]), 'eod.xlsx', 'EMAIL')

    const parcel = await db.shipment.findUnique({ where: { trackingNumber: EARLY } })
    expect(parcel).not.toBeNull()
    expect(parcel?.orderId).toBeNull()
    expect(parcel?.nextPollAt).not.toBeNull()
    // The yellow line stops reading as a fault and says what will happen.
    expect(result.unmatched[0]?.reason).toMatch(/not.*heard of|does not know/i)
    expect(result.unmatched[0]?.reason).toMatch(/stored/i)
  })

  /**
   * The 2026-08-28 file, reported by the client: 64 parsed, 0 linked. Bring's
   * API had a bad night - two fetch failures, a 403, a timeout - and the rest
   * of the file ran out of budget. Every one of its package numbers was
   * 473-shaped (measured in production 2026-08-31: 233 of 496 linked Bring
   * parcels start 473, the rest 373), so the shape gate stored none of them
   * and the whole day's parcels were never retried.
   */
  it('stores a 473-shaped number that failed its lookup, and says it will retry', async () => {
    resolveConsignments.mockResolvedValueOnce({
      consignments: [],
      unresolved: [{ number: EARLY3, reason: 'fetch failed' }],
    })

    const result = await importWarehouseFile(book([EARLY3]), 'eod.xlsx', 'EMAIL')

    const parcel = await db.shipment.findUnique({ where: { trackingNumber: EARLY3 } })
    expect(parcel).not.toBeNull()
    expect(parcel?.orderId).toBeNull()
    expect(parcel?.nextPollAt).not.toBeNull()
    // The real failure is kept - "Bring has not heard of this parcel" would be
    // a lie here, because Bring was never successfully asked.
    expect(result.unmatched[0]?.reason).toMatch(/fetch failed/)
    expect(result.unmatched[0]?.reason).toMatch(/stored/i)
  })

  it('does not store a number that is not Bring-shaped, because those are other carriers', async () => {
    resolveConsignments.mockResolvedValueOnce({
      consignments: [],
      unresolved: [{ number: FOREIGN, reason: 'Bring has no parcel with this number' }],
    })

    const result = await importWarehouseFile(book([FOREIGN]), 'eod.xlsx', 'EMAIL')

    expect(await db.shipment.findUnique({ where: { trackingNumber: FOREIGN } })).toBeNull()
    expect(result.unmatched[0]?.reason).toBe('Bring has no parcel with this number')
  })
})
