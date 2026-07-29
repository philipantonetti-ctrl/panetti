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

type InsightRow = { date_start?: string; spend?: string; impressions?: string; clicks?: string }

export function parseMetaInsights(rows: InsightRow[]): DailyRow[] {
  const out: DailyRow[] = []
  for (const row of rows) {
    if (!row.date_start) continue
    out.push({
      date: utcDay(new Date(row.date_start + 'T00:00:00Z')),
      spend: toMinor(row.spend ?? '0'),
      impressions: parseInt(row.impressions ?? '0', 10) || 0,
      clicks: parseInt(row.clicks ?? '0', 10) || 0,
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
    fields: 'spend,impressions,clicks',
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
