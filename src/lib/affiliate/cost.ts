import { db } from '../db'
import { utcDay } from '../dates'
import type { EngineAffiliateCost } from '../metrics/types'

/**
 * One (shop, day, currency, channel) slice of affiliate money, raw minor units
 * in the slice's own currency - the finest grain anything needs. The engine
 * rolls it up to (shop, day, currency) with `toShopDayCurrency`; the Marketing
 * page additionally buckets the same slices per channel. Money stays UNSUMMED
 * across channels here precisely so both readings come from one query.
 */
export type AffiliateGroup = {
  shopId: string
  date: Date
  currency: string
  channelId: string
  channelName: string
  commission: number
  brokerageFee: number
  orderValue: number
  /** How many transactions the slice sums - the Marketing page's "tracked sales". */
  sales: number
}

/**
 * THE query: what counts as affiliate cost, in one place.
 *
 * Non-denied rows only (a denied sale costs nothing), the range clamped to UTC
 * days on both ends, and only rows matched to one of the asked shops -
 * unmatched rows (shopId null) belong to no shop's figures and are surfaced
 * separately, never summed here. Transactions count regardless of the
 * account's `active` flag: booked money still counts after an account is
 * paused - `active` gates syncing, not history.
 *
 * Deliberate trade: the dashboard path now fetches channel-grain rows and
 * rolls them up in TypeScript rather than letting the database hand it the
 * coarser (shop, day, currency) grain directly. That is a few thousand small
 * rows at the very most, and it buys correctness by construction - every
 * caller aggregates the SAME rows with the SAME code, so the Dashboard and
 * the Marketing page cannot drift apart the way two hand-copied groupBys can.
 */
export async function affiliateGroups(
  shopIds: string[],
  from: Date,
  to: Date,
): Promise<AffiliateGroup[]> {
  if (!shopIds.length) return []
  const grouped = await db.affiliateTransaction.groupBy({
    by: ['shopId', 'date', 'currency', 'channelId', 'channelName'],
    where: {
      shopId: { in: shopIds },
      denyDate: null,
      date: { gte: utcDay(from), lte: utcDay(to) },
    },
    _count: { _all: true },
    _sum: { commission: true, brokerageFee: true, orderValue: true },
  })
  return grouped.map((g) => ({
    shopId: g.shopId!, // the `in` filter above makes null impossible
    date: g.date,
    currency: g.currency,
    channelId: g.channelId,
    channelName: g.channelName,
    commission: g._sum.commission ?? 0,
    brokerageFee: g._sum.brokerageFee ?? 0,
    orderValue: g._sum.orderValue ?? 0,
    sales: g._count._all,
  }))
}

/** The engine's row plus the order value and sale count shown beside the cost. */
export type ShopDayCurrencyCost = EngineAffiliateCost & { orderValue: number; sales: number }

/**
 * THE roll-up the engine eats: amount = commission + Addrevenue's brokerage
 * fee - both leave the bank account, so both count (the client's explicit
 * decision, 2026-08-24). Summing minor units is exact, so this is the only
 * place the (shop, day, currency) grain is decided - and because `mulRate`
 * rounds per conversion, that grain determines the converted total. The
 * Marketing page calls this too, which is what makes the two screens
 * incapable of disagreeing.
 */
export function toShopDayCurrency(groups: AffiliateGroup[]): ShopDayCurrencyCost[] {
  const rows = new Map<string, ShopDayCurrencyCost>()
  for (const g of groups) {
    const key = `${g.shopId}|${g.date.toISOString()}|${g.currency}`
    const amount = g.commission + g.brokerageFee
    const row = rows.get(key)
    if (row) {
      row.amount += amount
      row.orderValue += g.orderValue
      row.sales += g.sales
    } else {
      rows.set(key, {
        shopId: g.shopId,
        date: g.date,
        currency: g.currency,
        amount,
        orderValue: g.orderValue,
        sales: g.sales,
      })
    }
  }
  return [...rows.values()]
}

/**
 * Affiliate cost as the engine eats it - the one query above through the one
 * roll-up above, projected down to exactly EngineAffiliateCost (the engine's
 * input carries no Marketing-page extras; src/lib/data/load.affiliate.test.ts
 * pins that). The projection renames nothing and rounds nothing, so the money
 * and its grain still come from the single shared roll-up.
 */
export async function affiliateCosts(
  shopIds: string[],
  from: Date,
  to: Date,
): Promise<EngineAffiliateCost[]> {
  return toShopDayCurrency(await affiliateGroups(shopIds, from, to)).map(
    ({ shopId, date, amount, currency }) => ({ shopId, date, amount, currency }),
  )
}

/**
 * Every currency these shops hold affiliate rows in, so the FX loader has a
 * rate before the first conversion - real data has FI-market sales in SEK.
 */
export async function relevantAffiliateCurrencies(shopIds: string[]): Promise<string[]> {
  if (!shopIds.length) return []
  // groupBy, not findMany+distinct: Prisma applies `distinct` client-side,
  // which would fetch every transaction's currency on each dashboard load.
  const rows = await db.affiliateTransaction.groupBy({
    by: ['currency'],
    where: { shopId: { in: shopIds } },
  })
  return rows.map((r) => r.currency)
}
