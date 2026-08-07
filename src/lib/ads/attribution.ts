import { db } from '../db'
import { utcDay } from '../dates'
import type { SpendRow } from './marketing'

/**
 * Stored ad spend, resolved to the shop that actually paid for it.
 *
 * `currency` is the AD ACCOUNT's, not the shop's — a Norwegian store can run a
 * EUR ad account — so the caller converts at read time like everything else.
 */
export type AttributedSpend = {
  shopId: string
  date: Date
  spend: number
  currency: string
}

// Whole accounts: chosen on their own shopId — exactly the query that used to
// live in load.ts.
function wholeAccountsFor(shopIds: string[]) {
  return db.adAccount.findMany({
    where: { active: true, splitByCampaign: false, shopId: { in: shopIds } },
    select: { id: true, shopId: true, currency: true },
  })
}

// A campaign resolves into these shops if it is assigned directly to one of
// them, or it is unassigned and the account's own default shop is one of
// them. Shared by every caller that needs "which campaigns land in these
// shops" so a second copy of the condition can never drift from this one.
function campaignsInShops(shopIds: string[]) {
  return [
    { shopId: { in: shopIds } },
    { shopId: null, account: { shopId: { in: shopIds } } },
  ]
}

// Split accounts: their campaigns are chosen on where THEY land, not on the
// account's own shopId. An account whose default store sits outside the
// selection can still hold campaigns that belong inside it — filtering on the
// account would drop them.
function splitCampaignsFor(shopIds: string[]) {
  return db.adCampaign.findMany({
    where: {
      account: { active: true, splitByCampaign: true },
      OR: campaignsInShops(shopIds),
    },
    select: { id: true, shopId: true, accountId: true, account: { select: { shopId: true, currency: true } } },
  })
}

/**
 * One implementation, two callers: the metrics loader and /api/marketing. Two
 * copies would drift and the Dashboard and the Marketing page would disagree
 * about the same money.
 *
 * A whole account reads AdSpend and takes the account's own shopId. A split
 * account reads AdCampaignSpend and takes the campaign's shopId, falling back
 * to the account's when the campaign has not been assigned yet. Nothing is ever
 * read from both tables, so no account can be counted twice.
 */
export async function attributedSpend(
  shopIds: string[],
  from: Date,
  to: Date,
): Promise<AttributedSpend[]> {
  if (!shopIds.length) return []
  const date = { gte: utcDay(from), lte: utcDay(to) }

  const wholeAccounts = await wholeAccountsFor(shopIds)
  const wholeById = new Map(wholeAccounts.map((a) => [a.id, a]))
  const wholeRows = wholeAccounts.length
    ? await db.adSpend.findMany({
        where: { accountId: { in: wholeAccounts.map((a) => a.id) }, date },
        select: { accountId: true, date: true, spend: true },
        orderBy: { date: 'asc' },
      })
    : []

  const campaigns = await splitCampaignsFor(shopIds)
  const campaignById = new Map(campaigns.map((c) => [c.id, c]))
  const campaignRows = campaigns.length
    ? await db.adCampaignSpend.findMany({
        where: { campaignId: { in: campaigns.map((c) => c.id) }, date },
        select: { campaignId: true, date: true, spend: true },
        orderBy: { date: 'asc' },
      })
    : []

  return [
    ...wholeRows.map((r) => {
      const account = wholeById.get(r.accountId)!
      return { shopId: account.shopId, date: r.date, spend: r.spend, currency: account.currency }
    }),
    ...campaignRows.map((r) => {
      const campaign = campaignById.get(r.campaignId)!
      return {
        shopId: campaign.shopId ?? campaign.account.shopId,
        date: r.date,
        spend: r.spend,
        currency: campaign.account.currency,
      }
    }),
  ]
}

/**
 * Currencies of every ad account that could contribute spend to these shops —
 * whether or not it has any spend rows yet in a given window. A rate has to be
 * on hand the moment spend for that currency lands, not fetched retroactively
 * once it has; a currency with zero rows today is not one FX can ignore.
 */
export async function relevantAdCurrencies(shopIds: string[]): Promise<string[]> {
  if (!shopIds.length) return []
  const [wholeAccounts, campaigns] = await Promise.all([wholeAccountsFor(shopIds), splitCampaignsFor(shopIds)])
  return [...new Set([...wholeAccounts.map((a) => a.currency), ...campaigns.map((c) => c.account.currency)])]
}

/**
 * Which ad accounts have spend belonging to these shops.
 *
 * A whole account qualifies on its own shopId. A split account qualifies on
 * where its CAMPAIGNS resolve — its own shop may sit outside the selection
 * while its campaigns sit inside it. Filtering on the account alone is the bug
 * this exists to prevent, and it is the same rule attributedSpend follows, so
 * the Marketing page and the Dashboard agree on which accounts are in scope.
 */
export async function accountIdsForShops(shopIds: string[]): Promise<string[]> {
  if (!shopIds.length) return []
  const [wholeAccounts, campaigns] = await Promise.all([wholeAccountsFor(shopIds), splitCampaignsFor(shopIds)])
  return [...new Set([...wholeAccounts.map((a) => a.id), ...campaigns.map((c) => c.accountId)])]
}

/**
 * How many of these accounts' campaigns still have no store — the design's
 * "loudly" half of the fallback. A campaign with shopId: null attributes to
 * the account's default shop, which is correct but silent unless this count
 * is shown; excluding that spend instead would understate ad cost and make
 * profit look better than reality, which is worse. Only split accounts have
 * campaigns at all, so a whole account in `accountIds` contributes nothing.
 */
export async function unassignedCampaignCount(accountIds: string[]): Promise<number> {
  if (!accountIds.length) return 0
  return db.adCampaign.count({
    where: { accountId: { in: accountIds }, account: { splitByCampaign: true }, shopId: null },
  })
}

/**
 * Account-keyed rows for the Marketing page, which groups by account and shows
 * ten metric columns.
 *
 * A whole account's AdSpend rows pass through untouched. A split account has no
 * AdSpend rows at all, so its campaign rows are rolled up per (date, resolved
 * shop) and carry `shopId` so buildMarketing attributes them the same way the
 * Dashboard does. Without this the Marketing page would show zero for exactly
 * the accounts this feature exists for.
 *
 * `shopIds` is the caller's OWN filter (Marketing's `scopeIds`), not derived
 * from `accountIds`. An in-scope split account can still run campaigns for a
 * shop the caller did not ask about — `accountIds` only says the account
 * belongs in the response, not that every one of its campaigns does — so the
 * campaign query is narrowed with the same `campaignsInShops` condition
 * `splitCampaignsFor` uses, or an out-of-scope campaign's spend would leak
 * into `byDay` (buildMarketing drops it from `byShop`/`total` but not there).
 */
export async function accountSpendRows(
  accountIds: string[],
  shopIds: string[],
  from: Date,
  to: Date,
): Promise<SpendRow[]> {
  if (!accountIds.length) return []
  const date = { gte: utcDay(from), lte: utcDay(to) }

  const [whole, campaigns] = await Promise.all([
    db.adSpend.findMany({
      // A split account writes only AdCampaignSpend — see the double-counting
      // rule in attributedSpend above. Without this guard, an account ticked
      // "split by campaign" that still has a year of pre-split AdSpend rows
      // (nothing ever deletes them) would have BOTH tables read here, roughly
      // doubling its spend for as long as those rows exist.
      where: { accountId: { in: accountIds }, date, account: { splitByCampaign: false } },
      select: {
        accountId: true, date: true, spend: true, impressions: true, clicks: true,
        linkClicks: true, conversions: true, conversionValue: true,
        videoViews3s: true, thruplays: true,
      },
    }),
    db.adCampaign.findMany({
      where: {
        accountId: { in: accountIds },
        account: { splitByCampaign: true },
        OR: campaignsInShops(shopIds),
      },
      select: { id: true, shopId: true, accountId: true, account: { select: { shopId: true } } },
    }),
  ])

  const campaignById = new Map(campaigns.map((c) => [c.id, c]))
  const campaignRows = campaigns.length
    ? await db.adCampaignSpend.findMany({
        where: { campaignId: { in: campaigns.map((c) => c.id) }, date },
      })
    : []

  // Rolled up per account, day and resolved shop — the Marketing page groups by
  // account, so one row per campaign would multiply its row count for nothing.
  const rolled = new Map<string, SpendRow>()
  for (const r of campaignRows) {
    const campaign = campaignById.get(r.campaignId)!
    const shopId = campaign.shopId ?? campaign.account.shopId
    const key = `${campaign.accountId}|${shopId}|${r.date.toISOString()}`
    const existing = rolled.get(key)
    if (existing) {
      existing.spend += r.spend
      existing.impressions += r.impressions
      existing.clicks += r.clicks
      existing.linkClicks += r.linkClicks
      existing.conversions += r.conversions
      existing.conversionValue += r.conversionValue
      existing.videoViews3s += r.videoViews3s
      existing.thruplays += r.thruplays
    } else {
      rolled.set(key, {
        accountId: campaign.accountId,
        shopId,
        date: r.date,
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        linkClicks: r.linkClicks,
        conversions: r.conversions,
        conversionValue: r.conversionValue,
        videoViews3s: r.videoViews3s,
        thruplays: r.thruplays,
      })
    }
  }

  return [...whole, ...rolled.values()]
}
