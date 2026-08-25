import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { codeBookFor, storeOrder } from '@/lib/woo/sync'
import { verifyWooSignature } from '@/lib/woo/webhooks'
import type { WooOrder } from '@/lib/woo/map'

/**
 * Where the stores call in. The moment an order is placed, edited, refunded,
 * cancelled, trashed or restored, WooCommerce delivers it here - queued in the
 * store's background worker AFTER the shopper's request finished, so the
 * webshop never waits on us - and the dashboards are current seconds later.
 *
 * Every delivery must carry a valid HMAC signature made with this shop's own
 * secret (registered by `ensureWebhooks`, stored encrypted). The one unsigned
 * thing allowed in is Woo's activation ping, which is answered politely and
 * writes nothing.
 */
export async function POST(req: Request, { params }: { params: Promise<{ shopId: string }> }) {
  const { shopId } = await params
  const raw = await req.text()

  // The activation ping ("webhook_id=7", form-encoded, unsigned). Refusing it
  // would leave the webhook stuck in "pending" on the store.
  if (/^webhook_id=\d+$/.test(raw.trim())) {
    return NextResponse.json({ ok: true, ping: true })
  }

  const shop = await db.shop.findUnique({ where: { id: shopId } })
  if (!shop || !shop.active || !shop.wooWebhookSecret) {
    return NextResponse.json({ error: 'Unknown shop' }, { status: 404 })
  }

  let secret: string
  try {
    secret = decryptSecret(shop.wooWebhookSecret)
  } catch {
    // AUTH_SECRET rotated since the secret was stored; the next completed sync
    // mints a fresh one and re-registers. Until then, deliveries are refused.
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }
  if (!verifyWooSignature(raw, req.headers.get('x-wc-webhook-signature'), secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Unreadable payload' }, { status: 400 })
  }
  const body = payload as Partial<WooOrder>
  if (typeof body?.id !== 'number') {
    return NextResponse.json({ error: 'Unreadable payload' }, { status: 400 })
  }

  try {
    // Trashing sends just the id. The status lands and every figure lets the
    // order go; an order we never held needs nothing.
    if (req.headers.get('x-wc-webhook-topic') === 'order.deleted') {
      await db.order.updateMany({
        where: { shopId: shop.id, externalId: String(body.id) },
        data: { status: 'trash' },
      })
      return NextResponse.json({ ok: true })
    }

    // created / updated / restored carry the full order - the same shape the
    // sync pulls, stored down the same path, so both arrivals look identical.
    if (!Array.isArray(body.line_items)) {
      return NextResponse.json({ error: 'Unreadable payload' }, { status: 400 })
    }
    await storeOrder(shop.id, body as WooOrder, await codeBookFor(shop.id))
    return NextResponse.json({ ok: true })
  } catch {
    // A 5xx makes Woo retry the delivery; the scheduled sync catches it anyway.
    return NextResponse.json({ error: 'Could not store the change' }, { status: 500 })
  }
}
