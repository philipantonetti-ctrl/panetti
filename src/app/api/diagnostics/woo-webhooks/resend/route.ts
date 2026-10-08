import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { stampOrder } from '@/lib/woo/client'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const Body = z.object({ shopId: z.string().min(1), orderNumber: z.string().regex(/^\d+$/) })

/** The hidden field whose only job is to make the store save the order. */
export const RESEND_META_KEY = '_panetti_resent_to_webhooks'

/**
 * Send one order to the store's webhooks again.
 *
 * WooCommerce has no "deliver again" button. What it does have: every save
 * of an order fires `order.updated`, and the Visma connector (Maco) receives
 * that at the same address as a new order. So an order the connector missed
 * while its webhooks were off is written back with one hidden field, and the
 * store announces it again.
 *
 * One order per call, named by number, never a range: the person pressing
 * this has checked that the order is NOT in Visma yet, and a second copy in
 * Visma is the one outcome worse than a missing one.
 */
export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success)
      return NextResponse.json({ error: 'Send shopId and an orderNumber' }, { status: 400, headers: NO_STORE })
    const { shopId, orderNumber } = parsed.data

    const shop = await db.shop.findUnique({
      where: { id: shopId },
      select: { id: true, name: true, wooUrl: true, wooKey: true, wooSecret: true },
    })
    if (!shop?.wooUrl || !shop.wooKey || !shop.wooSecret)
      return NextResponse.json({ error: 'No such connected shop' }, { status: 404, headers: NO_STORE })

    // The store is addressed by its own id, which the sync stored as externalId.
    const order = await db.order.findFirst({
      where: { shopId: shop.id, number: orderNumber },
      select: { externalId: true, number: true, status: true },
    })
    if (!order)
      return NextResponse.json({ error: `${shop.name} has no order ${orderNumber}` }, { status: 404, headers: NO_STORE })

    const answer = await stampOrder(
      { url: shop.wooUrl, key: decryptSecret(shop.wooKey), secret: decryptSecret(shop.wooSecret) },
      order.externalId,
      { key: RESEND_META_KEY, value: new Date().toISOString() },
    )

    return NextResponse.json(
      { shop: shop.name, orderNumber: order.number, wooId: order.externalId, status: answer.status, modified: answer.modified },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not send the order again' },
      { status: 500, headers: NO_STORE },
    )
  }
}
