import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { fetchOrderNotes, fetchOrderRaw } from '@/lib/woo/client'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const CUT = 200

const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '').slice(0, CUT)

/**
 * What the Visma connector wrote back onto one webshop order.
 *
 * The connector (Maco) is meant to write the shipment number and the
 * "shipping" status back to the order once Visma ships it. Whether it did
 * lives in the order's hidden fields and notes, which no page here shows.
 * Read only. Only the status, the hidden fields and the notes are returned,
 * values cut to 200 characters; the buyer's address and contact never are.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const shopId = params.get('shopId')?.trim() ?? ''
    const number = params.get('number')?.trim() ?? ''
    if (!shopId || !/^\d+$/.test(number))
      return NextResponse.json({ error: 'Send shopId and a numeric order number' }, { status: 400, headers: NO_STORE })

    const shop = await db.shop.findUnique({
      where: { id: shopId },
      select: { id: true, name: true, wooUrl: true, wooKey: true, wooSecret: true },
    })
    if (!shop?.wooUrl || !shop.wooKey || !shop.wooSecret)
      return NextResponse.json({ error: 'No such connected shop' }, { status: 404, headers: NO_STORE })

    const order = await db.order.findFirst({
      where: { shopId: shop.id, number },
      select: { externalId: true, number: true },
    })
    if (!order)
      return NextResponse.json({ error: `${shop.name} has no order ${number}` }, { status: 404, headers: NO_STORE })

    const creds = { url: shop.wooUrl, key: decryptSecret(shop.wooKey), secret: decryptSecret(shop.wooSecret) }
    const raw = await fetchOrderRaw(creds, order.externalId)
    const notes = await fetchOrderNotes(creds, order.externalId)

    const meta = Array.isArray(raw.meta_data) ? (raw.meta_data as { key?: unknown; value?: unknown }[]) : []
    return NextResponse.json(
      {
        shop: shop.name,
        number: order.number,
        status: text(raw.status),
        modified: text(raw.date_modified_gmt),
        meta: meta.map((m) => ({ key: text(m.key), value: text(m.value) })),
        notes: notes.map((n) => ({
          date: text(n.date_created_gmt),
          author: text(n.author),
          toCustomer: n.customer_note === true,
          note: text(n.note),
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not read the order' },
      { status: 500, headers: NO_STORE },
    )
  }
}
