import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'
import { POST } from './route'

const DOMAIN = 'hook.inbox-test.invalid'
const SUPPORT = `support@${DOMAIN}`

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
}
afterAll(cleanup)
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
  await cleanup()
  vi.stubEnv('INBOX_INBOUND_SECRET', 's3cret')
  await db.mailbox.create({ data: { address: SUPPORT, name: 'Hook' } })
})

const post = (token: string, body: unknown) =>
  POST(new Request(`http://localhost/api/inbox/inbound?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

const mail = {
  From: 'kari.hook@example.com', FromFull: { Email: 'kari.hook@example.com', Name: 'Kari' }, To: SUPPORT, ToFull: [{ Email: SUPPORT }],
  OriginalRecipient: SUPPORT, Subject: 'Hei', MessageID: 'pm-1', TextBody: 'hei', Headers: [{ Name: 'Message-ID', Value: '<h1@x>' }], Attachments: [],
}

describe('POST /api/inbox/inbound', () => {
  it('refuses without the shared secret, and with the secret unset', async () => {
    expect((await post('wrong', mail)).status).toBe(401)
    vi.stubEnv('INBOX_INBOUND_SECRET', '')
    expect((await post('s3cret', mail)).status).toBe(401)
  })
  it('creates the ticket and answers 200 with the outcome', async () => {
    const res = await post('s3cret', mail)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'created' })
    expect(await db.ticket.count({ where: { mailbox: { address: SUPPORT } } })).toBe(1)
  })
  it('answers 200 for mail that is not ours, so Postmark does not retry it for six hours', async () => {
    const res = await post('s3cret', { ...mail, To: 'x@elsewhere.invalid', ToFull: [{ Email: 'x@elsewhere.invalid' }], OriginalRecipient: 'x@elsewhere.invalid' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'no_mailbox' })
  })
  it('400s a body that is not JSON', async () => {
    expect((await post('s3cret', 'not json')).status).toBe(400)
  })
})
