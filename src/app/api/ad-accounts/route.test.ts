import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, POST } = await import('./route')
const { DELETE, PATCH } = await import('./[id]/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const MARK = '[ad-accounts-test]'

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin',
    email: 'admin@test.local',
    role: 'ADMIN',
    ambassadorId: null,
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function wipe() {
  await db.adAccount.deleteMany({ where: { name: { contains: MARK } } })
  await db.adAccount.deleteMany({ where: { externalId: { in: ['777000111', '777000222'] } } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

let shopId = ''

beforeEach(async () => {
  await wipe()
  await asAdmin()
  shopId = (await db.shop.create({ data: { name: `Shop ${MARK}`, currency: 'NOK' } })).id
})

afterEach(async () => {
  await wipe()
  vi.unstubAllGlobals()
})

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/ad-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

/** Meta answers verification, then the insights backfill. */
function stubMetaHappy() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/insights'))
        return json({
          data: [{ date_start: '2026-07-01', spend: '250.00', impressions: '5000', clicks: '100' }],
        })
      return json({ name: `Panetti NO ${MARK}`, currency: 'NOK' })
    }),
  )
}

describe('POST /api/ad-accounts', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({})).status).toBe(403)
  })

  it('verifies against Meta, encrypts the token, and backfills spend', async () => {
    stubMetaHappy()

    const res = await post({
      shopId,
      provider: 'meta',
      externalId: 'act_777000111', // pasted with the prefix on purpose
      accessToken: 'EAAB-secret-token',
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    // Name and currency come from the platform, not the form.
    expect(body.account.name).toBe(`Panetti NO ${MARK}`)
    expect(body.account.currency).toBe('NOK')
    expect(body.account.externalId).toBe('777000111')
    expect(body.sync.ok).toBe(true)

    // Nothing secret in the response, encrypted at rest in the database.
    expect(JSON.stringify(body)).not.toContain('EAAB-secret-token')
    const stored = await db.adAccount.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'meta', externalId: '777000111' } },
    })
    expect(stored.credentials?.startsWith('enc:v1:')).toBe(true)
    expect(stored.credentials ?? '').not.toContain('EAAB-secret-token')

    const spend = await db.adSpend.findMany({ where: { accountId: stored.id } })
    expect(spend).toHaveLength(1)
    expect(spend[0].spend).toBe(25000)
  })

  it("answers 400 with the platform's words and stores nothing on bad credentials", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'Invalid OAuth access token' } }, 401)),
    )

    const res = await post({
      shopId,
      provider: 'meta',
      externalId: '777000111',
      accessToken: 'bad',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid OAuth access token')
    expect(await db.adAccount.count({ where: { externalId: '777000111' } })).toBe(0)
  })

  it('names the missing Google fields before calling anyone', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await post({ shopId, provider: 'google', externalId: '777-000-222' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Paste the developer token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to connect the same account twice', async () => {
    stubMetaHappy()
    const body = { shopId, provider: 'meta', externalId: '777000111', accessToken: 't' }
    expect((await post(body)).status).toBe(200)
    const dup = await post(body)
    expect(dup.status).toBe(409)
  })
})

describe('GET /api/ad-accounts', () => {
  it('lists accounts without ever leaking credentials', async () => {
    stubMetaHappy()
    await post({ shopId, provider: 'meta', externalId: '777000111', accessToken: 'EAAB-secret-token' })

    const res = await GET()
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json())
    expect(text).toContain(`Panetti NO ${MARK}`)
    expect(text).not.toContain('credentials')
    expect(text).not.toContain('EAAB-secret-token')
  })
})

describe('PATCH and DELETE /api/ad-accounts/[id]', () => {
  it('re-verifies replaced credentials and keeps blanks as they were', async () => {
    stubMetaHappy()
    await post({ shopId, provider: 'meta', externalId: '777000111', accessToken: 'old-token' })
    const stored = await db.adAccount.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'meta', externalId: '777000111' } },
    })

    const verify = vi.fn().mockResolvedValue(json({ name: `Renamed ${MARK}`, currency: 'NOK' }))
    vi.stubGlobal('fetch', verify)

    const res = await PATCH(
      new Request('http://localhost/api/ad-accounts/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: 'new-token' }),
      }),
      { params: Promise.resolve({ id: stored.id }) },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).account.name).toBe(`Renamed ${MARK}`)
    // The verify call used the NEW token.
    const headers = (verify.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer new-token')

    // A blank-only body changes nothing and calls no one.
    const idle = vi.fn()
    vi.stubGlobal('fetch', idle)
    const noop = await PATCH(
      new Request('http://localhost/api/ad-accounts/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: '' }),
      }),
      { params: Promise.resolve({ id: stored.id }) },
    )
    expect(noop.status).toBe(200)
    expect(idle).not.toHaveBeenCalled()
  })

  it('deletes the account and its spend with it', async () => {
    stubMetaHappy()
    await post({ shopId, provider: 'meta', externalId: '777000111', accessToken: 't' })
    const stored = await db.adAccount.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'meta', externalId: '777000111' } },
    })
    expect(await db.adSpend.count({ where: { accountId: stored.id } })).toBe(1)

    const res = await DELETE(new Request('http://localhost'), {
      params: Promise.resolve({ id: stored.id }),
    })
    expect(res.status).toBe(200)
    expect(await db.adAccount.count({ where: { id: stored.id } })).toBe(0)
    expect(await db.adSpend.count({ where: { accountId: stored.id } })).toBe(0)
  })
})
