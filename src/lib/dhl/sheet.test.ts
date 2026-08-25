import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { xlsxToRows } from './sheet'

/**
 * A structurally real xlsx. `cells` is raw <c> markup so a test can reproduce
 * the exact shapes Excel and DHL emit, including self-closing empty cells.
 */
const book = (shared: string[], rows: string[]) =>
  Buffer.from(
    zipSync({
      'xl/sharedStrings.xml': strToU8(
        `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet><sheetData>${rows
          .map((cells, i) => `<row r="${i + 1}">${cells}</row>`)
          .join('')}</sheetData></worksheet>`,
      ),
    }),
  )

/** A shared-string cell, as Excel writes text. */
const s = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`
/** A numeric cell. */
const n = (ref: string, v: string) => `<c r="${ref}"><v>${v}</v></c>`

describe('xlsxToRows', () => {
  it('keys each row by the header above it', () => {
    const rows = xlsxToRows(
      book(
        ['Shipment Number', 'Shipment Status', '9599036010', 'DELIVERED'],
        [s('A1', 0) + s('B1', 1), s('A2', 2) + s('B2', 3)],
      ),
    )
    expect(rows).toEqual([{ 'Shipment Number': '9599036010', 'Shipment Status': 'DELIVERED' }])
  })

  /**
   * The bug that made DHL's real export look empty.
   *
   * Excel writes an unused cell as `<c r="B2" s="1"/>` - self-closing, no
   * value. A reader that only matches the paired `<c ...>…</c>` form skips past
   * it and swallows the NEXT cell's value, filing it under the wrong column. On
   * the real file that made "Receiver Reference" read as blank and "VAT Country
   * Code" read as 650, and it very nearly cost us the whole integration.
   */
  it('does not let a self-closing empty cell steal the next cell value', () => {
    const rows = xlsxToRows(
      book(
        ['A head', 'B head', 'C head', 'the value'],
        [s('A1', 0) + s('B1', 1) + s('C1', 2), s('A2', 3) + `<c r="B2" s="1"/>` + s('C2', 3)],
      ),
    )
    expect(rows[0]['A head']).toBe('the value')
    expect(rows[0]['B head']).toBe('')
    // The one that matters: C keeps its own value rather than B taking it.
    expect(rows[0]['C head']).toBe('the value')
  })

  it('keeps a numeric cell as text, so a long id never loses digits', () => {
    const rows = xlsxToRows(book(['Shipment Number'], [s('A1', 0), n('A2', '9599036010')]))
    expect(rows[0]['Shipment Number']).toBe('9599036010')
  })

  it('leaves a column absent from a row as an empty string, never undefined', () => {
    const rows = xlsxToRows(
      book(['A head', 'B head', 'only A'], [s('A1', 0) + s('B1', 1), s('A2', 2)]),
    )
    expect(rows[0]['B head']).toBe('')
  })

  it('unescapes XML entities, because company names contain &', () => {
    const rows = xlsxToRows(book(['Name', 'Reise &amp; Bahn'], [s('A1', 0), s('A2', 1)]))
    expect(rows[0].Name).toBe('Reise & Bahn')
  })

  it('returns nothing when the sheet holds only a header', () => {
    expect(xlsxToRows(book(['Shipment Number'], [s('A1', 0)]))).toEqual([])
  })

  it('throws something a person can read when the bytes are not a spreadsheet', () => {
    expect(() => xlsxToRows(Buffer.from('not a spreadsheet'))).toThrow(
      /could not be read as an Excel file/i,
    )
  })
})
