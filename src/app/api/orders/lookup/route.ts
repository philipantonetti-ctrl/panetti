import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/** An order number means nothing without its shop; this turns the pair into an id. */
export async function GET(req: Request) {
  try {
    assertOperations(await currentUser())
    const params = new URL(req.url).searchParams
    const shopId = params.get('shop')?.trim() ?? ''
    const number = params.get('number')?.trim() ?? ''
    if (!shopId || !number) return NextResponse.json({ error: 'A shop and an order number' }, { status: 400, headers: NO_STORE })
    const order = await db.order.findFirst({ where: { shopId, number }, select: { id: true } })
    if (!order) return NextResponse.json({ error: `No order ${number} in that shop` }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ orderId: order.id }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not look that order up' }, { status: 500, headers: NO_STORE })
  }
}
