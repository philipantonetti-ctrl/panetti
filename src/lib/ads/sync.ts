import { db } from '../db'
import { utcDay } from '../dates'
import { decryptSecret } from '../secrets'
import { fetchMetaDaily } from './meta'
import { fetchGoogleDaily } from './google'
import type { AdCredentials, DailyRow, GoogleCredentials, MetaCredentials } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
/** First sync reaches back a year of history. */
const BACKFILL_DAYS = 365
/**
 * Platforms restate recent days inside their attribution windows, so every
 * later sync re-fetches the last 35 and the upsert overwrites in place.
 */
const RESTATE_DAYS = 35
/** Meta refreshes insights every 3-6 hours; asking more often is wasted quota. */
const MIN_HOURS_BETWEEN = 6

export type AdAccountRow = {
  id: string
  provider: string
  externalId: string
  name: string
  credentials: string
  lastSyncAt: Date | null
}

export type AdSyncResult = {
  accountId: string
  name: string
  ok: boolean
  days: number
  error?: string
}

export function syncWindow(lastSyncAt: Date | null, now: Date): { from: Date; to: Date } {
  const to = utcDay(now)
  const back = lastSyncAt ? RESTATE_DAYS : BACKFILL_DAYS
  return { from: new Date(to.getTime() - back * DAY_MS), to }
}

export function readCredentials(stored: string): AdCredentials {
  return JSON.parse(decryptSecret(stored)) as AdCredentials
}

async function fetchDaily(account: AdAccountRow, from: Date, to: Date): Promise<DailyRow[]> {
  const creds = readCredentials(account.credentials)
  return account.provider === 'meta'
    ? fetchMetaDaily(creds as MetaCredentials, account.externalId, from, to)
    : fetchGoogleDaily(creds as GoogleCredentials, account.externalId, from, to)
}

async function storeDaily(accountId: string, rows: DailyRow[]): Promise<number> {
  await db.$transaction(
    rows.map((r) =>
      db.adSpend.upsert({
        where: { accountId_date: { accountId, date: r.date } },
        create: {
          accountId,
          date: r.date,
          spend: r.spend,
          impressions: r.impressions,
          clicks: r.clicks,
        },
        update: { spend: r.spend, impressions: r.impressions, clicks: r.clicks },
      }),
    ),
  )
  return rows.length
}

export async function syncAdAccount(account: AdAccountRow, now = new Date()): Promise<AdSyncResult> {
  try {
    const { from, to } = syncWindow(account.lastSyncAt, now)
    const days = await storeDaily(account.id, await fetchDaily(account, from, to))
    await db.adAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: now, lastError: null },
    })
    return { accountId: account.id, name: account.name, ok: true, days }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Sync failed'
    // Shown as the status badge on the settings page. Stored, never thrown:
    // one broken account must not stop the others.
    await db.adAccount
      .update({ where: { id: account.id }, data: { lastError: error } })
      .catch(() => {})
    return { accountId: account.id, name: account.name, ok: false, days: 0, error }
  }
}

export async function syncAllAdAccounts(opts: { force?: boolean } = {}): Promise<AdSyncResult[]> {
  const accounts = await db.adAccount.findMany({ where: { active: true } })
  const now = new Date()
  const due = opts.force
    ? accounts
    : accounts.filter(
        (a) =>
          !a.lastSyncAt || now.getTime() - a.lastSyncAt.getTime() >= MIN_HOURS_BETWEEN * 3_600_000,
      )

  const results: AdSyncResult[] = []
  for (const a of due) results.push(await syncAdAccount(a, now))
  return results
}
