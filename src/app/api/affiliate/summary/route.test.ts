import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')
const { loadMetricsInput } = await import('@/lib/data/load')
const { computeMetrics } = await import('@/lib/metrics/engine')

const MARK = '[affiliate-summary-test]'

// April 2026, on purpose: every other affiliate suite seeds January and March,
// and `unmatched` is a workspace-wide count no marker can scope.
const RANGE = 'from=2026-04-01&to=2026-04-30'

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin',
    email: 'admin@test.local',
    role: 'ADMIN',
    ambassadorId: null,
  })
}

async function wipe() {
  await db.affiliateAccount.deleteMany({ where: { name: { contains: MARK } } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  // Fake, non-ECB currencies used by the conversion tests below — no other
  // suite (and no real sync) ever writes these bases.
  await db.fxRate.deleteMany({ where: { base: { in: ['XTA', 'XTB'] } } })
}

let shopA = ''
let shopB = ''
let accountId = ''

beforeEach(async () => {
  await wipe()
  await asAdmin()

  shopA = (await db.shop.create({ data: { name: `Shop A ${MARK}`, currency: 'NOK' } })).id
  shopB = (await db.shop.create({ data: { name: `Shop B ${MARK}`, currency: 'NOK' } })).id

  const account = await db.affiliateAccount.create({
    data: {
      externalId: `aff-summary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `Panetti ${MARK}`,
      token: 'plain-token',
      // Inactive, so a parallel sync suite's forced syncAll never sweeps this
      // row up and rewrites its transactions. The summary reads transactions,
      // not account activity.
      active: false,
    },
  })
  accountId = account.id

  const base = {
    accountId: account.id,
    market: 'NO',
    shopId: shopA,
    channelId: '11',
    channelName: 'Blogg A',
    status: 'new',
    currency: 'NOK',
  }
  await db.affiliateTransaction.createMany({
    data: [
      // Two sales, one channel, one day, one currency — one converted bucket.
      { ...base, externalId: 's1', date: new Date('2026-04-02'), commission: 12835, brokerageFee: 1925, orderValue: 85564 },
      { ...base, externalId: 's2', date: new Date('2026-04-02'), commission: 5988, brokerageFee: 898, orderValue: 40000 },
      // A second channel on a second day.
      { ...base, externalId: 's3', channelId: '22', channelName: 'Blogg B', date: new Date('2026-04-03'), commission: 100, brokerageFee: 10, orderValue: 1000 },
      // Denied costs nothing and is not a tracked sale.
      { ...base, externalId: 's4', date: new Date('2026-04-04'), commission: 99999, brokerageFee: 9999, orderValue: 500000, denyDate: new Date('2026-05-01') },
      // Outside the range.
      { ...base, externalId: 's5', date: new Date('2026-05-02'), commission: 7777, brokerageFee: 777, orderValue: 60000 },
      // Belongs to no shop: surfaced as `unmatched`, never summed into a shop.
      { ...base, externalId: 's6', shopId: null, date: new Date('2026-04-05'), commission: 5555, brokerageFee: 555, orderValue: 30000 },
      // Shop B, so the per-shop table has something to split.
      { ...base, externalId: 's7', shopId: shopB, date: new Date('2026-04-02'), commission: 2000, brokerageFee: 200, orderValue: 30000 },
    ],
  })
})

afterEach(wipe)

const get = (qs: string) => GET(new Request(`http://localhost/api/affiliate/summary?${qs}`))

describe('GET /api/affiliate/summary', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await get(RANGE)).status).toBe(403)
  })

  it('totals commission + brokerage per channel and shop, in the shop currency', async () => {
    const res = await get(`${RANGE}&shops=${shopA}`)
    expect(res.status).toBe(200)
    const body = await res.json()

    // One shop selected -> its own currency, so no conversion is in the way.
    expect(body.displayCurrency).toBe('NOK')
    expect(body.total).toEqual({
      sales: 3, // the denied one and the May one are not sales
      orderValue: 85564 + 40000 + 1000,
      cost: 12835 + 1925 + 5988 + 898 + 100 + 10,
    })

    expect(body.byChannel).toEqual([
      { channelId: '11', channelName: 'Blogg A', sales: 2, orderValue: 125564, cost: 21646 },
      { channelId: '22', channelName: 'Blogg B', sales: 1, orderValue: 1000, cost: 110 },
    ])

    // One shop asked for, one shop answered — the client hides this table.
    expect(body.byShop).toHaveLength(1)
    expect(body.byShop[0]).toMatchObject({ shopId: shopA, shopName: `Shop A ${MARK}`, cost: 21756 })

    // Money that belongs to no shop is missing from every figure above —
    // including the total — and is said so rather than quietly dropped: the
    // count AND the money (s6: 5555 commission + 555 brokerage, already NOK).
    expect(body.unmatched).toBe(1)
    expect(body.unmatchedCost).toBe(5555 + 555)
  })

  it('splits both shops when both are in scope, biggest cost first', async () => {
    const res = await get(RANGE)
    expect(res.status).toBe(200)
    const body = await res.json()

    const mine = body.byShop.filter((r: { shopId: string }) => r.shopId === shopA || r.shopId === shopB)
    expect(mine.map((r: { shopId: string }) => r.shopId)).toEqual([shopA, shopB])
    expect(mine[0].sales).toBe(3)
    expect(mine[1].sales).toBe(1)
  })

  /**
   * The reason this route re-aggregates to (shop, day, currency) before
   * converting instead of converting row by row: the Dashboard's Affiliate
   * column is the same money, and two roundings of the same figure are how
   * one screen comes to contradict another.
   */
  it('reports exactly the affiliate cost the engine charges to net profit', async () => {
    // A second currency on the same shop and day, so the two paths have a real
    // cross-rate to disagree over if they were computing it differently.
    await db.affiliateTransaction.create({
      data: {
        accountId,
        externalId: 's8',
        date: new Date('2026-04-02'),
        market: 'FI',
        shopId: shopA,
        channelId: '11',
        channelName: 'Blogg A',
        status: 'new',
        commission: 3333,
        brokerageFee: 333,
        orderValue: 20000,
        currency: 'SEK',
      },
    })

    const from = new Date('2026-04-01')
    const to = new Date('2026-04-30')
    const engine = computeMetrics(await loadMetricsInput({ shopIds: [shopA], from, to }))

    const body = await (await get(`${RANGE}&shops=${shopA}`)).json()
    expect(body.total.cost).toBe(engine.total.affiliate)
  })

  it('answers empty figures for the no-shops sentinel', async () => {
    const res = await get(`${RANGE}&shops=none`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.byShop).toEqual([])
    expect(body.byChannel).toEqual([])
    expect(body.total).toEqual({ sales: 0, orderValue: 0, cost: 0 })
  })

  // FIX 2: the unmatched rows' currencies must join the set that decides
  // whether rates are needed at all. Here the matched side is empty, so ONLY
  // an unmatched row is foreign — if its currency were left out, the route
  // would build no rate table and crossConvert would pass 100 through
  // unchanged, printing a figure in the wrong currency as though converted.
  it("converts unmatched money at each day's own rate", async () => {
    // Fake, non-ECB currencies: isConvertible() is false for both, so
    // ensureRates never asks the provider for them, and the seeded fxRate row
    // on the range's own day keeps its freshness check satisfied — the test
    // controls every rate deterministically, offline.
    const shopC = await db.shop.create({ data: { name: `Shop C ${MARK}`, currency: 'XTA' } })
    await db.fxRate.createMany({
      data: [
        { date: new Date('2026-04-22T00:00:00Z'), base: 'XTA', quote: 'USD', rate: 1 },
        { date: new Date('2026-04-22T00:00:00Z'), base: 'XTB', quote: 'USD', rate: 0.5 },
      ],
    })
    await db.affiliateTransaction.create({
      data: {
        accountId,
        externalId: 'u1',
        date: new Date('2026-04-22'),
        market: 'DE',
        shopId: null,
        channelId: '44',
        channelName: 'Preisvergleich.de',
        status: 'new',
        commission: 100,
        brokerageFee: 0,
        orderValue: 1000,
        currency: 'XTB',
      },
    })

    const body = await (await get(`from=2026-04-22&to=2026-04-22&shops=${shopC.id}`)).json()
    expect(body.displayCurrency).toBe('XTA')
    expect(body.total).toEqual({ sales: 0, orderValue: 0, cost: 0 })
    expect(body.unmatched).toBe(1)
    expect(body.unmatchedCost).toBe(50) // 100 XTB at that day's 0.5 XTB->XTA
  })

  // FIX 4: byChannel partitions the same groups differently from the total
  // ((channel, day, currency) vs the engine's (shop, day, currency)), and each
  // converted bucket rounds once — so the two sums can drift by rounding. The
  // residual is allocated to the largest channel row, so the channel table
  // tallies exactly to the headline figure the engine also reports.
  it('makes the channel rows tally exactly to the total when per-partition rounding disagrees', async () => {
    const shopD = await db.shop.create({ data: { name: `Shop D ${MARK}`, currency: 'XTA' } })
    await db.fxRate.createMany({
      data: [
        { date: new Date('2026-04-20T00:00:00Z'), base: 'XTA', quote: 'USD', rate: 1 },
        { date: new Date('2026-04-20T00:00:00Z'), base: 'XTB', quote: 'USD', rate: 0.5 },
      ],
    })
    const base = {
      accountId,
      market: 'NO',
      shopId: shopD.id,
      status: 'new',
      currency: 'XTB',
      date: new Date('2026-04-20'),
    }
    await db.affiliateTransaction.createMany({
      data: [
        // 1 minor unit per channel at rate 0.5: each channel bucket rounds its
        // 0.5 half away to 1, but the shop-grain total is round(2 * 0.5) = 1 —
        // a guaranteed one-unit residual between the two partitions.
        { ...base, externalId: 'r1', channelId: '55', channelName: 'Round A', commission: 1, brokerageFee: 0, orderValue: 1 },
        { ...base, externalId: 'r2', channelId: '66', channelName: 'Round B', commission: 1, brokerageFee: 0, orderValue: 1 },
      ],
    })

    const body = await (await get(`from=2026-04-20&to=2026-04-20&shops=${shopD.id}`)).json()
    // The headline stays the engine's own figure — the residual moves a
    // channel row, never the total.
    expect(body.total.cost).toBe(1)
    expect(body.total.orderValue).toBe(1)
    const costs = body.byChannel.map((r: { cost: number }) => r.cost)
    expect(costs.reduce((a: number, b: number) => a + b, 0)).toBe(body.total.cost)
    expect([...costs].sort((a: number, b: number) => a - b)).toEqual([0, 1]) // one row absorbed it, not both
    const values = body.byChannel.map((r: { orderValue: number }) => r.orderValue)
    expect(values.reduce((a: number, b: number) => a + b, 0)).toBe(body.total.orderValue)
  })

  // FIX 5: channelName participates in the grouping, so a renamed channel
  // yields several groups for one channelId — the displayed name must be the
  // most recent one, not whichever group an unordered result listed last.
  it('shows a renamed channel under its most recent name', async () => {
    const base = {
      accountId,
      market: 'NO',
      shopId: shopA,
      channelId: '33',
      status: 'new',
      currency: 'NOK',
      orderValue: 1000,
    }
    await db.affiliateTransaction.createMany({
      data: [
        // Newest inserted first on purpose: insertion order must not decide.
        { ...base, externalId: 'n2', channelName: 'New name', date: new Date('2026-04-16'), commission: 100, brokerageFee: 10 },
        { ...base, externalId: 'n1', channelName: 'Old name', date: new Date('2026-04-15'), commission: 200, brokerageFee: 20 },
      ],
    })

    const body = await (await get(`${RANGE}&shops=${shopA}`)).json()
    const row = body.byChannel.find((r: { channelId: string }) => r.channelId === '33')
    // One row for the channel — both days' money under the newest name.
    expect(row).toMatchObject({ channelName: 'New name', sales: 2, cost: 330 })
  })

  it('reports the program as connected once an active account exists', async () => {
    await db.affiliateAccount.create({
      data: {
        externalId: `aff-summary-live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: `Live ${MARK}`,
        token: 'plain-token',
        active: true,
      },
    })
    const body = await (await get(`${RANGE}&shops=${shopA}`)).json()
    expect(body.connected).toBe(true)
  })
})
