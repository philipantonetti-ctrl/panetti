import { db } from '../db'
import { utcDay } from '../dates'
import type { EngineAffiliateCost } from '../metrics/types'

/**
 * Affiliate cost as the engine eats it: one row per (shop, day, currency),
 * amount = commission + Addrevenue's brokerage fee — both leave the bank
 * account, so both count (the client's explicit decision, 2026-08-24).
 * Denied rows cost nothing; unmatched rows (shopId null) can belong to no
 * shop's figures and are surfaced elsewhere instead of summed here.
 *
 * One implementation for every caller, like ads/attribution.ts: a second
 * copy is how the Dashboard and the Marketing page come to disagree.
 */
export async function affiliateCosts(
  shopIds: string[],
  from: Date,
  to: Date,
): Promise<EngineAffiliateCost[]> {
  if (!shopIds.length) return []
  const grouped = await db.affiliateTransaction.groupBy({
    by: ['shopId', 'date', 'currency'],
    where: {
      shopId: { in: shopIds },
      denyDate: null,
      date: { gte: utcDay(from), lte: utcDay(to) },
    },
    _sum: { commission: true, brokerageFee: true },
  })
  return grouped.map((g) => ({
    shopId: g.shopId!,
    date: g.date,
    amount: (g._sum.commission ?? 0) + (g._sum.brokerageFee ?? 0),
    currency: g.currency,
  }))
}

/**
 * Every currency these shops hold affiliate rows in, so the FX loader has a
 * rate before the first conversion — real data has FI-market sales in SEK.
 */
export async function relevantAffiliateCurrencies(shopIds: string[]): Promise<string[]> {
  if (!shopIds.length) return []
  const rows = await db.affiliateTransaction.findMany({
    where: { shopId: { in: shopIds } },
    select: { currency: true },
    distinct: ['currency'],
  })
  return rows.map((r) => r.currency)
}
