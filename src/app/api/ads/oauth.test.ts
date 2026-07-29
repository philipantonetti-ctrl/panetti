import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieJar = { session: undefined as string | undefined, state: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === 'ecom_session')
        return cookieJar.session ? { value: cookieJar.session } : undefined
      if (name === 'ads_oauth_state') return cookieJar.state ? { value: cookieJar.state } : undefined
      return undefined
    },
  }),
}))

const { GET: startRoute } = await import('./oauth/[provider]/start/route')
const { GET: callbackRoute } = await import('./oauth/[provider]/callback/route')
const { GET: accountsRoute } = await import('./connections/[id]/accounts/route')
const { POST: bulkRoute } = await import('../ad-accounts/bulk/route')
const { GET: appsGet, PUT: appsPut } = await import('../ad-platform-apps/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const MARK = '[oauth-test]'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const asAdmin = async () => {
  cookieJar.session = await signSession({
    userId: 'test-admin',
    email: 'admin@test.local',
    role: 'ADMIN',
    ambassadorId: null,
  })
}

async function wipe() {
  await db.adAccount.deleteMany({ where: { name: { contains: MARK } } })
  await db.adConnection.deleteMany({ where: { label: { contains: MARK } } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

/**
 * AdPlatformApp rows are singletons per provider, shared with the seed data
 * the e2e suite reads. This file borrows them and always puts them back.
 */
async function restoreSeedApps() {
  await db.adPlatformApp.upsert({
    where: { provider: 'meta' },
    create: { provider: 'meta', clientId: 'seed-app', clientSecret: 'seed' },
    update: { clientId: 'seed-app', clientSecret: 'seed' },
  })
  await db.adPlatformApp.upsert({
    where: { provider: 'google' },
    create: { provider: 'google', clientId: 'seed-app', clientSecret: 'seed', developerToken: 'seed' },
    update: { clientId: 'seed-app', clientSecret: 'seed', developerToken: 'seed' },
  })
}

beforeEach(async () => {
  await wipe()
  await asAdmin()
  cookieJar.state = undefined
  // Only this suite's app rows: the seed's are absent on the test DB wipe path.
  await db.adPlatformApp.upsert({
    where: { provider: 'meta' },
    create: { provider: 'meta', clientId: 'oauth-test-app', clientSecret: 'shh' },
    update: { clientId: 'oauth-test-app', clientSecret: 'shh' },
  })
})

afterEach(async () => {
  await wipe()
  await restoreSeedApps()
  vi.unstubAllGlobals()
})

const start = (provider: string) =>
  startRoute(new Request(`http://localhost/api/ads/oauth/${provider}/start`), {
    params: Promise.resolve({ provider }),
  })

const callback = (provider: string, qs: string) =>
  callbackRoute(new Request(`http://localhost/api/ads/oauth/${provider}/callback?${qs}`), {
    params: Promise.resolve({ provider }),
  })

/** Meta saves and starts prove themselves against the platform first. */
function stubMetaAppOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('grant_type=client_credentials')) return json({ access_token: 'app|token' })
      return json({ app_domains: ['localhost'] })
    }),
  )
}

describe('platform setup', () => {
  it('refuses a wrong App ID or secret with Facebook words and stores nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'Error validating client secret.' } }, 400)),
    )
    const res = await appsPut(
      new Request('http://localhost/api/ad-platform-apps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'meta', clientId: 'oauth-test-bad', clientSecret: 'typo' }),
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Error validating client secret.')
    const row = await db.adPlatformApp.findUniqueOrThrow({ where: { provider: 'meta' } })
    expect(row.clientId).not.toBe('oauth-test-bad')
  })

  it('passes the warning through when the missing domain cannot be written either', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('grant_type=client_credentials'))
          return json({ access_token: 'app|token' })
        if (init?.method === 'POST') return json({ error: { message: 'no' } }, 400)
        return json({ app_domains: ['some-other-site.com'] })
      }),
    )
    const res = await appsPut(
      new Request('http://localhost/api/ad-platform-apps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'meta', clientId: 'oauth-test-9002', clientSecret: 's' }),
      }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).warning).toContain('App Domains')
  })

  it('stores secrets encrypted and answers with booleans only', async () => {
    stubMetaAppOk()
    const res = await appsPut(
      new Request('http://localhost/api/ad-platform-apps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'meta',
          clientId: 'oauth-test-9000',
          clientSecret: 'super-secret-value',
        }),
      }),
    )
    expect(res.status).toBe(200)

    const stored = await db.adPlatformApp.findUniqueOrThrow({ where: { provider: 'meta' } })
    expect(stored.clientSecret.startsWith('enc:v1:')).toBe(true)
    expect(stored.clientSecret).not.toContain('super-secret-value')

    const list = await appsGet()
    const text = JSON.stringify(await list.json())
    expect(text).toContain('oauth-test-9000')
    expect(text).toContain('"hasSecret":true')
    expect(text).not.toContain('super-secret-value')

    // A blank secret on a later save keeps the stored one.
    await appsPut(
      new Request('http://localhost/api/ad-platform-apps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'meta', clientId: 'oauth-test-9001', clientSecret: '' }),
      }),
    )
    const kept = await db.adPlatformApp.findUniqueOrThrow({ where: { provider: 'meta' } })
    expect(kept.clientId).toBe('oauth-test-9001')
    expect(kept.clientSecret).toBe(stored.clientSecret)
  })
})

describe('oauth start', () => {
  it('stamps a state cookie and sends the admin to the platform dialog', async () => {
    stubMetaAppOk()
    const res = await start('meta')
    expect(res.status).toBe(307)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('facebook.com/v25.0/dialog/oauth')
    expect(location).toContain('client_id=oauth-test-app')
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/ads_oauth_state=meta(%3A|:)/)
  })

  it('writes a missing domain into the Meta app, then asks for a second click', async () => {
    // Facebook's dialog can lag seconds behind a settings write. Walking
    // straight from the write into the dialog loses that race exactly once —
    // the client saw the wall on the very click that fixed his app.
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('grant_type=client_credentials'))
          return json({ access_token: 'app|token' })
        if (init?.method === 'POST') return json({ success: true })
        return json({ app_domains: ['somewhere-else.example'] })
      })
    vi.stubGlobal('fetch', fetchMock)

    const res = await start('meta')
    expect(res.status).toBe(307)
    const location = decodeURIComponent(res.headers.get('location') ?? '')
    expect(location).toContain('/settings/ad-accounts?notice=')
    expect(location).toContain('again')

    const write = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
    expect(String(write?.[0])).toContain('/oauth-test-app')
    expect(String((write?.[1] as RequestInit).body)).toContain('localhost')
  })

  it('bounces to the setup with the fix in words when the domain cannot be written', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('grant_type=client_credentials'))
          return json({ access_token: 'app|token' })
        if (init?.method === 'POST') return json({ error: { message: 'no' } }, 400)
        return json({ app_domains: [] })
      }),
    )

    const res = await start('meta')
    expect(res.status).toBe(307)
    const location = decodeURIComponent(res.headers.get('location') ?? '')
    expect(location).toContain('/settings/ad-accounts?error=')
    expect(location).toContain('App Domains')
  })

  it("bounces with Facebook's words when the saved pair has gone bad", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'Error validating client secret.' } }, 400)),
    )
    const res = await start('meta')
    const location = decodeURIComponent(res.headers.get('location') ?? '')
    expect(location).toContain('/settings/ad-accounts?error=')
    expect(location).toContain('Error validating client secret.')
  })

  it('still walks to Facebook when Meta itself cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const res = await start('meta')
    expect(res.headers.get('location')).toContain('facebook.com/v25.0/dialog/oauth')
  })

  it('sends the admin back with words when the platform setup is missing', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'google' } })
    const res = await start('google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('error=')
  })
})

describe('oauth callback', () => {
  it('stores an encrypted connection and opens the picker', async () => {
    cookieJar.state = 'meta:st-1'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: 'short' }))
        .mockResolvedValueOnce(json({ access_token: 'long-secret', expires_in: 5_184_000 }))
        .mockResolvedValueOnce(json({ name: `Philip ${MARK}` })),
    )

    const res = await callback('meta', 'code=c1&state=st-1')
    expect(res.status).toBe(307)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('picker=')

    const connection = await db.adConnection.findFirstOrThrow({
      where: { label: `Philip ${MARK}` },
    })
    expect(connection.secret.startsWith('enc:v1:')).toBe(true)
    expect(connection.secret).not.toContain('long-secret')
    expect(connection.expiresAt).not.toBeNull()
  })

  it('logging in again refreshes the connection instead of duplicating it', async () => {
    await db.adConnection.create({
      data: { provider: 'meta', label: `Philip ${MARK}`, secret: 'old' },
    })
    cookieJar.state = 'meta:st-2'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: 'short' }))
        .mockResolvedValueOnce(json({ access_token: 'brand-new', expires_in: 100 }))
        .mockResolvedValueOnce(json({ name: `Philip ${MARK}` })),
    )

    await callback('meta', 'code=c2&state=st-2')
    const rows = await db.adConnection.findMany({ where: { label: `Philip ${MARK}` } })
    expect(rows).toHaveLength(1)
    expect(rows[0].secret).not.toBe('old')
  })

  it('a wrong state stores nothing', async () => {
    cookieJar.state = 'meta:right'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await callback('meta', 'code=c&state=wrong')
    expect(res.headers.get('location')).toContain('error=')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await db.adConnection.count({ where: { label: { contains: MARK } } })).toBe(0)
  })
})

describe('connection accounts + bulk connect', () => {
  it('lists accounts with suggestions and marks the connected ones', async () => {
    const shop = await db.shop.create({ data: { name: `Mazzetti.no ${MARK}`, currency: 'NOK' } })
    const connection = await db.adConnection.create({
      data: { provider: 'meta', label: `Login ${MARK}`, secret: 'tok' },
    })
    await db.adAccount.create({
      data: {
        shopId: shop.id,
        provider: 'meta',
        externalId: '888555222',
        name: `Old one ${MARK}`,
        currency: 'NOK',
        credentials: null,
        connectionId: connection.id,
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          data: [
            { account_id: '888555222', name: 'Old one', currency: 'NOK' },
            { account_id: '999111333', name: `Mazzetti NO ${MARK}`, currency: 'NOK' },
          ],
        }),
      ),
    )

    const res = await accountsRoute(new Request('http://localhost'), {
      params: Promise.resolve({ id: connection.id }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const old = body.accounts.find((a: { externalId: string }) => a.externalId === '888555222')
    const fresh = body.accounts.find((a: { externalId: string }) => a.externalId === '999111333')
    expect(old.alreadyConnected).toBe(true)
    expect(fresh.alreadyConnected).toBe(false)
    expect(fresh.suggestedShopId).toBe(shop.id)
  })

  it('bulk connect creates accounts on the login, backfills, and skips duplicates', async () => {
    const shop = await db.shop.create({ data: { name: `Shop ${MARK}`, currency: 'NOK' } })
    const connection = await db.adConnection.create({
      data: { provider: 'meta', label: `Login2 ${MARK}`, secret: 'tok' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json({ data: [{ date_start: '2026-07-01', spend: '10.00', impressions: '5', clicks: '1' }] }),
      ),
    )

    const post = () =>
      bulkRoute(
        new Request('http://localhost/api/ad-accounts/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connectionId: connection.id,
            accounts: [
              { externalId: '444555666', name: `Picked ${MARK}`, currency: 'NOK', shopId: shop.id },
            ],
          }),
        }),
      )

    const first = await post()
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    expect(firstBody.results[0].ok).toBe(true)
    expect(firstBody.results[0].days).toBe(1)

    const account = await db.adAccount.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'meta', externalId: '444555666' } },
    })
    expect(account.connectionId).toBe(connection.id)
    expect(account.credentials).toBeNull()
    expect(await db.adSpend.count({ where: { accountId: account.id } })).toBe(1)

    const again = await post()
    const againBody = await again.json()
    expect(againBody.results).toHaveLength(0)
    expect(againBody.skipped[0]).toContain('already connected')
  })
})
