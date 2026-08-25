import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { db } from '@/lib/db'
import { importWarehouseFile } from '@/lib/bring/import'

const TAG = '[dhl-import-test]'
const PREFIX = '95IMP'
const FILES = ['Saved_shipment_export.xlsx']
const scoped = { shop: { name: { contains: TAG } } }

const HEADERS = [
  'Shipment Status', 'Creation Date (UTC)', 'Pickup Date', 'Shipment Number',
  'Sender Reference', 'Receiver Reference', 'Product Name',
]

/** A DHL export with the real column names and invented values. */
const dhlBook = (rows: Record<string, string>[]) => {
  const strings: string[] = []
  const idx = (v: string) => {
    const at = strings.indexOf(v)
    return at === -1 ? strings.push(v) - 1 : at
  }
  const line = (values: string[], r: number) =>
    `<row r="${r}">${values
      .map((v, i) =>
        v === ''
          ? `<c r="${String.fromCharCode(65 + i)}${r}" s="1"/>`
          : `<c r="${String.fromCharCode(65 + i)}${r}" t="s"><v>${idx(v)}</v></c>`,
      )
      .join('')}</row>`
  const body = rows.map((row, n) => line(HEADERS.map((h) => row[h] ?? ''), n + 2)).join('')
  const head = line(HEADERS, 1)
  return Buffer.from(
    zipSync({
      'xl/sharedStrings.xml': strToU8(`<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${head}${body}</sheetData></worksheet>`),
    }),
  )
}

const row = (over: Record<string, string> = {}) => ({
  'Shipment Status': 'INTRANSIT',
  'Creation Date (UTC)': '46248.398772071756',
  'Pickup Date': '46252.0',
  'Shipment Number': `${PREFIX}00001`,
  'Sender Reference': 'Shipment: 027438',
  'Receiver Reference': 'Panetti.de Order #15537',
  'Product Name': 'DHL Parcel Connect',
  ...over,
})

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: PREFIX } } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: PREFIX } } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.trackingImport.deleteMany({ where: { filename: { in: FILES } } })
}

beforeAll(async () => {
  await cleanup()
  const shop = await db.shop.create({
    data: { name: `Panetti Germany ${TAG}`, currency: 'EUR', deliveryTrackingFrom: new Date('2026-01-01') },
  })
  await db.order.create({
    data: {
      shopId: shop.id, externalId: '15537', number: '15537',
      placedAt: new Date('2026-08-10T09:00:00Z'), status: 'completed', currency: 'EUR',
      grossSales: 1000, discountTotal: 0, netSales: 1000,
      shippingCharged: 0, taxTotal: 0, total: 1000, customerEmail: 'de@example.test',
    },
  })
  // Bring DISCONNECTED on purpose: a German parcel must not depend on a
  // Norwegian carrier's credentials. Upsert, never delete-then-create - it is a
  // fixed-id singleton no tag can isolate.
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', bringApiUid: null, bringApiKey: null, bringClientUrl: null },
    update: { bringApiUid: null, bringApiKey: null, bringClientUrl: null },
  })
})

afterAll(cleanup)

describe('importWarehouseFile with a DHL export', () => {
  it('links the parcels and records the run, with Bring not connected at all', async () => {
    const result = await importWarehouseFile(
      dhlBook([row()]), 'Saved_shipment_export.xlsx', 'EMAIL',
    )
    expect(result.linked).toBe(1)
    expect(result.parsed).toBe(1)

    const shipment = await db.shipment.findUniqueOrThrow({
      where: { trackingNumber: `${PREFIX}00001` },
    })
    expect(shipment.carrier).toBe('DHL')
    expect(shipment.orderId).not.toBeNull()

    const record = await db.trackingImport.findFirst({
      where: { filename: 'Saved_shipment_export.xlsx' },
      orderBy: { receivedAt: 'desc' },
    })
    expect(record?.source).toBe('EMAIL')
    expect(record?.rowsLinked).toBe(1)
  })

  it('counts a freight row it passed over, so a short import is visible', async () => {
    const result = await importWarehouseFile(
      dhlBook([
        row({ 'Shipment Number': `${PREFIX}00002` }),
        // Pallet freight: no order reference, correctly not a customer delivery.
        row({
          'Shipment Number': `${PREFIX}00003`,
          'Receiver Reference': 'LET19703987R',
          'Product Name': 'DHL Road Freight Standard',
        }),
      ]),
      'Saved_shipment_export.xlsx',
      'EMAIL',
    )
    expect(result.linked).toBe(1)
    expect(result.parsed).toBe(2)
    expect(result.unaccounted).toBe(1)
  })

  it('states why a parcel did not link instead of dropping it', async () => {
    const result = await importWarehouseFile(
      dhlBook([
        row({ 'Shipment Number': `${PREFIX}00004`, 'Receiver Reference': 'Panetti.de Order #90909' }),
      ]),
      'Saved_shipment_export.xlsx',
      'EMAIL',
    )
    expect(result.linked).toBe(0)
    expect(result.unmatched.some((u) => /90909/.test(u.reason))).toBe(true)
  })
})
