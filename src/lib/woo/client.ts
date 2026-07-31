import { toMinor } from '../money'
import type { WooOrder } from './map'

export type WooCredentials = {
  url: string // https://shop.example.com
  key: string
  secret: string
}

export type FetchFilter = {
  /** Incremental syncs: only orders changed since the last completed sync. */
  modifiedAfter?: Date | null
  /** First-sync chunks: only orders placed after the newest one already stored. */
  createdAfter?: Date | null
  /** Stop after this many pages; `hasMore` tells the caller history is behind it. */
  maxPages?: number
  /**
   * Epoch ms, as from `Date.now()`. Start no further page once it passes. One
   * store must not be able to spend a whole run's budget.
   */
  deadline?: number
  /** Ceiling for a single request; clamped down to what is left of the deadline. */
  requestTimeoutMs?: number
}

export type FetchResult = {
  orders: WooOrder[]
  hasMore: boolean
  /**
   * Incremental pulls only: the last `date_modified_gmt` seen, which is where a
   * truncated pull can safely resume from. Undefined when nothing came back.
   */
  resumeFrom?: string
  /**
   * False when the store did not return orders in modified order, or sent one
   * without the stamp — in either case `resumeFrom` is NOT safe to resume from,
   * because orders we never saw may sit behind it. Always true for a first-sync
   * chunk, which is sorted by created date and makes no such claim.
   */
  sortedByModified: boolean
}

/** No store gets longer than this for one request, deadline or not. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * What one request is allowed. The ceiling, or whatever is left of the run,
 * whichever is smaller — a 30-second request begun with 10 seconds left would
 * overrun the deadline the caller is relying on. Never below 1ms: an expired
 * budget still has to be a valid timeout, and the page loop is what stops.
 */
export function requestBudgetMs(filter: FetchFilter, now = Date.now()): number {
  const ceiling = filter.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const left = filter.deadline === undefined ? ceiling : filter.deadline - now
  return Math.max(1, Math.min(ceiling, left))
}

/**
 * A readable error from a Woo response. The body is truncated hard: a broken
 * WordPress answers with a whole HTML error page, and that belongs in nobody's
 * toast, log line or error report.
 */
async function wooError(res: Response): Promise<Error> {
  const text = (await res.text()).slice(0, 300)
  return new Error(`WooCommerce responded ${res.status}: ${text}`)
}

/**
 * True for the error AbortSignal.timeout produces when it fires. Node/undici
 * raise it directly; some wrappers surface it one level down as `cause`.
 */
function isTimeoutAbort(err: unknown): boolean {
  const named = (e: unknown, name: string) => e instanceof Error && e.name === name
  return (
    named(err, 'TimeoutError') ||
    named(err, 'AbortError') ||
    (err instanceof Error && (named(err.cause, 'TimeoutError') || named(err.cause, 'AbortError')))
  )
}

/**
 * Fetch orders one page at a time, oldest first. WooCommerce caps `per_page` at 100.
 *
 * Stops on a short page (the end), at `maxPages`, or once the caller's deadline
 * passes — the last two both report `hasMore: true`, and for an incremental
 * pull `resumeFrom` says exactly how far we got, so the caller can carry on next
 * run instead of starting the same window again.
 */
export async function fetchOrders(creds: WooCredentials, filter: FetchFilter): Promise<FetchResult> {
  const all: WooOrder[] = []
  const maxPages = filter.maxPages ?? 50
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  // Only an incremental pull is sorted by modified date, so only it can claim a
  // resume point. A first-sync chunk makes no such claim.
  const incremental = Boolean(filter.modifiedAfter)
  let resumeFrom: string | undefined
  let sortedByModified = true

  for (let page = 1; page <= maxPages; page++) {
    // Checked before the request, not after: starting a page we have no time to
    // finish wastes the budget of every store still waiting behind this one.
    if (filter.deadline !== undefined && Date.now() >= filter.deadline) {
      return { orders: all, hasMore: true, resumeFrom, sortedByModified }
    }

    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      orderby: incremental ? 'modified' : 'date',
      order: 'asc',
    })
    // Woo compares date filters against the STORE's local time unless told
    // otherwise. Ours are UTC, so without this a store at UTC+2 hands back a
    // two-hour-wider window every single pull.
    if (filter.modifiedAfter) {
      params.set('dates_are_gmt', 'true')
      params.set('modified_after', filter.modifiedAfter.toISOString().slice(0, 19))
    }
    if (filter.createdAfter) params.set('after', filter.createdAfter.toISOString().slice(0, 19))

    let res: Response
    try {
      res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(requestBudgetMs(filter)),
      })
    } catch (err) {
      // A timeout is a stopping condition, not a failure: the pages already
      // fetched are real, and the caller can resume from here next run.
      // requestBudgetMs deliberately hands the LAST request whatever is left of
      // the deadline — sometimes a couple hundred ms — so this is the clamp's
      // NORMAL outcome, not a rare edge case. Anything else (DNS, connection
      // refused, a real network failure) still throws, so the store still
      // reports a genuine failure.
      if (isTimeoutAbort(err)) {
        return { orders: all, hasMore: true, resumeFrom, sortedByModified }
      }
      throw err
    }

    if (!res.ok) throw await wooError(res)

    const batch = (await res.json()) as WooOrder[]
    all.push(...batch)

    // Verify the ordering we asked for actually happened. Advancing a watermark
    // to the last row of an unsorted result would skip every order the store
    // did not happen to return.
    if (incremental) {
      for (const o of batch) {
        const stamp = o.date_modified_gmt
        if (!stamp) {
          sortedByModified = false
          continue
        }
        // Fixed-width GMT strings, so lexical order is chronological order.
        if (resumeFrom !== undefined && stamp < resumeFrom) sortedByModified = false
        resumeFrom = stamp
      }
    }

    if (batch.length < 100) return { orders: all, hasMore: false, resumeFrom, sortedByModified } // last page
  }

  // Every page we were allowed to fetch came back full — more is behind it.
  return { orders: all, hasMore: true, resumeFrom, sortedByModified }
}

/**
 * Fetch specific orders by their WooCommerce ids. Used by the customer
 * backfill, which knows exactly which stored orders still miss their customer.
 * Ids Woo no longer has simply don't come back — the caller decides what that
 * means.
 */
export async function fetchOrdersByIds(creds: WooCredentials, ids: string[]): Promise<WooOrder[]> {
  const all: WooOrder[] = []
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let i = 0; i < ids.length; i += 100) {
    const params = new URLSearchParams({
      include: ids.slice(i, i + 100).join(','),
      per_page: '100',
    })
    // A store that never answers must cost this run, not every store behind
    // it — every request from here down carries this same budget, the way
    // fetchOrders already does for the sync's main page loop.
    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw await wooError(res)
    all.push(...((await res.json()) as WooOrder[]))
  }

  return all
}

export type WooWebhook = {
  id: number
  topic: string
  delivery_url: string
  status: string // "active" | "paused" | "disabled"
}

/** Every webhook the store has, whatever its status. */
export async function fetchWebhooks(creds: WooCredentials): Promise<WooWebhook[]> {
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')
  const res = await fetch(
    `${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/webhooks?per_page=100&status=all`,
    { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  )
  if (!res.ok) throw await wooError(res)
  return (await res.json()) as WooWebhook[]
}

/** Register one webhook: this topic, delivered there, signed with that secret. */
export async function createWebhook(
  creds: WooCredentials,
  webhook: { name: string; topic: string; deliveryUrl: string; secret: string },
): Promise<void> {
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')
  const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/webhooks`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      name: webhook.name,
      topic: webhook.topic,
      delivery_url: webhook.deliveryUrl,
      secret: webhook.secret,
      status: 'active',
    }),
  })
  if (!res.ok) throw await wooError(res)
}

/** Wake a paused/disabled webhook back up and make sure it signs with our secret. */
export async function activateWebhook(
  creds: WooCredentials,
  id: number,
  secret: string,
): Promise<void> {
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')
  const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/webhooks/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ status: 'active', secret }),
  })
  if (!res.ok) throw await wooError(res)
}

/**
 * Every discount code defined in the store, uppercased and deduped. Read only,
 * using the same credentials as orders. Used to populate the code picker so an
 * admin picks a real coupon instead of retyping it.
 */
export async function fetchCoupons(creds: WooCredentials): Promise<string[]> {
  const codes = new Set<string>()
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ per_page: '100', page: String(page) })
    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/coupons?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
    })
    if (!res.ok) throw await wooError(res)

    const batch = (await res.json()) as { code?: string }[]
    for (const c of batch) if (c.code) codes.add(c.code.toUpperCase())
    if (batch.length < 100) break
  }

  return [...codes]
}

/**
 * The store's own listed price per product (incl. VAT in our stores), keyed by
 * the WooCommerce product id. Products without a price are skipped.
 */
export async function fetchCatalogPrices(creds: WooCredentials): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ per_page: '100', page: String(page) })
    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/products?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw await wooError(res)

    const batch = (await res.json()) as { id: number; price?: string }[]
    for (const p of batch) {
      const value = p.price ? parseFloat(p.price) : NaN
      if (!Number.isNaN(value)) prices.set(String(p.id), toMinor(value))
    }
    if (batch.length < 100) break
  }

  return prices
}
