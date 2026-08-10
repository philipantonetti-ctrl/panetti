import { db } from '../db'
import { utcDay } from '../dates'
import { decryptSecret } from '../secrets'
import { platformApp } from './platform-app'
import { fetchMetaDaily, fetchMetaDailyBudget, fetchMetaCampaignDaily } from './meta'
import { fetchGoogleDaily, fetchGoogleDailyBudget, fetchGoogleCampaignDaily } from './google'
import {
  AdApiError,
  type AdCredentials,
  type DailyRow,
  type GoogleCredentials,
  type MetaCredentials,
  type CampaignDailyRow,
} from './types'

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
  credentials: string | null
  loginCustomerId?: string | null
  lastSyncAt: Date | null
  splitByCampaign?: boolean
  /** Set when the account was connected by logging in rather than pasting. */
  connection?: { provider: string; secret: string; expiresAt: Date | null } | null
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
  if (!lastSyncAt) return { from: new Date(to.getTime() - BACKFILL_DAYS * DAY_MS), to }

  // lastSyncAt is a DATE, not a yes/no. An account that stopped syncing for 60
  // days needs those 60 days re-fetched as well as the restate window, because
  // nothing else will ever go back for them: the next successful sync writes
  // lastSyncAt = now and the hole becomes permanent and invisible.
  const daysSince = Math.ceil((to.getTime() - utcDay(lastSyncAt).getTime()) / DAY_MS)
  const back = Math.min(BACKFILL_DAYS, Math.max(RESTATE_DAYS, daysSince + RESTATE_DAYS))
  return { from: new Date(to.getTime() - back * DAY_MS), to }
}

export function readCredentials(stored: string): AdCredentials {
  return JSON.parse(decryptSecret(stored)) as AdCredentials
}

/**
 * A login connection wins over pasted credentials; neither is a visible error,
 * never a silent skip. Google logins also need the platform app for the
 * developer token and OAuth client.
 */
export async function resolveCredentials(account: AdAccountRow): Promise<AdCredentials> {
  if (account.connection) {
    if (account.provider === 'meta') {
      if (account.connection.expiresAt && account.connection.expiresAt < new Date()) {
        throw new AdApiError('Facebook login expired. Press Connect with Facebook to renew it.')
      }
      return { accessToken: decryptSecret(account.connection.secret) }
    }
    const app = await platformApp('google')
    if (!app?.developerToken) {
      throw new AdApiError('Google connect is not configured on the server.')
    }
    return {
      developerToken: app.developerToken,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken: decryptSecret(account.connection.secret),
      ...(account.loginCustomerId ? { loginCustomerId: account.loginCustomerId } : {}),
    }
  }
  if (!account.credentials) {
    throw new AdApiError('No credentials. Connect this account again.')
  }
  return readCredentials(account.credentials)
}

function fetchDaily(
  account: AdAccountRow,
  creds: AdCredentials,
  from: Date,
  to: Date,
): Promise<DailyRow[]> {
  return account.provider === 'meta'
    ? fetchMetaDaily(creds as MetaCredentials, account.externalId, from, to)
    : fetchGoogleDaily(creds as GoogleCredentials, account.externalId, from, to)
}

function fetchBudget(account: AdAccountRow, creds: AdCredentials): Promise<number> {
  return account.provider === 'meta'
    ? fetchMetaDailyBudget(creds as MetaCredentials, account.externalId)
    : fetchGoogleDailyBudget(creds as GoogleCredentials, account.externalId)
}

function fetchCampaignDaily(
  account: AdAccountRow,
  creds: AdCredentials,
  from: Date,
  to: Date,
): Promise<CampaignDailyRow[]> {
  return account.provider === 'meta'
    ? fetchMetaCampaignDaily(creds as MetaCredentials, account.externalId, from, to)
    : fetchGoogleCampaignDaily(creds as GoogleCredentials, account.externalId, from, to)
}

async function storeDaily(accountId: string, rows: DailyRow[]): Promise<number> {
  await db.$transaction(
    rows.map((r) => {
      const metrics = {
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        linkClicks: r.linkClicks,
        conversions: r.conversions,
        conversionValue: r.conversionValue,
        videoViews3s: r.videoViews3s,
        thruplays: r.thruplays,
        reach: r.reach,
      }
      return db.adSpend.upsert({
        where: { accountId_date: { accountId, date: r.date } },
        create: { accountId, date: r.date, ...metrics },
        update: metrics,
      })
    }),
  )
  return rows.length
}

/**
 * Campaign rows for a split account. The AdCampaign row is upserted for its
 * NAME only — shopId is a person's decision and the sync must never touch it,
 * or renaming a campaign in the platform would silently unassign its store.
 */
async function storeCampaignDaily(accountId: string, rows: CampaignDailyRow[]): Promise<number> {
  const idByExternal = new Map<string, string>()
  for (const externalId of new Set(rows.map((r) => r.campaignId))) {
    const name = rows.find((r) => r.campaignId === externalId)!.campaignName
    const campaign = await db.adCampaign.upsert({
      where: { accountId_externalId: { accountId, externalId } },
      create: { accountId, externalId, name },
      update: { name },
    })
    idByExternal.set(externalId, campaign.id)
  }

  await db.$transaction(
    rows.map((r) => {
      const metrics = {
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        linkClicks: r.linkClicks,
        conversions: r.conversions,
        conversionValue: r.conversionValue,
        videoViews3s: r.videoViews3s,
        thruplays: r.thruplays,
      }
      const campaignId = idByExternal.get(r.campaignId)!
      return db.adCampaignSpend.upsert({
        where: { campaignId_date: { campaignId, date: r.date } },
        create: { campaignId, date: r.date, ...metrics },
        update: metrics,
      })
    }),
  )
  return rows.length
}

export async function syncAdAccount(account: AdAccountRow, now = new Date()): Promise<AdSyncResult> {
  try {
    const creds = await resolveCredentials(account)
    const { from, to } = syncWindow(account.lastSyncAt, now)
    // A split account writes campaign rows and NEVER an AdSpend row. Both would
    // silently double this account's cost everywhere it is read.
    const days = account.splitByCampaign
      ? await storeCampaignDaily(account.id, await fetchCampaignDaily(account, creds, from, to))
      : await storeDaily(account.id, await fetchDaily(account, creds, from, to))

    // Budgets are decoration on top of the spend history: refreshed when the
    // platform answers, kept as they were when it does not.
    let dailyBudget: number | undefined
    try {
      dailyBudget = await fetchBudget(account, creds)
    } catch {
      // The last known budget stands.
    }

    await db.adAccount.update({
      where: { id: account.id },
      data: {
        lastSyncAt: now,
        lastError: null,
        ...(dailyBudget !== undefined ? { dailyBudget } : {}),
      },
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
  const accounts = await db.adAccount.findMany({
    where: { active: true },
    include: { connection: true },
  })
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
