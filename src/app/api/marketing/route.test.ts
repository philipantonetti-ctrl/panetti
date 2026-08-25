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
    expect(body.unassignedCampaigns).toBe(0) // no split accounts in this fixture

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
    // The split account's own default shop sits OUTSIDE the filter below - only
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

    // Filter to the campaign's shop only - the split account's own shop (B) is excluded.
    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const row = body.byShop.find((r: { shopId: string }) => r.shopId === shopId)
    // 500.00 NOK from the whole account (beforeEach) + 123.45 NOK from the split campaign.
    expect(row.spend).toBe(50000 + 12345)
  })

  // Task 6: the design requires the unassigned-campaign fallback to be
  // visible, not silent - a count of campaigns still on shopId: null, so an
  // admin can go assign them rather than never learning the fallback fired.
  it('counts campaigns still on the account default, so the fallback is visible', async () => {
    const splitAccount = await db.adAccount.create({
      data: {
        shopId,
        provider: 'google',
        externalId: `mkt-unassigned-${Date.now()}`,
        name: `Unassigned Account ${MARK}`,
        currency: 'NOK',
        splitByCampaign: true,
      },
    })
    await db.adCampaign.create({
      data: { accountId: splitAccount.id, externalId: 'u1', name: 'Unassigned 1', shopId: null },
    })
    await db.adCampaign.create({
      data: { accountId: splitAccount.id, externalId: 'u2', name: 'Unassigned 2', shopId: null },
    })
    await db.adCampaign.create({
      data: { accountId: splitAccount.id, externalId: 'u3', name: 'Assigned', shopId },
    })

    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unassignedCampaigns).toBe(2)
  })

  // FIX 3: accountIdsForShops filters active:true in both its sub-queries, so
  // switching an ad account off after it spent money made that spend vanish
  // from the Spend Check panel too, with nothing saying anything went
  // missing. The panel must surface it (status 'inactive', needsAttention),
  // while the headline totals stay exactly what they were - an inactive
  // account is excluded from money on purpose.
  it('lists an inactive account with spend in range on the Spend Check panel, without moving the totals', async () => {
    const inactive = await db.adAccount.create({
      data: {
        shopId,
        provider: 'meta',
        externalId: `mkt-inactive-${Date.now()}`,
        name: `Inactive Account ${MARK}`,
        currency: 'NOK',
        active: false,
      },
    })
    await db.adSpend.create({
      data: { accountId: inactive.id, date: new Date('2026-03-10T00:00:00Z'), spend: 400_00, impressions: 0, clicks: 0 },
    })

    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()

    // Headline totals: only the active account's 500.00 NOK, unchanged.
    const row = body.byShop.find((r: { shopId: string }) => r.shopId === shopId)
    expect(row.spend).toBe(50000)
    expect(body.total.spend).toBe(50000)

    // The panel: the inactive account is listed, flagged, and raises the banner.
    const panelAccount = body.spendCheck.accounts.find((a: { id: string }) => a.id === inactive.id)
    expect(panelAccount).toBeDefined()
    expect(panelAccount.status).toBe('inactive')
    expect(panelAccount.nativeTotal).toBe(400_00)
    expect(body.spendCheck.needsAttention).toBe(true)
  })

  it('does not list an inactive account that has no spend in the range', async () => {
    const inactive = await db.adAccount.create({
      data: {
        shopId,
        provider: 'meta',
        externalId: `mkt-inactive-empty-${Date.now()}`,
        name: `Inactive Empty ${MARK}`,
        currency: 'NOK',
        active: false,
      },
    })

    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.spendCheck.accounts.some((a: { id: string }) => a.id === inactive.id)).toBe(false)
  })

  // FIX 4: "all stores" (no shops= param) still only ever means all ACTIVE
  // shops. A split account with a campaign resolving to a DEACTIVATED shop
  // therefore reads partial even when the caution driven off the selection
  // (allStores) is suppressed - this is the false mismatch the caution
  // exists to prevent, firing exactly where the client-side signal cannot.
  it('reports partialAccounts=true for the all-stores view when a split account has a campaign on a deactivated shop', async () => {
    const deactivated = await db.shop.create({ data: { name: `Deactivated ${MARK}`, currency: 'NOK', active: false } })
    const splitAccount = await db.adAccount.create({
      data: {
        shopId,
        provider: 'google',
        externalId: `mkt-partial-${Date.now()}`,
        name: `Partial Account ${MARK}`,
        currency: 'NOK',
        splitByCampaign: true,
      },
    })
    await db.adCampaign.create({
      data: { accountId: splitAccount.id, externalId: 'partial-in', name: 'In scope', shopId },
    })
    await db.adCampaign.create({
      data: { accountId: splitAccount.id, externalId: 'partial-out', name: 'On deactivated shop', shopId: deactivated.id },
    })

    // No `shops=` param at all: the "all stores" request the UI sends when
    // nothing is filtered (MarketingClient only sets it when selected.length).
    const res = await get('from=2026-03-01&to=2026-03-31')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.partialAccounts).toBe(true)
  })

  it('reports partialAccounts=false when every split account resolves entirely inside the active shops', async () => {
    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.partialAccounts).toBe(false)
  })

  it('narrows every surface to one platform', async () => {
    // A second, google-provider account with its own in-range spend, so the
    // filter has something to actually exclude - without it, byPlatform
    // would read ['meta'] whether or not the filter worked at all.
    const google = await db.adAccount.create({
      data: {
        shopId,
        provider: 'google',
        externalId: `mkt-google-${Date.now()}`,
        name: `Google Account ${MARK}`,
        currency: 'NOK',
        dailyBudget: 500000,
      },
    })
    await db.adSpend.create({
      data: { accountId: google.id, date: new Date('2026-03-10T00:00:00Z'), spend: 15000, impressions: 1000, clicks: 20 },
    })

    const res = await get('from=2026-03-01&to=2026-03-31&platform=meta')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.byPlatform.map((p: { provider: string }) => p.provider)).toEqual(['meta'])
    // The spend check panel describes the same accounts the totals do, or the
    // panel would "prove" a total that is not on screen.
    expect(
      body.spendCheck.accounts.every((a: { provider: string }) => a.provider === 'meta'),
    ).toBe(true)
  })

  it('refuses an unknown platform rather than answering with a plausible zero', async () => {
    const res = await get('from=2026-03-01&to=2026-03-31&platform=tiktok')

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Unknown ad platform')
  })

  // Human ruling: filtering to a platform that IS connected somewhere in the
  // workspace, then scoping to a store that has no account on that platform,
  // is a true empty result (the store spent nothing there) - not a typo. Only
  // a platform absent from the WHOLE workspace is the error case.
  it('answers with zeros, not an error, when the platform is connected elsewhere in the workspace but not to the selected shop', async () => {
    const otherShop = await db.shop.create({ data: { name: `Shop B ${MARK}`, currency: 'NOK' } })
    await db.adAccount.create({
      data: {
        shopId: otherShop.id,
        provider: 'google',
        externalId: `mkt-google-elsewhere-${Date.now()}`,
        name: `Google Elsewhere ${MARK}`,
        currency: 'NOK',
      },
    })

    // `shopId` only ever had the meta account from beforeEach - google is
    // real, just not here.
    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopId}&platform=google`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.byPlatform).toEqual([])
    const row = body.byShop.find((r: { shopId: string }) => r.shopId === shopId)
    expect(row.spend).toBe(0)
    expect(row.roas).toBeNull()
    expect(row.cpa).toBeNull()
  })
})
