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
    const rows = await parseTrackingFile(buf, 'warehouse.pdf', known)
    expect(Array.isArray(rows)).toBe(true)
  })

  it('refuses a file type it cannot read, with a message a human can act on', async () => {
    await expect(parseTrackingFile(Buffer.from('x'), 'notes.docx', known)).rejects.toThrow(
      /Only PDF and CSV/,
    )
  })
})
