import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, POST } = await import('./route')
const { PATCH, DELETE } = await import('./[id]/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')
const { decryptSecret } = await import('@/lib/secrets')

const MARK = '[affiliate-accounts-test]'
/** The one secret in this file. Every assertion about leaking looks for it. */
const TOKEN = 'addrevenue-live-token-0123456789'
const ADVERTISER = '9868510001'

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
  await db.affiliateAccount.deleteMany({ where: { name: { contains: MARK } } })
  await db.affiliateAccount.deleteMany({ where: { externalId: ADVERTISER } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

let shopId = ''

beforeEach(async () => {
  await wipe()
  await asAdmin()
  shopId = (
    await db.shop.create({
      data: { name: `Shop ${MARK}`, currency: 'NOK', wooUrl: 'https://www.affiliate-accounts-test.no' },
    })
  ).id
})

afterEach(async () => {
  await wipe()
  vi.unstubAllGlobals()
})

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/affiliate/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

/**
 * Addrevenue, answering: the advertiser with two markets, then two sales.
 * The FI market points at a domain no shop holds, so one sale matches no shop -
 * which is the number the status cell exists to show.
 */
function stubAddrevenue() {
  const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    if (auth !== `Bearer ${TOKEN}`) return json({ message: 'Invalid token' }, 403)
    const url = String(input)
    if (url.includes('/advertisers'))
      return json({
        results: [
          {
            id: Number(ADVERTISER),
            displayName: `Panetti ${MARK}`,
            markets: {
              NO: { market: 'NO', url: 'https://www.affiliate-accounts-test.no' },
              FI: { market: 'FI', url: 'https://www.affiliate-accounts-test.fi' },
            },
          },
        ],
        meta: { hasNextPage: false },
      })
    if (url.includes('/transactions'))
      return json({
        results: [
          {
            id: 5001,
            date: '2026-03-02',
            channelId: 3464435,
            channelName: 'Forbrukertesten.com',
            market: 'NO',
            currency: 'NOK',
            eventValue: '855.64',
            commission: '128.35',
            brokerageFee: 19.25,
            status: 'new',
            denyDate: null,
            eventOrderId: '19101',
          },
          {
            id: 5002,
            date: '2026-03-03',
            channelId: 3464435,
            channelName: 'Forbrukertesten.com',
            market: 'FI',
            currency: 'EUR',
            eventValue: '80.00',
            commission: '12.00',
            brokerageFee: 1.8,
            status: 'new',
            denyDate: null,
            eventOrderId: '19102',
          },
        ],
        meta: { hasNextPage: false },
      })
    return json({ message: 'unexpected call' }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Connect the brand, then stop it syncing.
 *
 * The pause is housekeeping, not the subject: this suite shares one dev
 * database with `sync.test.ts`, whose forced syncAllAffiliateAccounts sweeps up
 * every ACTIVE account it finds - including one of ours, mid-test.
 */
async function connect() {
  const res = await post({ token: TOKEN })
  await db.affiliateAccount.updateMany({
    where: { externalId: ADVERTISER },
    data: { active: false },
  })
  return res
}

const stored = () =>
  db.affiliateAccount.findUniqueOrThrow({
    where: { provider_externalId: { provider: 'addrevenue', externalId: ADVERTISER } },
  })

describe('POST /api/affiliate/accounts', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({ token: TOKEN })).status).toBe(403)
  })

  it('names what is missing before calling anyone', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await post({ token: 'short' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Paste the API token from Addrevenue')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers a malformed body with a 400, never a thrown SyntaxError', async () => {
    // The generic catch logs its error, and V8's SyntaxError quotes the body
    // it choked on - on this route that can be a token. The 400 path must
    // catch the parse itself.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(
      new Request('http://localhost/api/affiliate/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"token": "${TOKEN}`, // truncated mid-string, as a bad client would
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid details')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /** The whole point of the route: prove it, THEN store it. */
  it("answers with Addrevenue's own words and stores nothing when the token is refused", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Forbidden' }, 403)))

    const res = await post({ token: 'a-token-that-was-never-valid' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(
      'Addrevenue rejected the token. Check it in Addrevenue and paste it again.',
    )
    expect(await db.affiliateAccount.count({ where: { externalId: ADVERTISER } })).toBe(0)
    expect(await db.affiliateAccount.count({ where: { name: { contains: MARK } } })).toBe(0)
  })

  it('verifies the token, encrypts it, and imports the history at once', async () => {
    stubAddrevenue()

    const res = await connect()
    expect(res.status).toBe(200)
    const body = await res.json()

    // Name and advertiser id come from Addrevenue, not from anything typed.
    expect(body.account.name).toBe(`Panetti ${MARK}`)
    expect(body.account.externalId).toBe(ADVERTISER)
    expect(body.sync).toMatchObject({ ok: true, rows: 2, unmatchedMarkets: ['FI'] })

    // The counts the settings table reads: everything imported, and the one
    // sale whose market belongs to no shop.
    expect(body.account.transactions).toBe(2)
    expect(body.account.unmatched).toBe(1)

    // Nothing secret in the answer, and no `token` key at all to forget to strip.
    expect(JSON.stringify(body)).not.toContain(TOKEN)
    expect(Object.keys(body.account)).not.toContain('token')

    // Encrypted at rest, and still the token we were given.
    const row = await stored()
    expect(row.token.startsWith('enc:v1:')).toBe(true)
    expect(row.token).not.toContain(TOKEN)
    expect(decryptSecret(row.token)).toBe(TOKEN)

    // The matched market's sale is charged to the shop; the other is not
    // guessed at.
    const rows = await db.affiliateTransaction.findMany({
      where: { accountId: row.id },
      orderBy: { externalId: 'asc' },
    })
    expect(rows.map((r) => r.shopId)).toEqual([shopId, null])
    expect(rows[0].commission).toBe(12835)
  })

  it('refuses a token for an advertiser already connected, by name', async () => {
    stubAddrevenue()
    expect((await connect()).status).toBe(200)

    const dup = await post({ token: TOKEN })
    expect(dup.status).toBe(409)
    expect((await dup.json()).error).toBe(`Panetti ${MARK} is already connected.`)
    expect(await db.affiliateAccount.count({ where: { externalId: ADVERTISER } })).toBe(1)
  })
})

describe('GET /api/affiliate/accounts', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await GET()).status).toBe(403)
  })

  it('lists the brands and their counts, never the token', async () => {
    stubAddrevenue()
    await connect()

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    // Found by advertiser id: the shared dev database holds other suites' rows.
    const mine = (body.accounts as { externalId: string }[]).find((a) => a.externalId === ADVERTISER)
    expect(mine).toMatchObject({ name: `Panetti ${MARK}`, transactions: 2, unmatched: 1 })
    expect(Object.keys(mine!)).not.toContain('token')
    expect(JSON.stringify(body)).not.toContain(TOKEN)
  })

  it("keeps each brand's counts on its own row", async () => {
    stubAddrevenue()
    await connect()

    // A second brand, seeded directly - the per-account join in withCounts is
    // what this test is about, and one account cannot exercise a join.
    const other = await db.affiliateAccount.create({
      data: {
        externalId: `${ADVERTISER}2`,
        name: `Mazzetti ${MARK}`,
        token: 'plain-token',
        active: false,
      },
    })
    await db.affiliateTransaction.create({
      data: {
        accountId: other.id,
        externalId: '9001',
        date: new Date('2026-03-04'),
        market: 'SE',
        shopId: null,
        channelId: '77',
        channelName: 'Testsieger.de',
        status: 'new',
        commission: 1000,
        brokerageFee: 150,
        orderValue: 9000,
        currency: 'SEK',
      },
    })

    const body = await (await GET()).json()
    const rows = body.accounts as { externalId: string; transactions: number; unmatched: number }[]
    // Distinct counts per brand - a join that summed globally would show 3/2 on both.
    expect(rows.find((a) => a.externalId === ADVERTISER)).toMatchObject({ transactions: 2, unmatched: 1 })
    expect(rows.find((a) => a.externalId === `${ADVERTISER}2`)).toMatchObject({ transactions: 1, unmatched: 1 })
  })
})

describe('PATCH and DELETE /api/affiliate/accounts/[id]', () => {
  const patch = (id: string, active: boolean) =>
    PATCH(
      new Request('http://localhost/api/affiliate/accounts/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      }),
      { params: Promise.resolve({ id }) },
    )

  it('pauses and resumes without touching a single imported sale', async () => {
    stubAddrevenue()
    await connect()
    const row = await stored()

    const resumed = await patch(row.id, true)
    expect(resumed.status).toBe(200)
    expect((await resumed.json()).active).toBe(true)
    expect(await db.affiliateTransaction.count({ where: { accountId: row.id } })).toBe(2)

    const paused = await patch(row.id, false)
    expect((await paused.json()).active).toBe(false)
    expect((await stored()).active).toBe(false)
    // History is what the dashboards charge to profit; pausing must not move it.
    expect(await db.affiliateTransaction.count({ where: { accountId: row.id } })).toBe(2)
  })

  it('404s on an id that is not there', async () => {
    expect((await patch('no-such-account', false)).status).toBe(404)
    expect(
      (await DELETE(new Request('http://localhost'), {
        params: Promise.resolve({ id: 'no-such-account' }),
      })).status,
    ).toBe(404)
  })

  it('takes the imported sales with it on delete', async () => {
    stubAddrevenue()
    await connect()
    const row = await stored()
    expect(await db.affiliateTransaction.count({ where: { accountId: row.id } })).toBe(2)

    const res = await DELETE(new Request('http://localhost'), {
      params: Promise.resolve({ id: row.id }),
    })
    expect(res.status).toBe(200)
    expect(await db.affiliateAccount.count({ where: { id: row.id } })).toBe(0)
    expect(await db.affiliateTransaction.count({ where: { accountId: row.id } })).toBe(0)
  })
})
