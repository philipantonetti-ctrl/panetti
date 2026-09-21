import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

/** The account's chat widgets, as Gorgias lists them: the same name five times, told apart by language. */
const fetchChatWidgets = vi.fn(async () => [
  { id: '104368', name: 'Panetti', language: 'da' },
  { id: '100585', name: 'Panetti', language: 'no' },
])
vi.mock('@/lib/support/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/support/client')>('@/lib/support/client')
  return { ...actual, fetchChatWidgets: () => fetchChatWidgets() }
})

const { GET, PUT } = await import('./route')

const TAG = '[chat-settings-test]'
async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
let shopId = ''
beforeEach(async () => {
  await cleanup()
  fetchChatWidgets.mockClear()
  shopId = (await db.shop.create({ data: { name: `Panetti Denmark ${TAG}`, currency: 'DKK' } })).id
  vi.stubEnv('GORGIAS_WEBHOOK_SECRET', 's3cret')
  vi.stubEnv('APP_URL', 'https://panetti.vercel.app')
  vi.stubEnv('GORGIAS_DOMAIN', 'test-account')
  vi.stubEnv('GORGIAS_EMAIL', 'admin@example.invalid')
  vi.stubEnv('GORGIAS_API_KEY', 'key')
})
afterEach(() => vi.unstubAllEnvs())

const put = (body: unknown) =>
  PUT(new Request('http://localhost/api/support/chat-settings', { method: 'PUT', body: JSON.stringify(body) }))

describe('chat settings', () => {
  /**
   * One URL for the whole account. Gorgias cannot aim an HTTP integration at
   * one shop's chat, so the shop is read from the chat's widget instead and the
   * URL names no shop at all.
   */
  it('gives one webhook URL for the account, and each shop with its widget and its switch', async () => {
    const body = await (await GET()).json()
    expect(body.webhookUrl).toBe('https://panetti.vercel.app/api/gorgias/webhook?token=s3cret')
    expect(body.secretConfigured).toBe(true)
    expect(body.shops.find((s: { id: string }) => s.id === shopId)).toMatchObject({ aiChatFrom: null, gorgiasChatId: null })
    expect(body.widgets).toEqual([
      { id: '104368', label: 'Panetti, Danish' },
      { id: '100585', label: 'Panetti, Norwegian' },
    ])
    expect(body.widgetsError).toBeNull()
  })

  it('says so when Gorgias could not be asked for the widgets, and still lists the shops', async () => {
    fetchChatWidgets.mockRejectedValueOnce(new Error('gorgias down'))
    const body = await (await GET()).json()
    expect(body.widgets).toEqual([])
    expect(body.widgetsError).toMatch(/Gorgias/)
    expect(body.shops.some((s: { id: string }) => s.id === shopId)).toBe(true)
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
    expect(body.webhookUrl).toBeNull()
  })

  it('links a shop to its chat widget, and unlinks it', async () => {
    expect((await put({ shopId, widgetId: '104368' })).status).toBe(200)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).gorgiasChatId).toBe('104368')

    expect((await put({ shopId, widgetId: null })).status).toBe(200)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).gorgiasChatId).toBeNull()
  })

  it('refuses a widget another shop already holds, by name', async () => {
    const other = await db.shop.create({ data: { name: `Panetti Norway ${TAG}`, currency: 'NOK', gorgiasChatId: '104368' } })
    const res = await put({ shopId, widgetId: '104368' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain(other.name)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).gorgiasChatId).toBeNull()
  })

  /** A date with no widget would look switched on and answer nobody. */
  it('refuses a date for a shop with no chat widget chosen', async () => {
    const res = await put({ shopId, date: '2026-09-10' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/chat widget/i)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).aiChatFrom).toBeNull()
  })

  it('sets and clears the switch as a date at midnight UTC', async () => {
    await put({ shopId, widgetId: '104368' })

    expect((await put({ shopId, date: '2026-09-10' })).status).toBe(200)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).aiChatFrom?.toISOString()).toBe('2026-09-10T00:00:00.000Z')

    expect((await put({ shopId, date: null })).status).toBe(200)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).aiChatFrom).toBeNull()
  })

  it('switches the chat off when the widget is unlinked, so nothing looks on that is not', async () => {
    await put({ shopId, widgetId: '104368' })
    await put({ shopId, date: '2026-09-10' })
    await put({ shopId, widgetId: null })
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).aiChatFrom).toBeNull()
  })
})
