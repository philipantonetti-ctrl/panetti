import { db } from '../db'
import { utcDay } from '../dates'

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

// Split accounts: their campaigns are chosen on where THEY land, not on the
// account's own shopId. An account whose default store sits outside the
// selection can still hold campaigns that belong inside it — filtering on the
// account would drop them.
function splitCampaignsFor(shopIds: string[]) {
  return db.adCampaign.findMany({
    where: {
      account: { active: true, splitByCampaign: true },
      OR: [
        { shopId: { in: shopIds } },
        { shopId: null, account: { shopId: { in: shopIds } } },
      ],
    },
    select: { id: true, shopId: true, account: { select: { shopId: true, currency: true } } },
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
