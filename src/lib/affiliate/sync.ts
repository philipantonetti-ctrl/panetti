import { db } from '../db'
import { utcDay } from '../dates'
import { decryptSecret } from '../secrets'
import { fetchAdvertiser, fetchTransactions } from './client'
import { matchMarketsToShops } from './match'

/**
 * The Addrevenue sync: refetch the WHOLE history and make our table an exact
 * mirror — upsert what they return, delete what they no longer do. The entire
 * history is ~2,200 rows in one page per brand, and old rows change status in
 * place months later, so a windowed fetch would buy nothing and cost the
 * restatement guarantee. No watermarks, no restate window.
 */

/** Panetti's first transaction is 2025-07-19; start the fetch before it. */
const FIRST_DATA_DATE = '2025-07-01'
/** Statuses settle over days, not minutes; more often is wasted calls. */
const MIN_HOURS_BETWEEN = 6

export type AffiliateAccountRow = {
  id: string
  name: string
  token: string
  lastSyncAt: Date | null
}

export type AffiliateSyncResult = {
  accountId: string
  name: string
  ok: boolean
  rows: number
  unmatchedMarkets: string[]
  error?: string
}

export async function syncAffiliateAccount(
  account: AffiliateAccountRow,
  now = new Date(),
): Promise<AffiliateSyncResult> {
  try {
    const token = decryptSecret(account.token)

    // The market map is rebuilt every run, so connecting a shop later heals
    // every historical row on the next sync — the mirror rewrite below writes
    // shopId afresh for all of them.
    const advertiser = await fetchAdvertiser(token)
    const shops = await db.shop.findMany({
      where: { active: true },
      select: { id: true, wooUrl: true },
    })
    const { byMarket, unmatched } = matchMarketsToShops(advertiser.markets, shops)

    const toDate = utcDay(now).toISOString().slice(0, 10)
    const rows = await fetchTransactions(token, { fromDate: FIRST_DATA_DATE, toDate })

    await db.$transaction([
      ...rows.map((r) => {
        const data = {
          date: r.date,
          market: r.market,
          shopId: byMarket.get(r.market) ?? null,
          channelId: r.channelId,
          channelName: r.channelName,
          status: r.status,
          denyDate: r.denyDate,
          commission: r.commission,
          brokerageFee: r.brokerageFee,
          orderValue: r.orderValue,
          currency: r.currency,
          eventOrderId: r.eventOrderId,
        }
        return db.affiliateTransaction.upsert({
          where: { accountId_externalId: { accountId: account.id, externalId: r.externalId } },
          create: { accountId: account.id, externalId: r.externalId, ...data },
          update: data,
        })
      }),
      // The fetch covered the full history, so anything of ours it did not
      // return no longer exists on their side. Inside the same transaction:
      // the table is never caught between two truths.
      db.affiliateTransaction.deleteMany({
        where: { accountId: account.id, externalId: { notIn: rows.map((r) => r.externalId) } },
      }),
    ])

    await db.affiliateAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: now, lastError: null },
    })
    return { accountId: account.id, name: account.name, ok: true, rows: rows.length, unmatchedMarkets: unmatched }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Sync failed'
    // Shown on the settings page. Stored, never thrown: one broken token must
    // not stop the other brand — or the cron.
    await db.affiliateAccount
      .update({ where: { id: account.id }, data: { lastError: error } })
      .catch(() => {})
    return { accountId: account.id, name: account.name, ok: false, rows: 0, unmatchedMarkets: [], error }
  }
}

export async function syncAllAffiliateAccounts(
  opts: { force?: boolean } = {},
): Promise<AffiliateSyncResult[]> {
  const accounts = await db.affiliateAccount.findMany({ where: { active: true } })
  const now = new Date()
  const due = opts.force
    ? accounts
    : accounts.filter(
        (a) =>
          !a.lastSyncAt || now.getTime() - a.lastSyncAt.getTime() >= MIN_HOURS_BETWEEN * 3_600_000,
      )

  const results: AffiliateSyncResult[] = []
  for (const a of due) results.push(await syncAffiliateAccount(a, now))
  return results
}
