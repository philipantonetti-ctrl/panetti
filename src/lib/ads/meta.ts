import { toMinor } from '../money'
import { utcDay } from '../dates'
import { AdApiError, type DailyRow, type MetaCredentials, type VerifiedAccount } from './types'

/**
 * Meta Marketing API (Graph v25.0), Insights endpoint.
 *
 * One row per calendar day at account level: spend arrives as a decimal string
 * in the ad account's own currency. Auth is a system-user access token with
 * ads_read, which Meta lets us send as a Bearer header — so the token never
 * appears in a URL, and the paging.next links Meta hands back stay clean too.
 */

const GRAPH = 'https://graph.facebook.com/v25.0'
/** 12 months of daily rows fits one page; the page cap is a runaway guard. */
const PAGE_LIMIT = 500
const MAX_PAGES = 10

type ActionEntry = { action_type?: string; value?: string }
type InsightRow = {
  date_start?: string
  spend?: string
  impressions?: string
  clicks?: string
  inline_link_clicks?: string
  reach?: string
  actions?: ActionEntry[]
  action_values?: ActionEntry[]
  video_thruplay_watched_actions?: ActionEntry[]
}

/** Purchases and video views arrive as action lists keyed by action_type. */
const action = (list: ActionEntry[] | undefined, type: string): number =>
  parseFloat(list?.find((a) => a.action_type === type)?.value ?? '0') || 0

const count = (value: string | undefined): number => parseInt(value ?? '0', 10) || 0

export function parseMetaInsights(rows: InsightRow[]): DailyRow[] {
  const out: DailyRow[] = []
  for (const row of rows) {
    if (!row.date_start) continue
    // omni_purchase spans web + app + shop; older accounts only report purchase.
    const conversions = action(row.actions, 'omni_purchase') || action(row.actions, 'purchase')
    const value =
      action(row.action_values, 'omni_purchase') || action(row.action_values, 'purchase')
    const thruplays =
      action(row.video_thruplay_watched_actions, 'video_view') ||
      parseFloat(row.video_thruplay_watched_actions?.[0]?.value ?? '0') ||
      0
    out.push({
      date: utcDay(new Date(row.date_start + 'T00:00:00Z')),
      spend: toMinor(row.spend ?? '0'),
      impressions: count(row.impressions),
      clicks: count(row.clicks),
      linkClicks: count(row.inline_link_clicks),
      conversions,
      conversionValue: toMinor(value),
      videoViews3s: action(row.actions, 'video_view'),
      thruplays,
      reach: count(row.reach),
    })
  }
  return out
}

async function metaJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) throw new AdApiError(body.error?.message ?? `Meta answered ${res.status}`)
  return body
}

const day = (d: Date) => utcDay(d).toISOString().slice(0, 10)

export async function fetchMetaDaily(
  creds: MetaCredentials,
  externalId: string,
  from: Date,
  to: Date,
): Promise<DailyRow[]> {
  const params = new URLSearchParams({
    level: 'account',
    time_increment: '1',
    time_range: JSON.stringify({ since: day(from), until: day(to) }),
    fields:
      'spend,impressions,clicks,inline_link_clicks,reach,actions,action_values,video_thruplay_watched_actions',
    limit: String(PAGE_LIMIT),
  })

  let url: string | undefined = `${GRAPH}/act_${externalId}/insights?${params}`
  const rows: DailyRow[] = []
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body: { data?: InsightRow[]; paging?: { next?: string } } = await metaJson(
      url,
      creds.accessToken,
    )
    rows.push(...parseMetaInsights(body.data ?? []))
    url = body.paging?.next
  }
  return rows
}

type CampaignRow = { daily_budget?: string; effective_status?: string }

/**
 * The current daily budget across ACTIVE campaigns, in the account currency's
 * minor units (which is how Meta returns budget amounts). A setting, not a
 * time series — refreshed at every sync.
 */
export async function fetchMetaDailyBudget(
  creds: MetaCredentials,
  externalId: string,
): Promise<number> {
  const params = new URLSearchParams({ fields: 'daily_budget,effective_status', limit: '200' })
  let url: string | undefined = `${GRAPH}/act_${externalId}/campaigns?${params}`
  let total = 0
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body: { data?: CampaignRow[]; paging?: { next?: string } } = await metaJson(
      url,
      creds.accessToken,
    )
    for (const campaign of body.data ?? []) {
      if (campaign.effective_status !== 'ACTIVE') continue
      // Lifetime-budget campaigns carry no daily_budget and add nothing here.
      total += parseInt(campaign.daily_budget ?? '0', 10) || 0
    }
    url = body.paging?.next
  }
  return total
}

/** Prove the credentials work and read the account's real name and currency. */
export async function verifyMeta(
  creds: MetaCredentials,
  externalId: string,
): Promise<VerifiedAccount> {
  const body: { name?: string; currency?: string } = await metaJson(
    `${GRAPH}/act_${externalId}?${new URLSearchParams({ fields: 'name,currency' })}`,
    creds.accessToken,
  )
  if (!body.currency) throw new AdApiError('Meta did not return the account currency')
  return { name: body.name ?? `Meta ${externalId}`, currency: body.currency }
}
