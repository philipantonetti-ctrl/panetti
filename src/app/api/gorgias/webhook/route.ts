import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { handleChatMessage } from '@/lib/support/chat'
import { fetchTicketMessages, gorgiasCredentials } from '@/lib/support/client'
import { gorgiasChannel } from '@/lib/support/gorgias-channel'
import { handleMessage } from '@/lib/support/handle'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Reading the ticket, asking the assistant and answering is not instant. */
export const maxDuration = 120

/**
 * A new customer message, pushed to us by Gorgias.
 *
 * Gorgias calls this on its ticket-created and ticket-message-created
 * triggers, with a body we define ourselves in their HTTP integration. The
 * shape is therefore ours, not theirs, and it is deliberately small: the
 * conversation id, who wrote, and what they said.
 *
 * IMPORTANT, measured from their documentation: Gorgias does NOT retry a
 * non-2xx response. A failure here is a customer message lost, so this
 * answers 200 to everything it has taken responsibility for and records the
 * problem on the conversation instead.
 */
function authorised(req: Request): boolean {
  const expected = process.env.GORGIAS_WEBHOOK_SECRET
  if (!expected) return false
  const given = new URL(req.url).searchParams.get('token') ?? req.headers.get('X-Panetti-Secret') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

type Body = {
  ticketId?: string | number
  /** chat | email | ... as Gorgias names the ticket's channel. */
  channel?: string
  /** ISO time the ticket was created; compared with the shop's chat switch. */
  ticketCreatedAt?: string
  customerEmail?: string
  customerName?: string
  subject?: string
  message?: string
  via?: string
  /** True when the message was written by an agent, so we do not answer ourselves. */
  fromAgent?: boolean
}

export async function POST(req: Request) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401, headers: NO_STORE })
  }

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400, headers: NO_STORE })
  }

  const ticketId = body.ticketId === undefined ? '' : String(body.ticketId).trim()
  if (!ticketId) {
    return NextResponse.json({ error: 'Which ticket?' }, { status: 400, headers: NO_STORE })
  }

  /**
   * A chat, on a shop named in the URL: the chat turn owns it, agent messages
   * included, because telling its own replies from a person's is its job.
   * Without a shop the body is handled the old way, as an email-style ticket.
   *
   * The MESSAGE is read from the API rather than taken from the body. Gorgias
   * documents no `message` template scope for an HTTP integration - their
   * macro reference says outright that it does not document `from_agent` -
   * and that field is what stops the assistant answering itself. So the
   * template passes ticket facts, which Gorgias does document, and the three
   * facts about the message come from the TicketMessage object, which it
   * also documents.
   */
  const shopId = new URL(req.url).searchParams.get('shop')?.trim() || null
  const isChat = body.channel === 'chat' || body.via === 'gorgias_chat' || body.via === 'offline_capture'
  if (shopId && isChat) {
    const creds = gorgiasCredentials()
    if (!creds) {
      return NextResponse.json(
        { ok: true, decision: 'skipped', reason: 'Gorgias credentials are not configured' },
        { headers: NO_STORE },
      )
    }
    try {
      // Oldest first, so the newest is the one that woke us. A message that
      // arrived while we were being called is newer still, and answering that
      // one is right: `superseded` in the chat turn settles the ordering.
      const messages = await fetchTicketMessages(creds, ticketId)
      const newest = messages[messages.length - 1]
      if (!newest) {
        return NextResponse.json(
          { ok: true, decision: 'skipped', reason: 'The ticket has no message to read' },
          { headers: NO_STORE },
        )
      }
      const via = newest.via ?? body.via ?? 'chat'
      const channel = gorgiasChannel(via)
      if (!channel) {
        return NextResponse.json(
          { ok: true, decision: 'skipped', reason: 'Gorgias credentials are not configured' },
          { headers: NO_STORE },
        )
      }
      const startedAt = body.ticketCreatedAt ? new Date(body.ticketCreatedAt) : null
      const result = await handleChatMessage(
        {
          shopId,
          conversationId: ticketId,
          messageId: String(newest.id),
          customerEmail: body.customerEmail?.trim().toLowerCase() || null,
          customerName: body.customerName?.trim() || null,
          text: newest.body_text ?? '',
          via,
          fromAgent: newest.from_agent === true,
          conversationStartedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
        },
        { channel },
      )
      return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE })
    } catch (e) {
      // 200 deliberately, for the same reason as below: Gorgias does not retry.
      console.error(e)
      return NextResponse.json({ ok: false, decision: 'failed', error: 'Could not handle the message' }, { headers: NO_STORE })
    }
  }

  // Our own replies and our own notes come back through the same trigger.
  // Answering them would be a machine talking to itself forever.
  if (body.fromAgent === true) {
    return NextResponse.json({ ok: true, decision: 'skipped', reason: 'written by an agent' }, { headers: NO_STORE })
  }

  const channel = gorgiasChannel(body.via ?? null)
  if (!channel) {
    return NextResponse.json(
      { ok: true, decision: 'skipped', reason: 'Gorgias credentials are not configured' },
      { headers: NO_STORE },
    )
  }

  try {
    const result = await handleMessage(channel, {
      conversationId: ticketId,
      customerEmail: body.customerEmail?.trim().toLowerCase() || null,
      customerName: body.customerName?.trim() || null,
      text: body.message ?? '',
      subject: body.subject?.trim() || null,
      via: body.via ?? null,
    })
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE })
  } catch (e) {
    // 200 deliberately. Gorgias does not retry, so a 500 here would simply
    // lose the message; the error is ours to find in the log, not theirs to
    // resend.
    console.error(e)
    return NextResponse.json(
      { ok: false, decision: 'failed', error: 'Could not handle the message' },
      { headers: NO_STORE },
    )
  }
}
