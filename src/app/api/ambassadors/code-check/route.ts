import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertStaff, AuthError } from '@/lib/auth/guard'
import { rangeFromQuery } from '@/lib/api/range'
import { loadCodeOrders } from '@/lib/ambassadors/code-check'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Staff: every order that used one discount code in a period, each marked
 * counted or not with the reason, and the ambassador the code belongs to.
 *
 * Matches the code on the ORDER, not the ambassador link, so a code nobody
 * has been given in Panetti yet (a campaign code, say) still shows its orders
 * and says plainly that no ambassador gets them.
 */
export async function GET(req: Request) {
  try {
    assertStaff(await currentUser())
    const params = new URL(req.url).searchParams
    const code = (params.get('code') ?? '').trim().toUpperCase()
    if (!code) {
      return NextResponse.json({ error: 'Type a discount code' }, { status: 400, headers: NO_STORE })
    }

    const { timezone } = await getSetting()
    const range = rangeFromQuery(params, new Date(), timezone)

    const [orders, codes] = await Promise.all([
      // Codes are stored upper case on both sides, so equality is exact.
      loadCodeOrders({ couponCode: code }, range, timezone),
      db.ambassadorCode.findMany({
        where: { code },
        select: { ambassador: { select: { name: true } }, shop: { select: { name: true } } },
        orderBy: { shop: { name: 'asc' } },
      }),
    ])

    return NextResponse.json(
      {
        code,
        range: { from: range.from.toISOString(), to: range.to.toISOString() },
        linkedTo: codes.map((c) => ({ ambassador: c.ambassador.name, shop: c.shop.name })),
        used: orders.length,
        counted: orders.filter((o) => o.counts).length,
        orders,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not check that code' }, { status: 500, headers: NO_STORE })
  }
}
