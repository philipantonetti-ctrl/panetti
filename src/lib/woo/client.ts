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
}

export type FetchResult = { orders: WooOrder[]; hasMore: boolean }

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
 * Fetch orders one page at a time, oldest first. WooCommerce caps `per_page` at 100.
 *
 * Stops early on a short page (the end), or at `maxPages` with `hasMore: true` so
 * the caller decides what a partial pull means — a first sync resumes from where
 * it stopped; an incremental sync treats it as an error rather than skip orders.
 */
export async function fetchOrders(creds: WooCredentials, filter: FetchFilter): Promise<FetchResult> {
  const all: WooOrder[] = []
  const maxPages = filter.maxPages ?? 50
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let page = 1; page <= maxPages; page++) {
    // An incremental pull is filtered on modified date, so it must be SORTED on
    // modified date too: that is the only ordering in which a truncated result
    // has a safe place to resume from. A first sync walks history forwards by
    // creation date and resumes on that instead.
    const incremental = Boolean(filter.modifiedAfter)
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

    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
    })

    if (!res.ok) throw await wooError(res)

    const batch = (await res.json()) as WooOrder[]
    all.push(...batch)
    if (batch.length < 100) return { orders: all, hasMore: false } // last page
  }

  // Every page we were allowed to fetch came back full — more is behind it.
  return { orders: all, hasMore: true }
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
    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
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
    { headers: { Authorization: `Basic ${auth}` } },
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
