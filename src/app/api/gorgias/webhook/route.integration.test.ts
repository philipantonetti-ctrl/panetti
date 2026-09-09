import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

/**
 * The door Gorgias pushes messages through. The handler beneath it is mocked:
 * this is about the guard, the loop protection and the promise never to fail
 * in a way that loses a customer's message.
 */
type Handled = { decision: string; reason: string | null; conversationId: string }
const handleMessage = vi.fn<(channel: unknown, message: { customerEmail: string | null; text: string; via: string | null; conversationId: string }) => Promise<Handled>>(
  async () => ({ decision: 'drafted', reason: null, conversationId: 'T-9' }),
)
vi.mock('@/lib/support/handle', () => ({
  handleMessage: (channel: never, message: never) => handleMessage(channel, message),
}))

type ChatIn = { shopId: string; conversationId: string; messageId: string; text: string; fromAgent: boolean; via: string | null; customerEmail: string | null; conversationStartedAt: Date | null }
const handleChatMessage = vi.fn<(incoming: ChatIn, deps: unknown) => Promise<{ decision: string; reason: string | null }>>(
  async () => ({ decision: 'sent', reason: null }),
)
vi.mock('@/lib/support/chat', () => ({
  handleChatMessage: (incoming: never, deps: never) => handleChatMessage(incoming, deps),
}))

/**
 * Gorgias's HTTP integration can pass ticket facts and nothing about the
 * message, so the webhook reads the message from the API. That call is what
 * this stub answers.
 */
type Msg = { id: number; from_agent: boolean; public: boolean; channel: string; via: string; body_text: string; created_datetime: string; sender: null }
const fetchTicketMessages = vi.fn<(creds: unknown, ticketId: string) => Promise<Msg[]>>(async () => [
  { id: 90209, from_agent: false, public: true, channel: 'chat', via: 'gorgias_chat', body_text: 'Hej', created_datetime: '2026-09-09T09:59:00Z', sender: null },
  { id: 90210, from_agent: false, public: true, channel: 'chat', via: 'gorgias_chat', body_text: 'Hvor er min pakke?', created_datetime: '2026-09-09T10:00:00Z', sender: null },
])
vi.mock('@/lib/support/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/support/client')>('@/lib/support/client')
  return { ...actual, fetchTicketMessages: (creds: never, ticketId: never) => fetchTicketMessages(creds, ticketId) }
})

const { POST } = await import('./route')

beforeEach(() => {
  handleMessage.mockClear()
  handleChatMessage.mockClear()
  fetchTicketMessages.mockClear()
  vi.stubEnv('GORGIAS_WEBHOOK_SECRET', 's3cret')
  vi.stubEnv('GORGIAS_DOMAIN', 'test-account')
  vi.stubEnv('GORGIAS_EMAIL', 'admin@example.invalid')
  vi.stubEnv('GORGIAS_API_KEY', 'key')
})
afterEach(() => vi.unstubAllEnvs())

const post = (body: unknown, token = 's3cret') =>
  POST(
    new Request(`http://localhost/api/gorgias/webhook?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

const mail = {
  ticketId: 236490307,
  customerEmail: 'Kari@Example.com',
  customerName: 'Kari',
  subject: 'Hvor er pakken?',
  message: 'Hei, hvor er pakken min?',
  via: 'email',
}

describe('POST /api/gorgias/webhook', () => {
  it('refuses without the shared secret, and when none is configured', async () => {
    expect((await post(mail, 'wrong')).status).toBe(401)
    vi.stubEnv('GORGIAS_WEBHOOK_SECRET', '')
    expect((await post(mail)).status).toBe(401)
    expect(handleMessage).not.toHaveBeenCalled()
  })

  it('passes the message on, with the address lowercased for matching', async () => {
    const res = await post(mail)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, decision: 'drafted' })
    expect(handleMessage.mock.calls[0][1]).toMatchObject({
      conversationId: '236490307',
      customerEmail: 'kari@example.com',
      text: 'Hei, hvor er pakken min?',
      via: 'email',
    })
  })

  /**
   * Our own replies and notes arrive back through the same trigger. Answering
   * them is a machine talking to itself until somebody notices the bill.
   */
  it('never answers a message an agent wrote, including its own', async () => {
    const res = await post({ ...mail, fromAgent: true })

    expect(res.status).toBe(200)
    expect((await res.json()).decision).toBe('skipped')
    expect(handleMessage).not.toHaveBeenCalled()
  })

  it('asks which ticket when none was named', async () => {
    expect((await post({ ...mail, ticketId: undefined })).status).toBe(400)
  })

  it('400s a body that is not JSON', async () => {
    expect((await post('not json')).status).toBe(400)
  })

  /**
   * Measured from their documentation: Gorgias does NOT retry a non-2xx. A 500
   * here would simply lose the customer's message, so a failure is recorded and
   * acknowledged instead.
   */
  it('answers 200 even when handling failed, because a retry never comes', async () => {
    handleMessage.mockRejectedValueOnce(new Error('database down'))

    const res = await post(mail)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, decision: 'failed' })
  })

  it('says so plainly when Gorgias is not configured, rather than pretending to answer', async () => {
    vi.stubEnv('GORGIAS_API_KEY', '')
    const res = await post(mail)

    expect(res.status).toBe(200)
    expect((await res.json()).reason).toMatch(/not configured/i)
    expect(handleMessage).not.toHaveBeenCalled()
  })
})

const chat = {
  ticketId: 551789749,
  channel: 'chat',
  ticketCreatedAt: '2026-09-09T10:00:00+02:00',
  customerEmail: 'Nikolaj@Example.com',
  customerName: 'Nikolaj',
  subject: 'Conversation with Nikolaj',
}

/**
 * A chat body carries only what Gorgias documents a template variable for:
 * ticket facts. Everything about the MESSAGE - its id, its text, and whether
 * an agent wrote it - is read from the API, because Gorgias documents no
 * `message` template scope and a guess there would be an assistant answering
 * its own messages in a live chat window.
 */
describe('a chat message with a shop', () => {
  const postChat = (body: unknown, qs = 'token=s3cret&shop=shop_dk') =>
    POST(new Request(`http://localhost/api/gorgias/webhook?${qs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))

  it('goes to the chat turn with the shop, the start time, and the newest message from the API', async () => {
    const res = await postChat(chat)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, decision: 'sent' })
    expect(handleMessage).not.toHaveBeenCalled()
    expect(fetchTicketMessages.mock.calls[0][1]).toBe('551789749')
    expect(handleChatMessage.mock.calls[0][0]).toMatchObject({
      shopId: 'shop_dk',
      conversationId: '551789749',
      // The newest message, not the oldest: the API answers oldest first.
      messageId: '90210',
      text: 'Hvor er min pakke?',
      fromAgent: false,
      customerEmail: 'nikolaj@example.com',
      via: 'gorgias_chat',
      conversationStartedAt: new Date('2026-09-09T08:00:00Z'),
    })
  })

  it('passes an agent message through, so the chat turn can tell its own from a person', async () => {
    fetchTicketMessages.mockResolvedValueOnce([
      { id: 90211, from_agent: true, public: true, channel: 'chat', via: 'gorgias_chat', body_text: 'Selena here.', created_datetime: '2026-09-09T10:01:00Z', sender: null },
    ])
    await postChat(chat)
    expect(handleChatMessage.mock.calls[0][0]).toMatchObject({ fromAgent: true, text: 'Selena here.' })
  })

  it('answers nothing when the ticket has no message to read', async () => {
    fetchTicketMessages.mockResolvedValueOnce([])
    const res = await postChat(chat)
    expect(res.status).toBe(200)
    expect((await res.json()).decision).toBe('skipped')
    expect(handleChatMessage).not.toHaveBeenCalled()
  })

  it('treats a chat without a shop as it always did, an email-style ticket', async () => {
    await postChat(chat, 'token=s3cret')
    expect(handleChatMessage).not.toHaveBeenCalled()
    expect(handleMessage).toHaveBeenCalledTimes(1)
  })

  it('answers 200 when the chat turn fails, because Gorgias never retries', async () => {
    handleChatMessage.mockRejectedValueOnce(new Error('database down'))
    const res = await postChat(chat)
    expect(res.status).toBe(200)
    expect((await res.json()).decision).toBe('failed')
  })

  it('answers 200 when the message cannot be read, because Gorgias never retries', async () => {
    fetchTicketMessages.mockRejectedValueOnce(new Error('gorgias down'))
    const res = await postChat(chat)
    expect(res.status).toBe(200)
    expect((await res.json()).decision).toBe('failed')
    expect(handleChatMessage).not.toHaveBeenCalled()
  })
})
