import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))
const { currentUser } = await import('@/lib/auth/current-user')
const { GET: list } = await import('./route')
const { GET: detail, PATCH } = await import('./[id]/route')

const DOMAIN = 'tickets.inbox-test.invalid'
let mailboxId: string, t1: string, t2: string, userId: string

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
  await db.user.deleteMany({ where: { email: `agent@${DOMAIN}` } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
  userId = (await db.user.create({ data: { email: `agent@${DOMAIN}`, passwordHash: 'x', role: 'ADMIN' } })).id
  mailboxId = (await db.mailbox.create({ data: { address: `support@${DOMAIN}`, name: 'T' } })).id
  const mk = (subject: string, email: string, status: string, at: string) =>
    db.ticket.create({ data: { mailboxId, subject, customerEmail: email, customerName: 'Kari', status, firstMessageAt: new Date(at), lastMessageAt: new Date(at),
      messages: { create: { direction: 'INBOUND', fromEmail: email, toEmail: `support@${DOMAIN}`, textBody: 'body text', sentAt: new Date(at) } } } })
  t1 = (await mk('Where is my order', 'kari.tickets@example.com', 'OPEN', '2026-08-20T10:00:00Z')).id
  t2 = (await mk('Retur', 'ola.tickets@example.com', 'CLOSED', '2026-08-19T10:00:00Z')).id
})

const url = (q = '') => new Request(`http://localhost/api/inbox/tickets${q}`)
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describe('GET /api/inbox/tickets', () => {
  it('lists newest-first with the fields the queue shows, filtered by status and search', async () => {
    const all = await (await list(url(`?mailboxId=${mailboxId}`))).json()
    expect(all.tickets.map((t: { subject: string }) => t.subject)).toEqual(['Where is my order', 'Retur'])
    expect(all.tickets[0]).toMatchObject({ status: 'OPEN', customerEmail: 'kari.tickets@example.com', mailbox: `support@${DOMAIN}` })
    const open = await (await list(url(`?mailboxId=${mailboxId}&status=OPEN`))).json()
    expect(open.tickets).toHaveLength(1)
    const found = await (await list(url(`?mailboxId=${mailboxId}&q=ola.tickets%40`))).json()
    expect(found.tickets.map((t: { id: string }) => t.id)).toEqual([t2])
  })
  it('is admin-only', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'x@y.z', role: 'MARKETING' } as never)
    expect((await list(url())).status).toBe(403)
  })
})

describe('GET + PATCH /api/inbox/tickets/[id]', () => {
  it('opens a ticket with its messages and the customer context', async () => {
    const res = await detail(new Request('http://localhost/x'), ctx(t1))
    const body = await res.json()
    expect(body.ticket.subject).toBe('Where is my order')
    expect(body.messages).toHaveLength(1)
    expect(body.context).toHaveProperty('orders')
    expect(body.context.previousTickets).toEqual([])
  })
  it('updates status, assignee, priority, tags and the matched order, and stamps closedAt', async () => {
    const res = await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ status: 'CLOSED', assigneeUserId: userId, priority: 'HIGH', tags: ['vip'] }) }), ctx(t1))
    expect(res.status).toBe(200)
    const t = await db.ticket.findUniqueOrThrow({ where: { id: t1 } })
    expect(t).toMatchObject({ status: 'CLOSED', assigneeUserId: userId, priority: 'HIGH', tags: ['vip'] })
    expect(t.closedAt).not.toBeNull()
    await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ status: 'OPEN', assigneeUserId: null }) }), ctx(t1))
    const again = await db.ticket.findUniqueOrThrow({ where: { id: t1 } })
    expect(again.closedAt).toBeNull()
    expect(again.assigneeUserId).toBeNull()
  })
  it('rejects a status it does not know', async () => {
    const res = await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ status: 'SNOOZED' }) }), ctx(t1))
    expect(res.status).toBe(400)
  })
  it('404s an unknown ticket', async () => {
    expect((await detail(new Request('http://localhost/x'), ctx('nope'))).status).toBe(404)
  })
})
