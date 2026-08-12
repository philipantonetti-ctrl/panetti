import { db } from '../db'
import { parseTrackingFile, parseTrackingNumbers } from './parse'
import { knownOrderNumbers, linkRows, type UnmatchedRow } from './link'
import { resolveConsignments, type ResolvedConsignment } from './consignments'
import { matchByEmail } from './match'
// Note the directory: config.ts lives under delivery/, not bring/.
import { getDeliveryConfig } from '../delivery/config'

export type ImportResult = {
  importId: string
  /**
   * How many things the file offered to import, in whichever unit that path
   * counts in. `importTrackingFile` counts distinct parcel-shaped numbers in
   * the document. `importWarehouseFile` counts resolved CONSIGNMENTS plus the
   * numbers Bring could not resolve — not raw long numbers, which come in two
   * per parcel (a shipment reference and a package number) and would show a
   * flawless run as parcels vanishing. Always `linked + unaccounted`.
   */
  parsed: number
  /**
   * How many of those were linked to an order. For `importWarehouseFile` this
   * counts CONSIGNMENTS, not packages: a two-package consignment that matches
   * still writes two Shipment rows but counts once here, so `linked` stays in
   * the same unit as `parsed`.
   */
  linked: number
  /**
   * Entries refused for a reason we can state — an order number two shops
   * share, or an email that matched zero or two orders instead of one.
   */
  unmatched: UnmatchedRow[]
  /**
   * Everything the file offered that did not end up linked, INCLUDING the
   * ones we cannot explain. Always `parsed - linked`. This is the number that
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

/**
 * Read one warehouse file the format-independent way.
 *
 * The warehouse's own order number is not ours and lands on the wrong order
 * every time, so this path never looks at it. It takes the long numbers out of
 * the file, asks Bring who each parcel belongs to, and matches on the recipient
 * email. That means a change to their column order, their headings, or their
 * file format is not an outage here.
 *
 * `importTrackingFile` above is the older order-number path and is left alone.
 */
export async function importWarehouseFile(
  buf: Buffer,
  filename: string,
  source: 'UPLOAD' | 'EMAIL',
  opts: { deadline?: number } = {},
): Promise<ImportResult> {
  const receivedAt = new Date()

  let numbers: string[]
  try {
    numbers = await parseTrackingNumbers(buf, filename)
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not read this file'
    await recordFailedAttempt(filename, source, {
      rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0, error,
    })
    throw new ImportParseError(error)
  }

  // Everything from here on can fail mid-way — Bring timing out, a dropped
  // database connection, even the bookkeeping write itself — and a throw that
  // escapes unrecorded is exactly the silent morning this feature exists to
  // prevent: no TrackingImport row, Postmark redelivers nothing because the
  // route answers 200 regardless, and the delivery page reads like a quiet
  // day while some Shipments may already sit half-linked. So the whole of it
  // is one guarded block, and whatever is known when it fails is recorded
  // before rethrowing — same shape as the linkRows guard above.
  let consignments: ResolvedConsignment[] = []
  let unresolved: string[] = []
  let linked = 0
  const unmatched: UnmatchedRow[] = []

  try {
    // getDeliveryConfig's own docstring promises it never throws, but it does
    // a findUnique, so it is guarded here like everything else in this block
    // rather than trusted on faith.
    const { creds } = await getDeliveryConfig()
    if (!creds)
      throw new ImportParseError('Bring is not connected, so parcels cannot be identified')

    ;({ consignments, unresolved } = await resolveConsignments(creds, numbers, opts))

    for (const c of consignments) {
      const outcome = await matchByEmail(c.recipientEmail, receivedAt)
      if (outcome.orderId === null) {
        unmatched.push({
          orderNumber: c.recipientName ?? c.consignmentId,
          trackingNumber: c.packageNumbers[0],
          reason: outcome.reason,
        })
        continue
      }
      for (const trackingNumber of c.packageNumbers) {
        await db.shipment.upsert({
          where: { trackingNumber },
          // Due immediately, so the next cron run picks it up.
          create: {
            trackingNumber,
            orderId: outcome.orderId,
            linkSource: 'BRING_EMAIL',
            nextPollAt: new Date(),
          },
          // Only the link. Milestones, events and poll state are the sync's
          // to own, and a re-import must not undo a week of tracking.
          update: { orderId: outcome.orderId, linkSource: 'BRING_EMAIL' },
        })
      }
      // Once per CONSIGNMENT, not per package: a two-package consignment
      // that matches still counts once here, so `linked` stays in the same
      // unit as `parsed` below and the two totals actually add up.
      linked++
    }

    // Consignments and the numbers Bring never resolved — not raw long
    // numbers, which run two per parcel (a shipment reference and a package
    // number) and would show a flawless import as parcels vanishing.
    const parsed = consignments.length + unresolved.length
    const unaccounted = unresolved.length + unmatched.length

    const record = await db.trackingImport.create({
      data: {
        filename,
        source,
        rowsParsed: parsed,
        rowsLinked: linked,
        rowsUnmatched: unaccounted,
        unmatched: unmatched.length ? JSON.stringify(unmatched) : null,
      },
    })

    return { importId: record.id, parsed, linked, unmatched, unaccounted }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not import this file'
    await recordFailedAttempt(filename, source, {
      rowsParsed: consignments.length + unresolved.length,
      rowsLinked: linked,
      rowsUnmatched: unresolved.length + unmatched.length,
      error,
    })
    throw e
  }
}
