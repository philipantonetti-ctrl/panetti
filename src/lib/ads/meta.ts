import { toMinor } from '../money'
import { utcDay } from '../dates'
import {
  AdApiError,
  type BreakdownEntry,
  type BreakdownLevel,
  type CampaignDailyRow,
  type DailyRow,
  type MetaCredentials,
  type VerifiedAccount,
} from './types'
import { CHUNK_DAYS, chunkRange } from './windows'

/**
 * Meta Marketing API (Graph v25.0), Insights endpoint.
 *
 * One row per calendar day at account level for the daily sync, or one row
 * per campaign, ad set or ad totalled over a range for the breakdown table
 * below — same endpoint, a different `level` and no `time_increment`. Spend
 * arrives as a decimal string in the ad account's own currency. Auth is a
 * system-user access token with ads_read, which Meta lets us send as a Bearer
 * header — so the token never appears in a URL, and the paging.next links
 * Meta hands back stay clean too.
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

type BreakdownInsightRow = InsightRow & {
  campaign_id?: string
  campaign_name?: string
  adset_id?: string
  adset_name?: string
  ad_id?: string
  ad_name?: string
}

/** Purchases and video views arrive as action lists keyed by action_type. */
const action = (list: ActionEntry[] | undefined, type: string): number =>
  parseFloat(list?.find((a) => a.action_type === type)?.value ?? '0') || 0

const count = (value: string | undefined): number => parseInt(value ?? '0', 10) || 0

/**
 * Purchases and their value, from Meta's action lists.
 *
 * Shared by the daily sync and the breakdown table on purpose. If these drifted
 * apart, one screen would say a campaign made 284 purchases and another would
 * say something else, and both would be citing Meta.
 */
export function purchasesFrom(row: {
  actions?: ActionEntry[]
  action_values?: ActionEntry[]
}): { purchases: number; purchaseValue: number } {
  // omni_purchase spans web + app + shop; older accounts only report purchase.
  return {
    purchases: action(row.actions, 'omni_purchase') || action(row.actions, 'purchase'),
    purchaseValue: toMinor(
      String(action(row.action_values, 'omni_purchase') || action(row.action_values, 'purchase')),
    ),
  }
}

export function parseMetaInsights(rows: InsightRow[]): DailyRow[] {
  const out: DailyRow[] = []
  for (const row of rows) {
    if (!row.date_start) continue
    const { purchases, purchaseValue } = purchasesFrom(row)
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
      conversions: purchases,
      conversionValue: purchaseValue,
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

/** Which id and name field each level reports itself under. */
const BREAKDOWN_FIELDS: Record<BreakdownLevel, { id: string; name: string }> = {
  campaign: { id: 'campaign_id', name: 'campaign_name' },
  adset: { id: 'adset_id', name: 'adset_name' },
  ad: { id: 'ad_id', name: 'ad_name' },
}

/**
 * One row per campaign, ad set or ad, totalled over the range.
 *
 * Meta serves insights off any object id, so a drill-down needs no filter
 * syntax: ad sets are asked of the campaign, ads of the ad set. Deliberately no
 * `time_increment` — this table shows a total for the chosen period, and asking
 * per day would return entities × days and page for a very long time.
 */
export async function fetchMetaBreakdown(
  creds: MetaCredentials,
  target: { level: BreakdownLevel; accountExternalId: string; parentId?: string },
  from: Date,
  to: Date,
): Promise<BreakdownEntry[]> {
  const fields = BREAKDOWN_FIELDS[target.level]
  const params = new URLSearchParams({
    level: target.level,
    time_range: JSON.stringify({ since: day(from), until: day(to) }),
    fields: `${fields.id},${fields.name},spend,impressions,clicks,actions,action_values`,
    limit: String(PAGE_LIMIT),
  })

  // Campaigns hang off the account; everything deeper hangs off its parent.
  const object = target.parentId ? target.parentId : `act_${target.accountExternalId}`

  let url: string | undefined = `${GRAPH}/${object}/insights?${params}`
  const rows: BreakdownEntry[] = []
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body: { data?: BreakdownInsightRow[]; paging?: { next?: string } } = await metaJson(
      url,
      creds.accessToken,
    )
    for (const row of body.data ?? []) {
      const id = row[fields.id as keyof BreakdownInsightRow]
      if (typeof id !== 'string') continue // a total row, not an entity
      rows.push({
        id,
        name: String(row[fields.name as keyof BreakdownInsightRow] ?? id),
        spend: toMinor(row.spend ?? '0'),
        impressions: count(row.impressions),
        clicks: count(row.clicks),
        ...purchasesFrom(row),
      })
    }
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

/**
 * One row per campaign per day, for a split account.
 *
 * fetchMetaBreakdown warns that asking per day "would return entities x days
 * and page for a very long time". That warning is right, and it is why the
 * range is fetched in windows here. The cap is still real: PAGE_LIMIT 500 x
 * MAX_PAGES 10 = 5000 rows, and the loop below would otherwise stop at the cap
 * and return a short answer that looks complete. Chunking prevents that; the
 * throw makes any future surprise loud instead of silent.
 */
export async function fetchMetaCampaignDaily(
  creds: MetaCredentials,
  externalId: string,
  from: Date,
  to: Date,
): Promise<CampaignDailyRow[]> {
  const rows: CampaignDailyRow[] = []

  for (const window of chunkRange(from, to, CHUNK_DAYS)) {
    const params = new URLSearchParams({
      level: 'campaign',
      time_increment: '1',
      time_range: JSON.stringify({ since: day(window.from), until: day(window.to) }),
      fields:
        'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,action_values,video_thruplay_watched_actions',
      limit: String(PAGE_LIMIT),
    })

    let url: string | undefined = `${GRAPH}/act_${externalId}/insights?${params}`
    let page = 0
    for (; url && page < MAX_PAGES; page++) {
      const body: { data?: BreakdownInsightRow[]; paging?: { next?: string } } = await metaJson(
        url,
        creds.accessToken,
      )
      for (const row of body.data ?? []) {
        if (!row.campaign_id) continue // nothing to key on, same as mapBreakdownRow
        const [daily] = parseMetaInsights([row])
        if (!daily) continue
        rows.push({ ...daily, campaignId: row.campaign_id, campaignName: row.campaign_name || row.campaign_id })
      }
      url = body.paging?.next
    }

    // Still a next link after MAX_PAGES means the answer was cut short. Meta
    // does not say so, and a short year that looks complete is worse than an
    // error, so say so here.
    if (url) {
      throw new AdApiError(
        'Too many rows for one request. This account has more campaigns than a 90-day window can carry.',
      )
    }
  }

  return rows
}
