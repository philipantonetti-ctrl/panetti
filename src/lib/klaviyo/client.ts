/**
 * Klaviyo's JSON:API, pinned to one revision.
 *
 * Everything here is read-only reporting: who the account is, which campaigns
 * exist, and what each one did. The reporting endpoint is the scarce one -
 * Klaviyo allows it 225 calls a DAY - so the sync calls it once per run and
 * the run is spaced hours apart; the cheap listing endpoints ride along.
 */

const BASE = 'https://a.klaviyo.com'

/**
 * Klaviyo versions by date and retires old ones; unpinned requests break the
 * day they do. Verified against the live docs on 2026-08-31.
 */
const REVISION = '2026-07-15'

/** A guard against a provider that pages forever. 20 x 100 campaigns is years. */
const MAX_PAGES = 20

/** Wording safe to store as lastError and show on the settings page. */
export class KlaviyoApiError extends Error {}

export type KlaviyoAccount = { accountId: string; currency: string }

export type KlaviyoCampaign = {
  id: string
  name: string
  channel: 'email' | 'sms'
  sentAt: Date | null
}

/** One campaign's results, money in integer minor units. */
export type KlaviyoCampaignValues = {
  campaignId: string
  recipients: number
  opens: number
  clicks: number
  conversions: number
  conversionValue: number
}

async function request(key: string, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(path.startsWith('https://') ? path : `${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        revision: REVISION,
        accept: 'application/vnd.api+json',
        ...(init.body ? { 'content-type': 'application/vnd.api+json' } : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch {
    throw new KlaviyoApiError('Could not reach Klaviyo. Check the connection and try again.')
  }
  if (res.status === 401 || res.status === 403) {
    // Covers a mistyped key, a revoked key and a key missing a scope alike -
    // one message a person can act on, and never the key itself.
    throw new KlaviyoApiError('Klaviyo rejected the key. Check it in Klaviyo and paste it again.')
  }
  if (res.status === 429) {
    throw new KlaviyoApiError('Klaviyo is rate limiting us. It refreshes on the next scheduled sync.')
  }
  if (!res.ok) {
    throw new KlaviyoApiError(`Klaviyo answered ${res.status}. Try again in a while.`)
  }
  try {
    return await res.json()
  } catch {
    throw new KlaviyoApiError('Klaviyo answered with something that was not JSON. Try again in a while.')
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Proves a pasted key against the live account and reads back who it is.
 * The currency matters: every campaign's revenue arrives in it, and showing
 * kroner under a dollar sign would be a wrong number wearing a right one.
 */
export async function verifyKey(key: string): Promise<KlaviyoAccount> {
  const body = (await request(key, '/api/accounts')) as {
    data?: { id?: unknown; attributes?: { preferred_currency?: unknown } }[]
  }
  const first = (body.data ?? [])[0]
  const accountId = str(first?.id)
  if (!accountId) {
    throw new KlaviyoApiError('The key works, but no Klaviyo account is attached to it.')
  }
  return { accountId, currency: str(first?.attributes?.preferred_currency) ?? 'USD' }
}

/**
 * Every campaign on the account, email and SMS both. Klaviyo requires the
 * channel filter, so the walk runs once per channel; mobile push is left out
 * because the client sends none and each channel costs requests.
 */
export async function fetchCampaigns(key: string): Promise<KlaviyoCampaign[]> {
  const campaigns: KlaviyoCampaign[] = []
  for (const channel of ['email', 'sms'] as const) {
    let url: string | null =
      `/api/campaigns?filter=${encodeURIComponent(`equals(messages.channel,'${channel}')`)}`
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const body = (await request(key, url)) as {
        data?: { id?: unknown; attributes?: { name?: unknown; send_time?: unknown } }[]
        links?: { next?: unknown }
      }
      for (const row of body.data ?? []) {
        const id = str(row.id)
        if (!id) continue
        const sent = str(row.attributes?.send_time)
        campaigns.push({
          id,
          name: str(row.attributes?.name) ?? id,
          channel,
          sentAt: sent ? new Date(sent) : null,
        })
      }
      url = str(body.links?.next)
    }
  }
  return campaigns
}

/**
 * The metric campaign revenue is attributed against. Klaviyo's reporting
 * endpoint demands one; the shop integrations all call it "Placed Order".
 * Null when the account has none - then campaigns carry opens and clicks but
 * no revenue, and the caller says so rather than inventing a metric.
 */
export async function findPlacedOrderMetricId(key: string): Promise<string | null> {
  let url: string | null = '/api/metrics'
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const body = (await request(key, url)) as {
      data?: { id?: unknown; attributes?: { name?: unknown } }[]
      links?: { next?: unknown }
    }
    for (const row of body.data ?? []) {
      if (str(row.attributes?.name) === 'Placed Order') return str(row.id)
    }
    url = str(body.links?.next)
  }
  return null
}

/**
 * One report request for every campaign's last twelve months - deliberately
 * ONE: this endpoint's budget is 225 calls a day, which is why the results
 * are mirrored into our own table instead of asked for per page view.
 */
export async function fetchCampaignValues(
  key: string,
  conversionMetricId: string | null,
): Promise<KlaviyoCampaignValues[]> {
  // Conversion statistics require the metric; asking for them without it is a
  // 400 in Klaviyo's own validation.
  const statistics = conversionMetricId
    ? ['recipients', 'opens', 'clicks', 'conversions', 'conversion_value']
    : ['recipients', 'opens', 'clicks']

  const body = (await request(key, '/api/campaign-values-reports', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'campaign-values-report',
        attributes: {
          timeframe: { key: 'last_12_months' },
          ...(conversionMetricId ? { conversion_metric_id: conversionMetricId } : {}),
          statistics,
        },
      },
    }),
  })) as {
    data?: {
      attributes?: {
        results?: { groupings?: { campaign_id?: unknown }; statistics?: Record<string, unknown> }[]
      }
    }
  }

  const rows: KlaviyoCampaignValues[] = []
  for (const r of body.data?.attributes?.results ?? []) {
    const campaignId = str(r.groupings?.campaign_id)
    if (!campaignId) continue
    const s = r.statistics ?? {}
    rows.push({
      campaignId,
      recipients: num(s.recipients),
      opens: num(s.opens),
      clicks: num(s.clicks),
      conversions: num(s.conversions),
      // Klaviyo reports major units of the account currency; stored money in
      // this codebase is integer minor units, so the boundary converts here.
      conversionValue: Math.round(num(s.conversion_value) * 100),
    })
  }
  return rows
}
