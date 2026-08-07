import { db } from '../db'
import { parseTrackingFile } from './parse'
import { knownOrderNumbers, linkRows, type UnmatchedRow } from './link'

export type ImportResult = {
  importId: string
  /** Distinct parcel numbers the document appeared to contain. */
  parsed: number
  linked: number
  /** Rows refused for a reason we can state — an order number two shops share. */
  unmatched: UnmatchedRow[]
  /**
   * Parcel numbers the file offered that did not end up linked, INCLUDING the
   * ones we cannot explain. Always >= unmatched.length. This is the number that
   * tells an operator the file was only half understood; `unmatched` alone
   * cannot, because a row we failed to read leaves nothing to describe.
   */
  unaccounted: number
}

/**
 * A file we could not read. Its message is written for the person who uploaded
 * it — "Only PDF and CSV files can be read. This one is a .docx" — so the route
 * is allowed to pass it straight through. Anything NOT wearing this type is
 * unexpected, and its text is not fit for a client.
 */
export class ImportParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportParseError'
  }
}

/**
 * Best-effort: if the database is what failed, this bookkeeping write can
 * fail too, and must not mask the real error behind a confusing second one.
 * Same discipline as recordRun in src/lib/woo/sync.ts.
 */
function recordFailedAttempt(
  filename: string,
  source: 'UPLOAD' | 'EMAIL',
  fields: { rowsParsed: number; rowsLinked: number; rowsUnmatched: number; error: string },
) {
  return db.trackingImport.create({ data: { filename, source, ...fields } }).catch(() => {})
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
  // Split from the parse step below on purpose: this is a database read, not
  // a judgement about the file, so its failure must NOT be dressed up as an
  // ImportParseError — that type is a promise to the route that the message
  // is safe to show, and a dropped connection's message is not.
  let known: Set<string>
  try {
    known = await knownOrderNumbers()
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not read this file'
    await recordFailedAttempt(filename, source, { rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0, error })
    throw e
  }

  // `seen` is what the document APPEARED to contain; `rows` is what we managed
  // to pair. Recording rows.length as "parsed" was a lie by omission: a 100-row
  // file we half-understood reported "read 40, linked 40" — a complete success
  // — while sixty parcels vanished. And a vanished parcel leaves its order
  // looking never-shipped, so it eventually fires a Slack alert about a parcel
  // that shipped perfectly normally, with its tracking number sitting in the
  // file we just read.
  let rows
  let seen: number
  try {
    ;({ rows, seen } = await parseTrackingFile(buf, filename, known))
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not read this file'
    await recordFailedAttempt(filename, source, { rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0, error })
    throw new ImportParseError(error)
  }

  let linked: number
  let unmatched: UnmatchedRow[]
  try {
    ;({ linked, unmatched } = await linkRows(rows))
  } catch (e) {
    // Unexpected by definition — parsing already succeeded, so this is the
    // database's failure, not the file's. Re-thrown untagged, same as the
    // knownOrderNumbers failure above, so the route treats it as unsafe to
    // show verbatim.
    const error = e instanceof Error ? e.message : 'Could not link this file'
    await recordFailedAttempt(filename, source, {
      rowsParsed: seen, rowsLinked: 0, rowsUnmatched: seen, error,
    })
    throw e
  }

  // Everything the file offered that did not end up linked, whether we could
  // name a reason for it or not. `unmatched` still carries the reasons we DO
  // have (an order number two shops share); the remainder is the silent kind,
  // and it is counted rather than described because there is nothing honest to
  // say about a row we could not read.
  const unaccounted = Math.max(0, seen - linked)

  const record = await db.trackingImport.create({
    data: {
      filename,
      source,
      rowsParsed: seen,
      rowsLinked: linked,
      rowsUnmatched: unaccounted,
      unmatched: unmatched.length ? JSON.stringify(unmatched) : null,
    },
  })

  return { importId: record.id, parsed: seen, linked, unmatched, unaccounted }
}
