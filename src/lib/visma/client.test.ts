import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetVismaTokenCache,
  VismaError,
  vismaCredentials,
  vismaGet,
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
