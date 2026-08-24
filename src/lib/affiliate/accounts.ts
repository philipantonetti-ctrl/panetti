import { db } from '../db'

/**
 * What the settings page may see of a connected brand — and, just as much, what
 * it may not.
 *
 * One shape, used by the page's server render AND by GET /api/affiliate/accounts,
 * for the same reason `ads/accounts.ts` exists: the token is not a field of this
 * type at all, so no route can leak it by forgetting to strip it, and the two
 * places that list brands cannot drift into showing different columns.
 */
export type PublicAffiliateAccount = {
  id: string
  externalId: string
  name: string
  active: boolean
  lastSyncAt: string | null
  lastError: string | null
  /** Sales imported for this brand, all time. */
  transactions: number
  /** Of those, the ones whose market matched no shop — the number worth acting on. */
  unmatched: number
}

type AccountRow = {
  id: string
  externalId: string
  name: string
  active: boolean
  lastSyncAt: Date | null
  lastError: string | null
}

/**
 * The counts beside each brand, in two grouped queries rather than two per
 * account. A brand's history is thousands of rows and this page is opened
 * precisely when a figure looks wrong; it must not be the slow screen.
 */
export async function withCounts(accounts: AccountRow[]): Promise<PublicAffiliateAccount[]> {
  const accountId = { in: accounts.map((a) => a.id) }
  const [totals, orphans] = await Promise.all([
    db.affiliateTransaction.groupBy({
      by: ['accountId'],
      where: { accountId },
      _count: { _all: true },
    }),
    db.affiliateTransaction.groupBy({
      by: ['accountId'],
      where: { accountId, shopId: null },
      _count: { _all: true },
    }),
  ])
  const total = new Map(totals.map((r) => [r.accountId, r._count._all]))
  const orphan = new Map(orphans.map((r) => [r.accountId, r._count._all]))

  return accounts.map((a) => ({
    id: a.id,
    externalId: a.externalId,
    name: a.name,
    active: a.active,
    lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
    lastError: a.lastError,
    transactions: total.get(a.id) ?? 0,
    unmatched: orphan.get(a.id) ?? 0,
  }))
}

/** Every connected brand, oldest first — the order they were added in. */
export async function listAffiliateAccounts(): Promise<PublicAffiliateAccount[]> {
  return withCounts(await db.affiliateAccount.findMany({ orderBy: { createdAt: 'asc' } }))
}
