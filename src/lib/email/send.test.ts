import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { sendEmail } from './send'

/** The same type-argument trick notify.test.ts documents: `vi.fn(async () => …)` */
/** alone infers a ZERO-ARG mock, and indexing `mock.calls[0][1]` is then a type */
/** error even though it works at runtime. tsconfig typechecks this file. */
type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const ok = () => vi.fn<Fetch>(async () => new Response('{}', { status: 200 }))

beforeEach(() => {
  vi.stubEnv('POSTMARK_SERVER_TOKEN', 'server-token')
  vi.stubEnv('EMAIL_FROM', 'no-reply@panetti.no')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('sendEmail', () => {
  it('posts the message to Postmark with the server token', async () => {
    const fn = ok()
    vi.stubGlobal('fetch', fn)

    await sendEmail('amb@example.com', 'Reset your password', 'Here is your link')

    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.postmarkapp.com/email')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Postmark-Server-Token']).toBe('server-token')

    const body = JSON.parse(init.body as string)
    expect(body.From).toBe('no-reply@panetti.no')
    expect(body.To).toBe('amb@example.com')
    expect(body.Subject).toBe('Reset your password')
    expect(body.TextBody).toBe('Here is your link')
  })

  /**
   * The warehouse report arrives on the INBOUND stream of the same Postmark
   * server. Naming the stream keeps a password reset off it: a transactional
   * message delivered on the wrong stream is either rejected outright or
   * counted against the wrong volume, and the intake is load-bearing.
   */
  it('sends on the outbound stream, never the one the warehouse report uses', async () => {
    const fn = ok()
    vi.stubGlobal('fetch', fn)

    await sendEmail('amb@example.com', 'Subject', 'Body')

    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.MessageStream).toBe('outbound')
  })

  it('throws and names the status when Postmark rejects the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<Fetch>(async () => new Response('{"ErrorCode":401,"Message":"Bad token"}', { status: 401 })),
    )
    await expect(sendEmail('amb@example.com', 'S', 'B')).rejects.toThrow(/401/)
  })

  it('throws a message naming the variable when the server token is not set', async () => {
    vi.stubEnv('POSTMARK_SERVER_TOKEN', '')
    vi.stubGlobal('fetch', ok())
    await expect(sendEmail('amb@example.com', 'S', 'B')).rejects.toThrow(/POSTMARK_SERVER_TOKEN/)
  })

  it('throws a message naming the variable when the sender address is not set', async () => {
    vi.stubEnv('EMAIL_FROM', '')
    vi.stubGlobal('fetch', ok())
    await expect(sendEmail('amb@example.com', 'S', 'B')).rejects.toThrow(/EMAIL_FROM/)
  })

  /** Configuration is checked before the network, so a misconfigured server
   *  never opens a connection to say something we already knew. */
  it('does not call Postmark at all when it is not configured', async () => {
    vi.stubEnv('POSTMARK_SERVER_TOKEN', '')
    const fn = ok()
    vi.stubGlobal('fetch', fn)
    await expect(sendEmail('amb@example.com', 'S', 'B')).rejects.toThrow()
    expect(fn).not.toHaveBeenCalled()
  })

  /**
   * A support reply must leave from the BRAND's address, threaded onto the
   * customer's conversation. Neither is a concern of the password reset that
   * this function was written for, so both arrive as options and the old
   * three-argument call keeps meaning exactly what it did.
   */
  it('sends from the address given, with custom headers, and returns Postmark id', async () => {
    const fn = vi.fn<Fetch>(async () => new Response('{"MessageID":"pm-123"}', { status: 200 }))
    vi.stubGlobal('fetch', fn)

    const r = await sendEmail('kari@example.com', 'Re: Order', 'Hello', {
      from: 'support@panetti.no',
      headers: { 'Message-ID': '<a@panetti.no>', 'In-Reply-To': '<b@gmail.com>' },
    })

    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.From).toBe('support@panetti.no')
    expect(body.Headers).toEqual([
      { Name: 'Message-ID', Value: '<a@panetti.no>' },
      { Name: 'In-Reply-To', Value: '<b@gmail.com>' },
    ])
    expect(r).toEqual({ postmarkId: 'pm-123' })
  })

  it('falls back to EMAIL_FROM and sends no Headers field when none are given', async () => {
    const fn = ok()
    vi.stubGlobal('fetch', fn)
    await sendEmail('amb@example.com', 'S', 'B')
    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.From).toBe('no-reply@panetti.no')
    expect(body.Headers).toBeUndefined()
  })

  it('an explicit from does not need EMAIL_FROM to be set', async () => {
    vi.stubEnv('EMAIL_FROM', '')
    vi.stubGlobal('fetch', ok())
    await expect(sendEmail('a@b.c', 'S', 'B', { from: 'support@panetti.no' })).resolves.toEqual({ postmarkId: null })
  })
})
