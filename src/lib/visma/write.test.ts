import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVismaTokenCache, vismaGet, VismaError } from './client'
import {
  assertWritableTenant,
  numberFromLocation,
  REAL_TENANT_ID,
  TEST_TENANT_ID,
  vismaPost,
  writeCredentials,
} from './write'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

beforeEach(() => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  // Production's value: the REAL company. The write path must ignore it.
  vi.stubEnv('VISMA_TENANT_ID', REAL_TENANT_ID)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('writeCredentials', () => {
  it('always names the test company, whatever VISMA_TENANT_ID says', () => {
    expect(writeCredentials()).toEqual({ clientId: 'cid', clientSecret: 'sec', tenantId: TEST_TENANT_ID })
  })
  it('is null when the credentials are missing', () => {
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    expect(writeCredentials()).toBeNull()
  })
})

describe('assertWritableTenant', () => {
  it('refuses the real company', () => {
    expect(() => assertWritableTenant(REAL_TENANT_ID)).toThrow(/real Visma company/)
    expect(() => assertWritableTenant(REAL_TENANT_ID.toUpperCase())).toThrow(/real Visma company/)
  })
  it('refuses any company that is not the test one', () => {
    expect(() => assertWritableTenant('00000000-0000-0000-0000-000000000000')).toThrow(/unknown Visma company/)
  })
  it('allows the test company', () => {
    expect(() => assertWritableTenant(TEST_TENANT_ID)).not.toThrow()
  })
})

describe('numberFromLocation', () => {
  it('takes the last path segment', () => {
    expect(numberFromLocation('https://api.finance.visma.net/v1/customerPayment/000123')).toBe('000123')
    expect(numberFromLocation('https://x/v2/journaltransaction/GL0042/')).toBe('GL0042')
    expect(numberFromLocation(null)).toBeNull()
  })
})

describe('vismaPost', () => {
  it('never calls fetch for the real company', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      vismaPost({ clientId: 'cid', clientSecret: 'sec', tenantId: REAL_TENANT_ID }, 'controller/api/v1/customerPayment', {}),
    ).rejects.toThrow(/real Visma company/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks for read+create on the test tenant, posts JSON to the new host, returns the number', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), init })
        if (String(url).includes('connect/token')) return json({ access_token: 'wtok', expires_in: 3600 })
        return json({}, 201, { Location: 'https://api.finance.visma.net/v1/customerPayment/000777' })
      }),
    )
    const made = await vismaPost(writeCredentials()!, 'controller/api/v1/customerPayment', { hold: { value: true } })
    expect(made).toEqual({ status: 201, number: '000777' })

    const token = String(seen[0].init?.body)
    expect(token).toContain(`tenant_id=${TEST_TENANT_ID}`)
    expect(token).toContain('scope=vismanet_erp_service_api%3Aread+vismanet_erp_service_api%3Acreate')
    expect(token).not.toContain('update')

    expect(seen[1].url).toBe('https://api.finance.visma.net/v1/customerPayment')
    expect(seen[1].init?.method).toBe('POST')
    expect((seen[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer wtok')
    expect(JSON.parse(String(seen[1].init?.body))).toEqual({ hold: { value: true } })
  })

  it('throws a VismaError carrying the status on a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token')
          ? json({ access_token: 'wtok', expires_in: 3600 })
          : new Response('{"message":"Customer 10859 not found"}', { status: 400 }),
      ),
    )
    const err = await vismaPost(writeCredentials()!, 'controller/api/v1/customerPayment', {}).catch((e) => e)
    expect(err).toBeInstanceOf(VismaError)
    expect(err.status).toBe(400)
    expect(err.message).toContain('Customer 10859 not found')
  })
})

describe('token cache', () => {
  it('keeps the read token and the write token apart', async () => {
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('connect/token')) {
          bodies.push(String(init?.body))
          return json({ access_token: `t${bodies.length}`, expires_in: 3600 })
        }
        return json([], 201)
      }),
    )
    const creds = writeCredentials()!
    await vismaGet(creds, 'controller/api/v1/customer')
    await vismaPost(creds, 'controller/api/v1/customerPayment', {})
    await vismaGet(creds, 'controller/api/v1/customer')
    // One mint per scope: the second GET reuses the read token.
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).not.toContain('create')
    expect(bodies[1]).toContain('create')
  })
})
