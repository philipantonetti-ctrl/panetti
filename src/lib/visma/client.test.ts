import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetVismaTokenCache,
  VismaError,
  vismaCredentials,
  vismaGet,
  vismaRequestBudgetMs,
  vismaToken,
  type VismaCredentials,
} from './client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const CREDS: VismaCredentials = { clientId: 'cid', clientSecret: 'sec', tenantId: 'tid' }

beforeEach(() => resetVismaTokenCache())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('vismaCredentials', () => {
  it('is null when nothing is configured, because a missing integration is not an error', () => {
    vi.stubEnv('VISMA_CLIENT_ID', '')
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    vi.stubEnv('VISMA_TENANT_ID', '')
    expect(vismaCredentials()).toBeNull()
  })

  it('is null when only some of the three are set', () => {
    vi.stubEnv('VISMA_CLIENT_ID', 'cid')
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    vi.stubEnv('VISMA_TENANT_ID', 'tid')
    expect(vismaCredentials()).toBeNull()
  })

  it('reads all three', () => {
    vi.stubEnv('VISMA_CLIENT_ID', 'cid')
    vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
    vi.stubEnv('VISMA_TENANT_ID', 'tid')
    expect(vismaCredentials()).toEqual(CREDS)
  })
})

describe('vismaToken', () => {
  it('asks for the read scope and the tenant', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ access_token: 'tok', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await vismaToken(CREDS)).toBe('tok')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://connect.visma.com/connect/token')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('scope')).toBe('vismanet_erp_service_api:read')
    expect(body.get('tenant_id')).toBe('tid')
  })

  it('reuses a live token instead of minting one per request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ access_token: 'tok', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    await vismaToken(CREDS, 1_000_000)
    await vismaToken(CREDS, 1_000_000 + 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('mints a new one once the old is near expiry', async () => {
    // A Response body reads once, so this builds a fresh one per call rather
    // than handing the same consumed object to the second request.
    const fetchMock = vi.fn(async () => json({ access_token: 'tok', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    await vismaToken(CREDS, 1_000_000)
    await vismaToken(CREDS, 1_000_000 + 3_600_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not serve one tenant"s token to another', async () => {
    const fetchMock = vi.fn(async () => json({ access_token: 'tok', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    await vismaToken(CREDS, 1_000_000)
    await vismaToken({ ...CREDS, tenantId: 'other' }, 1_000_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not put the secret in the error when Visma rejects it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'invalid_client' }, 401)))
    await expect(vismaToken(CREDS)).rejects.toThrow(VismaError)
    await expect(vismaToken(CREDS)).rejects.not.toThrow(/sec/)
  })

  it('refuses a 200 that carries no token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ token_type: 'Bearer' })))
    await expect(vismaToken(CREDS)).rejects.toThrow(VismaError)
  })
})

describe('vismaGet', () => {
  it('sends the bearer token to the integration host', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(json([{ orderNbr: '500000' }]))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await vismaGet<{ orderNbr: string }[]>(CREDS, 'controller/api/v1/purchaseorder')
    expect(rows).toEqual([{ orderNbr: '500000' }])

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://integration.visma.net/API/controller/api/v1/purchaseorder')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('truncates a gateway HTML error rather than logging the page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token')
          ? json({ access_token: 'tok', expires_in: 3600 })
          : new Response('<html>' + 'x'.repeat(5000) + '</html>', { status: 502 }),
      ),
    )

    // toThrow takes a matcher, not a predicate, so the length assertion has to
    // read the message itself.
    const error = await vismaGet(CREDS, 'controller/api/v1/purchaseorder').then(
      () => null,
      (e: Error) => e,
    )
    expect(error).toBeInstanceOf(VismaError)
    expect(error!.message).toMatch(/502/)
    expect(error!.message.length).toBeLessThan(400)
  })
})

/**
 * The 60-second ceiling is what makes a caller's deadline a lie unless the
 * request is clamped to it. The sync route gives the B2B sales import until
 * 265s of a 300s platform ceiling: a request starting at 264.9s and running its
 * full minute finishes around 325s, overruns the invocation, and takes the
 * parcel poll and the delivery alert down with it - the exact outcome the
 * deadline exists to prevent. `bring/client.ts` has clamped for this reason
 * since it was written; this is the same rule.
 */
describe('vismaRequestBudgetMs', () => {
  const now = 1_000_000

  it('gives a request only what is left of the caller’s deadline', () => {
    expect(vismaRequestBudgetMs({ deadline: now + 5_000 }, now)).toBe(5_000)
  })

  it('never exceeds the ceiling, however much time is left', () => {
    expect(vismaRequestBudgetMs({ deadline: now + 900_000 }, now)).toBe(60_000)
  })

  /** No deadline is the ordinary path: the other three imports call this way. */
  it('gives the full ceiling when the caller set no deadline', () => {
    expect(vismaRequestBudgetMs({}, now)).toBe(60_000)
  })

  it('still returns a valid timeout when the budget is already spent', () => {
    // The caller's loop is what stops; a zero or negative timeout would be
    // rejected by AbortSignal.timeout rather than failing the request cleanly.
    expect(vismaRequestBudgetMs({ deadline: now - 1 }, now)).toBe(1)
  })

  /**
   * EVERY request, not just the GET. A cold token cache pays a mint first, so a
   * clamp that covered only the GET would leave the claim "a request started
   * near the budget's end cannot overrun" true of one call and false of the one
   * that always comes before it - which is precisely the kind of comment
   * outrunning its code that this clamp was added to stop.
   */
  it('clamps the token mint as well, which a cold cache always pays first', async () => {
    const signals: (AbortSignal | null | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        signals.push(init?.signal)
        return String(url).includes('connect/token')
          ? json({ access_token: 'tok', expires_in: 3600 })
          : json([])
      }),
    )

    await vismaGet(CREDS, 'controller/api/v1/purchaseorder', { deadline: Date.now() - 1 })

    // The token call is the first one out. Given the 1ms floor it aborts almost
    // at once; given the bare 60-second ceiling it never would.
    const tokenSignal = signals[0]
    expect(tokenSignal).toBeInstanceOf(AbortSignal)
    await new Promise((r) => setTimeout(r, 30))
    expect(tokenSignal!.aborted).toBe(true)
  })
})
