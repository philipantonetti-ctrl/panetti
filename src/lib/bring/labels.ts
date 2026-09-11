import { xlsxToRows } from '../dhl/sheet'
import { nameKey } from '../delivery/name-key'

/**
 * The recipient's name for every long number in the warehouse's report.
 *
 * `parseTrackingNumbers` reads the same file as a bag of long numbers on
 * purpose, so a change of column order or heading is not an outage. This
 * reader keeps that promise as far as it can: the ONE heading it depends on
 * is `Namn`, found by its folded spelling, and the numbers on a row are
 * taken from every cell rather than from a named column. The KolliID (18
 * digits) and the Sändningsref (17 digits) both map to the row's name, so
 * whichever number Bring or DHL later answers to finds it.
 *
 * Null means "this file gives no names": a csv, a sheet with no such column,
 * or an archive that will not open. The number path reports its own error
 * for the last; here null simply means the import goes on without names.
 */
export type Labels = { names: Map<string, string>; rows: number }

/** The same floor as extractLongNumbers: a timestamp is 14 digits, a parcel is 17 or 18. */
const MIN_DIGITS = 15

export function readLabels(buf: Buffer, filename: string): Labels | null {
  if (!filename.toLowerCase().endsWith('.xlsx')) return null
  let rows: Record<string, string>[]
  try {
    rows = xlsxToRows(buf)
  } catch {
    return null
  }
  if (rows.length === 0) return null
  const header = Object.keys(rows[0]).find((h) => nameKey(h) === 'namn')
  if (!header) return null

  const names = new Map<string, string>()
  let counted = 0
  for (const row of rows) {
    const name = (row[header] ?? '').trim()
    if (!name || nameKey(name) === '') continue
    let found = false
    for (const [column, value] of Object.entries(row)) {
      if (column === header) continue
      const digits = (value ?? '').replace(/\D/g, '')
      if (digits.length < MIN_DIGITS) continue
      names.set(digits, name)
      found = true
    }
    if (found) counted++
  }
  return { names, rows: counted }
}
