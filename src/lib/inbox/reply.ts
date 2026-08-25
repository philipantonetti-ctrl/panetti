import { db } from '@/lib/db'
import { sendEmail } from '@/lib/email/send'
import { mintMessageId, replySubject } from './threading'

/**
 * A reply leaves from the ticket's mailbox - the brand's own address - and
 * carries the three headers that keep it in the customer's thread:
 *
 *   Message-ID   ours, minted BEFORE the send and stored with the row
 *   In-Reply-To  the customer's latest message (never our own last reply)
 *   References   every id in the conversation, oldest first
 *
 * The subject is theirs under one "Re:", plus our [PA-n] token for clients
 * that strip headers. Nothing is stored unless Postmark accepted the message:
 * a failed send must not leave a reply on screen that the customer never got.
 */
export async function sendTicketReply(ticketId: string, userId: string, text: string, now: Date = new Date()): Promise<{ messageId: string }> {
  const body = text.trim()
  if (!body) throw new Error('The reply is empty')

  const ticket = await db.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { mailbox: true, messages: { orderBy: { sentAt: 'asc' }, select: { direction: true, rfcMessageId: true } } },
  })

  // Synthetic postmark: ids stand in for mail that carried no Message-ID at
  // all; putting one in a References header would be noise no client can use.
  const chain = ticket.messages.map((m) => m.rfcMessageId).filter((x): x is string => !!x && !x.startsWith('postmark:'))
  const lastInbound = [...ticket.messages].reverse().find((m) => m.direction === 'INBOUND' && m.rfcMessageId && !m.rfcMessageId.startsWith('postmark:'))
  const messageId = mintMessageId(ticket.number, ticket.mailbox.address, now)
  const subject = replySubject(ticket.subject, ticket.number)
  const signed = ticket.mailbox.signature.trim() ? `${body}\n\n${ticket.mailbox.signature.trim()}` : body

  const headers: Record<string, string> = { 'Message-ID': messageId }
  if (lastInbound?.rfcMessageId) headers['In-Reply-To'] = `<${lastInbound.rfcMessageId}>`
  if (chain.length) headers['References'] = chain.map((id) => `<${id}>`).join(' ')

  const { postmarkId } = await sendEmail(ticket.customerEmail, subject, signed, { from: ticket.mailbox.address, headers })

  const message = await db.$transaction(async (tx) => {
    const m = await tx.ticketMessage.create({
      data: {
        ticketId, direction: 'OUTBOUND', authorUserId: userId,
        rfcMessageId: messageId.slice(1, -1),
        inReplyTo: lastInbound?.rfcMessageId ?? null,
        references: chain.join(' '),
        fromEmail: ticket.mailbox.address, toEmail: ticket.customerEmail,
        subject, textBody: signed, postmarkId, sentAt: now,
      },
    })
    // We answered; the ball is in the customer's court until they write back,
    // which ingest turns into OPEN again.
    await tx.ticket.update({ where: { id: ticketId }, data: { status: 'PENDING', lastMessageAt: now } })
    return m
  })
  return { messageId: message.id }
}

/** An internal note: same row shape, never sent, never changes the status. */
export async function addNote(ticketId: string, userId: string, text: string, now: Date = new Date()): Promise<{ messageId: string }> {
  const body = text.trim()
  if (!body) throw new Error('The note is empty')
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const m = await db.ticketMessage.create({
    data: { ticketId, direction: 'NOTE', authorUserId: userId, fromEmail: user.email, toEmail: '', textBody: body, sentAt: now },
  })
  return { messageId: m.id }
}
