import { utcDay } from '../dates'
import { AdApiError, type DailyRow, type GoogleCredentials, type VerifiedAccount } from './types'

/**
 * Google Ads API v25 over REST.
 *
 * Access tokens are short-lived, so each call mints one from the stored OAuth
 * refresh token first. Reports come from GoogleAdsService.SearchStream: a GAQL
 * query against the `customer` resource segmented by date gives one row per
 * calendar day at account level. `cost_micros` is millionths of a whole unit
 * of the account currency, so one minor unit (cent/øre) is 10 000 micros.
 */

const API = 'https://googleads.googleapis.com/v25'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** REST protobuf JSON is camelCase; tolerate snake_case anyway. */
type GoogleResult = {
  segments?: { date?: string }
  metrics?: { costMicros?: string; cost_micros?: string; impressions?: string; clicks?: string }
  customer?: {
    descriptiveName?: string
    descriptive_name?: string
    currencyCode?: string
    currency_code?: string
  }
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
    out.push({
      date: utcDay(new Date(r.segments.date + 'T00:00:00Z')),
      spend: microsToMinor(r.metrics?.costMicros ?? r.metrics?.cost_micros),
      impressions: parseInt(String(r.metrics?.impressions ?? '0'), 10) || 0,
      clicks: parseInt(String(r.metrics?.clicks ?? '0'), 10) || 0,
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
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new AdApiError(errorMessage(body) ?? `Google answered ${res.status}`)
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
    'SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks ' +
    `FROM customer WHERE segments.date BETWEEN '${day(from)}' AND '${day(to)}'`
  return toDailyRows(await searchStream(creds, customerId, query))
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
