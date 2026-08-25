import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'
import { addNote, sendTicketReply } from './reply'

const DOMAIN = 'reply.inbox-test.invalid'
const SUPPORT = `support@${DOMAIN}`
let ticketId: string, userId: string, mailboxId: string

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>
const postmarkOk = () => vi.fn<Fetch>(async () => new Response('{"MessageID":"pm-9"}', { status: 200 }))

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
  await db.user.deleteMany({ where: { email: `agent@${DOMAIN}` } })
}
afterAll(cleanup)
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

beforeEach(async () => {
  await cleanup()
  vi.stubEnv('POSTMARK_SERVER_TOKEN', 'tok')
  userId = (await db.user.create({ data: { email: `agent@${DOMAIN}`, passwordHash: 'x', role: 'ADMIN' } })).id
  mailboxId = (await db.mailbox.create({ data: { address: SUPPORT, name: 'Panetti', signature: 'Med vennlig hilsen\nPanetti' } })).id
  const t = await db.ticket.create({
    data: {
      mailboxId, subject: 'Hvor er ordre #1042?', customerEmail: 'kari.reply@example.com', customerName: 'Kari',
      firstMessageAt: new Date('2026-08-20T08:00:00Z'), lastMessageAt: new Date('2026-08-20T08:00:00Z'),
      messages: { create: [{ direction: 'INBOUND', rfcMessageId: 'm1.reply@gmail.com', fromEmail: 'kari.reply@example.com', toEmail: SUPPORT, textBody: 'hvor?', sentAt: new Date('2026-08-20T08:00:00Z') }] },
    },
  })
  ticketId = t.id
})

describe('sendTicketReply', () => {
  it('sends from the mailbox, to the customer, threaded onto their message, signed, and records it', async () => {
    const fn = postmarkOk()
    vi.stubGlobal('fetch', fn)

    const r = await sendTicketReply(ticketId, userId, 'Den er på vei.')

    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.From).toBe(SUPPORT)
    expect(body.To).toBe('kari.reply@example.com')
    const number = (await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).number
    expect(body.Subject).toBe(`Re: Hvor er ordre #1042? [PA-${number}]`)
    expect(body.TextBody).toBe('Den er på vei.\n\nMed vennlig hilsen\nPanetti')
    const h = Object.fromEntries(body.Headers.map((x: { Name: string; Value: string }) => [x.Name, x.Value]))
    expect(h['In-Reply-To']).toBe('<m1.reply@gmail.com>')
    expect(h['References']).toBe('<m1.reply@gmail.com>')
    expect(h['Message-ID']).toMatch(new RegExp(`^<pa${number}\\..+@${DOMAIN}>$`))

    const m = await db.ticketMessage.findUniqueOrThrow({ where: { id: r.messageId } })
    expect(m).toMatchObject({ direction: 'OUTBOUND', authorUserId: userId, fromEmail: SUPPORT, toEmail: 'kari.reply@example.com', inReplyTo: 'm1.reply@gmail.com', references: 'm1.reply@gmail.com', postmarkId: 'pm-9' })
    expect(`<${m.rfcMessageId}>`).toBe(h['Message-ID'])
    const t = await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })
    expect(t.status).toBe('PENDING')
  })

  it('the second reply references the whole chain, oldest first, still answering the customer', async () => {
    vi.stubGlobal('fetch', postmarkOk())
    const first = await sendTicketReply(ticketId, userId, 'one')
    const ours = (await db.ticketMessage.findUniqueOrThrow({ where: { id: first.messageId } })).rfcMessageId!
    const fn = postmarkOk()
    vi.stubGlobal('fetch', fn)
    await sendTicketReply(ticketId, userId, 'two')
    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    const h = Object.fromEntries(body.Headers.map((x: { Name: string; Value: string }) => [x.Name, x.Value]))
    expect(h['References']).toBe(`<m1.reply@gmail.com> <${ours}>`)
    expect(h['In-Reply-To']).toBe('<m1.reply@gmail.com>')
  })

  it('stores nothing when Postmark refuses, so the agent can retry without a ghost reply', async () => {
    vi.stubGlobal('fetch', vi.fn<Fetch>(async () => new Response('{"Message":"Sender signature not confirmed"}', { status: 422 })))
    await expect(sendTicketReply(ticketId, userId, 'x')).rejects.toThrow(/422/)
    expect(await db.ticketMessage.count({ where: { ticketId, direction: 'OUTBOUND' } })).toBe(0)
  })

  it('refuses an empty reply', async () => {
    vi.stubGlobal('fetch', postmarkOk())
    await expect(sendTicketReply(ticketId, userId, '   ')).rejects.toThrow(/empty/i)
  })
})

describe('addNote', () => {
  it('records an internal note that never touches Postmark or the ticket status', async () => {
    const fn = postmarkOk()
    vi.stubGlobal('fetch', fn)
    const r = await addNote(ticketId, userId, 'Called the warehouse.')
    expect(fn).not.toHaveBeenCalled()
    const m = await db.ticketMessage.findUniqueOrThrow({ where: { id: r.messageId } })
    expect(m).toMatchObject({ direction: 'NOTE', textBody: 'Called the warehouse.', fromEmail: `agent@${DOMAIN}`, toEmail: '' })
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status).toBe('OPEN')
  })
})
