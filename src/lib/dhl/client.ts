/**
 * DHL's Shipment Tracking - Unified API, over HTTP.
 *
 * Deliberately the same shape as src/lib/bring/client.ts: a hard request
 * ceiling, a budget clamped to whatever is left of the caller's deadline, and
 * error bodies truncated so a gateway's HTML error page never reaches a log
 * line.
 *
 * ONE PARCEL PER REQUEST, and that is not a choice. DHL's endpoint takes a
 * single `trackingNumber`; there is no batch form. Combined with the rate limit
 * below it is the fact that shapes the whole DHL side of the poller.
 *
 * Verified against the live API 2026-08-17 with the client's own key: a valid
 * key and an unknown number answers 404 "No shipment with given tracking number
 * found", and no key at all answers 401. The API Secret issued alongside the
 * key is NOT used by this product and is deliberately not stored anywhere.
 */

const BASE = 'https://api-eu.dhl.com/track/shipments'

/** No poll gets longer than this for one request, deadline or not. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * How long to wait between two DHL calls.
 *
 * DHL's free tier is 250 calls a day at a maximum of one every five seconds.
 * Six, not five: the limit is enforced on DHL's clock, not ours, and a run that
 * trips it gets a 429 that costs a parcel its turn. A second of margin is
 * cheaper than a retry.
 */
export const RATE_LIMIT_GAP_MS = 6_000

/** What the free tier allows in a day, with a little held back. */
export const DAILY_CALL_BUDGET = 240

export type DhlFilter = { deadline?: number; requestTimeoutMs?: number }

/**
 * What one request is allowed. The ceiling, or whatever is left of the run,
 * whichever is smaller. Never below 1ms: an expired budget still has to be a
 * valid timeout, and it is the caller's loop that stops, not this.
 */
export function requestBudgetMs(filter: DhlFilter, now = Date.now()): number {
  const ceiling = filter.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const left = filter.deadline === undefined ? ceiling : filter.deadline - now
  return Math.max(1, Math.min(ceiling, left))
}

async function dhlError(res: Response): Promise<Error> {
  const text = (await res.text()).slice(0, 300)
  return new Error(`DHL responded ${res.status}: ${text}`)
}

/**
 * Track one parcel. Returns the raw body, unparsed — mapping is map.ts's job,
 * and keeping them apart is what lets the mapper be tested against a recorded
 * response with no network at all.
 *
 * Null means DHL does not know this number. That is an ordinary answer for a
 * parcel the warehouse has booked but not yet handed over, so it is not an
 * error and the caller decides what it means. Every other non-2xx throws —
 * 429 especially, which must never be mistaken for "unknown": that would push a
 * rate-limited parcel into the slow tier and quietly lose a day of tracking.
 */
export async function fetchTracking(
  apiKey: string,
  trackingNumber: string,
  opts: DhlFilter = {},
): Promise<unknown | null> {
  const params = new URLSearchParams({ trackingNumber })

  const res = await fetch(`${BASE}?${params}`, {
    headers: {
      // Not Authorization, not x-api-key. DHL answers 401 to anything else.
      'DHL-API-Key': apiKey,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(requestBudgetMs(opts)),
  })

  if (res.status === 404) return null
  if (!res.ok) throw await dhlError(res)

  return res.json()
}
