import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { ingestInbound, type InboundPayload } from '@/lib/inbox/ingest'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Attachments arrive inline and a thread can be long; parsing is not instant. */
export const maxDuration = 60

/**
 * NOT admin-only, and deliberately so: Postmark is a machine and has no
 * session. A shared secret in the URL is the whole of the authentication -
 * the same arrangement api/delivery/inbound already runs on - so it is
 * compared in constant time and nothing happens before it passes.
 */
function authorised(req: Request): boolean {
  const expected = process.env.INBOX_INBOUND_SECRET
  if (!expected) return false
  const given = new URL(req.url).searchParams.get('token') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * One inbound email from Postmark.
 *
 * Unlike the delivery intake, a failure here is allowed to be a 500: Postmark
 * retries ten times over six hours, which is exactly right for a database
 * that was briefly unreachable, and the unique Message-ID makes every retry
 * of a message we DID store a no-op. Only the outcomes that would fail
 * identically forever - not our mailbox, an autoresponder, our own mail -
 * are acknowledged with a 200, so they never come back.
 */
export async function POST(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorised' }, { status: 401, headers: NO_STORE })

  let body: InboundPayload
  try {
    body = (await req.json()) as InboundPayload
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400, headers: NO_STORE })
  }

  try {
    const result = await ingestInbound(body)
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ ok: false, error: 'Could not store the email' }, { status: 500, headers: NO_STORE })
  }
}
