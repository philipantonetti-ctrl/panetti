import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { importWarehouseFile } from '@/lib/bring/import'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Reading a file and asking Bring about every parcel in it is not instant. */
export const maxDuration = 60

/** What the warehouse could plausibly attach that we can actually read. */
const READABLE = /\.(xlsx|csv|txt|pdf)$/i

/** Refuse anything absurd before decoding it. A day's report is a few kilobytes. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

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
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
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
    if (!filename || !READABLE.test(filename) || !content) continue

    const buf = Buffer.from(content, 'base64')
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      results.push({ filename, error: 'Attachment too large' })
      continue
    }

    try {
      const r = await importWarehouseFile(buf, filename, 'EMAIL')
      results.push({ filename, linked: r.linked })
    } catch (e) {
      // importWarehouseFile has already written its own TrackingImport row.
      console.error(e)
      results.push({ filename, error: e instanceof Error ? e.message : 'Import failed' })
    }
  }

  if (results.length === 0) {
    // An email that carried nothing we could read is exactly the event nobody
    // would otherwise notice: linking simply stops and the page looks like a
    // quiet day.
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
