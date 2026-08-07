import { afterEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { attributedSpend, relevantAdCurrencies, accountSpendRows } from './attribution'

const TAG = 'attribution-test'
const DAY = new Date('2026-03-01T00:00:00Z')

afterEach(async () => {
  await db.adAccount.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

async function shop(name: string) {
  return db.shop.create({ data: { name: `${TAG} ${name}`, currency: 'NOK' } })
}

async function splitAccountWith(defaultShopId: string, campaigns: { externalId: string; shopId: string | null; spend: number }[]) {
  const account = await db.adAccount.create({
    data: { shopId: defaultShopId, provider: 'google', externalId: `${Date.now()}`, name: `${TAG} acct`, currency: 'NOK', splitByCampaign: true },
  })
  for (const c of campaigns) {
    const campaign = await db.adCampaign.create({
      data: { accountId: account.id, externalId: c.externalId, name: `${TAG} ${c.externalId}`, shopId: c.shopId },
    })
    await db.adCampaignSpend.create({
      data: { campaignId: campaign.id, date: DAY, spend: c.spend, impressions: 0, clicks: 0 },
    })
  }
  return account
}

const totalFor = (rows: { shopId: string; spend: number }[], shopId: string) =>
  rows.filter((r) => r.shopId === shopId).reduce((sum, r) => sum + r.spend, 0)

describe('attributedSpend', () => {
  it('sends each campaign to its own store', async () => {
    const [a, b, def] = [await shop('a'), await shop('b'), await shop('default')]
    await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: b.id, spend: 2000 },
    ])

    const rows = await attributedSpend([a.id, b.id, def.id], DAY, DAY)
    expect(totalFor(rows, a.id)).toBe(1000)
    expect(totalFor(rows, b.id)).toBe(2000)
    expect(totalFor(rows, def.id)).toBe(0)
  })

  it('falls back to the account default when a campaign is unassigned', async () => {
    const [a, def] = [await shop('a'), await shop('default')]
    await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: null, spend: 500 },
    ])

    const rows = await attributedSpend([a.id, def.id], DAY, DAY)
    expect(totalFor(rows, a.id)).toBe(1000)
    expect(totalFor(rows, def.id)).toBe(500)
  })

  it('moves history when a campaign is reassigned', async () => {
    const [a, b, def] = [await shop('a'), await shop('b'), await shop('default')]
    const account = await splitAccountWith(def.id, [{ externalId: 'c1', shopId: a.id, spend: 1000 }])

    expect(totalFor(await attributedSpend([a.id, b.id, def.id], DAY, DAY), a.id)).toBe(1000)

    await db.adCampaign.updateMany({ where: { accountId: account.id, externalId: 'c1' }, data: { shopId: b.id } })

    const after = await attributedSpend([a.id, b.id, def.id], DAY, DAY)
    expect(totalFor(after, a.id)).toBe(0)
    expect(totalFor(after, b.id)).toBe(1000) // the same past day, now on B
  })

  it('includes a campaign whose store is selected even when the account default is not', async () => {
    const [a, def] = [await shop('a'), await shop('default')]
    await splitAccountWith(def.id, [{ externalId: 'c1', shopId: a.id, spend: 1000 }])

    // Only shop A is selected. The account's own shopId is `def`, which is not.
    const rows = await attributedSpend([a.id], DAY, DAY)
    expect(totalFor(rows, a.id)).toBe(1000)
  })

  it('reads a whole account from AdSpend, unchanged', async () => {
    const s = await shop('whole')
    const account = await db.adAccount.create({
      data: { shopId: s.id, provider: 'meta', externalId: '4443332221', name: `${TAG} whole`, currency: 'NOK' },
    })
    await db.adSpend.create({
      data: { accountId: account.id, date: DAY, spend: 777, impressions: 0, clicks: 0 },
    })

    expect(totalFor(await attributedSpend([s.id], DAY, DAY), s.id)).toBe(777)
  })
})

describe('relevantAdCurrencies', () => {
  // The whole-account version of this — an EUR account with zero AdSpend rows
  // whose rate must still be fetched — is covered in load.integration.test.ts.
  // This is its split-account mirror: nothing exercised that branch, so a
  // later simplification could drop it and a split account's currency would
  // silently vanish from the FX table.
  it('includes a split account’s currency even when its campaign has zero spend rows', async () => {
    const [a, def] = [await shop('a'), await shop('default')]
    const account = await db.adAccount.create({
      data: {
        shopId: def.id,
        provider: 'google',
        externalId: `${Date.now()}-fx`,
        name: `${TAG} fx acct`,
        currency: 'EUR',
        splitByCampaign: true,
      },
    })
    // The campaign belongs to shop A, but has never synced a single spend row.
    await db.adCampaign.create({
      data: { accountId: account.id, externalId: 'c-fx', name: `${TAG} c-fx`, shopId: a.id },
    })

    const currencies = await relevantAdCurrencies([a.id])
    expect(currencies).toContain('EUR')
  })
})

describe('accountSpendRows', () => {
  it('returns AdSpend rows unchanged for a whole account', async () => {
    const s = await shop('whole-ms')
    const account = await db.adAccount.create({
      data: { shopId: s.id, provider: 'meta', externalId: `${TAG}-5551110000`, name: `${TAG} whole`, currency: 'NOK' },
    })
    await db.adSpend.create({
      data: {
        accountId: account.id, date: DAY, spend: 500, impressions: 10, clicks: 2,
        linkClicks: 1, conversions: 1, conversionValue: 250, videoViews3s: 7, thruplays: 3,
      },
    })

    const rows = await accountSpendRows([account.id], DAY, DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ accountId: account.id, spend: 500, videoViews3s: 7, thruplays: 3 })
    expect(rows[0].shopId).toBeUndefined() // no override: buildMarketing uses the account's own shop
  })

  it('rolls a split account up per shop, carrying a shopId override', async () => {
    const [a, b, def] = [await shop('ms-a'), await shop('ms-b'), await shop('ms-def')]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: b.id, spend: 2000 },
    ])

    const rows = await accountSpendRows([account.id], DAY, DAY)
    expect(rows).toHaveLength(2) // one per shop, not one per campaign
    const byShop = Object.fromEntries(rows.map((r) => [r.shopId, r.spend]))
    expect(byShop[a.id]).toBe(1000)
    expect(byShop[b.id]).toBe(2000)
  })

  it('sums several campaigns that share a shop into one row', async () => {
    const [a, def] = [await shop('ms-sum'), await shop('ms-sumdef')]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: a.id, spend: 250 },
    ])

    const rows = await accountSpendRows([account.id], DAY, DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].spend).toBe(1250)
  })

  it('never returns a split account total that differs from its campaign total', async () => {
    const [a, def] = [await shop('ms-tot'), await shop('ms-totdef')]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: null, spend: 750 },
    ])

    const rows = await accountSpendRows([account.id], DAY, DAY)
    expect(rows.reduce((sum, r) => sum + r.spend, 0)).toBe(1750) // nothing lost, nothing doubled
  })
})
