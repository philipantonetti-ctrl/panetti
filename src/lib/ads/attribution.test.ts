import { afterEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import {
  attributedSpend,
  relevantAdCurrencies,
  accountSpendRows,
  accountIdsForShops,
  unassignedCampaignCount,
  hasPartialSplitAccounts,
} from './attribution'

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

    const rows = await accountSpendRows([account.id], [s.id], DAY, DAY)
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

    const rows = await accountSpendRows([account.id], [a.id, b.id], DAY, DAY)
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

    const rows = await accountSpendRows([account.id], [a.id], DAY, DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].spend).toBe(1250)
  })

  it('never returns a split account total that differs from its campaign total', async () => {
    const [a, def] = [await shop('ms-tot'), await shop('ms-totdef')]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: null, spend: 750 },
    ])

    const rows = await accountSpendRows([account.id], [a.id, def.id], DAY, DAY)
    expect(rows.reduce((sum, r) => sum + r.spend, 0)).toBe(1750) // nothing lost, nothing doubled
    // The unassigned campaign (c2) must land on the account's own default
    // shop, not merely "somewhere non-dropping" — the sum alone would still
    // pass if the fallback resolved to a wrong shop.
    expect(rows.find((r) => r.shopId === def.id)?.spend).toBe(750)
  })

  // CRITICAL: an account gets ticked "split by campaign", the PATCH sets
  // lastSyncAt: null so the next sync backfills a year of AdCampaignSpend, but
  // nothing ever deletes the OLD AdSpend rows that predate the flip. Reading
  // both tables for the same account would roughly double its spend forever.
  // This is not "structurally impossible" — it is exactly what the PATCH
  // route's own behaviour produces the moment someone ticks the box.
  it('does not double-count a split account that still has a leftover AdSpend row', async () => {
    const [a, def] = [await shop('legacy-a'), await shop('legacy-def')]
    const account = await splitAccountWith(def.id, [{ externalId: 'c1', shopId: a.id, spend: 1000 }])
    // A pre-existing AdSpend row from before the account was split — never
    // cleaned up, exactly as the real PATCH flow leaves it.
    await db.adSpend.create({
      data: { accountId: account.id, date: DAY, spend: 99999, impressions: 0, clicks: 0 },
    })

    const rows = await accountSpendRows([account.id], [a.id], DAY, DAY)
    // Only the campaign-derived row, never the legacy AdSpend row too.
    expect(rows).toHaveLength(1)
    expect(rows.reduce((sum, r) => sum + r.spend, 0)).toBe(1000)
  })

  // IMPORTANT: buildMarketing derives byShop/total from engine.byShop, which
  // drops an out-of-scope shop's row — but byDay adds every SpendRow's minor
  // spend unconditionally. Filtering Marketing to shop A on an account that
  // also runs campaigns for shop B would put B's spend into the chart while
  // the table and total both stayed correct, which is exactly the kind of
  // mismatch nobody notices until the numbers are added up by hand.
  it("drops a split account's campaign that resolves outside the requested shops", async () => {
    const [inScope, outOfScope, def] = [
      await shop('leak-in'),
      await shop('leak-out'),
      await shop('leak-def'),
    ]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c-in', shopId: inScope.id, spend: 1000 },
      { externalId: 'c-out', shopId: outOfScope.id, spend: 5000 },
    ])

    // The account is in scope (its in-scope campaign put it there — see
    // accountIdsForShops), but the caller only asked about `inScope`.
    const rows = await accountSpendRows([account.id], [inScope.id], DAY, DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].shopId).toBe(inScope.id)
    expect(rows[0].spend).toBe(1000)
  })
})

describe('accountIdsForShops', () => {
  it("includes a split account whose campaign is in scope, even when the account's own shop is not", async () => {
    const [a, def] = [await shop('ids-a'), await shop('ids-def')]
    const account = await splitAccountWith(def.id, [{ externalId: 'c1', shopId: a.id, spend: 1000 }])

    // Only shop A is selected. The account's own shopId is `def`, which is not.
    const ids = await accountIdsForShops([a.id])
    expect(ids).toContain(account.id)
  })

  it('includes a whole account on its own shopId', async () => {
    const s = await shop('ids-whole')
    const account = await db.adAccount.create({
      data: { shopId: s.id, provider: 'meta', externalId: `${TAG}-ids-whole`, name: `${TAG} ids whole`, currency: 'NOK' },
    })

    const ids = await accountIdsForShops([s.id])
    expect(ids).toContain(account.id)
  })

  it('excludes a split account with no campaigns anywhere in scope', async () => {
    const [def, elsewhere] = [await shop('ids-excl-def'), await shop('ids-excl-elsewhere')]
    const account = await splitAccountWith(def.id, [{ externalId: 'c1', shopId: elsewhere.id, spend: 1000 }])

    const ids = await accountIdsForShops([def.id])
    expect(ids).not.toContain(account.id)
  })
})

describe('hasPartialSplitAccounts', () => {
  // FIX 4: the exact "all stores but partial" case — nothing was filtered
  // (scopeIds is the full active-shop list), but a split account still has a
  // campaign mapped to a shop outside that scope (standing in for a
  // deactivated one, which the ShopFilter selection can never surface).
  it('is true when an in-scope split account has a campaign resolving outside the given shops', async () => {
    const [inScope, outside, def] = [
      await shop('partial-in'),
      await shop('partial-out'),
      await shop('partial-def'),
    ]
    await splitAccountWith(def.id, [
      { externalId: 'c-in', shopId: inScope.id, spend: 1000 },
      { externalId: 'c-out', shopId: outside.id, spend: 500 },
    ])

    // `outside` is never passed — this stands in for "all active stores",
    // which never includes a deactivated one.
    expect(await hasPartialSplitAccounts([inScope.id])).toBe(true)
  })

  it('is false when every in-scope split account resolves entirely inside the given shops', async () => {
    const [a, b, def] = [await shop('whole-a'), await shop('whole-b'), await shop('whole-def')]
    await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: b.id, spend: 500 },
    ])

    expect(await hasPartialSplitAccounts([a.id, b.id])).toBe(false)
  })

  it('is false when there are no split accounts in scope at all', async () => {
    const s = await shop('no-split')
    expect(await hasPartialSplitAccounts([s.id])).toBe(false)
  })
})

describe('unassignedCampaignCount', () => {
  it('counts campaigns with no store assigned, on split accounts only', async () => {
    const [a, def] = [await shop('uac-a'), await shop('uac-def')]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 }, // assigned: not counted
      { externalId: 'c2', shopId: null, spend: 500 }, // unassigned: counted
      { externalId: 'c3', shopId: null, spend: 250 }, // unassigned: counted
    ])

    expect(await unassignedCampaignCount([account.id])).toBe(2)
  })

  it('is zero when every campaign has a store', async () => {
    const [a, def] = [await shop('uac-zero-a'), await shop('uac-zero-def')]
    const account = await splitAccountWith(def.id, [{ externalId: 'c1', shopId: a.id, spend: 1000 }])

    expect(await unassignedCampaignCount([account.id])).toBe(0)
  })

  it('ignores a whole account, which has no campaigns to leave unassigned', async () => {
    const s = await shop('uac-whole')
    const account = await db.adAccount.create({
      data: { shopId: s.id, provider: 'meta', externalId: `${TAG}-uac-whole`, name: `${TAG} uac whole`, currency: 'NOK' },
    })

    expect(await unassignedCampaignCount([account.id])).toBe(0)
  })
})
