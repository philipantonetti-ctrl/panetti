import type { GorgiasTicket, GorgiasUser } from './map'

/**
 * Talking to Gorgias.
 *
 * Measured against the live account on 2026-08-28: Basic auth with the account
 * email and an API key, cursor pagination, and a rate limit of 40 requests per
 * 20 seconds reported back in `x-gorgias-account-api-call-limit`.
 *
 * The list endpoint takes NO date filter - only a cursor and an ordering - so
 * "everything since yesterday" is expressed as "newest first, stop when we
 * reach what we already have". That is why the sync carries a watermark
 * rather than a query.
 */

export type GorgiasCredentials = { domain: string; email: string; apiKey: string }

/** Unset means not connected, which is a state and not an error. */
export function gorgiasCredentials(): GorgiasCredentials | null {
  const domain = process.env.GORGIAS_DOMAIN?.trim()
  const email = process.env.GORGIAS_EMAIL?.trim()
  const apiKey = process.env.GORGIAS_API_KEY?.trim()
  if (!domain || !email || !apiKey) return null
  return { domain, email, apiKey }
}

/**
 * One request in twenty is the documented ceiling of 40 per 20 seconds. Half
 * of it is taken deliberately: this runs beside the WooCommerce, Visma and
 * Bring stages in one cron, and a burst that earns a 429 would cost the whole
 * import rather than one page.
 */
export const PAGE_PAUSE_MS = 1_000

const REQUEST_TIMEOUT_MS = 20_000

export class GorgiasError extends Error {}

/** Never longer than the run has left. Floors at 1ms so the caller's deadline decides. */
function budgetMs(deadline?: number): number {
  if (deadline === undefined) return REQUEST_TIMEOUT_MS
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
}

async function get<T>(
  creds: GorgiasCredentials,
  path: string,
  params: Record<string, string>,
  deadline?: number,
): Promise<{ data: T[]; nextCursor: string | null }> {
  const url = new URL(`https://${creds.domain}.gorgias.com/api/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64')
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(budgetMs(deadline)),
  })

  if (res.status === 429) {
    // Named, so a caller can stop the whole import cleanly rather than
    // hammering a door that has just been shut.
    throw new GorgiasError(`Gorgias rate limit reached; retry after ${res.headers.get('retry-after') ?? '?'}s`)
  }
  if (!res.ok) {
    throw new GorgiasError(`Gorgias responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }

  const body = (await res.json()) as { data?: T[]; meta?: { next_cursor?: string | null } }
  return { data: body.data ?? [], nextCursor: body.meta?.next_cursor ?? null }
}

/** One page of tickets. `order` decides which end of history it reads from. */
export function fetchTickets(
  creds: GorgiasCredentials,
  opts: { order: 'created_datetime:asc' | 'updated_datetime:desc'; cursor?: string | null; limit?: number },
  deadline?: number,
) {
  return get<GorgiasTicket>(
    creds,
    'tickets',
    {
      limit: String(opts.limit ?? 100),
      order_by: opts.order,
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    },
    deadline,
  )
}

export function fetchUsers(creds: GorgiasCredentials, cursor?: string | null, deadline?: number) {
  return get<GorgiasUser>(creds, 'users', { limit: '100', ...(cursor ? { cursor } : {}) }, deadline)
}

export type GorgiasSurvey = { ticket_id: number; score: number | null; scored_datetime: string | null }

export function fetchSurveys(creds: GorgiasCredentials, cursor?: string | null, deadline?: number) {
  return get<GorgiasSurvey>(creds, 'satisfaction-surveys', { limit: '100', ...(cursor ? { cursor } : {}) }, deadline)
}
