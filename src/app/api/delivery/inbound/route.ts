import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { importWarehouseFile } from '@/lib/bring/import'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Reading a file and asking Bring about every parcel in it is not instant. */
export const maxDuration = 60

/**
 * Leaves 10s of the 60s ceiling for the parse, the database writes and the
 * response itself. Only the Bring lookups inside resolveConsignments check
 * this — one HTTP call per parcel, the one part of the chain that can
 * genuinely run long — so a slow Bring day stops the import cleanly instead
 * of the platform killing the function mid-write. Same shape as
 * SHOPS_DEADLINE_MS in api/cron/sync/route.ts.
 *
 * It is a budget for the WHOLE REQUEST, spent once and shared by every
 * attachment — see the single `deadline` computed before the loop below.
 */
const IMPORT_DEADLINE_MS = 50_000

/** What the warehouse could plausibly attach that we can actually read. */
const READABLE = /\.(xlsx|csv|txt|pdf)$/i

/** Refuse anything absurd before decoding it. A day's report is a few kilobytes. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/**
 * The base64 STRING length a decoded attachment of MAX_ATTACHMENT_BYTES can
 * reach, rounded up. Checked against the still-encoded string, before
 * `Buffer.from(..., 'base64')` runs, so a hostile attachment is refused
 * without ever materialising the decoded copy in memory.
 */
const MAX_ATTACHMENT_B64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4

/**
 * NOT admin-only, and deliberately so: Postmark is a machine and has no session.
 * A shared secret in the URL is the whole of the authentication, so it is
 * compared in constant time and the route does nothing at all before it passes.
 */
function authorised(req: Request): boolean {
  const expected = process.env.DELIVERY_INBOUND_SECRET
  if (!expected) return false
  const given = new URL(req.url).searchParams.get('token') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // A length mismatch still leaks that one bit — right length or not — same
  // as the throw below would. This only avoids timingSafeEqual THROWING on
  // mismatched lengths (and turning a bad token into a 500); it is not itself
  // a leak mitigation. Same trade as verifyWooSignature in lib/woo/webhooks.ts.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

type Attachment = { Name?: unknown; Content?: unknown; ContentID?: unknown }

/**
 * Who sent this, and is it who we expect?
 *
 * The URL token above authenticates POSTMARK, not the person who emailed. Until
 * this existed nothing read `From` at all, so anyone who learned the inbound
 * address could post a spreadsheet straight into the shipment data — and that
 * address has to be given to the warehouse for any of this to work, so it
 * cannot stay secret forever.
 *
 * A WARNING, never a refusal, and that is the whole design decision. As of
 * 2026-08-18 the warehouse has never sent a single email: Postmark's own record
 * shows three inbound messages ever, all internal tests. So the first real
 * report is precisely the one most likely to arrive from an address slightly
 * different from the one we were told, and refusing it would drop the file this
 * feature has been waiting weeks for. Importing it and saying so loudly costs
 * nothing and still surfaces the surprise, on the one screen built to show it.
 *
 * Unset means unchecked. Nobody has configured a sender yet, and an
 * unconfigured guard must not start flagging every ordinary morning.
 *
 * A sender we cannot read is not called unexpected either — we would be
 * asserting something we do not know. Postmark always sends `From`, so in
 * practice this only covers a malformed payload.
 *
 * Case-insensitive: mail addresses are not case sensitive, and a mailer that
 * upper-cases the domain must not raise an alarm every day.
 */
function senderWarning(body: { From?: unknown; FromFull?: { Email?: unknown } }): string | null {
  const expected = process.env.WAREHOUSE_SENDER?.trim().toLowerCase()
  if (!expected) return null

  const raw =
    typeof body?.FromFull?.Email === 'string'
      ? body.FromFull.Email
      : typeof body?.From === 'string'
        ? body.From
        : ''
  const actual = raw.trim().toLowerCase()
  if (!actual || actual === expected) return null

  return `Imported, but sent from ${actual} instead of ${expected}. Check who sent this.`
}

/**
 * Is this part of the message BODY rather than something enclosed with it?
 *
 * Postmark puts inline images in the same `Attachments` array as real files —
 * the company logo and the disclaimer graphic in an email signature arrive
 * exactly like an attached spreadsheet does. Without some test for it, every
 * ordinary warehouse email would write a refusal row for `image001.png` beside
 * its successful import, every single day, and the one screen whose whole job
 * is making a bad morning visible would be permanently red on good mornings.
 *
 * **`ContentID` cannot be that test on its own, and believing it was cost us a
 * day.** Gmail stamps a Content-ID on EVERY attachment. Measured from the raw
 * MIME of a real message on 2026-08-14, the warehouse report arrived carrying
 * `Content-Disposition: attachment` and `Content-ID: <f_mssm65ae0>` together on
 * the same part. Trusting ContentID alone skipped the spreadsheet, left
 * `recorded` at 0, and filed "This email carried no readable attachment" while
 * the file sat in the payload untouched.
 *
 * So the FILENAME decides first. A file this route can read is an enclosure
 * whatever ContentID says, because no email signature is ever an `.xlsx`,
 * `.csv`, `.txt` or `.pdf`. Only something we could not have imported anyway is
 * allowed to be written off as part of the body, which is what still keeps the
 * signature logo from writing a refusal row beside every good morning.
 *
 * The body's `cid:` references would be the textbook test, and it is
 * deliberately not used here: it depends on Postmark's `HtmlBody` field, whose
 * real contents we have not measured. This fix rests only on what the raw MIME
 * actually showed.
 *
 * `ContentType` is deliberately NOT a signal either. Skipping every `image/*`
 * would also swallow a screenshot someone genuinely attached INSTEAD of the
 * report, and that is a real refusal an operator needs to see.
 */
function isInline(a: Attachment): boolean {
  const name = typeof a?.Name === 'string' ? a.Name : ''
  if (READABLE.test(name)) return false
  return typeof a?.ContentID === 'string' && a.ContentID.trim() !== ''
}

/**
 * The durable trace of one delivery we refused to read.
 *
 * Best-effort, exactly like recordFailedAttempt in lib/bring/import.ts: if the
 * database is what failed, this bookkeeping write fails too and must not turn a
 * refused attachment into a 500 that makes Postmark redeliver forever.
 */
function recordRefusal(filename: string, error: string) {
  return db.trackingImport
    .create({
      data: {
        filename,
        source: 'EMAIL',
        rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0,
        error,
      },
    })
    .catch(() => {})
}

/**
 * One inbound email from the warehouse.
 *
 * Answers 200 to almost everything on purpose. Postmark redelivers on a
 * non-2xx, and a file we have already taken and failed to parse will fail
 * exactly the same way on every retry — so a failure is RECORDED, in
 * TrackingImport, and acknowledged. The delivery page is where a bad morning
 * becomes visible; the retry queue is not.
 */
export async function POST(req: Request) {
  if (!authorised(req))
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401, headers: NO_STORE })

  let body: { Attachments?: unknown; From?: unknown; FromFull?: { Email?: unknown } }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400, headers: NO_STORE })
  }

  // Per email, not per attachment — one sender sends the whole message.
  const oddSender = senderWarning(body)

  const attachments = Array.isArray(body.Attachments) ? (body.Attachments as Attachment[]) : []
  const results: { filename: string; linked?: number; error?: string }[] = []
  // How many attachments left a TrackingImport row behind, by any route: one
  // importWarehouseFile wrote (success or its own recordFailedAttempt), or one
  // recordRefusal wrote for an attachment we would not even open. NOT
  // results.length — `results` is the JSON body handed to Postmark and no human
  // ever reads it. This counts the durable traces, which is what decides
  // whether the catch-all row at the bottom is a needed record or a duplicate.
  let recorded = 0

  // ONE budget for the whole request, spent before the loop rather than inside
  // it. Computed per attachment, two readable attachments each claimed a fresh
  // 50s against a 60s maxDuration for the request as a whole — and a platform
  // timeout is not a JS throw, so nothing in importWarehouseFile's guard runs:
  // no row is written, no 200 is returned, and Postmark redelivers the same
  // payload forever.
  const deadline = Date.now() + IMPORT_DEADLINE_MS

  for (const a of attachments) {
    // Checked FIRST, and skipped completely: no `results` entry, no
    // TrackingImport row, and — the part that matters — not counted in
    // `recorded`. A signature logo is not a delivery. So an email whose ONLY
    // attachments are inline images still falls through to the "nothing
    // readable arrived" row at the bottom, which is right: a signature with no
    // report is still a morning where nothing came, and it must not be allowed
    // to look like a quiet day.
    //
    // The one thing this can get wrong is a mailer that stamps a ContentID on a
    // real enclosure too, which would drop the report. That fails visibly, not
    // silently: nothing is recorded, so `recorded` stays 0 and the bottom row
    // says the email carried nothing readable.
    if (isInline(a)) continue

    const filename = typeof a?.Name === 'string' ? a.Name : ''
    const content = typeof a?.Content === 'string' ? a.Content : ''

    if (!filename || !READABLE.test(filename) || !content) {
      // Recorded in TrackingImport, not merely in `results`. A bare `continue`
      // here used to mean a skipped attachment left no trace whenever a SIBLING
      // attachment in the same email succeeded — the report renamed `eod.xls`
      // vanished behind the `notes.txt` that happened to ride along — and
      // pushing it into `results` alone did not fix that, because `results` is
      // handed back to Postmark and read by nobody. The delivery page reads
      // TrackingImport, so that is where a refusal has to land.
      const error = !filename
        ? 'This email carried an attachment with no filename'
        : !content
          ? `This email carried no content for ${filename}`
          : `${filename} is not a file type this route can read`
      const named = filename || '(unnamed attachment)'
      results.push({ filename: named, error })
      await recordRefusal(named, error)
      recorded++
      continue
    }

    // Gate on the still-encoded length before decoding: a hostile attachment
    // is refused without ever materialising the decoded copy.
    if (content.length > MAX_ATTACHMENT_B64_CHARS) {
      const error = `${filename} is too large to read`
      results.push({ filename, error })
      await recordRefusal(filename, error)
      recorded++
      continue
    }

    const buf = Buffer.from(content, 'base64')
    recorded++

    try {
      const r = await importWarehouseFile(buf, filename, 'EMAIL', { deadline })
      results.push({ filename, linked: r.linked })

      // Onto the import's OWN row, so the Imports list stays one line per file:
      // what arrived, whether it worked, and anything odd about it. Written
      // after the import rather than before because only now is there a row to
      // write on.
      //
      // Best-effort, exactly like recordRefusal above: a note about the sender
      // must never turn a successful import into a 500 that makes Postmark
      // redeliver a file we have already taken.
      //
      // Only the success path. When the import throws it has already recorded
      // its own reason, and that reason is what an operator needs first — a
      // sender note would overwrite the thing that actually went wrong.
      if (oddSender) {
        await db.trackingImport
          .update({ where: { id: r.importId }, data: { error: oddSender } })
          .catch(() => {})
      }
    } catch (e) {
      // importWarehouseFile guards every step that can fail — parsing,
      // Bring, matching, the Shipment and TrackingImport writes — and
      // records a TrackingImport row before rethrowing (best-effort: see
      // recordFailedAttempt in lib/bring/import.ts). This branch exists so
      // that throw still resolves to a 200 for Postmark, not a second,
      // duplicate database write.
      console.error(e)
      results.push({ filename, error: e instanceof Error ? e.message : 'Import failed' })
    }
  }

  if (recorded === 0) {
    // Nothing in this email left a trace anywhere: no attachments at all, or
    // none that were more than part of the message body. An email that arrived
    // and said nothing is still the event nobody would otherwise notice, so it
    // gets its own row and the delivery page can tell it apart from a morning
    // the warehouse never wrote.
    //
    // Filed as '(none)' even when a signature image did ride along, because the
    // claim this row makes is about ENCLOSURES: nothing came that we could have
    // read. A logo in a footer is not a delivery.
    //
    // Deliberately NOT written when an attachment was already recorded above,
    // whether it was refused (recordRefusal) or reached importWarehouseFile and
    // threw (recordFailedAttempt in lib/bring/import.ts). Those rows name the
    // file and the reason; a second, vaguer row for the same delivery would
    // only be a confusing duplicate.
    await recordRefusal('(none)', 'This email carried no readable attachment')
  }

  return NextResponse.json({ ok: true, results }, { headers: NO_STORE })
}
