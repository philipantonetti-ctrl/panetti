import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { handleChatMessage } from '@/lib/support/chat'
import { fetchTicketMessages, gorgiasCredentials } from '@/lib/support/client'
import { gorgiasChannel, isAutomaticMessage } from '@/lib/support/gorgias-channel'
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
   * A chat: the chat turn owns it, agent messages included, because telling
   * its own replies from a person's is its job.
   *
   * WHICH SHOP is read from the chat itself. One Gorgias account serves every
   * shop, an HTTP integration fires for all ten of its chat widgets, and
   * Gorgias has no rule action that triggers one (their rule glossary lists
   * twenty-one actions; none calls an integration). So a shop in the URL would
   * answer a Norwegian chat from the Danish shop's pages. The customer's
   * chat messages carry the widget's id as `integration_id` - measured on live
   * tickets - and the shop is the one that widget was linked to on the
   * settings page. A `shop` in the URL is honoured
   * only as a second lock: it must name the same shop.
   *
   * The MESSAGE is read from the API rather than taken from the body. Gorgias
   * documents no `message` template scope for an HTTP integration - their
   * macro reference says outright that it does not document `from_agent` -
   * and that field is what stops the assistant answering itself. So the
   * template passes ticket facts, which Gorgias does document, and the three
   * facts about the message come from the TicketMessage object, which it
   * also documents.
   */
  const urlShop = new URL(req.url).searchParams.get('shop')?.trim() || null
  const isChat = body.channel === 'chat' || body.via === 'gorgias_chat' || body.via === 'offline_capture'
  if (isChat) {
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
      // What Gorgias wrote by itself is passed over: the widget's "back in 9
      // minutes" lands a millisecond after the customer's first message, and
      // taking it for the newest message would answer nobody. An internal
      // note is passed over too: the assistant's own draft note comes back
      // through this trigger, and the customer never saw it.
      const messages = (await fetchTicketMessages(creds, ticketId)).filter(
        (m) => m.public !== false && !isAutomaticMessage(m),
      )
      const newest = messages[messages.length - 1]
      if (!newest) {
        return NextResponse.json(
          { ok: true, decision: 'skipped', reason: 'The ticket has no message to read' },
          { headers: NO_STORE },
        )
      }
      // The widget is the one the CUSTOMER wrote through. An agent's reply
      // to a chat left overnight goes out by email and carries the email
      // integration's id instead (live ticket 240772034, 2026-09-21).
      const widget =
        messages.find((m) => m.from_agent !== true && m.channel === 'chat' && m.integration_id != null)?.integration_id ??
        messages.find((m) => m.channel === 'chat' && m.integration_id != null)?.integration_id ??
        null
      const shop = widget === null ? null : await db.shop.findFirst({ where: { gorgiasChatId: String(widget) }, select: { id: true } })
      if (!shop) {
        return NextResponse.json(
          { ok: true, decision: 'skipped', reason: 'This chat widget is not linked to a shop.' },
          { headers: NO_STORE },
        )
      }
      if (urlShop && urlShop !== shop.id) {
        return NextResponse.json(
          { ok: true, decision: 'skipped', reason: 'This chat belongs to another shop than the URL names.' },
          { headers: NO_STORE },
        )
      }
      const shopId = shop.id
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
