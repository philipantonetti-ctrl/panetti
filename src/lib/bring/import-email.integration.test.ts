import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { nameKey } from '@/lib/delivery/name-key'

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
const FILES = ['eod.xlsx', 'broken.docx', 'named.xlsx', 'nameless.xlsx']

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

// The same builder as labels.test.ts, copied here because the two files must
// stay independent.
const HEADERS = ['Datum', 'Antal', 'Order', 'Namn', 'KolliID', 'S\u00e4ndningsref', 'Levs\u00e4tt', 'Vikt']
const col = (i: number) => String.fromCharCode(65 + i)
const sheet = (rows: Partial<Record<string, string>>[], headers: string[] = HEADERS) => {
  const strings: string[] = []
  const idx = (v: string) => {
    const at = strings.indexOf(v)
    return at === -1 ? strings.push(v) - 1 : at
  }
  const cells = (values: string[], r: number) =>
    values
      .map((v, i) => (v === '' ? `<c r="${col(i)}${r}" s="1"/>` : `<c r="${col(i)}${r}" t="s"><v>${idx(v)}</v></c>`))
      .join('')
  const body = rows.map((row, n) => `<row r="${n + 2}">${cells(headers.map((h) => row[h] ?? ''), n + 2)}</row>`).join('')
  const head = `<row r="1">${cells(headers, 1)}</row>`
  return Buffer.from(
    zipSync({
      'xl/sharedStrings.xml': strToU8(`<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${head}${body}</sheetData></worksheet>`),
    }),
  )
}
const ltasRow = (kolli: string, name: string, ref = '') => ({
  Datum: '2026-09-10 08:19:24', Antal: '1', Order: '027286', Namn: name, KolliID: kolli, 'S\u00e4ndningsref': ref, 'Levs\u00e4tt': 'BOXHD_NO', Vikt: '16.4',
})

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

  it('never lets a null name from the carrier wipe a name already stored on the row', async () => {
    const order = await db.order.create({
      data: {
        shopId, externalId: 'I-KEPT', number: `${PREFIX}9004`,
        placedAt: new Date(), status: 'completed', currency: 'NOK',
        grossSales: 500, discountTotal: 0, netSales: 500,
        shippingCharged: 0, taxTotal: 0, total: 500,
        customerEmail: 'kept-name@example.test',
      },
    })
    await db.shipment.create({
      data: {
        trackingNumber: `${PREFIX}0601`,
        carrier: 'BRING',
        recipientName: 'Kept Name',
        destinationCountry: 'SE',
      },
    })
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C-KEPT`,
          packageNumbers: [`${PREFIX}0601`],
          recipientEmail: 'kept-name@example.test',
          // The carrier gave no name this time; the file (book(), no Namn
          // column at all) gives none either.
          recipientName: null,
        },
      ],
      unresolved: [],
    })
    const result = await importWarehouseFile(book([`${PREFIX}0601`]), 'eod.xlsx', 'EMAIL')
    expect(result.linked).toBe(1)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${PREFIX}0601` } })
    expect(row?.orderId).toBe(order.id)
    expect(row?.recipientName).toBe('Kept Name')
  })

  it('never re-points a row someone already linked by hand, even when the email finds a real order', async () => {
    // A customer of its own, so the pre-existing manual link is unambiguous.
    const manualOrder = await db.order.create({
      data: {
        shopId, externalId: 'I-MANUAL', number: `${PREFIX}9003`,
        placedAt: new Date(), status: 'completed', currency: 'NOK',
        grossSales: 500, discountTotal: 0, netSales: 500,
        shippingCharged: 0, taxTotal: 0, total: 500,
        customerEmail: 'manual-link@example.test',
      },
    })
    // A person, or an earlier night's import, already attached this package
    // number to manualOrder.
    await db.shipment.create({
      data: {
        trackingNumber: `${PREFIX}0501`,
        carrier: 'BRING',
        orderId: manualOrder.id,
        linkSource: 'MANUAL',
        destinationCountry: 'SE',
      },
    })

    // Same consignment id as the very first test's IMIMPC1: I1 already holds
    // a shipment from it, so I1 is a real, uncontested candidate for
    // buyer@example.test rather than excluded as "holds another
    // consignment's parcel". That makes this a genuine match - the LINKED
    // branch, not the refused one - so it is the fix, not an absent match,
    // that has to keep the row from moving.
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C1`,
          packageNumbers: [`${PREFIX}0501`],
          recipientEmail: 'buyer@example.test',
          recipientName: 'Buyer',
          destinationCountry: 'DK',
        },
      ],
      unresolved: [],
    })

    const result = await importWarehouseFile(book([`${PREFIX}0501`]), 'eod.xlsx', 'EMAIL')
    // The resolver really did match somebody, proving this exercises the
    // linked branch rather than the already-safe refused one.
    expect(result.linked).toBe(1)

    const row = await db.shipment.findUnique({ where: { trackingNumber: `${PREFIX}0501` } })
    // The link stays exactly where the person put it...
    expect(row?.orderId).toBe(manualOrder.id)
    expect(row?.linkSource).toBe('MANUAL')
    // ...but the facts a re-import legitimately learns are not thrown away.
    expect(row?.destinationCountry).toBe('DK')
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

// The tests above leave buyer@example.test's order holding a shipment from
// consignment IMIMPC1, and matchByEmail rightly refuses to add a SECOND
// consignment to an order that already holds one from another - so any test
// here that re-uses that address for a fresh consignment needs its slate
// clean first. Nothing after this point reads the earlier tests' rows.
describe('the warehouse file names a row', () => {
  beforeAll(async () => {
    await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: PREFIX } } })
  })

  it('names an already-stored UNKNOWN row from the file and links it by that name', async () => {
    const o = await db.order.create({
      data: {
        shopId, externalId: 'N1', number: 'N1', placedAt: new Date(Date.now() - 2 * 24 * 3600_000), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        customerName: 'Martin R\u00f6thke', customerNameKey: nameKey('Martin R\u00f6thke'), customerEmail: 'martin@example.test', shippingCountry: 'DE',
      },
    })
    const number = '473999999000000011'
    await db.shipment.create({ data: { trackingNumber: number, carrier: 'DHL', destinationCountry: 'DE', unlinkedReason: 'old reason' } })
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [{ number, reason: 'Bring has no parcel with this number' }],
    })
    const result = await importWarehouseFile(sheet([ltasRow(number, 'ROTHKE MARTIN')]), 'named.xlsx', 'UPLOAD')
    expect(result.namesRead).toBe(1)
    expect(result.linked).toBe(1)
    expect(result.unaccounted).toBe(0)
    expect(result.parsed).toBe(result.linked + result.unaccounted)
    const row = await db.shipment.findUnique({ where: { trackingNumber: number } })
    expect(row?.orderId).toBe(o.id)
    expect(row?.linkSource).toBe('FILE_NAME')
    expect(row?.recipientName).toBe('ROTHKE MARTIN')
    expect(row?.unlinkedReason).toBeNull()
    expect(row?.carrier).toBe('DHL')
    const record = await db.trackingImport.findFirst({ where: { filename: 'named.xlsx' }, orderBy: { receivedAt: 'desc' } })
    expect(record?.namesRead).toBe(1)
  })

  it('a resolved consignment whose email matches nothing links by the name, and Bring\u2019s own name wins over the file\u2019s', async () => {
    const o = await db.order.create({
      data: {
        shopId, externalId: 'N2', number: 'N2', placedAt: new Date(Date.now() - 2 * 24 * 3600_000), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        customerName: 'Anitta Airi', customerNameKey: nameKey('Anitta Airi'), customerEmail: 'anitta@example.test', shippingCountry: 'FI',
      },
    })
    resolveConsignments.mockResolvedValue({
      consignments: [{
        consignmentId: `${PREFIX}C9`, packageNumbers: [`${PREFIX}0009`],
        recipientEmail: 'different@example.test', recipientName: 'Anitta Airi', destinationCountry: 'FI', weightKg: 1.6, bookedAt: null,
      }],
      unresolved: [],
    })
    const result = await importWarehouseFile(sheet([ltasRow(`${PREFIX}0009`, 'Wrong Name In File')]), 'named.xlsx', 'UPLOAD')
    expect(result.linked).toBe(1)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${PREFIX}0009` } })
    expect(row?.orderId).toBe(o.id)
    expect(row?.linkSource).toBe('FILE_NAME')
    expect(row?.recipientName).toBe('Anitta Airi')
  })

  it('a file with no Namn column still links by email and records that no names were read', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [{
        consignmentId: `${PREFIX}C10`, packageNumbers: [`${PREFIX}0010`],
        recipientEmail: 'buyer@example.test', recipientName: 'Buyer', destinationCountry: 'NO', weightKg: 1, bookedAt: null,
      }],
      unresolved: [],
    })
    const result = await importWarehouseFile(
      sheet([{ Datum: '2026-09-10', KolliID: `${PREFIX}0010` }], ['Datum', 'KolliID']), 'nameless.xlsx', 'UPLOAD',
    )
    expect(result.linked).toBe(1)
    expect(result.namesRead).toBe(0)
    const record = await db.trackingImport.findFirst({ where: { filename: 'nameless.xlsx' }, orderBy: { receivedAt: 'desc' } })
    expect(record?.namesRead).toBe(0)
  })

  it('fills in the name on a dismissed row from a re-uploaded file but never links it', async () => {
    const o = await db.order.create({
      data: {
        shopId, externalId: 'N3', number: 'N3', placedAt: new Date(Date.now() - 2 * 24 * 3600_000), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        customerName: 'Dismissed Person', customerNameKey: nameKey('Dismissed Person'), customerEmail: 'dismissed@example.test', shippingCountry: 'DE',
      },
    })
    const number = '473999999000000013'
    await db.shipment.create({
      data: { trackingNumber: number, carrier: 'DHL', destinationCountry: 'DE', dismissedAt: new Date(), terminal: true },
    })
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [{ number, reason: 'Bring has no parcel with this number' }],
    })
    const result = await importWarehouseFile(sheet([ltasRow(number, 'Dismissed Person')]), 'named.xlsx', 'UPLOAD')
    expect(result.linked).toBe(0)
    const row = await db.shipment.findUnique({ where: { trackingNumber: number } })
    expect(row?.recipientName).toBe('Dismissed Person')
    expect(row?.orderId).toBeNull()
    expect(row?.orderId).not.toBe(o.id)
    expect(row?.dismissedAt).not.toBeNull()
  })

  it('counts a re-imported number that is already linked as linked, not unmatched', async () => {
    const o = await db.order.create({
      data: {
        shopId, externalId: 'N4', number: 'N4', placedAt: new Date(), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        customerEmail: 'already-linked@example.test',
      },
    })
    const number = '473999999000000014'
    await db.shipment.create({
      data: { trackingNumber: number, carrier: 'BRING', orderId: o.id, linkSource: 'BRING_EMAIL' },
    })
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [{ number, reason: 'Bring has no parcel with this number' }],
    })
    const result = await importWarehouseFile(sheet([ltasRow(number, 'Some Name')]), 'named.xlsx', 'UPLOAD')
    expect(result.linked).toBe(1)
    expect(result.unmatched).toEqual([])
    expect(result.parsed).toBe(result.linked + result.unaccounted)
    const row = await db.shipment.findUnique({ where: { trackingNumber: number } })
    expect(row?.orderId).toBe(o.id)
  })

  it('a named row the rules cannot place keeps its line, with the name reason appended', async () => {
    const number = '473999999000000012'
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [{ number, reason: 'Bring has no parcel with this number' }],
    })
    const result = await importWarehouseFile(sheet([ltasRow(number, 'Nobody Ordered')]), 'named.xlsx', 'UPLOAD')
    expect(result.linked).toBe(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].reason).toMatch(/asks Bring again, then DHL - The label says Nobody Ordered and no order/)
    expect((await db.shipment.findUnique({ where: { trackingNumber: number } }))?.recipientName).toBe('Nobody Ordered')
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
