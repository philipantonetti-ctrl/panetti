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

const { POST } = await import('./route')

beforeEach(() => {
  handleMessage.mockClear()
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
