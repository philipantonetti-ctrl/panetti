import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { db } from '@/lib/db'
import { nameKey } from '@/lib/delivery/name-key'
import { rereadStoredFiles, RULES_VERSION } from './reread'

// Unique to this file: a shop tag for orders, a filename for import rows, and
// an 18-digit number range (999888777...) no other suite or carrier uses, so
// every cleanup below is scoped and no parallel suite can sweep these away.
const TAG = '[reread-test]'
const FILE = 'reread-test.xlsx'
const scoped = { shop: { name: { contains: TAG } } }
const N = (i: number) => `99988877700000${String(i).padStart(4, '0')}`
const now = new Date('2026-09-11T12:00:00Z')

let shopId: string

// The same xlsx builder as labels.test.ts and import-email.integration.test.ts,
// copied because the files must stay independent.
const HEADERS = ['Datum', 'Antal', 'Order', 'Namn', 'KolliID', 'Sändningsref', 'Levsätt', 'Vikt']
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
const ltasRow = (kolli: string, name: string) => ({
  Datum: '2026-09-10 08:19:24', Antal: '1', Order: '027286', Namn: name, KolliID: kolli, 'Sändningsref': '', 'Levsätt': 'BOXHD_NO', Vikt: '16.4',
})

const order = (n: string, customerName: string, shippingCountry = 'DE') =>
  db.order.create({
    data: {
      shopId, externalId: n, number: n, placedAt: new Date(now.getTime() - 2 * 24 * 3600_000), status: 'completed', currency: 'EUR',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName, customerNameKey: nameKey(customerName), customerEmail: `${n}@example.test`, shippingCountry,
    },
  })

const stored = (file: Buffer, fileRules: number | null = null) =>
  db.trackingImport.create({
    data: { filename: FILE, source: 'EMAIL', rowsParsed: 1, rowsLinked: 0, rowsUnmatched: 1, file: new Uint8Array(file), fileRules },
  })

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: '999888777' } } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.trackingImport.deleteMany({ where: { filename: FILE } })
}

beforeAll(async () => {
  await cleanup()
  const shop = await db.shop.create({
    data: { name: `Shop ${TAG}`, currency: 'EUR', deliveryTrackingFrom: new Date('2026-01-01') },
  })
  shopId = shop.id
})

afterAll(cleanup)

describe('rereadStoredFiles', () => {
  it('reads a stored file the current rules never saw, names the parcel and links it by that name', async () => {
    const o = await order('R1', 'Tobias Kohlmeyer')
    await db.shipment.create({ data: { trackingNumber: N(1), carrier: 'DHL', destinationCountry: 'DE', unlinkedReason: 'old reason' } })
    const rec = await stored(sheet([ltasRow(N(1), 'KOHLMEYER TOBIAS')]))

    const r = await rereadStoredFiles({ now })

    expect(r).toEqual({ files: 1, linked: 1 })
    const row = await db.shipment.findUnique({ where: { trackingNumber: N(1) } })
    expect(row?.orderId).toBe(o.id)
    expect(row?.linkSource).toBe('FILE_NAME')
    expect(row?.recipientName).toBe('KOHLMEYER TOBIAS')
    expect(row?.unlinkedReason).toBeNull()
    const after = await db.trackingImport.findUnique({ where: { id: rec.id } })
    expect(after?.fileRules).toBe(RULES_VERSION)
    expect(after?.rereadAt).toEqual(now)
    expect(after?.rereadLinked).toBe(1)
    expect(after?.namesRead).toBe(1)
  })

  it('leaves a file already read with the current rules alone', async () => {
    await db.trackingImport.deleteMany({ where: { filename: FILE } })
    const rec = await stored(sheet([ltasRow(N(2), 'NOBODY HERE')]), RULES_VERSION)

    const r = await rereadStoredFiles({ now })

    expect(r).toEqual({ files: 0, linked: 0 })
    const after = await db.trackingImport.findUnique({ where: { id: rec.id } })
    expect(after?.rereadAt).toBeNull()
  })

  it('never moves a linked parcel and never attaches a dismissed one, but still fills in their names', async () => {
    await db.trackingImport.deleteMany({ where: { filename: FILE } })
    const a = await order('R3', 'Anna Berg')
    const b = await order('R4', 'Carl Lind')
    await db.shipment.create({ data: { trackingNumber: N(3), carrier: 'DHL', destinationCountry: 'DE', orderId: a.id, linkSource: 'MANUAL' } })
    await db.shipment.create({ data: { trackingNumber: N(4), carrier: 'DHL', destinationCountry: 'DE', dismissedAt: now } })
    const rec = await stored(sheet([ltasRow(N(3), 'LIND CARL'), ltasRow(N(4), 'LIND CARL')]))

    const r = await rereadStoredFiles({ now })

    expect(r).toEqual({ files: 1, linked: 0 })
    const linked = await db.shipment.findUnique({ where: { trackingNumber: N(3) } })
    expect(linked?.orderId).toBe(a.id)
    expect(linked?.linkSource).toBe('MANUAL')
    expect(linked?.recipientName).toBe('LIND CARL')
    const dismissed = await db.shipment.findUnique({ where: { trackingNumber: N(4) } })
    expect(dismissed?.orderId).toBeNull()
    expect(dismissed?.recipientName).toBe('LIND CARL')
    expect(b.id).toBeTruthy()
    const after = await db.trackingImport.findUnique({ where: { id: rec.id } })
    expect(after?.rereadLinked).toBe(0)
    expect(after?.namesRead).toBe(2)
  })

  it('stops at the deadline and leaves the rest for the next tick', async () => {
    await db.trackingImport.deleteMany({ where: { filename: FILE } })
    const rec = await stored(sheet([ltasRow(N(5), 'NOBODY HERE')]))

    const r = await rereadStoredFiles({ now, deadline: Date.now() - 1 })

    expect(r).toEqual({ files: 0, linked: 0 })
    const after = await db.trackingImport.findUnique({ where: { id: rec.id } })
    expect(after?.fileRules).toBeNull()
  })

  it('a stored file with no name column is marked read, with no names', async () => {
    await db.trackingImport.deleteMany({ where: { filename: FILE } })
    const rec = await stored(sheet([{ KolliID: N(6) }], ['Datum', 'KolliID']))

    const r = await rereadStoredFiles({ now })

    expect(r).toEqual({ files: 1, linked: 0 })
    const after = await db.trackingImport.findUnique({ where: { id: rec.id } })
    expect(after?.fileRules).toBe(RULES_VERSION)
    expect(after?.namesRead).toBe(0)
  })
})
