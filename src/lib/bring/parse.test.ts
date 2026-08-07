import { describe, expect, it } from 'vitest'
import { extractPairs, looksLikeTracking, parseTrackingFile } from './parse'

const known = new Set(['1001', '1002', '1003', 'PAN-2201'])

describe('looksLikeTracking', () => {
  it('accepts a Bring package number', () => {
    expect(looksLikeTracking('370724403790000123')).toBe(true)
  })

  it('rejects a short order number, which is the whole point', () => {
    expect(looksLikeTracking('1001')).toBe(false)
  })

  it('rejects a date and a price, which appear on every one of these documents', () => {
    expect(looksLikeTracking('2026-08-04')).toBe(false)
    expect(looksLikeTracking('1.234,00')).toBe(false)
  })

  it('rejects a word', () => {
    expect(looksLikeTracking('Sendingsnummer')).toBe(false)
  })
})

describe('extractPairs', () => {
  it('pairs each known order number with the nearest tracking-shaped token', () => {
    const text = `
      Ordre   Sendingsnummer
      1001    370724403790000123
      1002    370724403790000124
    `
    expect(extractPairs(text, known)).toEqual([
      { orderNumber: '1001', trackingNumber: '370724403790000123' },
      { orderNumber: '1002', trackingNumber: '370724403790000124' },
    ])
  })

  it('reads the columns the other way round, because the layout is theirs not ours', () => {
    const text = `370724403790000123  1001\n370724403790000124  1002`
    expect(extractPairs(text, known)).toEqual([
      { orderNumber: '1001', trackingNumber: '370724403790000123' },
      { orderNumber: '1002', trackingNumber: '370724403790000124' },
    ])
  })

  it('survives extra columns of noise between the two', () => {
    const text = `1001  Oslo  2026-08-04  1.234,00  370724403790000123`
    expect(extractPairs(text, known)).toEqual([
      { orderNumber: '1001', trackingNumber: '370724403790000123' },
    ])
  })

  it('handles a non-numeric order number', () => {
    expect(extractPairs('PAN-2201 370724403790000199', known)).toEqual([
      { orderNumber: 'PAN-2201', trackingNumber: '370724403790000199' },
    ])
  })

  it('ignores an order number we do not hold, rather than inventing a link', () => {
    expect(extractPairs('9999 370724403790000123', known)).toEqual([])
  })

  it('ignores an order number with no tracking number anywhere near it', () => {
    expect(extractPairs('1001 Ordre mottatt', known)).toEqual([])
  })

  it('never gives one tracking number to two orders', () => {
    const rows = extractPairs('1001 1002 370724403790000123', known)
    expect(rows).toHaveLength(1)
    expect(rows[0].orderNumber).toBe('1002')
  })

  it('returns nothing at all for an empty document, and does not throw', () => {
    expect(extractPairs('', known)).toEqual([])
  })

  it('refuses a tracking-shaped token that repeats, because a parcel number is unique', () => {
    // The support number in the footer is 8 digits, so it looks like a parcel
    // number and sits right beside order 1002. Refusing it costs one missing
    // pair, which shows up in the import's unmatched count. Accepting it would
    // silently attach the wrong parcel to 1002 and look like success.
    const text = `
      Kundeservice 21009000
      1001 370724403790000123
      1002 21009000
    `
    expect(extractPairs(text, known)).toEqual([
      { orderNumber: '1001', trackingNumber: '370724403790000123' },
    ])
  })
})

describe('parseTrackingFile', () => {
  // Skipped: src/lib/bring/__fixtures__/warehouse.pdf does not exist yet — the
  // client has not sent a real warehouse PDF. Do not fabricate one. The moment
  // a real file arrives: add it at that path, enable this test, and tighten
  // the assertion below from "is an array" to the actual order/tracking pairs
  // the document contains.
  it.skip('reads the real warehouse PDF', async () => {
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(new URL('./__fixtures__/warehouse.pdf', import.meta.url))
    // Widen the known set to whatever that document actually contains, then
    // narrow this assertion to the real order numbers once you have seen them.
    const { rows } = await parseTrackingFile(buf, 'warehouse.pdf', known)
    expect(Array.isArray(rows)).toBe(true)
  })

  it('refuses a file type it cannot read, with a message a human can act on', async () => {
    await expect(parseTrackingFile(Buffer.from('x'), 'notes.docx', known)).rejects.toThrow(
      /Only PDF and CSV/,
    )
  })

  it('reports every parcel number the file held, not just the ones it paired', async () => {
    // Two of these three parcels belong to orders we do not hold, so they are
    // dropped entirely — there is no unmatched row to describe them. Without
    // `seen`, this file would report "1 row, 1 linked": a flawless import that
    // quietly lost two thirds of its parcels, and left two orders looking
    // never-shipped until the alert fired about them.
    const csv = Buffer.from(
      '1001,370724403790000123\n' +
        '9998,370724403790000124\n' +
        '9999,370724403790000125\n',
      'utf8',
    )
    const { rows, seen } = await parseTrackingFile(csv, 'today.csv', known)
    expect(rows).toHaveLength(1)
    expect(seen).toBe(3)
  })

  it('counts a repeated parcel number once, and still refuses to pair it', async () => {
    // The support line in a footer looks like a parcel number and repeats.
    // It counts toward what the file offered — the operator should see that
    // something went unlinked — but it must never be paired.
    const csv = Buffer.from('21009000\n1001,370724403790000123\n1002,21009000\n', 'utf8')
    const { rows, seen } = await parseTrackingFile(csv, 'today.csv', known)
    expect(rows).toEqual([{ orderNumber: '1001', trackingNumber: '370724403790000123' }])
    expect(seen).toBe(2)
  })

  it('reports no shortfall when every parcel in the file was linked', async () => {
    const csv = Buffer.from('1001,370724403790000123\n1002,370724403790000124\n', 'utf8')
    const { rows, seen } = await parseTrackingFile(csv, 'today.csv', known)
    expect(rows).toHaveLength(2)
    expect(seen).toBe(2)
  })
})
