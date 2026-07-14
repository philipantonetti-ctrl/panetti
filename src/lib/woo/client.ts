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
    if (batch.length < 100) break // last page
  }

  return all
}
