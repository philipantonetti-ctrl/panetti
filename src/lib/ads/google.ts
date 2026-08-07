import { utcDay } from '../dates'
import { toMinor } from '../money'
import {
  AdApiError,
  type BreakdownEntry,
  type BreakdownLevel,
  type CampaignDailyRow,
  type DailyRow,
  type GoogleCredentials,
  type VerifiedAccount,
} from './types'
import { CHUNK_DAYS, chunkRange } from './windows'

/**
 * Google Ads API v25 over REST.
 *
 * Access tokens are short-lived, so each call mints one from the stored OAuth
 * refresh token first. Reports come from GoogleAdsService.SearchStream: a GAQL
 * query against the `customer` resource segmented by date gives one row per
 * calendar day at account level for the daily sync, while a query against
 * `campaign`, `ad_group` or `ad_group_ad` — totalled over a range instead of
 * segmented by day — feeds the breakdown table below. `cost_micros` is
 * millionths of a whole unit of the account currency, so one minor unit
 * (cent/øre) is 10 000 micros.
 */

const API = 'https://googleads.googleapis.com/v25'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** REST protobuf JSON is camelCase; tolerate snake_case anyway. */
type GoogleResult = {
  segments?: { date?: string }
  metrics?: {
    costMicros?: string
    cost_micros?: string
    impressions?: string
    clicks?: string
    conversions?: number | string
    conversionsValue?: number | string
    conversions_value?: number | string
  }
  customer?: {
    descriptiveName?: string
    descriptive_name?: string
    currencyCode?: string
    currency_code?: string
  }
  campaignBudget?: { resourceName?: string; resource_name?: string; amountMicros?: string; amount_micros?: string }
  campaign_budget?: { resourceName?: string; resource_name?: string; amountMicros?: string; amount_micros?: string }
  campaign?: { id?: string; name?: string }
  adGroup?: { id?: string; name?: string }
  adGroupAd?: { ad?: { id?: string; name?: string } }
}
type Chunk = { results?: GoogleResult[] }

/** SearchStream answers with an ARRAY of chunks; tolerate a bare object too. */
export function parseGoogleChunks(body: unknown): GoogleResult[] {
  const chunks: Chunk[] = Array.isArray(body) ? body : body ? [body as Chunk] : []
  return chunks.flatMap((c) => c.results ?? [])
}

/** Micros -> minor units: 1 cent/øre = 10 000 micros. */
export function microsToMinor(micros: string | number | undefined): number {
  const n = typeof micros === 'string' ? parseInt(micros, 10) : (micros ?? 0)
  return Number.isFinite(n) ? Math.round(n / 10_000) : 0
}

export function toDailyRows(results: GoogleResult[]): DailyRow[] {
  const out: DailyRow[] = []
  for (const r of results) {
    if (!r.segments?.date) continue
    const clicks = parseInt(String(r.metrics?.clicks ?? '0'), 10) || 0
    const conversions = parseFloat(String(r.metrics?.conversions ?? '0')) || 0
    const value =
      parseFloat(String(r.metrics?.conversionsValue ?? r.metrics?.conversions_value ?? '0')) || 0
    out.push({
      date: utcDay(new Date(r.segments.date + 'T00:00:00Z')),
      spend: microsToMinor(r.metrics?.costMicros ?? r.metrics?.cost_micros),
      impressions: parseInt(String(r.metrics?.impressions ?? '0'), 10) || 0,
      clicks,
      // A search or shopping click IS a link click; Meta's distinction has no
      // Google twin, so the columns stay comparable.
      linkClicks: clicks,
      conversions,
      conversionValue: toMinor(value),
      videoViews3s: 0,
      thruplays: 0,
      reach: 0,
    })
  }
  return out
}

export async function googleAccessToken(creds: GoogleCredentials): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.access_token)
    throw new AdApiError(body.error_description ?? body.error ?? 'Google sign-in failed')
  return body.access_token
}

function errorMessage(body: unknown): string | undefined {
  const first = Array.isArray(body) ? body[0] : body
  return (first as { error?: { message?: string } } | null)?.error?.message
}

async function searchStream(
  creds: GoogleCredentials,
  customerId: string,
  query: string,
): Promise<GoogleResult[]> {
  const token = await googleAccessToken(creds)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': creds.developerToken,
    'Content-Type': 'application/json',
  }
  // Access granted through a manager (MCC) account must say which manager.
  if (creds.loginCustomerId) headers['login-customer-id'] = creds.loginCustomerId

  const res = await fetch(`${API}/customers/${customerId}/googleAds:searchStream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  })
  // A distinct sentinel, not `null`: a malformed or truncated body must never
  // read the same as "Google answered with a legitimate empty result", or a
  // parse failure silently becomes zero rows and the sync records success
  // with lastError: null. Chunked windowing (windows.ts) turns one request
  // into five per sync, so one bad chunk would otherwise discard up to 90
  // days of campaign spend and report a plausible-looking short year — the
  // same silent-truncation class the Meta page-cap guard exists to prevent.
  const PARSE_FAILED = Symbol('parse-failed')
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = PARSE_FAILED
  }
  if (!res.ok) {
    // Non-ok behaviour is unchanged: a body that failed to parse contributes
    // no error message, same as the old `catch(() => null)` did.
    throw new AdApiError(
      (body === PARSE_FAILED ? undefined : errorMessage(body)) ?? `Google answered ${res.status}`,
    )
  }
  if (body === PARSE_FAILED) {
    throw new AdApiError('Google returned a response that could not be parsed.')
  }
  return parseGoogleChunks(body)
}

const day = (d: Date) => utcDay(d).toISOString().slice(0, 10)

export async function fetchGoogleDaily(
  creds: GoogleCredentials,
  customerId: string,
  from: Date,
  to: Date,
): Promise<DailyRow[]> {
  const query =
    'SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, ' +
    'metrics.conversions, metrics.conversions_value ' +
    `FROM customer WHERE segments.date BETWEEN '${day(from)}' AND '${day(to)}'`
  return toDailyRows(await searchStream(creds, customerId, query))
}

/**
 * The current daily budget across ENABLED campaigns, minor units. A budget
 * shared by several campaigns counts once — that is what the money really is.
 */
export async function fetchGoogleDailyBudget(
  creds: GoogleCredentials,
  customerId: string,
): Promise<number> {
  const results = await searchStream(
    creds,
    customerId,
    'SELECT campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros ' +
      "FROM campaign WHERE campaign.status = 'ENABLED'",
  )
  const seen = new Set<string>()
  let total = 0
  for (const r of results) {
    const budget = r.campaignBudget ?? r.campaign_budget
    if (!budget) continue
    const name = budget.resourceName ?? budget.resource_name ?? ''
    if (name && seen.has(name)) continue
    if (name) seen.add(name)
    total += microsToMinor(budget.amountMicros ?? budget.amount_micros)
  }
  return total
}

/** Prove the credentials work and read the account's real name and currency. */
export async function verifyGoogle(
  creds: GoogleCredentials,
  customerId: string,
): Promise<VerifiedAccount> {
  const results = await searchStream(
    creds,
    customerId,
    'SELECT customer.descriptive_name, customer.currency_code FROM customer',
  )
  const c = results[0]?.customer
  const currency = c?.currencyCode ?? c?.currency_code
  if (!currency) throw new AdApiError('Google did not return the account currency')
  return {
    name: c?.descriptiveName ?? c?.descriptive_name ?? `Google Ads ${customerId}`,
    currency,
  }
}

/** Resource, id/name columns and parent column for each level. */
const BREAKDOWN_GAQL: Record<
  BreakdownLevel,
  { from: string; id: string; name: string; parent?: string }
> = {
  campaign: { from: 'campaign', id: 'campaign.id', name: 'campaign.name' },
  adset: { from: 'ad_group', id: 'ad_group.id', name: 'ad_group.name', parent: 'campaign.id' },
  ad: {
    from: 'ad_group_ad',
    id: 'ad_group_ad.ad.id',
    name: 'ad_group_ad.ad.name',
    parent: 'ad_group.id',
  },
}

/**
 * Pull the level's id/name out of whichever nested resource GAQL returned it
 * under. Null for a row with no id — a total row, the same reason Meta's own
 * breakdown parser skips one (meta.ts) — an id-less row has nothing to key on
 * and would collide with every other id-less row under the same account in
 * BreakdownTable's `accountId:id` React key.
 */
function mapBreakdownRow(level: BreakdownLevel, r: GoogleResult): BreakdownEntry | null {
  const entity =
    level === 'campaign' ? r.campaign : level === 'adset' ? r.adGroup : r.adGroupAd?.ad
  if (!entity?.id) return null
  const purchases = parseFloat(String(r.metrics?.conversions ?? '0')) || 0
  const purchaseValue =
    parseFloat(String(r.metrics?.conversionsValue ?? r.metrics?.conversions_value ?? '0')) || 0
  return {
    id: entity.id,
    // Most modern ad types (responsive search, Performance Max) leave the
    // ad's own name unset — it is an optional label, not every ad has one.
    // Falling back to the id, as Meta's breakdown does, beats a blank cell
    // sitting next to real numbers.
    name: entity.name || entity.id,
    spend: microsToMinor(r.metrics?.costMicros ?? r.metrics?.cost_micros),
    purchases,
    purchaseValue: toMinor(purchaseValue),
    impressions: parseInt(String(r.metrics?.impressions ?? '0'), 10) || 0,
    clicks: parseInt(String(r.metrics?.clicks ?? '0'), 10) || 0,
  }
}

/**
 * One row per campaign, ad group or ad, totalled over the range.
 *
 * `segments.date` appears in the WHERE and never in the SELECT: in the SELECT it
 * segments the result by day, which is a different table and a far larger one.
 */
export async function fetchGoogleBreakdown(
  creds: GoogleCredentials,
  target: { level: BreakdownLevel; customerId: string; parentId?: string },
  from: Date,
  to: Date,
): Promise<BreakdownEntry[]> {
  const shape = BREAKDOWN_GAQL[target.level]
  const where = [
    `segments.date BETWEEN '${day(from)}' AND '${day(to)}'`,
    ...(shape.parent && target.parentId ? [`${shape.parent} = ${target.parentId}`] : []),
  ].join(' AND ')

  const query =
    `SELECT ${shape.id}, ${shape.name}, metrics.cost_micros, metrics.conversions, ` +
    `metrics.conversions_value, metrics.impressions, metrics.clicks ` +
    `FROM ${shape.from} WHERE ${where}`

  const rows = await searchStream(creds, target.customerId, query)
  return rows
    .map((r) => mapBreakdownRow(target.level, r))
    .filter((entry): entry is BreakdownEntry => entry !== null)
}

/**
 * One row per campaign per day, for a split account.
 *
 * `fetchGoogleBreakdown` keeps segments.date out of its SELECT on purpose — in
 * the SELECT it segments by day, "which is a different table and a far larger
 * one". Here that segmentation is exactly what is wanted, so it goes in both,
 * and the range is fetched in windows to keep any one answer small.
 */
export async function fetchGoogleCampaignDaily(
  creds: GoogleCredentials,
  customerId: string,
  from: Date,
  to: Date,
): Promise<CampaignDailyRow[]> {
  const rows: CampaignDailyRow[] = []
  for (const window of chunkRange(from, to, CHUNK_DAYS)) {
    const query =
      'SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, ' +
      'metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value ' +
      `FROM campaign WHERE segments.date BETWEEN '${day(window.from)}' AND '${day(window.to)}'`
    rows.push(...toCampaignDailyRows(await searchStream(creds, customerId, query)))
  }
  return rows
}

/**
 * Reuses toDailyRows for the metrics so a campaign's numbers can never disagree
 * with the same campaign's numbers elsewhere. A row with no campaign id is
 * skipped for the reason mapBreakdownRow gives: it has nothing to key on.
 *
 * Not exported: its only consumer is fetchGoogleCampaignDaily above, and its
 * own behaviour (campaign-id extraction, dropping id-less rows) is already
 * proven through it in google.test.ts — a second, direct test would only
 * duplicate those assertions without covering anything fetchGoogleCampaignDaily
 * does not.
 */
function toCampaignDailyRows(results: GoogleResult[]): CampaignDailyRow[] {
  const out: CampaignDailyRow[] = []
  for (const r of results) {
    const id = r.campaign?.id
    if (!id) continue
    const [daily] = toDailyRows([r])
    if (!daily) continue
    out.push({ ...daily, campaignId: id, campaignName: r.campaign?.name || id })
  }
  return out
}
