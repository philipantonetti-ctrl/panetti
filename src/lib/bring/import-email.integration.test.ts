import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
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
  // it is a fixed-id row no tag can isolate — see the Global Constraints.
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
    // One consignment linked, not two packages — see the `linked` assertion above.
    expect(row?.rowsLinked).toBe(1)
  })

  it('is safe to run twice — the second import adopts, never rebuilds', async () => {
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
   * linked, 5 unmatched — and only TWO of the five said anything about
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

  // A file can be taken this far — parsed, past the Bring-connected check —
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
})
