import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
const { currentUser } = await import('@/lib/auth/current-user')
const { POST } = await import('./route')

const DOMAIN = 'messages.inbox-test.invalid'
let ticketId: string, userId: string
type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

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
  vi.mocked(currentUser).mockResolvedValue({ userId, email: `agent@${DOMAIN}`, role: 'ADMIN' } as never)
  const mailboxId = (await db.mailbox.create({ data: { address: `support@${DOMAIN}`, name: 'M' } })).id
  ticketId = (await db.ticket.create({ data: { mailboxId, subject: 'S', customerEmail: 'kari.msg@example.com', firstMessageAt: new Date(), lastMessageAt: new Date(),
    messages: { create: { direction: 'INBOUND', rfcMessageId: `in@${DOMAIN}`, fromEmail: 'kari.msg@example.com', toEmail: `support@${DOMAIN}`, textBody: 'hi', sentAt: new Date() } } } })).id
})

const post = (id: string, body: unknown) =>
  POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })

describe('POST /api/inbox/tickets/[id]/messages', () => {
  it('a note is stored and nothing is sent', async () => {
    const fn = vi.fn<Fetch>(async () => new Response('{}'))
    vi.stubGlobal('fetch', fn)
    const res = await post(ticketId, { kind: 'note', text: 'checking' })
    expect(res.status).toBe(200)
    expect(fn).not.toHaveBeenCalled()
    expect(await db.ticketMessage.count({ where: { ticketId, direction: 'NOTE' } })).toBe(1)
  })
  it('a reply goes out through Postmark as the signed-in agent', async () => {
    const fn = vi.fn<Fetch>(async () => new Response('{"MessageID":"pm"}'))
    vi.stubGlobal('fetch', fn)
    const res = await post(ticketId, { kind: 'reply', text: 'On its way' })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(1)
    const m = await db.ticketMessage.findFirstOrThrow({ where: { ticketId, direction: 'OUTBOUND' } })
    expect(m.authorUserId).toBe(userId)
  })
  it('a reply that Postmark refuses comes back as a readable error, not a 500 shrug', async () => {
    vi.stubGlobal('fetch', vi.fn<Fetch>(async () => new Response('{"Message":"Sender signature not confirmed"}', { status: 422 })))
    const res = await post(ticketId, { kind: 'reply', text: 'x' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Sender signature/)
  })
  it('refuses an empty text and an unknown kind', async () => {
    expect((await post(ticketId, { kind: 'reply', text: '  ' })).status).toBe(400)
    expect((await post(ticketId, { kind: 'shout', text: 'x' })).status).toBe(400)
  })
})
