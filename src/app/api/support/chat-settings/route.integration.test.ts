import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

const { GET, PUT } = await import('./route')

const TAG = '[chat-settings-test]'
async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
let shopId = ''
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti Denmark ${TAG}`, currency: 'DKK' } })).id
  vi.stubEnv('GORGIAS_WEBHOOK_SECRET', 's3cret')
  vi.stubEnv('APP_URL', 'https://panetti.vercel.app')
})
afterEach(() => vi.unstubAllEnvs())

describe('chat settings', () => {
  it('lists each shop with its switch and the exact webhook URL to paste', async () => {
    const body = await (await GET()).json()
    const row = body.shops.find((s: { id: string }) => s.id === shopId)
    expect(row).toMatchObject({ aiChatFrom: null, webhookUrl: `https://panetti.vercel.app/api/gorgias/webhook?token=s3cret&shop=${shopId}` })
    expect(body.secretConfigured).toBe(true)
  })

  /**
   * The template is pasted into Gorgias by hand and never tested until a real
   * customer writes, so every variable in it must be one Gorgias documents.
   * These six are (macro-variables reference); the message's own facts are NOT
   * - there is no documented `message` scope for an HTTP integration - so the
   * webhook reads those from the API instead, and none of them may appear here.
   */
  it('pastes only template variables Gorgias documents', async () => {
    const body = await (await GET()).json()

    for (const confirmed of [
      '{{ticket.id}}',
      '{{ticket.channel}}',
      '{{ticket.created_datetime}}',
      '{{ticket.customer.email}}',
      '{{ticket.customer.firstname}}',
      '{{ticket.subject}}',
    ]) {
      expect(body.bodyTemplate, confirmed).toContain(confirmed)
    }
    for (const unconfirmed of ['{{message.', '{{ticket.via}}', '{{ticket.customer.name}}']) {
      expect(body.bodyTemplate, unconfirmed).not.toContain(unconfirmed)
    }
  })

  it('says when the secret is missing instead of printing a broken URL', async () => {
    vi.stubEnv('GORGIAS_WEBHOOK_SECRET', '')
    const body = await (await GET()).json()
    expect(body.secretConfigured).toBe(false)
    expect(body.shops.find((s: { id: string }) => s.id === shopId).webhookUrl).toBeNull()
  })

  it('sets and clears the switch as a date at midnight UTC', async () => {
    const put = (date: string | null) =>
      PUT(new Request('http://localhost/api/support/chat-settings', { method: 'PUT', body: JSON.stringify({ shopId, date }) }))

    expect((await put('2026-09-10')).status).toBe(200)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).aiChatFrom?.toISOString()).toBe('2026-09-10T00:00:00.000Z')

    expect((await put(null)).status).toBe(200)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).aiChatFrom).toBeNull()
  })
})
