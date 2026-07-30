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
  await db.adPlatformApp.upsert({
    where: { provider: 'google' },
    create: {
      provider: 'google',
      clientId: 'oauth-test-google',
      clientSecret: 'shh',
      developerToken: 'dev',
    },
    update: { clientId: 'oauth-test-google', clientSecret: 'shh', developerToken: 'dev' },
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

// Two save-time tests lived here, both driving ensureMetaApp: a wrong App
// ID refused with Facebook's words, and the App Domains warning. Saving no
// longer calls Meta at all — the token proves itself instead, in
// src/lib/ads/token.test.ts — so they went with it.

describe('platform setup', () => {
  it('stores secrets encrypted and answers with booleans only', async () => {
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

// Four Meta start tests lived here: the domain write, the second click it
// asked for, the refused write, and the unreachable-Meta fallthrough. The
// second-click one WAS the loop — ensureMetaApp could report "healed"
// forever.

describe('oauth start', () => {
  it('stamps a state cookie and sends the admin to the platform dialog', async () => {
    const res = await start('google')
    expect(res.status).toBe(307)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth')
    expect(location).toContain('client_id=oauth-test-google')
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/ads_oauth_state=google(%3A|:)/)
  })

  it('sends the admin back with words when the platform setup is missing', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'google' } })
    const res = await start('google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('error=')
  })
})

describe('oauth callback', () => {
  /** Google hands back a refresh token, then names who logged in. */
  const stubGoogleLogin = (refreshToken: string) =>
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: 'short', refresh_token: refreshToken }))
        .mockResolvedValueOnce(json({ name: `Philip ${MARK}` })),
    )

  it('stores an encrypted connection and opens the picker', async () => {
    cookieJar.state = 'google:st-1'
    stubGoogleLogin('long-secret')

    const res = await callback('google', 'code=c1&state=st-1')
    expect(res.status).toBe(307)
    expect(res.headers.get('location') ?? '').toContain('picker=')

    const connection = await db.adConnection.findFirstOrThrow({
      where: { label: `Philip ${MARK}` },
    })
    expect(connection.secret.startsWith('enc:v1:')).toBe(true)
    expect(connection.secret).not.toContain('long-secret')
    // Google refresh tokens do not expire the way Meta's user tokens did.
    expect(connection.expiresAt).toBeNull()
  })

  it('logging in again refreshes the connection instead of duplicating it', async () => {
    await db.adConnection.create({
      data: { provider: 'google', label: `Philip ${MARK}`, secret: 'old' },
    })
    cookieJar.state = 'google:st-2'
    stubGoogleLogin('brand-new')

    await callback('google', 'code=c2&state=st-2')
    const rows = await db.adConnection.findMany({ where: { label: `Philip ${MARK}` } })
    expect(rows).toHaveLength(1)
    expect(rows[0].secret).not.toBe('old')
  })

  it('a wrong state stores nothing', async () => {
    cookieJar.state = 'google:right'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await callback('google', 'code=c&state=wrong')
    expect(res.headers.get('location')).toContain('error=')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await db.adConnection.count({ where: { label: { contains: MARK } } })).toBe(0)
  })

})

describe('meta oauth start', () => {
  it('stamps a state cookie and sends the admin to the Facebook dialog', async () => {
    const res = await start('meta')
    expect(res.status).toBe(307)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('facebook.com/v25.0/dialog/oauth')
    expect(location).toContain('client_id=oauth-test-app')
    expect(location).toContain(encodeURIComponent('/api/ads/oauth/meta/callback'))
    expect(res.headers.get('set-cookie') ?? '').toMatch(/ads_oauth_state=meta(%3A|:)/)
  })

  // Saving the app row no longer calls Meta, so starting must not either.
  it('reaches the dialog without asking Facebook anything first', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await start('meta')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the admin to the setup when no meta app row exists', async () => {
    await db.adPlatformApp.delete({ where: { provider: 'meta' } })
    const res = await start('meta')
    expect(res.headers.get('location')).toContain(
      encodeURIComponent('Fill in the platform setup below first.'),
    )
  })
})

describe('meta oauth callback', () => {
  const stubExchange = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('fb_exchange_token'))
          return json({ access_token: 'long-lived', expires_in: 5_184_000 })
        if (url.includes('/me')) return json({ name: `${MARK} Jacob` })
        return json({ access_token: 'short' })
      }),
    )

  it('stores the long-lived token and opens the picker', async () => {
    stubExchange()
    cookieJar.state = 'meta:st-1'
    const res = await callback('meta', 'code=c1&state=st-1')

    expect(res.status).toBe(307)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/settings/ad-accounts?picker=')

    const row = await db.adConnection.findFirstOrThrow({
      where: { provider: 'meta', label: `${MARK} Jacob` },
    })
    expect(row.secret.startsWith('enc:v1:')).toBe(true)
    expect(row.secret).not.toContain('long-lived')
    // Meta tokens die; Google refresh tokens do not. The date must be real.
    expect(row.expiresAt).not.toBeNull()
    expect(location).toContain(row.id)
  })

  it('logging in again refreshes the same connection instead of piling up', async () => {
    stubExchange()
    cookieJar.state = 'meta:st-1'
    await callback('meta', 'code=c1&state=st-1')
    cookieJar.state = 'meta:st-2'
    await callback('meta', 'code=c2&state=st-2')

    const rows = await db.adConnection.findMany({
      where: { provider: 'meta', label: `${MARK} Jacob` },
    })
    expect(rows).toHaveLength(1)
  })

  it('refuses a callback whose state does not match the cookie', async () => {
    cookieJar.state = 'meta:st-1'
    const res = await callback('meta', 'code=c1&state=somebody-elses')
    expect(res.headers.get('location')).toContain(
      encodeURIComponent('The login came back wrong. Try again.'),
    )
    expect(await db.adConnection.count({ where: { label: { contains: MARK } } })).toBe(0)
  })

  it("passes Facebook's refusal straight through", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'Code was invalid.' } }, 400)),
    )
    cookieJar.state = 'meta:st-1'
    const res = await callback('meta', 'code=bad&state=st-1')
    expect(res.headers.get('location')).toContain(encodeURIComponent('Code was invalid.'))
  })
})

describe('unknown providers', () => {
  it('still refuses a platform we do not support', async () => {
    expect((await start('tiktok')).status).toBe(404)
    expect((await callback('tiktok', 'code=c&state=s')).status).toBe(404)
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
