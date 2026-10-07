import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { fetchWebhooks } from '@/lib/woo/client'
import { appBaseUrl, webhookDeliveryUrl } from '@/lib/woo/webhooks'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Every webhook each store has, and whether it is switched on.
 *
 * Orders reach Visma through a connector that is not ours, and a store tells
 * that connector about new orders with a webhook. WooCommerce switches a
 * webhook off by itself after repeated failed deliveries, and from then on
 * orders silently stop arriving - the store, the warehouse and this app all
 * keep working, so nothing else shows it. Nobody here has the stores' admin
 * login, but this app's own API key can list webhooks, so this is the one
 * place the switch can be read without one.
 *
 * Read only. Fields are copied by name: Woo's webhook object carries the
 * signing `secret`, and a delivery URL can carry a token in its query string,
 * so neither may ever reach the browser.
 */
export async function GET(req?: Request) {
  try {
    assertAdmin(await currentUser())

    // One shop when the per-shop page asks; otherwise every connected one.
    const shopId = req ? new URL(req.url).searchParams.get('shopId') : null
    const shops = await db.shop.findMany({
      where: {
        ...(shopId ? { id: shopId } : {}),
        active: true,
        wooUrl: { not: null },
        wooKey: { not: null },
        wooSecret: { not: null },
      },
      select: { id: true, name: true, wooUrl: true, wooKey: true, wooSecret: true },
      orderBy: { name: 'asc' },
    })
    const base = appBaseUrl()

    const result = await Promise.all(
      shops.map(async (shop) => {
        try {
          const hooks = await fetchWebhooks({
            url: shop.wooUrl!,
            key: decryptSecret(shop.wooKey!),
            secret: decryptSecret(shop.wooSecret!),
          })
          const ourUrl = base ? webhookDeliveryUrl(base, shop.id) : null
          return {
            shop: shop.name,
            ok: true,
            webhooks: hooks.map((w) => ({
              id: w.id,
              name: w.name ?? '',
              topic: w.topic,
              status: w.status,
              delivery: withoutQuery(w.delivery_url),
              ours: w.delivery_url === ourUrl,
              created: w.date_created_gmt ?? null,
              modified: w.date_modified_gmt ?? null,
            })),
          }
        } catch (e) {
          return {
            shop: shop.name,
            ok: false,
            error: e instanceof Error ? e.message : 'Could not read webhooks',
            webhooks: [],
          }
        }
      }),
    )

    return NextResponse.json({ shops: result }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not read webhooks' }, { status: 500, headers: NO_STORE })
  }
}

/** Host and path only: a query string can carry the receiver's access token. */
function withoutQuery(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return '(unreadable address)'
  }
}
