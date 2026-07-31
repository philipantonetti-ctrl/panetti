import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const metaBreakdown = vi.fn()
const googleBreakdown = vi.fn()
vi.mock('@/lib/ads/meta', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchMetaBreakdown: (...a: unknown[]) => metaBreakdown(...a),
}))
vi.mock('@/lib/ads/google', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchGoogleBreakdown: (...a: unknown[]) => googleBreakdown(...a),
}))

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

/**
 * DB-backed like src/app/api/marketing/route.test.ts: a real shop and real ad
 * accounts, scoped by the [breakdown-test] marker so parallel test files never
 * collide. The two platform drivers are mocked above so no test ever reaches
 * Meta or Google.
 */
const MARK = '[breakdown-test]'

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin',
    email: 'admin@test.local',
    role: 'ADMIN',
    ambassadorId: null,
  })
}

const asAmbassador = async () => {
  cookieValue.current = await signSession({
    userId: 'test-ambassador',
    email: 'amb@test.local',
    role: 'AMBASSADOR',
    ambassadorId: 'amb-1',
  })
}

async function wipe() {
  await db.adAccount.deleteMany({ where: { name: { contains: MARK } } })
  await db.adConnection.deleteMany({ where: { label: { contains: MARK } } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

let shopId = ''

async function makeAccount(over: Record<string, unknown> = {}) {
  return db.adAccount.create({
    data: {
      shopId,
      provider: 'meta',
      externalId: `bd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `Account ${MARK}`,
      // Deliberately not the shop's own currency (NOK, set in beforeEach):
      // same value on both sides would let "currency comes from the account"
      // pass even if the route read it off the shop instead.
      currency: 'SEK',
      credentials: JSON.stringify({ accessToken: 'seed' }),
      ...over,
    },
  })
}

/** A minimal, valid BreakdownEntry — the id varies, and a test may override
 * any other field (e.g. spend, to check ordering). */
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Campaign ${id}`,
  spend: 1000,
  purchases: 1,
  purchaseValue: 5000,
  impressions: 100,
  clicks: 10,
  ...over,
})

beforeEach(async () => {
  await wipe()
  await asAdmin()
  metaBreakdown.mockReset()
  googleBreakdown.mockReset()

  const shop = await db.shop.create({ data: { name: `Shop ${MARK}`, currency: 'NOK' } })
  shopId = shop.id
})

afterEach(wipe)

const get = (qs: string) => GET(new Request(`http://localhost/api/marketing/breakdown?${qs}`))

describe('GET /api/marketing/breakdown', () => {
  it('refuses a non-admin', async () => {
    await asAmbassador()
    const res = await get(`shopId=${shopId}`)
    expect(res.status).toBe(403)
    expect(metaBreakdown).not.toHaveBeenCalled()
    expect(googleBreakdown).not.toHaveBeenCalled()
  })

  it('asks the platform for the level and parent it was given', async () => {
    const account = await makeAccount()
    metaBreakdown.mockResolvedValue([])

    const res = await get(`shopId=${shopId}&level=adset&parentId=777`)
    expect(res.status).toBe(200)

    expect(metaBreakdown).toHaveBeenCalledTimes(1)
    const [, target] = metaBreakdown.mock.calls[0] as [
      unknown,
      { level: string; parentId?: string; accountExternalId: string },
    ]
    expect(target).toMatchObject({
      level: 'adset',
      parentId: '777',
      accountExternalId: account.externalId,
    })
  })

  it('switches driver on the provider', async () => {
    await makeAccount({ provider: 'google', externalId: `bd-google-${Date.now()}` })
    googleBreakdown.mockResolvedValue([])

    const res = await get(`shopId=${shopId}&provider=google`)
    expect(res.status).toBe(200)
    expect(googleBreakdown).toHaveBeenCalledTimes(1)
    expect(metaBreakdown).not.toHaveBeenCalled()
  })

  it('stamps each row with the account it came from', async () => {
    const account = await makeAccount()
    metaBreakdown.mockResolvedValue([entry('c1')])

    const res = await get(`shopId=${shopId}`)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({
      id: 'c1',
      accountId: account.id,
      accountName: account.name,
      currency: account.currency,
    })
  })

  it("returns the union across a shop's accounts", async () => {
    await makeAccount({ externalId: `bd-a-${Date.now()}` })
    await makeAccount({ externalId: `bd-b-${Date.now()}` })
    metaBreakdown.mockResolvedValue([entry('c1')])

    const res = await get(`shopId=${shopId}`)
    const body = await res.json()
    expect(body.rows).toHaveLength(2)
    expect(metaBreakdown).toHaveBeenCalledTimes(2)
  })

  // C1: campaign level has no accountId — asking every account is the whole
  // point there, and this must survive the fix below that scopes deeper
  // levels to one. Each account is made to return ITS OWN row (rather than
  // sharing one fixture, as the union test above does) so a fix that
  // accidentally filtered by the first account's id, or otherwise dropped
  // one account, would be caught by a row going missing rather than merely
  // an array length staying the same by coincidence.
  it('still fans out to every account at campaign level when no accountId is given', async () => {
    const accountA = await makeAccount({ externalId: `bd-a-${Date.now()}` })
    const accountB = await makeAccount({ externalId: `bd-b-${Date.now()}` })
    metaBreakdown.mockImplementation(
      async (_creds: unknown, target: { accountExternalId: string }) => [
        entry(target.accountExternalId === accountA.externalId ? 'a1' : 'b1'),
      ],
    )

    const res = await get(`shopId=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(metaBreakdown).toHaveBeenCalledTimes(2)
    const queried = (metaBreakdown.mock.calls as [unknown, { accountExternalId: string }][]).map(
      (c) => c[1].accountExternalId,
    )
    expect(queried.sort()).toEqual([accountA.externalId, accountB.externalId].sort())
    expect(body.rows.map((r: { accountId: string }) => r.accountId).sort()).toEqual(
      [accountA.id, accountB.id].sort(),
    )
  })

  // C1's fix, the critical finding: a campaign id belongs to exactly one ad
  // account, so a deeper level with an accountId must be scoped to it —
  // exactly one driver call, for that account, and nothing attributed to the
  // other. Before the fix this fanned out to both, so account B's driver
  // call would have run too and its row would have been stamped onto the
  // response as if it belonged to account A.
  it('scopes to one account when accountId is given: one driver call, no rows from the other account', async () => {
    const accountA = await makeAccount({ externalId: `bd-a-${Date.now()}` })
    const accountB = await makeAccount({ externalId: `bd-b-${Date.now()}` })
    metaBreakdown.mockImplementation(
      async (_creds: unknown, target: { accountExternalId: string }) => [
        entry(target.accountExternalId === accountA.externalId ? 'a1' : 'b1'),
      ],
    )

    const res = await get(`shopId=${shopId}&level=adset&parentId=777&accountId=${accountA.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(metaBreakdown).toHaveBeenCalledTimes(1)
    const [, target] = metaBreakdown.mock.calls[0] as [unknown, { accountExternalId: string }]
    expect(target.accountExternalId).toBe(accountA.externalId)

    expect(body.accountsChecked).toBe(1)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].accountId).toBe(accountA.id)
    expect(body.rows.some((r: { accountId: string }) => r.accountId === accountB.id)).toBe(false)
  })

  // I6: platform order carries no meaning on a page used to judge spending —
  // matches MarketingTable's own default sort (highest spend first).
  it('sorts rows by spend, richest first', async () => {
    await makeAccount()
    metaBreakdown.mockResolvedValue([
      entry('low', { spend: 100 }),
      entry('high', { spend: 5000 }),
      entry('mid', { spend: 900 }),
    ])

    const res = await get(`shopId=${shopId}`)
    const body = await res.json()
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(['high', 'mid', 'low'])
  })

  it('says so when the store has no accounts on that provider', async () => {
    const res = await get(`shopId=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(metaBreakdown).not.toHaveBeenCalled()
    // Zero accounts consulted, not merely zero rows returned — Task 5's
    // BreakdownTable reads this to say "no account" rather than "no campaigns".
    expect(body.accountsChecked).toBe(0)
  })

  it('turns an expired token into readable text, not a crash', async () => {
    const connection = await db.adConnection.create({
      data: {
        provider: 'meta',
        label: `Login ${MARK}`,
        secret: 'old-token',
        expiresAt: new Date(Date.now() - 1000),
      },
    })
    await makeAccount({ credentials: null, connectionId: connection.id })

    const res = await get(`shopId=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].message).toBe(
      'Facebook login expired. Press Connect with Facebook to renew it.',
    )
    expect(metaBreakdown).not.toHaveBeenCalled()
  })

  it('one broken account does not lose the other', async () => {
    const broken = await makeAccount({
      externalId: `bd-broken-${Date.now()}`,
      name: `Broken ${MARK}`,
    })
    const ok = await makeAccount({ externalId: `bd-ok-${Date.now()}`, name: `OK ${MARK}` })
    // Discriminate by which account is being asked, not by call order: Prisma
    // findMany makes no row-order promise without an explicit orderBy.
    metaBreakdown.mockImplementation(
      async (_creds: unknown, target: { accountExternalId: string }) => {
        if (target.accountExternalId === broken.externalId) throw new Error('Meta answered 500')
        return [entry('c1')]
      },
    )

    const res = await get(`shopId=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].accountId).toBe(ok.id)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].accountId).toBe(broken.id)
    expect(body.errors[0].accountName).toBe(broken.name)
    // Both accounts were consulted even though only one produced a row —
    // proves accountsChecked reflects accounts queried, not rows.length
    // (which is 1 here). Deriving it from rows would pass this fixture wrong.
    expect(body.accountsChecked).toBe(2)
  })

  it('refuses an unknown level before calling anyone', async () => {
    await makeAccount()
    const res = await get(`shopId=${shopId}&level=banana`)
    expect(res.status).toBe(400)
    expect(metaBreakdown).not.toHaveBeenCalled()
    expect(googleBreakdown).not.toHaveBeenCalled()
  })

  // The provider check was the one branch of the four with no test of its
  // own, despite deciding which platform gets called.
  it('refuses an unknown provider before calling anyone', async () => {
    await makeAccount()
    const res = await get(`shopId=${shopId}&provider=tiktok`)
    expect(res.status).toBe(400)
    expect(metaBreakdown).not.toHaveBeenCalled()
    expect(googleBreakdown).not.toHaveBeenCalled()
  })

  // Not one of the brief's nine, but this task's own job: Task 1's review noted
  // `level: 'adset'` with no parentId would silently query the whole account
  // instead of one campaign. The route must refuse it, the same as an unknown
  // level, before any driver is called.
  it('refuses adset with no parentId, before calling anyone', async () => {
    await makeAccount()
    const res = await get(`shopId=${shopId}&level=adset`)
    expect(res.status).toBe(400)
    expect(metaBreakdown).not.toHaveBeenCalled()
  })

  it('refuses ad with no parentId, before calling anyone', async () => {
    await makeAccount()
    const res = await get(`shopId=${shopId}&level=ad`)
    expect(res.status).toBe(400)
    expect(metaBreakdown).not.toHaveBeenCalled()
  })
})
