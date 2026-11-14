import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readPlanWorkbook } from './plan-xlsx'

/**
 * Philip's sales forecast workbook: one tab per month, each with a Panetti
 * block (B2C, Hungary, B2B, Everything) and a Mazzetti block (B2C only), and
 * per-country tables under "ACTUAL SALES" that are NOT the plan.
 */

type Cell = string | number | { f: string; v: number } | { error: string }
type Sheet = Record<string, Cell>

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function workbook(sheets: Record<string, Sheet>): Buffer {
  const shared: string[] = []
  const sid = (s: string) => {
    const i = shared.indexOf(s)
    if (i >= 0) return i
    shared.push(s)
    return shared.length - 1
  }
  const files: Record<string, Uint8Array> = {}
  const names = Object.keys(sheets)
  names.forEach((name, i) => {
    const rows = new Map<number, string[]>()
    for (const [ref, value] of Object.entries(sheets[name])) {
      const r = Number(/\d+/.exec(ref)![0])
      let xml: string
      if (typeof value === 'string') xml = `<c r="${ref}" t="s"><v>${sid(value)}</v></c>`
      else if (typeof value === 'number') xml = `<c r="${ref}"><v>${value}</v></c>`
      else if ('error' in value) xml = `<c r="${ref}" t="e"><v>${value.error}</v></c>`
      else xml = `<c r="${ref}"><f>${value.f}</f><v>${value.v}</v></c>`
      rows.set(r, [...(rows.get(r) ?? []), xml])
    }
    const body = [...rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([r, cells]) => `<row r="${r}">${cells.join('')}</row>`)
      .join('')
    // Sheet files numbered in REVERSE of the tab order, as Google writes them
    // out of order: the tab name must come from workbook.xml, never the file name.
    files[`xl/worksheets/sheet${names.length - i}.xml`] = strToU8(
      `<worksheet><sheetData>${body}</sheetData></worksheet>`,
    )
  })
  files['xl/workbook.xml'] = strToU8(
    `<workbook xmlns:r="r"><sheets>${names
      .map((n, i) => `<sheet state="visible" name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 10}"/>`)
      .join('')}</sheets></workbook>`,
  )
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<Relationships>${names
      .map((_, i) => `<Relationship Id="rId${i + 10}" Type="worksheet" Target="worksheets/sheet${names.length - i}.xml"/>`)
      .join('')}</Relationships>`,
  )
  files['xl/sharedStrings.xml'] = strToU8(
    `<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
  )
  return Buffer.from(zipSync(files))
}

const november: Sheet = {
  A1: 'November',
  B2: 'Panetti', C2: 'Total Units sold (B2C)', D2: 'Total Units sold (Hungary)',
  E2: 'Total Units sold (B2B)', F2: 'Total Units sold (Everything)', G2: 'Total Revenue ($) - Ex vat',
  B3: 'Panetti Pizzetta Primo', C3: 1710, D3: 300, E3: 900, F3: { f: 'SUM(C3:E3)', v: 2910 }, G3: 943350,
  B4: 'Panetti Pizza shovel', C4: 595, D4: 20, E4: 0, F4: 615, G4: 21285,
  // "Everything" left blank: the plan is still the columns that are filled in.
  B5: 'Panetti PrimoMix Pro', C5: 340,
  // Nothing planned at all: no line, rather than a zero.
  B6: 'Panetti Meat Grinder',
  B7: 'Total', C7: 2645, F7: 3525,
  B9: 'Mazzetti', C9: 'Total Units sold (B2C)', D9: 'Total Revenue ($) - Ex vat',
  B10: 'Mazzetti Advanced Comfort - Black', C10: 74, D10: 234950,
  B11: 'Mazzetti Ergonomic Comfort', C11: { error: '#REF!' },
  B12: 'Total', C12: 74,
  A14: 'ACTUAL SALES',
  // A per-country table under the plan: same heading, NOT the plan.
  B16: 'Panetti', C16: 'Total Units sold (B2C)',
  B17: 'Panetti Pizzetta Primo', C17: 1100,
}

describe('readPlanWorkbook', () => {
  it('reads each month tab: Everything for Panetti, B2C for Mazzetti, nothing below ACTUAL SALES', () => {
    const plan = readPlanWorkbook(workbook({ 'Sales Goals': { A1: 'Total sales' }, November: november }))
    expect(plan.months).toEqual([
      {
        month: 11,
        lines: [
          { name: 'Panetti Pizzetta Primo', units: 2910 },
          { name: 'Panetti Pizza shovel', units: 615 },
          { name: 'Panetti PrimoMix Pro', units: 340 },
          { name: 'Mazzetti Advanced Comfort - Black', units: 74 },
        ],
      },
    ])
  })

  it('takes the year from the "Total 2026" tab, never from a copied one', () => {
    const plan = readPlanWorkbook(
      workbook({ November: november, 'Total 2026': { A1: 'x' }, 'Kopi av Total 2025': { A1: 'x' } }),
    )
    expect(plan.year).toBe(2026)
  })

  it('has no year when the file does not say one', () => {
    expect(readPlanWorkbook(workbook({ November: november })).year).toBeNull()
  })

  it('reads every month tab, in calendar order, whatever order the tabs are in', () => {
    const jan: Sheet = {
      B2: 'Panetti', C2: 'Total Units sold (B2C)', F2: 'Total Units sold (Everything)',
      B3: 'Panetti Stand-Mixer', C3: 500, F3: 510,
    }
    const plan = readPlanWorkbook(workbook({ November: november, January: jan }))
    expect(plan.months.map((m) => m.month)).toEqual([1, 11])
    expect(plan.months[0].lines).toEqual([{ name: 'Panetti Stand-Mixer', units: 510 }])
  })

  it('says plainly when the file is not an Excel file', () => {
    expect(() => readPlanWorkbook(Buffer.from('not a zip'))).toThrow('This file could not be read as an Excel file.')
  })

  it('says plainly when no month tab holds a plan', () => {
    expect(() => readPlanWorkbook(workbook({ 'Sales Goals': { A1: 'Total sales' } }))).toThrow(
      'No month tabs (January to December) with a Panetti or Mazzetti table were found in this file.',
    )
  })
})
