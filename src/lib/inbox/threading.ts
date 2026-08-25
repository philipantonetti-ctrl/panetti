import { randomBytes } from 'crypto'

/** One header as Postmark's inbound webhook hands it over. */
export type Header = { Name: string; Value: string }

export function headerValue(headers: Header[], name: string): string | null {
  const want = name.toLowerCase()
  const hit = headers.find((h) => typeof h?.Name === 'string' && h.Name.toLowerCase() === want)
  return hit && typeof hit.Value === 'string' ? hit.Value : null
}

/**
 * Every message id in a header value, brackets stripped, in order. A bare id
 * with no brackets is accepted too: the RFC requires them, some clients omit
 * them, and a reply that fails to thread because of a missing '<' is a ticket
 * duplicated for nothing.
 */
export function messageIdsIn(value: string | null): string[] {
  if (!value) return []
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1])
  if (bracketed.length) return bracketed
  const bare = value.trim()
  return bare && !/\s/.test(bare) ? [bare] : []
}

export type ThreadRefs = {
  messageId: string | null
  inReplyTo: string | null
  references: string[]
}

export function threadRefs(headers: Header[]): ThreadRefs {
  return {
    messageId: messageIdsIn(headerValue(headers, 'Message-ID'))[0] ?? null,
    inReplyTo: messageIdsIn(headerValue(headers, 'In-Reply-To'))[0] ?? null,
    references: messageIdsIn(headerValue(headers, 'References')),
  }
}

/**
 * Our own token in a subject line, the fallback for clients that strip the
 * threading headers. The same shape Zendesk keeps ([1G7EOR-0Q2J]) for the
 * same reason.
 */
const TICKET_TOKEN = /\[PA-(\d+)\]/

export function ticketNumberIn(subject: string): number | null {
  const m = TICKET_TOKEN.exec(subject)
  return m ? Number(m[1]) : null
}

export const ticketToken = (number: number): string => `[PA-${number}]`

/**
 * Gmail threads on headers AND a matching subject, so the customer's subject is
 * kept as-is under a single "Re:" — never rewritten — with our token added
 * once at the end.
 */
export function replySubject(subject: string, number: number): string {
  const base = subject.trim() || 'Your message'
  const withRe = /^re:/i.test(base) ? base : `Re: ${base}`
  return ticketNumberIn(withRe) === number ? withRe : `${withRe} ${ticketToken(number)}`
}

/**
 * A Message-ID of our own, minted BEFORE the send. Building the References
 * chain from ids we chose means it never depends on reading anything back
 * from Postmark, which returns only its own UUID.
 */
export function mintMessageId(ticketNumber: number, mailboxAddress: string, now: Date = new Date()): string {
  const domain = mailboxAddress.split('@')[1] ?? 'localhost'
  return `<pa${ticketNumber}.${now.getTime().toString(36)}.${randomBytes(4).toString('hex')}@${domain}>`
}

/**
 * An autoresponder, by the headers the RFCs and Zendesk agree on. Answering
 * one is how two helpdesks talk to each other until someone pulls the plug.
 */
export function isAutomated(headers: Header[]): boolean {
  const auto = headerValue(headers, 'Auto-Submitted')
  if (auto && auto.trim().toLowerCase() !== 'no') return true
  const precedence = headerValue(headers, 'Precedence')?.trim().toLowerCase()
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true
  return headerValue(headers, 'X-Autoreply') !== null || headerValue(headers, 'X-Autorespond') !== null
}

/** Postmark runs SpamAssassin on inbound and stamps the score; 5 is its threshold. */
export function spamScoreOf(headers: Header[]): number | null {
  const raw = headerValue(headers, 'X-Spam-Score')
  if (raw === null) return null
  const n = Number(raw.trim())
  return Number.isFinite(n) ? n : null
}
