import { toMinor } from '../money'

/**
 * Addrevenue's v2 API, as MEASURED on 2026-08-24 — the public docs are thin
 * and partly wrong (they promise `http_code`/`count` at the top level; the
 * real envelope is `{ results, meta }`). One life-time token per brand
 * account; these are advertiser accounts, so /channels and /payouts answer
 * 403 and are not used.
 */

const BASE = 'https://addrevenue.io/api/v2'

/** Provider wording that can be shown on the settings page as-is. */
export class AffiliateApiError extends Error {}

export type AffiliateMarket = { market: string; url: string }

export type AffiliateAdvertiser = {
  externalId: string
  name: string
  markets: AffiliateMarket[]
}

/** One transaction, parsed: money in integer minor units of `currency`. */
export type AffiliateTxRow = {
  externalId: string // their numeric id, stringified — platform ids are Strings here
  date: Date // UTC midnight of the platform-reported sale day
  market: string
  channelId: string
  channelName: string
  status: string
  denyDate: Date | null
  commission: number
  brokerageFee: number
  orderValue: number
  currency: string
  eventOrderId: string | null
}

type Envelope = { results?: unknown[]; meta?: { hasNextPage?: boolean } }

async function get(token: string, path: string): Promise<Envelope> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
  } catch {
    throw new AffiliateApiError('Could not reach Addrevenue. Check the connection and try again.')
  }
  if (res.status === 403) {
    // Their 403 covers a missing header, an unknown token and an inactive
    // account alike — one message a person can act on.
    throw new AffiliateApiError('Addrevenue rejected the token. Check it in Addrevenue and paste it again.')
  }
  if (!res.ok) {
    throw new AffiliateApiError(`Addrevenue answered ${res.status}. Try again in a while.`)
  }
  return (await res.json()) as Envelope
}

/** "2026-01-02" (their plain sale day) -> UTC midnight. */
function utcDayOf(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`)
}

/**
 * The account's advertiser: id, display name, and each market's webshop URL —
 * the key the sync matches against Shop.wooUrl.
 */
export async function fetchAdvertiser(token: string): Promise<AffiliateAdvertiser> {
  const body = await get(token, '/advertisers')
  const first = (body.results ?? [])[0] as
    | { id: number; displayName?: string; name?: string; markets?: Record<string, { market: string; url: string }> }
    | undefined
  if (!first) {
    throw new AffiliateApiError('The token works, but no advertiser account is attached to it.')
  }
  return {
    externalId: String(first.id),
    name: first.displayName ?? first.name ?? String(first.id),
    markets: Object.values(first.markets ?? {}).map((m) => ({ market: m.market, url: m.url })),
  }
}

type RawTx = {
  id: number
  date: string
  channelId: number
  channelName?: string
  market?: string
  currency: string
  eventValue?: string | number | null
  commission?: string | number | null
  brokerageFee?: string | number | null
  status?: string
  denyDate?: string | null
  eventOrderId?: string | null
}

/**
 * Every transaction in the window, all pages. The whole history is ~2,200
 * rows against a 5,000-per-page cap, so today this is one request per brand —
 * the loop is for the day it is not.
 */
export async function fetchTransactions(
  token: string,
  window: { fromDate: string; toDate: string },
): Promise<AffiliateTxRow[]> {
  const rows: AffiliateTxRow[] = []
  let offset = 0
  for (;;) {
    const path =
      `/transactions?fromDate=${window.fromDate}&toDate=${window.toDate}` +
      (offset > 0 ? `&offset=${offset}` : '')
    const body = await get(token, path)
    const page = (body.results ?? []) as RawTx[]
    for (const r of page) {
      rows.push({
        externalId: String(r.id),
        date: utcDayOf(r.date),
        market: r.market ?? '',
        channelId: String(r.channelId),
        channelName: r.channelName ?? '',
        status: r.status ?? '',
        denyDate: r.denyDate ? utcDayOf(r.denyDate) : null,
        commission: toMinor(r.commission ?? 0),
        brokerageFee: toMinor(r.brokerageFee ?? 0),
        orderValue: toMinor(r.eventValue ?? 0),
        currency: r.currency,
        eventOrderId: r.eventOrderId ?? null,
      })
    }
    if (!body.meta?.hasNextPage || page.length === 0) return rows
    offset += page.length
  }
}
