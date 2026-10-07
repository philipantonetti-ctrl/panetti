import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { enableWebhook, fetchWebhooks } from '@/lib/woo/client'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const Body = z.object({ shopId: z.string().min(1), webhookId: z.number().int().positive() })

/**
 * Switch one of a store's webhooks back on.
 *
 * On 2 Oct 2026 Panetti.no orders stopped reaching Visma; the store's three
 * webhooks to the Visma connector (Maco) had been switched off, which
 * WooCommerce does by itself after repeated failed deliveries. Nobody here has
 * the store's admin login, but this app's key can flip the same switch.
 *
 * Only the status is written (`enableWebhook`), never the webhook's secret or
 * address, which belong to whoever receives it. The webhook is read before and
 * after, so the answer says what the store actually reports, not what was
 * asked for.
 */
export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success)
      return NextResponse.json({ error: 'Send shopId and a numeric webhookId' }, { status: 400, headers: NO_STORE })
    const { shopId, webhookId } = parsed.data

    const shop = await db.shop.findUnique({
      where: { id: shopId },
      select: { id: true, name: true, wooUrl: true, wooKey: true, wooSecret: true },
    })
    if (!shop?.wooUrl || !shop.wooKey || !shop.wooSecret)
      return NextResponse.json({ error: 'No such connected shop' }, { status: 404, headers: NO_STORE })

    const creds = { url: shop.wooUrl, key: decryptSecret(shop.wooKey), secret: decryptSecret(shop.wooSecret) }
    const before = (await fetchWebhooks(creds)).find((w) => w.id === webhookId)
    if (!before)
      return NextResponse.json({ error: 'The store has no webhook with that id' }, { status: 404, headers: NO_STORE })

    await enableWebhook(creds, webhookId)
    const after = (await fetchWebhooks(creds)).find((w) => w.id === webhookId)

    return NextResponse.json(
      {
        shop: shop.name,
        webhook: { id: before.id, name: before.name ?? '', topic: before.topic },
        before: before.status,
        after: after?.status ?? 'unknown',
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not switch the webhook on' },
      { status: 500, headers: NO_STORE },
    )
  }
}
