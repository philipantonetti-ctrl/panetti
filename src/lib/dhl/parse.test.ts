import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseDhlExport } from './parse'

/**
 * A DHL "Download shipment history" export.
 *
 * Column names are the real ones. Every VALUE is invented: the real export
 * carries customer names and home addresses, and none of that goes in the repo.
 * Tracking numbers keep their real shape - exactly 10 digits - because the
 * parser must not quietly turn one into a float.
 */
const HEADERS = [
  'Shipment Status',
  'Creation Date (UTC)',
  'Pickup Date',
  'Shipment Number',
  'Sender Reference',
  'Receiver Reference',
  'Product Name',
]

type Row = Partial<Record<(typeof HEADERS)[number], string>>

const col = (i: number) => String.fromCharCode(65 + i)

const book = (rows: Row[], headers: string[] = HEADERS) => {
  const strings: string[] = []
  const idx = (v: string) => {
    const at = strings.indexOf(v)
    return at === -1 ? strings.push(v) - 1 : at
  }
  const cells = (values: string[], r: number) =>
    values
      .map((v, i) => (v === '' ? `<c r="${col(i)}${r}" s="1"/>` : `<c r="${col(i)}${r}" t="s"><v>${idx(v)}</v></c>`))
      .join('')

  const body = rows
    .map((row, n) => `<row r="${n + 2}">${cells(headers.map((h) => row[h] ?? ''), n + 2)}</row>`)
    .join('')
  const head = `<row r="1">${cells(headers, 1)}</row>`

  return Buffer.from(
    zipSync({
      'xl/sharedStrings.xml': strToU8(
        `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${head}${body}</sheetData></worksheet>`),
    }),
  )
}

const parcel = (over: Row = {}): Row => ({
  'Shipment Status': 'DELIVERED',
  'Creation Date (UTC)': '46248.398772071756',
  'Pickup Date': '46252.0',
  'Shipment Number': '9599036010',
  'Sender Reference': 'Shipment: 027438',
  'Receiver Reference': 'Panetti.de Order #15537',
  'Product Name': 'DHL Parcel Connect',
  ...over,
})

describe('parseDhlExport', () => {
  it('reads the parcel, the shop and the order number off one row', () => {
    const out = parseDhlExport(book([parcel()]))!
    expect(out.shipments).toHaveLength(1)
    expect(out.shipments[0]).toMatchObject({
      trackingNumber: '9599036010',
      site: 'panetti.de',
      orderNumber: '15537',
      status: 'DELIVERED',
    })
    // Asserted to the day, not the millisecond: the serial carries a fraction
    // of a day and pinning its exact ms would break on a rounding change
    // without anything actually being wrong.
    expect(out.shipments[0].createdAt?.toISOString().slice(0, 10)).toBe('2026-08-14')
    expect(out.shipments[0].pickupAt).toEqual(new Date('2026-08-18T00:00:00.000Z'))
    expect(out.skipped).toEqual([])
  })

  it('keeps the tracking number as text, so a 10-digit id never becomes a float', () => {
    const out = parseDhlExport(book([parcel({ 'Shipment Number': '8499004276' })]))!
    expect(out.shipments[0].trackingNumber).toBe('8499004276')
  })

  /**
   * On a return the customer posts the parcel back, so DHL swaps the parties
   * and the order number moves from Receiver Reference to Sender Reference.
   * Reading only one column loses every return.
   */
  it('finds the order number in the sender column on a return', () => {
    const out = parseDhlExport(
      book([
        parcel({
          'Product Name': 'DHL Service Point Return',
          'Sender Reference': 'Panetti.se Order #13358',
          'Receiver Reference': 'Shipment 025767',
        }),
      ]),
    )!
    expect(out.shipments[0].site).toBe('panetti.se')
    expect(out.shipments[0].orderNumber).toBe('13358')
  })

  it('accepts the shorthand written without the words "Order #"', () => {
    const out = parseDhlExport(book([parcel({ 'Receiver Reference': 'Panetti.de 15343' })]))!
    expect(out.shipments[0].orderNumber).toBe('15343')
  })

  it('reads every shop the warehouse ships for', () => {
    const sites = ['Panetti.de', 'Panetti.se', 'Mazzetti.se', 'Mazzetti.dk', 'Mazzetti.fi']
    const out = parseDhlExport(
      book(
        sites.map((s, i) =>
          parcel({
            'Shipment Number': `95990369${String(i).padStart(2, '0')}`,
            'Receiver Reference': `${s} Order #1000${i}`,
          }),
        ),
      ),
    )!
    expect(out.shipments.map((s) => s.site)).toEqual([
      'panetti.de', 'panetti.se', 'mazzetti.se', 'mazzetti.dk', 'mazzetti.fi',
    ])
  })

  /**
   * Pallet freight and inbound stock ride along in the same export and are not
   * customer deliveries. They must be skipped, and skipping them must be
   * VISIBLE - a silently shorter import is how a missing parcel goes unnoticed.
   */
  it.each([
    ['a warehouse reference', 'Shipment: 026408'],
    ['a freight reference', 'LET19703987R'],
    ['an inbound purchase order', 'PO: 223730'],
    ['something unrecognisable', '1352-10264'],
  ])('skips %s and says so, rather than dropping it silently', (_label, reference) => {
    const out = parseDhlExport(
      book([parcel({ 'Sender Reference': 'Shipment: 026408', 'Receiver Reference': reference })]),
    )!
    expect(out.shipments).toEqual([])
    expect(out.skipped).toEqual([
      { trackingNumber: '9599036010', reference, product: 'DHL Parcel Connect' },
    ])
  })

  it('ignores a row with no tracking number at all', () => {
    const out = parseDhlExport(book([parcel({ 'Shipment Number': '' })]))!
    expect(out.shipments).toEqual([])
    expect(out.skipped).toEqual([])
  })

  it('turns the Excel serial dates into real ones', () => {
    // 46248.398772 is 2026-08-14 in Excel's serial scheme, which counts days
    // from 1899-12-30. Pinned against the real file: that row was created on
    // 14 August 2026 and its dashboard entry agrees.
    const out = parseDhlExport(book([parcel()]))!
    expect(out.shipments[0].createdAt?.toISOString().slice(0, 10)).toBe('2026-08-14')
    expect(out.shipments[0].pickupAt?.toISOString().slice(0, 10)).toBe('2026-08-18')
  })

  it('leaves a missing date null rather than inventing one', () => {
    const out = parseDhlExport(book([parcel({ 'Pickup Date': '' })]))!
    expect(out.shipments[0].pickupAt).toBeNull()
  })

  it('returns null for a file that is not a DHL export, so another reader can try', () => {
    const notDhl = book([{}], ['Datum', 'Order', 'KolliID'])
    expect(parseDhlExport(notDhl)).toBeNull()
  })

  it('returns null rather than throwing when the bytes are not a spreadsheet', () => {
    expect(parseDhlExport(Buffer.from('not a spreadsheet'))).toBeNull()
  })
})
