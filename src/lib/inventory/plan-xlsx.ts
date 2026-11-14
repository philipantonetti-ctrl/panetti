/**
 * Philip's sales forecast workbook, read into units per product per month.
 *
 * Its layout, as he keeps it in Google Sheets: one tab per month (January to
 * December), each with a "Panetti" table - units for B2C, Hungary, B2B and
 * "Everything" - and a "Mazzetti" table with B2C units only. Below a cell
 * reading "ACTUAL SALES" come per-country tables with the same headings; those
 * are not the plan and are never read.
 *
 * Everything sells out of the one warehouse (Philip, 2026-11-14: "yes all"), so
 * the plan is the "Everything" column. Where that cell is blank, the filled-in
 * channel columns are added up instead, so a product planned only for B2C
 * still has its plan.
 *
 * Products are kept by the NAME the sheet uses ("Panetti Pizzetta Primo");
 * which SKU a name is gets decided once, on the page, by a person.
 */
import { strFromU8, unzipSync } from 'fflate'

export type PlanLine = { name: string; units: number }
export type PlanWorkbook = {
  /** From a tab named exactly "Total 2026"; null when the file has none. */
  year: number | null
  months: { month: number; lines: PlanLine[] }[]
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

const BRANDS = new Set(['panetti', 'mazzetti'])
const UNITS = /^total units sold/i

/** Same two cell forms the DHL reader handles; see lib/dhl/sheet.ts. */
const CELL = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
const ROW = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

type Grid = Map<number, Map<string, string>>

function readGrid(xml: string, shared: string[]): Grid {
  const grid: Grid = new Map()
  for (const row of xml.matchAll(ROW)) {
    const cells = new Map<string, string>()
    for (const cell of row[2].matchAll(CELL)) {
      const column = /r="([A-Z]+)\d+"/.exec(cell[1])?.[1]
      if (!column) continue
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1]
      const body = cell[2] ?? ''
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let text = ''
      if (type === 's' && v !== undefined) text = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') text = unescape(/<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? '')
      else if (type === 'e') text = '' // #REF!, #VALUE!: no figure, not zero
      else if (v !== undefined) text = unescape(v)
      cells.set(column, text.trim())
    }
    grid.set(Number(row[1]), cells)
  }
  return grid
}

/** "B" is 2, "AA" is 27: compared as numbers, never as strings. */
const colIndex = (col: string) => [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)

const number = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** The plan tables of one month tab, above "ACTUAL SALES". */
function readMonth(grid: Grid): PlanLine[] {
  const rows = [...grid.keys()].sort((a, b) => a - b)
  const lines = new Map<string, number>()

  for (let i = 0; i < rows.length; i++) {
    const cells = grid.get(rows[i])!
    if ([...cells.values()].some((v) => v.toUpperCase() === 'ACTUAL SALES')) break

    // A table starts where a cell says "Panetti" or "Mazzetti" and a cell to
    // its right on the same row is a "Total Units sold (...)" heading.
    const brandCol = [...cells.entries()].find(([, v]) => BRANDS.has(v.toLowerCase()))?.[0]
    if (!brandCol) continue
    const heads = [...cells.entries()].filter(([col, v]) => colIndex(col) > colIndex(brandCol) && UNITS.test(v))
    if (heads.length === 0) continue
    const everything = heads.find(([, v]) => /everything/i.test(v))?.[0] ?? null
    const channels = heads.filter(([col]) => col !== everything).map(([col]) => col)

    for (i = i + 1; i < rows.length; i++) {
      const row = grid.get(rows[i])!
      const name = row.get(brandCol) ?? ''
      if (name === '' || name.toLowerCase() === 'total' || BRANDS.has(name.toLowerCase())) {
        i -= 1 // let the outer loop look at this row: it may start the next table
        break
      }
      let units = everything ? number(row.get(everything)) : null
      if (units === null) {
        const parts = channels.map((c) => number(row.get(c))).filter((n): n is number => n !== null)
        units = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null
      }
      if (units === null) continue // nothing planned for it this month
      lines.set(name, (lines.get(name) ?? 0) + Math.round(units))
    }
  }

  return [...lines].map(([name, units]) => ({ name, units }))
}

export function readPlanWorkbook(buf: Buffer): PlanWorkbook {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf))
  } catch {
    throw new Error('This file could not be read as an Excel file.')
  }
  const book = files['xl/workbook.xml']
  const rels = files['xl/_rels/workbook.xml.rels']
  if (!book || !rels) throw new Error('This file could not be read as an Excel file.')

  const targets = new Map(
    [...strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /\bId="([^"]+)"/.exec(m[0])?.[1] ?? '',
      /\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? '',
    ]),
  )
  const sheets = [...strFromU8(book).matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: unescape(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? '').trim(),
    target: targets.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? '',
  }))
  const shared = files['xl/sharedStrings.xml']
    ? [...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1])).join(''),
      )
    : []

  let year: number | null = null
  const months: PlanWorkbook['months'] = []
  for (const sheet of sheets) {
    const total = /^Total (\d{4})$/i.exec(sheet.name)
    if (total) year = Number(total[1])
    const month = MONTHS.indexOf(sheet.name.toLowerCase()) + 1
    if (month === 0) continue
    const path = `xl/${sheet.target.replace(/^\/?xl\//, '').replace(/^\//, '')}`
    const xml = files[path]
    if (!xml) continue
    const lines = readMonth(readGrid(strFromU8(xml), shared))
    if (lines.length > 0) months.push({ month, lines })
  }

  if (months.length === 0) {
    throw new Error('No month tabs (January to December) with a Panetti or Mazzetti table were found in this file.')
  }
  months.sort((a, b) => a.month - b.month)
  return { year, months }
}
