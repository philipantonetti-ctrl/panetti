import { afterEach, describe, expect, it, vi } from 'vitest'

const ROW = (campaignId: string, campaignName: string, spend: number) => ({
  campaignId,
  campaignName,
  date: new Date('2026-03-01T00:00:00Z'),
  spend,
  impressions: 5,
  clicks: 1,
  linkClicks: 1,
  conversions: 0,
  conversionValue: 0,
  videoViews3s: 0,
  thruplays: 0,
  reach: 0,
})

// vi.mock is HOISTED to the top of the module - it must never sit inside
// beforeEach or a describe block. Partial-mock so the rest of ./google is real.
vi.mock('./google', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./google')>()),
  fetchGoogleCampaignDaily: vi.fn(async () => [ROW('c1', 'Norway', 1000), ROW('c2', 'Sweden', 2000)]),
  fetchGoogleDailyBudget: vi.fn(async () => 0),
  // A real row, not []: if a split account ever also reached storeDaily, this
  // row would surface as an AdSpend row and the "writes NO AdSpend row" test
  // below would actually fail instead of vacuously passing on an empty array.
  fetchGoogleDaily: vi.fn(async () => [
    {
      date: new Date('2026-03-01T00:00:00Z'),
      spend: 9999,
      impressions: 3,
      clicks: 1,
      linkClicks: 1,
      conversions: 0,
      conversionValue: 0,
      videoViews3s: 0,
      thruplays: 0,
      reach: 0,
    },
  ]),
}))

const { db } = await import('@/lib/db')
const { syncAdAccount } = await import('./sync')
const { encryptSecret } = await import('@/lib/secrets')

const TAG = 'sync-split-test'

afterEach(async () => {
  await db.adAccount.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

/**
 * Real stored credentials rather than a spy on resolveCredentials: spying on an
 * ES module export is unreliable, and the credentials path is the one the sync
 * actually takes for a pasted account.
 */
async function splitAccount() {
  const shop = await db.shop.create({ data: { name: `${TAG} default`, currency: 'NOK' } })
  const account = await db.adAccount.create({
    data: {
      shopId: shop.id,
      provider: 'google',
      externalId: `${TAG}-5550001111`,
      name: `${TAG} acct`,
      currency: 'NOK',
      splitByCampaign: true,
      credentials: encryptSecret(
        JSON.stringify({ developerToken: 'd', clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
      ),
    },
  })
  return { shop, account }
}

describe('syncAdAccount for a split account', () => {
  it('writes one AdCampaign and one AdCampaignSpend per campaign', async () => {
    const { account } = await splitAccount()

    const result = await syncAdAccount({ ...account, connection: null })
    expect(result.ok).toBe(true)

    const campaigns = await db.adCampaign.findMany({
      where: { accountId: account.id },
      orderBy: { externalId: 'asc' },
    })
    expect(campaigns.map((c) => c.externalId)).toEqual(['c1', 'c2'])
    expect(campaigns.every((c) => c.shopId === null)).toBe(true)

    const spend = await db.adCampaignSpend.findMany({
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
    })
    expect(spend.map((s) => s.spend).sort((a, b) => a - b)).toEqual([1000, 2000])
  })

  it('writes NO AdSpend row, so the account is never counted twice', async () => {
    const { account } = await splitAccount()

    await syncAdAccount({ ...account, connection: null })

    expect(await db.adSpend.count({ where: { accountId: account.id } })).toBe(0)
  })

  it('refreshes a renamed campaign without unassigning its store', async () => {
    const { shop, account } = await splitAccount()
    await db.adCampaign.create({
      data: { accountId: account.id, externalId: 'c1', name: 'Old name', shopId: shop.id },
    })

    await syncAdAccount({ ...account, connection: null })

    const c1 = await db.adCampaign.findFirst({ where: { accountId: account.id, externalId: 'c1' } })
    expect(c1?.name).toBe('Norway')   // refreshed from the platform
    expect(c1?.shopId).toBe(shop.id)  // the person's choice survived
  })

  it('still writes AdSpend and no campaign rows when the account is not split', async () => {
    const { account } = await splitAccount()
    await db.adAccount.update({ where: { id: account.id }, data: { splitByCampaign: false } })

    await syncAdAccount({ ...account, splitByCampaign: false, connection: null })

    expect(await db.adCampaign.count({ where: { accountId: account.id } })).toBe(0)

    const spend = await db.adSpend.findMany({ where: { accountId: account.id } })
    expect(spend).toHaveLength(1)
    expect(spend[0].spend).toBe(9999)
  })

  it('does not duplicate rows or double spend when synced twice', async () => {
    const { account } = await splitAccount()

    await syncAdAccount({ ...account, connection: null })
    await syncAdAccount({ ...account, connection: null })

    const campaigns = await db.adCampaign.findMany({ where: { accountId: account.id } })
    expect(campaigns).toHaveLength(2) // c1 and c2, not four

    const spend = await db.adCampaignSpend.findMany({
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
    })
    expect(spend).toHaveLength(2)                       // one row per campaign per day
    expect(spend.map((s) => s.spend).sort((a, b) => a - b)).toEqual([1000, 2000]) // not [2000, 4000]
  })
})
