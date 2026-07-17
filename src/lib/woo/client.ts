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
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      orderby: 'date',
      order: 'asc',
    })
    if (filter.modifiedAfter) params.set('modified_after', filter.modifiedAfter.toISOString().slice(0, 19))
    if (filter.createdAfter) params.set('after', filter.createdAfter.toISOString().slice(0, 19))

    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
    })

    if (!res.ok) {
      throw new Error(`WooCommerce responded ${res.status}: ${await res.text()}`)
    }

    const batch = (await res.json()) as WooOrder[]
    all.push(...batch)
    if (batch.length < 100) return { orders: all, hasMore: false } // last page
  }

  // Every page we were allowed to fetch came back full — more is behind it.
  return { orders: all, hasMore: true }
}
