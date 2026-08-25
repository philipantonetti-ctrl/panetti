import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))

const { POST } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')

const url = 'http://localhost/api/delivery/test'
const post = (body: unknown) =>
  POST(new Request(url, { method: 'POST', body: JSON.stringify(body) }))

// Signature supplied as a type argument, not inferred: `vi.fn(async () => ...)`
// alone infers a ZERO-ARG mock, which makes `fn.mock.calls[0][0]`/`[1]` a
// compile error - indexing an empty tuple - even though it works at runtime.
type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const okFetch = (body: unknown = { consignmentSet: [] }) =>
  vi.fn<FetchFn>(async () => new Response(JSON.stringify(body), { status: 200 }))

const failingFetch = (message: string) =>
  vi.fn<FetchFn>(async () => {
    throw new Error(message)
  })

/**
 * DeliveryConfig is a fixed-id singleton (see the Global Constraints) -
 * upsert and blank the fields, never deleteMany() then create(), so a
 * racing file can never find the row missing. bringApiKey/slackWebhookUrl
 * are passed in PLAIN and encrypted here, mirroring exactly what the
 * settings route's own PUT does, so getDeliveryConfig()'s decrypt step is
 * exercised for real rather than assumed.
 */
async function seedConfig(fields: {
  bringApiUid?: string | null
  bringApiKey?: string | null
  bringClientUrl?: string | null
  slackWebhookUrl?: string | null
}) {
  const data = {
    bringApiUid: fields.bringApiUid ?? null,
    bringApiKey: fields.bringApiKey ? encryptSecret(fields.bringApiKey) : null,
    bringClientUrl: fields.bringClientUrl ?? null,
    slackWebhookUrl: fields.slackWebhookUrl ? encryptSecret(fields.slackWebhookUrl) : null,
  }
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...data },
    update: data,
  })
}

const blank = () => seedConfig({})

/**
 * DHL answers 404 to a number it does not know - verified against the live API
 * 2026-08-18 with the real key. fetchTracking turns that into null, so a 404 is
 * exactly the "your key was accepted, this parcel just isn't real" answer the
 * probe wants.
 */
const notFoundFetch = () =>
  vi.fn<FetchFn>(async () => new Response(JSON.stringify({ status: 404 }), { status: 404 }))

beforeEach(async () => {
  await blank()
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
  // The real key lives in .env, which the test runner can load. Blanking it
  // makes "not connected" the deliberate default rather than an accident of
  // whose machine the suite runs on - the same guard sync.integration.test.ts
  // opens with, and for the same reason.
  vi.stubEnv('DHL_API_KEY', '')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
afterAll(blank)

describe('POST /api/delivery/test', () => {
  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'x@y.z', role: 'AMBASSADOR' } as never)
    expect((await post({ target: 'bring' })).status).toBe(403)
  })

  it('never lets a proxy or CDN cache the result - private, no-store on every outcome', async () => {
    // 403: non-admin
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'x@y.z', role: 'AMBASSADOR' } as never)
    expect((await post({ target: 'bring' })).headers.get('Cache-Control')).toBe('private, no-store')

    // 400: unknown target
    expect((await post({ target: 'carrier-pigeon' })).headers.get('Cache-Control')).toBe(
      'private, no-store',
    )

    // 500: the outer, unexpected-error catch (malformed JSON body)
    const malformed = await POST(new Request(url, { method: 'POST', body: '{not json' }))
    expect(malformed.headers.get('Cache-Control')).toBe('private, no-store')

    // 200 ok:false - nothing stored
    expect((await post({ target: 'bring' })).headers.get('Cache-Control')).toBe('private, no-store')
    expect((await post({ target: 'slack' })).headers.get('Cache-Control')).toBe('private, no-store')
    expect((await post({ target: 'dhl' })).headers.get('Cache-Control')).toBe('private, no-store')

    // 200 ok:true - stored, upstream accepts
    await seedConfig({
      bringApiUid: 'ops@example.com',
      bringApiKey: 'key',
      bringClientUrl: 'https://panetti.vercel.app',
      slackWebhookUrl: 'https://hooks.slack.com/services/x',
    })
    vi.stubGlobal('fetch', okFetch())
    expect((await post({ target: 'bring' })).headers.get('Cache-Control')).toBe('private, no-store')
    expect((await post({ target: 'slack' })).headers.get('Cache-Control')).toBe('private, no-store')

    // 200 ok:false - stored, upstream rejects
    vi.stubGlobal('fetch', failingFetch('boom'))
    expect((await post({ target: 'bring' })).headers.get('Cache-Control')).toBe('private, no-store')
    expect((await post({ target: 'slack' })).headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('bring: accepts stored credentials, sending the three Mybring headers with the DECRYPTED key', async () => {
    await seedConfig({
      bringApiUid: 'ops@example.com',
      bringApiKey: 'the-real-key',
      bringClientUrl: 'https://panetti.vercel.app',
    })
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)

    const res = await post({ target: 'bring' })
    const body = await res.json()
    expect(body.ok).toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    // The stored value is 'enc:v1:...' - this proves getDeliveryConfig()'s
    // decrypt actually ran, not just that some string was forwarded.
    expect(headers['X-Mybring-API-Uid']).toBe('ops@example.com')
    expect(headers['X-Mybring-API-Key']).toBe('the-real-key')
    expect(headers['X-Bring-Client-URL']).toBe('https://panetti.vercel.app')
  })

  it('bring: says plainly what is missing when nothing is stored, not a stack', async () => {
    const fetchMock = vi.fn<FetchFn>()
    vi.stubGlobal('fetch', fetchMock)

    const res = await post({ target: 'bring' })
    const body = await res.json()
    expect(body).toEqual({
      ok: false,
      message: 'Bring is not connected. Save the account email, API key and client URL first.',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('slack: posts to the DECRYPTED webhook URL', async () => {
    await seedConfig({ slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/real-secret-token' })
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)

    const res = await post({ target: 'slack' })
    const body = await res.json()
    expect(body.ok).toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.slack.com/services/T00/B00/real-secret-token')
  })

  it('slack: says plainly what is missing when nothing is stored, not a stack', async () => {
    const fetchMock = vi.fn<FetchFn>()
    vi.stubGlobal('fetch', fetchMock)

    const res = await post({ target: 'slack' })
    const body = await res.json()
    expect(body).toEqual({ ok: false, message: 'Slack is not connected. Save a webhook URL first.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failing Bring call must not leak the credentials or the upstream host into the response', async () => {
    await seedConfig({
      bringApiUid: 'ops@example.com',
      bringApiKey: 'xoxb-REAL-SECRET-KEY',
      bringClientUrl: 'https://panetti.vercel.app',
    })
    vi.stubGlobal(
      'fetch',
      failingFetch(
        'connect ECONNREFUSED https://api.bring.com/tracking/api/v2/tracking.json?q=xoxb-REAL-SECRET-KEY',
      ),
    )

    const res = await post({ target: 'bring' })
    const text = await res.text()
    expect(text).not.toContain('xoxb-REAL-SECRET-KEY')
    expect(text).not.toContain('api.bring.com')
    expect(JSON.parse(text)).toEqual({
      ok: false,
      message: 'Bring refused the credentials. Check the account email, API key and client URL.',
    })
  })

  it('a failing Slack call must not leak the webhook token or the upstream host into the response', async () => {
    await seedConfig({ slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/xoxb-REAL-TOKEN' })
    vi.stubGlobal(
      'fetch',
      failingFetch('connect ECONNREFUSED https://hooks.slack.com/services/T00/B00/xoxb-REAL-TOKEN'),
    )

    const res = await post({ target: 'slack' })
    const text = await res.text()
    expect(text).not.toContain('xoxb-REAL-TOKEN')
    expect(text).not.toContain('hooks.slack.com')
    expect(JSON.parse(text)).toEqual({
      ok: false,
      message: 'Could not post to Slack. Check the webhook URL.',
    })
  })

  it('an unknown target is refused with 400, not 500', async () => {
    const res = await post({ target: 'carrier-pigeon' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Choose Bring, DHL or Slack.' })
  })

  /**
   * DHL's key is a deployment secret in Vercel, not a stored setting like
   * Bring's - so there is nothing on the settings page to look at, and until
   * this button existed nobody could tell a working key from a missing one.
   */
  it('dhl: accepts the key, sending it in the DHL-API-Key header', async () => {
    vi.stubEnv('DHL_API_KEY', 'the-real-dhl-key')
    const fetchMock = notFoundFetch()
    vi.stubGlobal('fetch', fetchMock)

    const res = await post({ target: 'dhl' })
    expect(await res.json()).toEqual({ ok: true, message: 'DHL accepted the credentials.' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    // Not Authorization, not x-api-key - DHL answers 401 to anything else.
    expect((init.headers as Record<string, string>)['DHL-API-Key']).toBe('the-real-dhl-key')
  })

  it('dhl: names the environment variable to set when the key is missing', async () => {
    const fetchMock = vi.fn<FetchFn>()
    vi.stubGlobal('fetch', fetchMock)

    const res = await post({ target: 'dhl' })
    expect(await res.json()).toEqual({
      ok: false,
      message: 'DHL is not connected. Add DHL_API_KEY in Vercel, then redeploy.',
    })
    // Nothing to ask, so nothing is asked - and no daily call is spent proving
    // what we already know.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failing DHL call must not leak the key or the upstream host into the response', async () => {
    vi.stubEnv('DHL_API_KEY', 'REAL-DHL-KEY-abc123')
    vi.stubGlobal(
      'fetch',
      failingFetch('connect ECONNREFUSED https://api-eu.dhl.com/track/shipments key=REAL-DHL-KEY-abc123'),
    )

    const res = await post({ target: 'dhl' })
    const text = await res.text()
    expect(text).not.toContain('REAL-DHL-KEY-abc123')
    expect(text).not.toContain('api-eu.dhl.com')
    expect(JSON.parse(text)).toEqual({
      ok: false,
      message: 'DHL refused the key. Check DHL_API_KEY in Vercel, then redeploy.',
    })
  })
})
