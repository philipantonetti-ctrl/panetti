import type { WooOrder } from './map'

export type WooCredentials = {
  url: string // https://shop.example.com
  key: string
  secret: string
}

/**
 * Fetch orders changed since `since`, one page at a time.
 * WooCommerce caps `per_page` at 100.
 */
export async function fetchOrders(creds: WooCredentials, since: Date | null): Promise<WooOrder[]> {
  const all: WooOrder[] = []
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      orderby: 'date',
      order: 'asc',
    })
    if (since) params.set('modified_after', since.toISOString().slice(0, 19))

    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
    })

    if (!res.ok) {
      throw new Error(`WooCommerce responded ${res.status}: ${await res.text()}`)
    }

    const batch = (await res.json()) as WooOrder[]
    all.push(...batch)
    if (batch.length < 100) return all // last page

    if (page === 50) {
      // 50 full pages and more behind them. Stopping here quietly would move
      // the sync watermark past orders we never fetched — refuse instead.
      throw new Error(
        'This store returned over 5,000 orders in one pull. Sync stopped so nothing ' +
          'is skipped silently — this store needs a staged first sync.',
      )
    }
  }

  return all
}
