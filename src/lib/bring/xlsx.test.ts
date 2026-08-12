import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { xlsxToText } from './xlsx'

/** A minimal but structurally real xlsx: shared strings plus one sheet. */
const book = (shared: string[], sheetValues: string[]) =>
  Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8('<workbook/>'),
      'xl/sharedStrings.xml': strToU8(
        `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet><sheetData><row>${sheetValues
          .map((v) => `<c><v>${v}</v></c>`)
          .join('')}</row></sheetData></worksheet>`,
      ),
    }),
  )

describe('xlsxToText', () => {
  it('returns text held as a shared string', () => {
    const text = xlsxToText(book(['373325386490923366'], []))
    expect(text).toContain('373325386490923366')
  })

  it('returns text held as a raw cell value', () => {
    const text = xlsxToText(book([], ['73325383667032998']))
    expect(text).toContain('73325383667032998')
  })

  it('separates neighbouring cells, so two values never fuse into one token', () => {
    const text = xlsxToText(book([], ['111111111111111', '222222222222222']))
    expect(text).not.toContain('111111111111111222222222222222')
  })

  it('reads every worksheet, not just the first', () => {
    const buf = Buffer.from(
      zipSync({
        'xl/worksheets/sheet1.xml': strToU8('<c><v>111111111111111</v></c>'),
        'xl/worksheets/sheet2.xml': strToU8('<c><v>222222222222222</v></c>'),
      }),
    )
    const text = xlsxToText(buf)
    expect(text).toContain('111111111111111')
    expect(text).toContain('222222222222222')
  })

  it('throws something the uploader can read when the bytes are not a zip', () => {
    expect(() => xlsxToText(Buffer.from('this is not a spreadsheet'))).toThrow(
      /could not be read as an Excel file/i,
    )
  })
})
