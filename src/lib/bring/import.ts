import { db } from '../db'
import { parseTrackingFile } from './parse'
import { knownOrderNumbers, linkRows, type UnmatchedRow } from './link'

export type ImportResult = {
  importId: string
  parsed: number
  linked: number
  unmatched: UnmatchedRow[]
}

/**
 * Read one warehouse file and link what it contains.
 *
 * Every attempt is recorded, successes and failures alike. A file that arrived
 * and could not be read is exactly the event nobody would otherwise notice:
 * linking simply stops, the delivery figures quietly stop growing, and the page
 * looks the same as a quiet day.
 */
export async function importTrackingFile(
  buf: Buffer,
  filename: string,
  source: 'UPLOAD' | 'EMAIL',
): Promise<ImportResult> {
  let rows
  try {
    rows = await parseTrackingFile(buf, filename, await knownOrderNumbers())
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not read this file'
    await db.trackingImport.create({
      data: { filename, source, rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0, error },
    })
    throw e
  }

  const { linked, unmatched } = await linkRows(rows)

  const record = await db.trackingImport.create({
    data: {
      filename,
      source,
      rowsParsed: rows.length,
      rowsLinked: linked,
      rowsUnmatched: unmatched.length,
      unmatched: unmatched.length ? JSON.stringify(unmatched) : null,
    },
  })

  return { importId: record.id, parsed: rows.length, linked, unmatched }
}
