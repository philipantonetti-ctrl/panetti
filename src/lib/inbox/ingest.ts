import { db } from '@/lib/db'
import { categorize, detectLanguage } from './classify'
import { matchOrder } from './match'
import { isAutomated, spamScoreOf, threadRefs, ticketNumberIn, type Header } from './threading'

/** The fields of Postmark's inbound webhook this code reads. */
export type InboundPayload = {
  From: string
  FromName?: string
  FromFull?: { Email?: string; Name?: string }
  To: string
  ToFull?: { Email?: string; Name?: string }[]
  Cc?: string
  CcFull?: { Email?: string; Name?: string }[]
  OriginalRecipient?: string
  Subject: string
  MessageID: string
  Date?: string
  TextBody?: string
  HtmlBody?: string
  StrippedTextReply?: string
  Headers?: Header[]
  Attachments?: { Name?: string; ContentType?: string; ContentLength?: number; Content?: string }[]
}

export type IngestResult =
  | { outcome: 'created' | 'continued'; ticketId: string; messageId: string }
  | { outcome: 'duplicate'; ticketId: string }
  | { outcome: 'automated' | 'ignored_own' | 'no_mailbox' }

/** Postmark caps a whole inbound message at 35 MB; one file here at 10. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_B64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4

/** A second mail from the same person, this soon, is the same conversation. */
const SAME_SENDER_WINDOW_DAYS = 14

const lower = (s: string | undefined | null) => (s ?? '').trim().toLowerCase()

/** Every address the mail was delivered to, in the order Postmark is surest of. */
function recipients(p: InboundPayload): string[] {
  const list = [
    lower(p.OriginalRecipient),
    ...(p.ToFull ?? []).map((t) => lower(t.Email)),
    ...(p.CcFull ?? []).map((t) => lower(t.Email)),
    ...(p.To ?? '').split(',').map((t) => lower(/<([^>]+)>/.exec(t)?.[1] ?? t)),
  ]
  return [...new Set(list.filter(Boolean))]
}

function sender(p: InboundPayload): { email: string; name: string } {
  const email = lower(p.FromFull?.Email) || lower(/<([^>]+)>/.exec(p.From)?.[1] ?? p.From)
  const name = (p.FromFull?.Name ?? p.FromName ?? '').trim()
  return { email, name }
}

/**
 * One inbound email becomes a ticket. The order of the checks is the design:
 *
 *  1. Which mailbox? By the address it was sent TO. None: not ours.
 *  2. From ourselves? Drop it: that is how two helpdesks talk forever.
 *  3. Seen this Message-ID? Postmark redelivers on any non-200; the unique
 *     column makes the second delivery a no-op instead of a second ticket.
 *  4. An autoresponder? Never opens a ticket.
 *  5. Which ticket? References/In-Reply-To against every id we hold, then
 *     our own [PA-n] subject token, then an open conversation with the same
 *     sender on the same mailbox. Never across mailboxes - a token from
 *     another brand's ticket is treated as no token.
 *
 * The message row and the ticket write land in one transaction.
 */
export async function ingestInbound(p: InboundPayload, now: Date = new Date()): Promise<IngestResult> {
  const headers = p.Headers ?? []
  const to = recipients(p)
  const mailboxes = await db.mailbox.findMany({ where: { active: true, address: { in: to } } })
  const mailbox = to.map((a) => mailboxes.find((m) => m.address === a)).find(Boolean)
  if (!mailbox) return { outcome: 'no_mailbox' }

  const from = sender(p)
  if (await db.mailbox.findFirst({ where: { address: from.email }, select: { id: true } })) return { outcome: 'ignored_own' }

  const refs = threadRefs(headers)
  // Postmark's own UUID stands in when a mailer sent no Message-ID: rare, but
  // without it such a mail would be stored once per redelivery.
  const rfcMessageId = refs.messageId ?? `postmark:${p.MessageID}`
  const seen = await db.ticketMessage.findUnique({ where: { rfcMessageId }, select: { ticketId: true } })
  if (seen) return { outcome: 'duplicate', ticketId: seen.ticketId }

  if (isAutomated(headers)) return { outcome: 'automated' }

  const text = (p.TextBody ?? '').trim()
  const stripped = (p.StrippedTextReply ?? '').trim() || null
  const subject = (p.Subject ?? '').trim()
  const sentAt = p.Date && !Number.isNaN(Date.parse(p.Date)) ? new Date(p.Date) : now

  const existing = await findTicket(mailbox.id, refs.inReplyTo, refs.references, subject, from.email, now)

  const attachments = (p.Attachments ?? []).flatMap((a) => {
    const name = typeof a.Name === 'string' ? a.Name : ''
    const content = typeof a.Content === 'string' ? a.Content : ''
    // Judged on the still-encoded length so a whale is refused before it is
    // ever decoded into memory - the delivery intake's own rule.
    if (!name || !content || content.length > MAX_ATTACHMENT_B64_CHARS) return []
    const buf = Buffer.from(content, 'base64')
    return [{ filename: name, contentType: a.ContentType || 'application/octet-stream', sizeBytes: buf.length, content: buf }]
  })

  const message = {
    direction: 'INBOUND',
    rfcMessageId,
    inReplyTo: refs.inReplyTo,
    references: refs.references.join(' '),
    fromEmail: from.email,
    toEmail: mailbox.address,
    subject,
    textBody: text,
    htmlBody: p.HtmlBody || null,
    strippedReply: stripped,
    spamScore: spamScoreOf(headers),
    postmarkId: p.MessageID || null,
    sentAt,
    attachments: { create: attachments },
  }

  if (existing) {
    // A first match is attempted now if none was ever made - BEFORE the
    // transaction: matchOrder is several reads, one of them wide, and holding
    // a pooled connection open while asking for more is how a busy serverless
    // pool starves itself.
    const match = existing.matchedOrderId ? null : await matchOrder({ email: from.email, text: `${subject}\n${text}`, shopId: mailbox.shopId })
    try {
      const created = await db.$transaction(async (tx) => {
        const m = await tx.ticketMessage.create({ data: { ...message, ticketId: existing.id } })
        // The customer wrote again: whatever state the ticket was in, someone
        // must look.
        await tx.ticket.update({
          where: { id: existing.id },
          data: { status: 'OPEN', closedAt: null, lastMessageAt: sentAt, ...(match ? { matchedOrderId: match.orderId } : {}) },
        })
        return m
      })
      return { outcome: 'continued', ticketId: existing.id, messageId: created.id }
    } catch (e) {
      return (await duplicateOf(e, rfcMessageId)) ?? Promise.reject(e)
    }
  }

  const match = await matchOrder({ email: from.email, text: `${subject}\n${text}`, shopId: mailbox.shopId })
  try {
    const ticket = await db.ticket.create({
      data: {
        mailboxId: mailbox.id,
        subject: subject || '(no subject)',
        customerEmail: from.email,
        customerName: from.name,
        category: categorize(subject, text),
        language: detectLanguage(`${subject}\n${text}`),
        matchedOrderId: match?.orderId ?? null,
        firstMessageAt: sentAt,
        lastMessageAt: sentAt,
        messages: { create: message },
      },
      include: { messages: { select: { id: true } } },
    })
    return { outcome: 'created', ticketId: ticket.id, messageId: ticket.messages[0].id }
  } catch (e) {
    return (await duplicateOf(e, rfcMessageId)) ?? Promise.reject(e)
  }
}

/**
 * Two deliveries of one message can pass the dedupe check together; the
 * unique column then rejects the second insert. That is the idempotency
 * WORKING, not an error - answer as the duplicate it is, so Postmark gets
 * its 200 and never redelivers.
 */
async function duplicateOf(e: unknown, rfcMessageId: string): Promise<IngestResult | null> {
  const p2002 = typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
  if (!p2002) return null
  const seen = await db.ticketMessage.findUnique({ where: { rfcMessageId }, select: { ticketId: true } })
  return seen ? { outcome: 'duplicate', ticketId: seen.ticketId } : null
}

async function findTicket(
  mailboxId: string, inReplyTo: string | null, references: string[], subject: string, fromEmail: string, now: Date,
): Promise<{ id: string; matchedOrderId: string | null } | null> {
  const ids = [...new Set([inReplyTo, ...references].filter((x): x is string => !!x))]
  if (ids.length) {
    const hit = await db.ticketMessage.findFirst({
      where: { rfcMessageId: { in: ids }, ticket: { mailboxId } },
      select: { ticket: { select: { id: true, matchedOrderId: true } } },
    })
    if (hit) return hit.ticket
  }
  const number = ticketNumberIn(subject)
  if (number !== null) {
    const byToken = await db.ticket.findFirst({ where: { number, mailboxId }, select: { id: true, matchedOrderId: true } })
    if (byToken) return byToken
  }
  const since = new Date(now.getTime() - SAME_SENDER_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  return db.ticket.findFirst({
    where: { mailboxId, customerEmail: fromEmail, status: { not: 'CLOSED' }, lastMessageAt: { gte: since } },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true, matchedOrderId: true },
  })
}
