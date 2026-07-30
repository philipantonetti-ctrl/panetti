import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

/**
 * The route's only credential source, after Task 2, is platformApp('meta').
 * Mock it here rather than writing real AdPlatformApp rows: the table's
 * provider column is uniquely constrained, and src/app/api/ads/oauth.test.ts
 * already owns the one meta row for real-database coverage of the accessor's
 * fallback path. Two files writing the same row from parallel Vitest workers
 * raced and failed nondeterministically.
 */
vi.mock('@/lib/ads/platform-app', () => ({
  platformApp: vi.fn(),
}))

const { POST } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')
const { decryptSecret } = await import('@/lib/secrets')
const { platformApp } = await import('@/lib/ads/platform-app')

const ME = 'plan-metatoken-me@example.local'
const LABEL = 'Plan Metatoken Person'
let myId = ''

async function wipe() {
  await db.adConnection.deleteMany({ where: { label: LABEL } })
  await db.user.deleteMany({ where: { email: ME } })
}

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: myId,
    email: ME,
    role: 'ADMIN',
    ambassadorId: null,
  })
}

beforeEach(async () => {
  await wipe()
  const me = await db.user.create({ data: { email: ME, passwordHash: 'x', role: 'ADMIN' } })
  myId = me.id
  await asAdmin()
  // Most tests want an app configured; the one that does not overrides this.
  vi.mocked(platformApp).mockResolvedValue({ clientId: 'appid', clientSecret: 'shh' })
})

afterEach(async () => {
  await wipe()
  vi.unstubAllGlobals()
})

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/ads/connections/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

/** Facebook, agreeing with everything. */
function stubHappyMeta(name = LABEL) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('grant_type=client_credentials'))
        return Response.json({ access_token: 'APP|TOKEN' })
      if (url.includes('/debug_token'))
        return Response.json({ data: { is_valid: true, expires_at: 0, scopes: ['ads_read'] } })
      return Response.json({ name })
    }),
  )
}

describe('POST /api/ads/connections/meta', () => {
  it('stores the token encrypted, never expiring, and hands back the connection', async () => {
    stubHappyMeta()

    const res = await post({ token: 'EAABpasted' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.label).toBe(LABEL)
    expect(body.expiresAt).toBeNull()

    const stored = await db.adConnection.findUniqueOrThrow({ where: { id: body.connectionId } })
    expect(stored.provider).toBe('meta')
    expect(stored.expiresAt).toBeNull()
    expect(stored.secret).not.toContain('EAABpasted')
    expect(decryptSecret(stored.secret)).toBe('EAABpasted')
  })

  it('refreshes the same person instead of piling up connections', async () => {
    stubHappyMeta()
    const first = await (await post({ token: 'EAABone' })).json()
    const second = await (await post({ token: 'EAABtwo' })).json()

    expect(second.connectionId).toBe(first.connectionId)
    const rows = await db.adConnection.findMany({ where: { label: LABEL } })
    expect(rows).toHaveLength(1)
    expect(decryptSecret(rows[0].secret)).toBe('EAABtwo')
  })

  it('answers 400 with Facebook words when the token is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('grant_type=client_credentials'))
          return Response.json({ access_token: 'APP|TOKEN' })
        if (url.includes('/debug_token')) return new Response('x', { status: 500 })
        return Response.json({ error: { message: 'Malformed access token' } }, { status: 400 })
      }),
    )

    const res = await post({ token: 'bad' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Malformed access token')
    expect(await db.adConnection.count({ where: { label: LABEL } })).toBe(0)
  })

  it('connects with no platform app at all, losing only the expiry check', async () => {
    // The App ID and secret are optional on purpose: demanding them before a
    // token is accepted would be one more wall in front of the one field
    // that matters. Without them we skip debug_token and still connect.
    vi.mocked(platformApp).mockResolvedValue(null)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/debug_token') || url.includes('client_credentials'))
        throw new Error('must not ask Facebook about a token with no app to ask as')
      return Response.json({ name: LABEL })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await post({ token: 'EAABpasted' })
    expect(res.status).toBe(200)
    expect((await res.json()).expiresAt).toBeNull()
    expect(await db.adConnection.count({ where: { label: LABEL } })).toBe(1)
  })

  it('refuses an empty token without calling Facebook', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await post({ token: '  ' })).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is admin only', async () => {
    stubHappyMeta()
    cookieValue.current = await signSession({
      userId: myId,
      email: ME,
      role: 'MARKETING',
      ambassadorId: null,
    })
    expect((await post({ token: 'EAABpasted' })).status).toBe(403)
  })
})
