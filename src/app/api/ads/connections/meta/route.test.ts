import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { POST } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')
const { decryptSecret, encryptSecret } = await import('@/lib/secrets')

const ME = 'plan-metatoken-me@example.local'
const LABEL = 'Plan Metatoken Person'
let myId = ''

async function wipe() {
  await db.adConnection.deleteMany({ where: { label: LABEL } })
  await db.user.deleteMany({ where: { email: ME } })
}

/**
 * AdPlatformApp is a singleton per provider, shared with the seed data and
 * with the oauth suite running alongside this one. Borrow it, always put it
 * back — never delete it out from under a neighbour.
 */
async function restoreSeedApp() {
  await db.adPlatformApp.upsert({
    where: { provider: 'meta' },
    create: { provider: 'meta', clientId: 'seed-app', clientSecret: 'seed' },
    update: { clientId: 'seed-app', clientSecret: 'seed' },
  })
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
})

afterEach(async () => {
  await wipe()
  await restoreSeedApp()
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

// upsert, never create: the row is a singleton and a neighbouring suite
// borrows it too, so `create` would race into a unique-constraint failure.
const app = () =>
  db.adPlatformApp.upsert({
    where: { provider: 'meta' },
    create: { provider: 'meta', clientId: 'appid', clientSecret: encryptSecret('shh') },
    update: { clientId: 'appid', clientSecret: encryptSecret('shh') },
  })

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
    await app()
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
    await app()
    stubHappyMeta()
    const first = await (await post({ token: 'EAABone' })).json()
    const second = await (await post({ token: 'EAABtwo' })).json()

    expect(second.connectionId).toBe(first.connectionId)
    const rows = await db.adConnection.findMany({ where: { label: LABEL } })
    expect(rows).toHaveLength(1)
    expect(decryptSecret(rows[0].secret)).toBe('EAABtwo')
  })

  it('answers 400 with Facebook words when the token is refused', async () => {
    await app()
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

  it('asks for the app first when no platform setup exists', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'meta' } })
    stubHappyMeta()
    const res = await post({ token: 'EAABpasted' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/app ID and secret/i)
    // afterEach puts the shared row back.
  })

  it('refuses an empty token without calling Facebook', async () => {
    await app()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await post({ token: '  ' })).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is admin only', async () => {
    await app()
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
