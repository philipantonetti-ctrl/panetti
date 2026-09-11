import { db } from '../db'
import { parseTrackingFile, parseTrackingNumbers } from './parse'
import { knownOrderNumbers, linkRows, type UnmatchedRow } from './link'
import {
  resolveConsignments,
  type ResolvedConsignment,
  type UnresolvedNumber,
} from './consignments'
import { matchByEmail, matchByName, type MatchOutcome } from './match'
import { readLabels } from './labels'
// Note the directory: config.ts lives under delivery/, not bring/.
import { getDeliveryConfig } from '../delivery/config'
import { attach, ATTACH_SELECT } from '../delivery/attach'
import { parseDhlExport } from '../dhl/parse'
import { linkDhlShipments } from '../dhl/link'

export type ImportResult = {
  importId: string
  /**
   * How many things the file offered to import, in whichever unit that path
   * counts in. `importTrackingFile` counts distinct parcel-shaped numbers in
   * the document. `importWarehouseFile` counts resolved CONSIGNMENTS plus the
   * numbers Bring could not resolve - not raw long numbers, which come in two
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
   * Entries refused for a reason we can state - an order number two shops
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
  /**
   * Rows of the warehouse file that carried a recipient name. 0 means the
   * file was read and had none we could find, which is the thing to look at
   * when parcels stop attaching; null means this path does not read names.
   */
  namesRead: number | null
}

/**
 * A file we could not read. Its message is written for the person who uploaded
 * it - "Only PDF and CSV files can be read. This one is a .docx" - so the route
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
  // ImportParseError - that type is a promise to the route that the message
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
  // file we half-understood reported "read 40, linked 40" - a complete success
  // - while sixty parcels vanished. And a vanished parcel leaves its order
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
    // Unexpected by definition - parsing already succeeded, so this is the
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

  return { importId: record.id, parsed: seen, linked, unmatched, unaccounted, namesRead: null }
}

/**
 * A Bring package number as the warehouse file prints one: 373 or 473, then
 * fifteen more digits. Measured, not assumed - of the 496 linked Bring parcels
 * in production on 2026-08-31, 263 start 373 and 233 start 473, and none of
 * the other carriers' numbers seen in the files (19 to 24 digits, or DHL's
 * ten) can collide with either. A 473 or 373 number Bring does not know is
 * stored as carrier UNKNOWN for the poller to identify; see the loop below.
 */
const BRING_SHAPED = /^[34]73\d{15}$/

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
   * its exports - so the Bring reader below gets the same file untouched and
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
      return { importId: record.id, parsed, linked, unmatched: rows, unaccounted: rows.length, namesRead: null }
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

  // The names on the labels, keyed by every long number on their row. Null
  // when this file gives none; the import then goes on exactly as before.
  const labels = readLabels(buf, filename)
  const nameFor = (candidates: (string | null)[]): string | null => {
    for (const n of candidates) {
      const v = n ? labels?.names.get(n) : undefined
      if (v) return v
    }
    return null
  }

  // Everything from here on can fail mid-way - Bring timing out, a dropped
  // database connection, even the bookkeeping write itself - and a throw that
  // escapes unrecorded is exactly the silent morning this feature exists to
  // prevent: no TrackingImport row, Postmark redelivers nothing because the
  // route answers 200 regardless, and the delivery page reads like a quiet
  // day while some Shipments may already sit half-linked. So the whole of it
  // is one guarded block, and whatever is known when it fails is recorded
  // before rethrowing - same shape as the linkRows guard above.
  let consignments: ResolvedConsignment[] = []
  /**
   * Numbers Bring gave nothing for, each carrying WHY.
   *
   * These used to be counted into `rowsUnmatched` and then thrown away, and
   * the 2026-08-18 file is what that cost: 51 parsed, 46 linked, 5 unmatched,
   * and only the two email refusals could say anything about themselves. The
   * other three were numbers out of this list. Nobody could find out which
   * ones, because the numbers were never written down - the count was the only
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

    ;({ consignments, unresolved } = await resolveConsignments(creds, numbers, opts))

    for (const c of consignments) {
      const facts = {
        carrier: 'BRING',
        consignmentId: c.consignmentId,
        destinationCountry: c.destinationCountry,
        weightKg: c.weightKg,
        recipientEmail: c.recipientEmail,
        recipientName: c.recipientName ?? nameFor([...c.packageNumbers, c.consignmentId]),
        bookedAt: c.bookedAt,
        identifiedAt: receivedAt,
      }
      // A null name here means "the carrier and the file both gave nothing",
      // not "erase the name". Left in `facts` it would overwrite a name an
      // earlier file or the poller already stored, so the update side omits
      // it entirely when it is null; `create` keeps the full `facts` since
      // there is nothing yet on the row for a null to overwrite.
      const { recipientName: factsName, ...factsWithoutName } = facts
      const updateFacts = factsName === null ? factsWithoutName : facts
      let outcome: MatchOutcome = await matchByEmail(c.recipientEmail, receivedAt, {
        bookedAt: c.bookedAt,
        consignmentId: c.consignmentId,
      })
      let linkSource: 'BRING_EMAIL' | 'FILE_NAME' = 'BRING_EMAIL'
      if (outcome.orderId === null && facts.recipientName) {
        // The name is the second key, and for a customer Bring holds no
        // email for it is the only one. The email's refusal is the more
        // useful sentence when there was an email, so it is kept then.
        const byName = await matchByName(facts.recipientName, receivedAt, {
          bookedAt: c.bookedAt, consignmentId: c.consignmentId, country: c.destinationCountry,
        })
        if (byName.orderId !== null) {
          outcome = byName
          linkSource = 'FILE_NAME'
        } else if (!c.recipientEmail) {
          outcome = byName
        }
      }
      if (outcome.orderId === null) {
        unmatched.push({
          orderNumber: c.recipientName ?? c.consignmentId,
          trackingNumber: c.packageNumbers[0],
          reason: outcome.reason,
        })
        // Stored, not dropped. A refusal used to survive only as a line of
        // JSON on the import; as a row it is listed on the Delivery page with
        // its reason and candidates, and the poller re-runs the match nightly
        // so a refusal the rules later resolve (the twin order gets its own
        // parcel) resolves itself. Due tomorrow: the parcel is not moving yet
        // and a person may link it first.
        for (const trackingNumber of c.packageNumbers) {
          await db.shipment.upsert({
            where: { trackingNumber },
            create: {
              trackingNumber,
              ...facts,
              unlinkedReason: outcome.reason,
              nextPollAt: new Date(receivedAt.getTime() + 24 * 60 * 60 * 1000),
            },
            // Never unlinks: a row a person or an earlier night already
            // attached keeps its order, and only learns the facts.
            update: { ...updateFacts },
          })
        }
        continue
      }
      for (const trackingNumber of c.packageNumbers) {
        await db.shipment.upsert({
          where: { trackingNumber },
          // Due immediately, so the next cron run picks it up.
          create: {
            trackingNumber,
            ...facts,
            orderId: outcome.orderId,
            linkSource,
            unlinkedReason: null,
            nextPollAt: new Date(),
          },
          // Facts only. Milestones, events and poll state are the sync's to
          // own, and the link is written below, never here - a re-import
          // must never move a link a person, or an earlier night, already
          // attached to a different order.
          update: { ...updateFacts },
        })
        // The link lands only on a row with no order yet. A row already
        // linked - by hand, or by an earlier night's import - keeps its
        // order no matter what today's file resolves the email to; only its
        // facts move.
        await db.shipment.updateMany({
          where: { trackingNumber, orderId: null },
          data: { orderId: outcome.orderId, linkSource, unlinkedReason: null },
        })
      }
      // Once per CONSIGNMENT, not per package: a two-package consignment
      // that matches still counts once here, so `linked` stays in the same
      // unit as `parsed` below and the two totals actually add up.
      linked++
    }

    for (const u of unresolved) {
      // A Bring-shaped number Bring does not know is not a verdict: the
      // warehouse prints one label series for every carrier it ships with, so
      // the number says who packed the parcel, not who carries it (17 of 17
      // such numbers checked on 2026-09-10 were DHL's). Stored with carrier
      // UNKNOWN and due now; the poller asks Bring again, then DHL, and the
      // first to answer owns the row - see lib/delivery/identify.ts.
      if (BRING_SHAPED.test(u.number)) {
        const name = labels?.names.get(u.number) ?? null
        await db.shipment.upsert({
          where: { trackingNumber: u.number },
          create: { trackingNumber: u.number, carrier: 'UNKNOWN', nextPollAt: new Date(), recipientName: name },
          // Adopt, never reset: it may already be identified, or mid-way.
          update: {},
        })
        const existing = await db.shipment.findUnique({
          where: { trackingNumber: u.number },
          select: { orderId: true },
        })
        if (existing && existing.orderId !== null) {
          // Already attached by an earlier import, a person, or the poller;
          // nothing to report - a re-upload must not read as a failure.
          linked++
          continue
        }
        let nameReason: string | null = null
        if (name) {
          // A row that had no name learns it; a carrier's own name, when one
          // exists, is never overwritten by the file's. Then the row tries to
          // attach on the spot - this is how re-uploading an old file links
          // the parcels that were stored before names were read.
          await db.shipment.updateMany({
            where: { trackingNumber: u.number, recipientName: null },
            data: { recipientName: name },
          })
          const row = await db.shipment.findUnique({ where: { trackingNumber: u.number }, select: ATTACH_SELECT })
          if (row && row.orderId === null) {
            const r = await attach(row)
            if (r.linked) {
              linked++
              continue
            }
            nameReason = r.reason
          }
        }
        unmatched.push({
          orderNumber: name ?? '(not identified)',
          trackingNumber: u.number,
          reason:
            (u.reason === 'Bring has no parcel with this number'
              ? 'Bring has not heard of this parcel yet - stored, the next check asks Bring again, then DHL'
              : `${u.reason} - stored, it will be retried by the next check`) +
            (nameReason ? ` - ${nameReason}` : ''),
        })
        continue
      }
      unmatched.push({
        orderNumber: '(not identified)',
        trackingNumber: u.number,
        reason: u.reason,
      })
    }

    // Consignments and the numbers Bring never resolved - not raw long
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
        namesRead: labels ? labels.rows : 0,
      },
    })

    return { importId: record.id, parsed, linked, unmatched, unaccounted, namesRead: labels ? labels.rows : 0 }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not import this file'
    // Derived from what was parsed, NOT as `unresolved.length + unmatched.length`.
    // A throw partway through the consignment loop leaves the consignments it
    // never reached counted in rowsParsed and in neither of the other two, so
    // the row would claim 27 parsed, 4 linked, 0 unmatched and quietly lose 23
    // parcels - against the promise ImportResult makes, that parsed is always
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
