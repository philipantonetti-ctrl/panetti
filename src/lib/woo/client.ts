import { readableErrorBody } from '../error-body'
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
  /**
   * Ask for these order statuses BY NAME. Empty or absent falls back to
   * WooCommerce's default, which is not the "everything" it reads as — see
   * `fetchOrderStatuses`.
   */
  statuses?: string[]
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
 * A readable error from a Woo response.
 *
 * A broken WordPress answers with a whole HTML error page, and that belongs in
 * nobody's toast, log line or error report — least of all the owner's, which
 * is where this string ends up by way of Shop.lastError and the Advisor.
 *
 * This used to truncate to 300 characters to that end. For that exact page the
 * first 300 characters are the doctype, three metas and the opening of
 * <title>, so the cut kept the boilerplate and threw away the sentence.
 * readableErrorBody extracts instead.
 */
async function wooError(res: Response): Promise<Error> {
  const said = readableErrorBody(await res.text())
  // Status alone when the page had no words in it at all: a trailing colon
  // with nothing after it reads as a truncation bug of its own.
  return new Error(`WooCommerce responded ${res.status}${said ? `: ${said}` : ''}`)
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
    // Named outright, because the default does not mean what it looks like.
    if (filter.statuses?.length) params.set('status', filter.statuses.join(','))

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
 * Every order status this store actually uses, its own inventions included.
 *
 * Asked because WooCommerce's default is a trap. Send no `status` and the REST
 * controller applies `any`, which becomes WordPress's `post_status => 'any'` —
 * and that is NOT everything: it silently omits any status registered with
 * `exclude_from_search`, which is how fulfilment plugins commonly register the
 * extra statuses they add. A store running orders through its own "shipping"
 * step therefore answers a perfectly ordinary window with those orders absent,
 * no error, no clue. Such an order can only ever arrive by webhook, and if that
 * one delivery is lost it is lost for good: every later pull is blind to it.
 *
 * This endpoint reports a row per status the store knows, custom ones included,
 * and those names ARE accepted by the `status` parameter. Naming them is the
 * only way to ask for everything and mean it.
 *
 * Best-effort: an empty list means "could not tell", and the caller falls back
 * to the default rather than narrowing the query to nothing.
 */
export async function fetchOrderStatuses(
  creds: WooCredentials,
  filter: { deadline?: number } = {},
): Promise<string[]> {
  // No budget left means no pull is going to happen either; spending a request
  // to describe a store we are not about to read takes it from the next store.
  if (filter.deadline !== undefined && Date.now() >= filter.deadline) return []

  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')
  try {
    const res = await fetch(
      `${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/reports/orders/totals`,
      {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(requestBudgetMs(filter)),
      },
    )
    if (!res.ok) return []
    const rows = (await res.json()) as { slug?: string }[]
    if (!Array.isArray(rows)) return []
    return rows.map((r) => r.slug).filter((s): s is string => typeof s === 'string' && s.length > 0)
  } catch {
    return [] // unreachable or unreadable: fall back, never narrow to nothing
  }
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

export type CatalogEntry = {
  /** The store's own listed price, minor units, incl VAT. Null if unpriced. */
  price: number | null
  /**
   * Units on hand, or null when the store does not manage stock for this item.
   * Null is not zero: zero is sold out and belongs at the top of the forecast,
   * "we do not know" does not.
   */
  stock: number | null
}

/**
 * Each product's listed price AND its stock, keyed by WooCommerce product id.
 *
 * One sweep, two facts. Both already live on the same `/products` response, so
 * asking twice would double the request count of every completed sync to learn
 * nothing new.
 */
export async function fetchCatalog(creds: WooCredentials): Promise<Map<string, CatalogEntry>> {
  const catalog = new Map<string, CatalogEntry>()
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ per_page: '100', page: String(page) })
    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/products?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw await wooError(res)

    const batch = (await res.json()) as {
      id: number
      price?: string
      manage_stock?: boolean
      stock_quantity?: number | null
    }[]
    for (const p of batch) {
      const value = p.price ? parseFloat(p.price) : NaN
      catalog.set(String(p.id), {
        price: Number.isNaN(value) ? null : toMinor(value),
        stock: p.manage_stock === true && typeof p.stock_quantity === 'number' ? p.stock_quantity : null,
      })
    }
    if (batch.length < 100) break
  }

  return catalog
}
