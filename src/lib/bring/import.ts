import { db } from '../db'
import { parseTrackingFile, parseTrackingNumbers } from './parse'
import { knownOrderNumbers, linkRows, type UnmatchedRow } from './link'
import {
  resolveConsignments,
  type ResolvedConsignment,
  type UnresolvedNumber,
} from './consignments'
import { matchByEmail } from './match'
// Note the directory: config.ts lives under delivery/, not bring/.
import { getDeliveryConfig } from '../delivery/config'
import { parseDhlExport } from '../dhl/parse'
import { linkDhlShipments } from '../dhl/link'

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
 * A Bring package number as the warehouse file prints one: 373 and fifteen
 * more digits. Measured, not assumed - every parcel this system has ever
 * matched is this shape, all six of the production misses below were this
 * shape, and none of the other carriers' numbers seen in the files (19 to 24
 * digits, or DHL's ten) can collide with it.
 */
const BRING_SHAPED = /^373\d{15}$/

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

  /**
   * DHL is tried first, and returns null the moment the bytes are not one of
   * its exports — so the Bring reader below gets the same file untouched and
   * ONE inbound address takes both. Neither sender has to know or care which
   * reader will pick their message up.
   *
   * It is first rather than second because it is the cheaper, surer test: it
   * keys on four named columns, while the Bring path accepts almost anything
   * with long digit runs in it and would happily swallow a DHL export whole,
   * pulling 10-digit shipment numbers out of it and asking Bring about every
   * one.
   */
  const dhl = parseDhlExport(buf)
  if (dhl) {
    try {
      const { linked, unmatched } = await linkDhlShipments(dhl.shipments, receivedAt)

      // Freight and inbound stock ride along in the same export. They are not
      // customer deliveries and are correctly passed over, but they are listed
      // here so a short import is visible rather than merely smaller.
      const rows: UnmatchedRow[] = [
        ...unmatched,
        ...dhl.skipped.map((s) => ({
          orderNumber: s.product || '(no product)',
          trackingNumber: s.trackingNumber,
          reason: `No order reference on this row: ${s.reference}`,
        })),
      ]
      const parsed = dhl.shipments.length + dhl.skipped.length

      const record = await db.trackingImport.create({
        data: {
          filename,
          source,
          rowsParsed: parsed,
          rowsLinked: linked,
          rowsUnmatched: rows.length,
          unmatched: rows.length ? JSON.stringify(rows) : null,
        },
      })
      return { importId: record.id, parsed, linked, unmatched: rows, unaccounted: rows.length }
    } catch (e) {
      // Same rule as the Bring block below: a throw that escapes unrecorded is
      // the silent morning this feature exists to prevent.
      const error = e instanceof Error ? e.message : 'Could not import this file'
      const parsed = dhl.shipments.length + dhl.skipped.length
      await recordFailedAttempt(filename, source, {
        rowsParsed: parsed, rowsLinked: 0, rowsUnmatched: parsed, error,
      })
      throw e
    }
  }

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
  /**
   * Numbers Bring gave nothing for, each carrying WHY.
   *
   * These used to be counted into `rowsUnmatched` and then thrown away, and
   * the 2026-08-18 file is what that cost: 51 parsed, 46 linked, 5 unmatched,
   * and only the two email refusals could say anything about themselves. The
   * other three were numbers out of this list. Nobody could find out which
   * ones, because the numbers were never written down — the count was the only
   * surviving evidence they had ever been in the file.
   *
   * They join `unmatched` below, so every entry behind the count names itself.
   */
  let unresolved: UnresolvedNumber[] = []
  let linked = 0
  const unmatched: UnmatchedRow[] = []

  try {
    // getDeliveryConfig's own docstring promises it never throws, but it does
    // a findUnique, so it is guarded here like everything else in this block
    // rather than trusted on faith.
    const { creds } = await getDeliveryConfig()
    if (!creds)
      throw new ImportParseError('Bring is not connected, so parcels cannot be identified')

    /**
     * Yesterday's too-early parcels, retried tonight.
     *
     * The midnight import races Bring's own data feed: on 2026-08-21 six real
     * parcels across two nights' files were refused as unknown, and Bring knew
     * every one of them by the next day. Such numbers are stored below rather
     * than refused, and THIS is the half that finishes the job - once Bring
     * has the parcel it hands back the recipient, and the order link lands a
     * night late instead of never.
     *
     * Best-effort and outside the file's own counts: housekeeping must
     * neither fail the import nor inflate tonight's numbers.
     */
    try {
      const early = await db.shipment.findMany({
        where: {
          orderId: null,
          carrier: 'BRING',
          trackingNumber: { startsWith: '373' },
          // A week is seven retries at one file a night. Older than that,
          // Bring genuinely never heard of it and the nightly lookup stops.
          createdAt: { gte: new Date(receivedAt.getTime() - 7 * 24 * 60 * 60 * 1000) },
        },
        select: { trackingNumber: true },
        orderBy: { createdAt: 'asc' },
        take: 40, // bounds the extra Bring calls a night can add
      })
      const retryNumbers = early.map((s) => s.trackingNumber).filter((n) => BRING_SHAPED.test(n))
      if (retryNumbers.length > 0) {
        const again = await resolveConsignments(creds, retryNumbers, opts)
        for (const c of again.consignments) {
          const outcome = await matchByEmail(c.recipientEmail, receivedAt)
          if (outcome.orderId === null) continue // still ambiguous: next night
          for (const trackingNumber of c.packageNumbers) {
            await db.shipment.upsert({
              where: { trackingNumber },
              create: {
                trackingNumber,
                orderId: outcome.orderId,
                linkSource: 'BRING_EMAIL',
                nextPollAt: new Date(),
              },
              update: { orderId: outcome.orderId, linkSource: 'BRING_EMAIL' },
            })
          }
        }
      }
    } catch {
      // A Bring blip during housekeeping must not fail the file; the same
      // parcels are simply retried with tomorrow's import.
    }

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

    // A number Bring never resolved is a refusal like any other, and is listed
    // beside them rather than merely counted. `orderNumber` is what we would
    // have called it, and for these we genuinely never learned: Bring is the
    // only thing that turns a number into a name, and Bring is what failed.
    for (const u of unresolved) {
      // Unless the number is Bring-shaped - then "no parcel" is almost always
      // a race lost against Bring's own feed, not a verdict, and treating it
      // as final is what cost six real parcels their tracking (see
      // BRING_SHAPED). Stored unlinked and poll-scheduled; the retry stage
      // above links it once Bring catches up.
      if (BRING_SHAPED.test(u.number)) {
        await db.shipment.upsert({
          where: { trackingNumber: u.number },
          create: { trackingNumber: u.number, nextPollAt: new Date() },
          // Adopt, never reset: it may already be mid-retry from an earlier
          // night.
          update: {},
        })
        unmatched.push({
          orderNumber: '(not identified)',
          trackingNumber: u.number,
          reason: 'Bring has not heard of this parcel yet - stored, it will be linked once Bring knows it',
        })
        continue
      }
      unmatched.push({
        orderNumber: '(not identified)',
        trackingNumber: u.number,
        reason: u.reason,
      })
    }

    // Consignments and the numbers Bring never resolved — not raw long
    // numbers, which run two per parcel (a shipment reference and a package
    // number) and would show a flawless import as parcels vanishing.
    const parsed = consignments.length + unresolved.length
    // Now simply the length of the list, because the list is now complete.
    // Written as two addends it drifted the moment either half changed, and
    // "5 unmatched, 2 explained" is the shape of that drift.
    const unaccounted = unmatched.length

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
    // Derived from what was parsed, NOT as `unresolved.length + unmatched.length`.
    // A throw partway through the consignment loop leaves the consignments it
    // never reached counted in rowsParsed and in neither of the other two, so
    // the row would claim 27 parsed, 4 linked, 0 unmatched and quietly lose 23
    // parcels — against the promise ImportResult makes, that parsed is always
    // linked + unaccounted. Same shape as importTrackingFile's `unaccounted`.
    const parsed = consignments.length + unresolved.length
    await recordFailedAttempt(filename, source, {
      rowsParsed: parsed,
      rowsLinked: linked,
      rowsUnmatched: Math.max(0, parsed - linked),
      error,
    })
    throw e
  }
}
