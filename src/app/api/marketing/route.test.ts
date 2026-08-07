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

const MARK = '[marketing-test]'

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin',
    email: 'admin@test.local',
    role: 'ADMIN',
    ambassadorId: null,
  })
}

async function wipe() {
  await db.adAccount.deleteMany({ where: { name: { contains: MARK } } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

let shopId = ''

beforeEach(async () => {
  await wipe()
  await asAdmin()

  const shop = await db.shop.create({ data: { name: `Shop ${MARK}`, currency: 'NOK' } })
  shopId = shop.id

  const paid = (externalId: string, netSales: number, tax: number) =>
    db.order.create({
      data: {
        shopId,
        externalId,
        number: externalId,
        placedAt: new Date('2026-03-10T12:00:00Z'),
        status: 'completed',
        currency: 'NOK',
        grossSales: netSales,
        discountTotal: 0,
        netSales,
        shippingCharged: 0,
        taxTotal: tax,
        total: netSales + tax,
      },
    })

  // Two paid orders: gross revenue 1000 + 250 and 2000 + 500 = 3750.00 NOK.
  await paid(`${MARK}-1`, 100000, 25000)
  await paid(`${MARK}-2`, 200000, 50000)
  // A pending order earns nothing and must not move ROAS or CPA.
  await db.order.create({
    data: {
      shopId,
      externalId: `${MARK}-3`,
      number: `${MARK}-3`,
      placedAt: new Date('2026-03-10T13:00:00Z'),
      status: 'pending',
      currency: 'NOK',
      grossSales: 999900,
      discountTotal: 0,
      netSales: 999900,
      shippingCharged: 0,
      taxTotal: 0,
      total: 999900,
    },
  })

  const account = await db.adAccount.create({
    data: {
      shopId,
      provider: 'meta',
      externalId: `mkt-${Date.now()}`,
      name: `Account ${MARK}`,
      currency: 'NOK',
      credentials: JSON.stringify({ accessToken: 'seed' }),
      dailyBudget: 800000,
    },
  })
  // 500.00 NOK across two March days, inside the query range.
  await db.adSpend.createMany({
    data: [
      { accountId: account.id, date: new Date('2026-03-10T00:00:00Z'), spend: 20000, impressions: 4000, clicks: 80 },
      { accountId: account.id, date: new Date('2026-03-11T00:00:00Z'), spend: 30000, impressions: 6000, clicks: 120 },
      // Outside the range: must be ignored.
      { accountId: account.id, date: new Date('2026-05-01T00:00:00Z'), spend: 99999, impressions: 1, clicks: 1 },
    ],
  })
})

afterEach(wipe)

const get = (qs: string) => GET(new Request(`http://localhost/api/marketing?${qs}`))

describe('GET /api/marketing', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await get('from=2026-03-01&to=2026-03-31')).status).toBe(403)
  })

  it('computes spend, ROAS and CPA from paid orders only, in the shop currency', async () => {
    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()

    // One shop selected -> its own currency, no conversion.
    expect(body.displayCurrency).toBe('NOK')
    expect(body.connected).toBe(true)

    const row = body.byShop.find((r: { shopId: string }) => r.shopId === shopId)
    expect(row.spend).toBe(50000) // 500.00 NOK, the May row ignored
    expect(row.dailyBudget).toBe(800000) // kr8,000.00, shop currency, no conversion
    expect(row.metaSpend).toBe(50000)
    expect(row.googleSpend).toBe(0)
    expect(row.orders).toBe(2) // pending not counted
    expect(row.grossRevenue).toBe(375000)
    expect(row.roas).toBeCloseTo(375000 / 50000, 10)
    expect(row.cpa).toBe(25000) // 500.00 / 2 orders
    expect(row.cpc).toBe(Math.round(50000 / 200))
    expect(row.ctr).toBeCloseTo(200 / 10000, 10)

    // The daily series carries the spend on its days.
    const day = body.series.find((p: { date: string }) => p.date === '2026-03-10')
    expect(day.spend).toBe(20000)
    expect(day.grossRevenue).toBe(375000)

    expect(JSON.stringify(body)).not.toContain('credentials')
  })

  it('answers empty figures for the no-shops sentinel', async () => {
    const res = await get('from=2026-03-01&to=2026-03-31&shops=none')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.byShop).toHaveLength(0)
    expect(body.total.spend).toBe(0)
  })

  it("shows a split account's spend on the shop its campaign resolves to, even when the account's own shop is filtered out", async () => {
    // The split account's own default shop sits OUTSIDE the filter below — only
    // its campaign, assigned to `shopId` (the filtered-in shop), is in scope.
    // This is the ordinary "filter the Marketing page to a couple of stores"
    // action, and exactly the case this feature exists for.
    const otherShop = await db.shop.create({ data: { name: `Shop B ${MARK}`, currency: 'NOK' } })
    const splitAccount = await db.adAccount.create({
      data: {
        shopId: otherShop.id,
        provider: 'google',
        externalId: `mkt-split-${Date.now()}`,
        name: `Split Account ${MARK}`,
        currency: 'NOK',
        splitByCampaign: true,
      },
    })
    const campaign = await db.adCampaign.create({
      data: { accountId: splitAccount.id, externalId: 'split-c1', name: 'Split campaign', shopId },
    })
    await db.adCampaignSpend.create({
      data: { campaignId: campaign.id, date: new Date('2026-03-10T00:00:00Z'), spend: 12345, impressions: 0, clicks: 0 },
    })

    // Filter to the campaign's shop only — the split account's own shop (B) is excluded.
    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const row = body.byShop.find((r: { shopId: string }) => r.shopId === shopId)
    // 500.00 NOK from the whole account (beforeEach) + 123.45 NOK from the split campaign.
    expect(row.spend).toBe(50000 + 12345)
  })
})
