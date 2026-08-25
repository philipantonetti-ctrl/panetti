import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ userId: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))
const { currentUser } = await import('@/lib/auth/current-user')
const { GET, POST } = await import('./route')
const { PATCH, DELETE } = await import('./[id]/route')

const DOMAIN = 'boxes.inbox-test.invalid'
const TAG = '[inbox-test-boxes]'
let shopId: string

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
  await cleanup()
  vi.mocked(currentUser).mockResolvedValue({ userId: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK' } })).id
})

const post = (body: unknown) => POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }))
const patch = (id: string, body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const del = (id: string) => DELETE(new Request('http://localhost/x', { method: 'DELETE' }), { params: Promise.resolve({ id }) })

describe('mailboxes API', () => {
  it('stores an address lowercase and trimmed, tied to its shop and language', async () => {
    const res = await post({ address: ` Support@${DOMAIN} `, name: 'Panetti NO', shopId, language: 'nb', signature: 'Hilsen' })
    expect(res.status).toBe(200)
    const { mailbox } = await res.json()
    expect(mailbox.address).toBe(`support@${DOMAIN}`)

    vi.stubEnv('POSTMARK_INBOUND_ADDRESS', 'abc123@inbound.postmarkapp.com')
    const listed = await (await GET()).json()
    const mine = listed.mailboxes.find((m: { id: string }) => m.id === mailbox.id)
    expect(mine).toMatchObject({ name: 'Panetti NO', language: 'nb', shop: { id: shopId }, ticketCount: 0, active: true })
    expect(listed.forwardingAddress).toBe('abc123@inbound.postmarkapp.com')
  })

  it('refuses a malformed address, an unknown language, and a duplicate', async () => {
    expect((await post({ address: 'not-an-email', name: 'X' })).status).toBe(400)
    expect((await post({ address: `a@${DOMAIN}`, name: 'X', language: 'xx' })).status).toBe(400)
    expect((await post({ address: `dup@${DOMAIN}`, name: 'X' })).status).toBe(200)
    expect((await post({ address: `dup@${DOMAIN}`, name: 'Y' })).status).toBe(409)
  })

  it('edits signature and active, and refuses to delete a mailbox with history', async () => {
    const { mailbox } = await (await post({ address: `edit@${DOMAIN}`, name: 'E' })).json()
    expect((await patch(mailbox.id, { active: false, signature: 'Mvh' })).status).toBe(200)
    expect(await db.mailbox.findUniqueOrThrow({ where: { id: mailbox.id } })).toMatchObject({ active: false, signature: 'Mvh' })

    await db.ticket.create({ data: { mailboxId: mailbox.id, subject: 'S', customerEmail: 'x@y.z', firstMessageAt: new Date(), lastMessageAt: new Date() } })
    const refused = await del(mailbox.id)
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toMatch(/Deactivate instead/)

    await db.ticket.deleteMany({ where: { mailboxId: mailbox.id } })
    expect((await del(mailbox.id)).status).toBe(200)
  })
})
