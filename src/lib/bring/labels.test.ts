import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readLabels } from './labels'

/**
 * The warehouse's LTAS end-of-day report. Column names are the real ones;
 * every value is invented. Long numbers are stored as shared strings, which
 * is how Excel keeps an 18-digit id intact.
 */
const HEADERS = ['Datum', 'Antal', 'Order', 'Namn', 'KolliID', 'S00e4ndningsref', 'Levs00e4tt', 'Vikt']
type Row = Partial<Record<string, string>>
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
      'xl/sharedStrings.xml': strToU8(`<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${head}${body}</sheetData></worksheet>`),
    }),
  )
}

const row = (over: Row = {}): Row => ({
  Datum: '2026-09-10 08:19:24', Antal: '1', Order: '027286', Namn: 'Martin R00f6thke',
  KolliID: '473325380030453648', 'S00e4ndningsref': '73325380030453641', 'Levs00e4tt': 'BOXHD_NO', Vikt: '16.4',
  ...over,
})

describe('readLabels', () => {
  it('maps the KolliID and the S00e4ndningsref of a row to its name', () => {
    const r = readLabels(book([row()]), 'LTAS_EoD_Exp_Report_20260910_18-00.xlsx')
    expect(r?.rows).toBe(1)
    expect(r?.names.get('473325380030453648')).toBe('Martin R00f6thke')
    expect(r?.names.get('73325380030453641')).toBe('Martin R00f6thke')
    expect(r?.names.size).toBe(2)
  })

  it('reads the header however it is cased and skips rows with no name or no long number', () => {
    const headers = HEADERS.map((h) => (h === 'Namn' ? 'NAMN' : h))
    const r = readLabels(
      book(
        [
          row({ NAMN: 'Anitta Airi', Namn: undefined }),
          row({ NAMN: '', Namn: undefined, KolliID: '473325380030453655', 'S00e4ndningsref': '' }),
          row({ NAMN: 'No Number', Namn: undefined, KolliID: '', 'S00e4ndningsref': '' }),
          row({ NAMN: '---', Namn: undefined, KolliID: '473325380030453662', 'S00e4ndningsref': '' }),
        ],
        headers,
      ),
      'x.xlsx',
    )
    expect(r?.rows).toBe(1)
    expect(r?.names.get('473325380030453648')).toBe('Anitta Airi')
    expect(r?.names.has('473325380030453655')).toBe(false)
    expect(r?.names.has('473325380030453662')).toBe(false)
  })

  it('ignores short numbers such as the date and the warehouse counter', () => {
    const r = readLabels(book([row({ Order: '999999999999', Datum: '2026-09-10 08:19:24' })]), 'x.xlsx')
    expect([...r!.names.keys()].every((k) => k.length >= 15)).toBe(true)
  })

  it('returns null without a Namn column, with no rows, or for a file that is not xlsx', () => {
    expect(readLabels(book([row()], HEADERS.filter((h) => h !== 'Namn')), 'x.xlsx')).toBeNull()
    expect(readLabels(book([]), 'x.xlsx')).toBeNull()
    expect(readLabels(Buffer.from('Datum;Namn;KolliID\n2026;Someone;473325380030453648\n'), 'x.csv')).toBeNull()
    expect(readLabels(Buffer.from('not a zip'), 'x.xlsx')).toBeNull()
  })
})
