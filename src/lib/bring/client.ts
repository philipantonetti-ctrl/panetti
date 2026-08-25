/**
 * Bring's Tracking API, over HTTP.
 *
 * Deliberately the same shape as src/lib/woo/client.ts: a hard request ceiling,
 * a budget clamped to whatever is left of the caller's deadline, and error
 * bodies truncated so a gateway's HTML error page never reaches a log line.
 *
 * Parcels here are booked under the WAREHOUSE's Bring customer number, not the
 * client's. The credentials identify the caller; they do not scope which
 * parcels may be read. That is the assumption the Phase 0 probe exists to
 * confirm, and everything downstream depends on it.
 */

const BASE = 'https://api.bring.com/tracking/api/v2/tracking.json'

/** No poll gets longer than this for one request, deadline or not. */
const REQUEST_TIMEOUT_MS = 30_000

export type BringCredentials = {
  uid: string // Mybring account email
  key: string // Mybring API key
  clientUrl: string // sent as X-Bring-Client-URL, per Bring's terms
}

export type BringFilter = { deadline?: number; requestTimeoutMs?: number }

/**
 * What one request is allowed. The ceiling, or whatever is left of the run,
 * whichever is smaller. Never below 1ms: an expired budget still has to be a
 * valid timeout, and it is the caller's loop that stops, not this.
 */
export function requestBudgetMs(filter: BringFilter, now = Date.now()): number {
  const ceiling = filter.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const left = filter.deadline === undefined ? ceiling : filter.deadline - now
  return Math.max(1, Math.min(ceiling, left))
}

async function bringError(res: Response): Promise<Error> {
  const text = (await res.text()).slice(0, 300)
  return new Error(`Bring responded ${res.status}: ${text}`)
}

/**
 * Track several parcels in one request. Returns the raw consignment entries,
 * unparsed - mapping is map.ts's job, and keeping them apart is what lets the
 * mapper be tested against a recorded fixture with no network at all.
 *
 * A number Bring does not know simply does not come back. The caller decides
 * what that means; it is not an error.
 */
export async function fetchTracking(
  creds: BringCredentials,
  numbers: string[],
  opts: BringFilter = {},
): Promise<unknown[]> {
  if (numbers.length === 0) return []

  const params = new URLSearchParams()
  for (const n of numbers) params.append('q', n)

  const res = await fetch(`${BASE}?${params}`, {
    headers: {
      'X-Mybring-API-Uid': creds.uid,
      'X-Mybring-API-Key': creds.key,
      'X-Bring-Client-URL': creds.clientUrl,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(requestBudgetMs(opts)),
  })

  if (!res.ok) throw await bringError(res)

  const body = (await res.json()) as { consignmentSet?: unknown[] }
  return body.consignmentSet ?? []
}
