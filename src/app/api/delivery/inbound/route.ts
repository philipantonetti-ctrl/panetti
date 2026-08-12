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

type Attachment = { Name?: unknown; Content?: unknown }

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

  let body: { Attachments?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400, headers: NO_STORE })
  }

  const attachments = Array.isArray(body.Attachments) ? (body.Attachments as Attachment[]) : []
  const results: { filename: string; linked?: number; error?: string }[] = []

  for (const a of attachments) {
    const filename = typeof a?.Name === 'string' ? a.Name : ''
    const content = typeof a?.Content === 'string' ? a.Content : ''

    if (!filename || !READABLE.test(filename) || !content) {
      // A bare `continue` here used to mean a skipped attachment left no
      // trace whenever a SIBLING attachment in the same email succeeded: the
      // loop still produced a non-empty `results`, so the "nothing readable
      // at all" record below never ran either, and a renamed report
      // (eod.xls instead of eod.xlsx) vanished behind a notes.txt that
      // happened to ride along. Recorded per-attachment instead.
      results.push({
        filename: filename || '(unnamed attachment)',
        error: !filename
          ? 'No filename'
          : !content
            ? 'No content'
            : 'Not a file type this route can read',
      })
      continue
    }

    // Gate on the still-encoded length before decoding: a hostile attachment
    // is refused without ever materialising the decoded copy.
    if (content.length > MAX_ATTACHMENT_B64_CHARS) {
      results.push({ filename, error: 'Attachment too large' })
      continue
    }

    const buf = Buffer.from(content, 'base64')

    try {
      const r = await importWarehouseFile(buf, filename, 'EMAIL', {
        deadline: Date.now() + IMPORT_DEADLINE_MS,
      })
      results.push({ filename, linked: r.linked })
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

  if (results.length === 0) {
    // An email whose Attachments carried nothing at all — not even a wrong
    // extension to skip and record above — is the one case left with no
    // per-attachment entry to point at, so it still gets its own row: the
    // event nobody would otherwise notice, linking simply stops and the page
    // looks like a quiet day.
    await db.trackingImport
      .create({
        data: {
          filename: attachments.map((a) => String(a?.Name ?? '?')).join(', ') || '(none)',
          source: 'EMAIL',
          rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0,
          error: 'This email carried no readable attachment',
        },
      })
      .catch(() => {})
  }

  return NextResponse.json({ ok: true, results }, { headers: NO_STORE })
}
