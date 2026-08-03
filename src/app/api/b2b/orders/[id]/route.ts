import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { buildOrderWrite, OrderBody, saveStandingPrices } from '../route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * What a hand-entered order may be set to. 'completed' earns; the other two
 * are in EXCLUDED_STATUSES, so the engine drops them with no special case. A
 * free-text status would quietly earn forever, because anything the engine
 * does not recognise counts.
 */
const STATUSES = ['completed', 'refunded', 'cancelled'] as const

const Body = OrderBody.extend({ status: z.enum(STATUSES).default('completed') })

type Ctx = { params: Promise<{ id: string }> }

/** Only orders this app owns. A synced order is not ours to rewrite. */
const ownB2bOrder = (id: string) =>
  db.order.findFirst({ where: { id, b2bCustomerId: { not: null } }, select: { id: true } })

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    if (!(await ownB2bOrder(id)))
      return NextResponse.json({ error: 'No such B2B order' }, { status: 404, headers: NO_STORE })

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid order' }, { status: 400, headers: NO_STORE })

    const w = await buildOrderWrite(parsed.data)

    // Lines are rewritten, not diffed — storeOrder()'s rule. `number` and
    // `externalId` are deliberately untouched: an edit is the same order.
    await db.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: id } })
      await tx.order.update({
        where: { id },
        data: {
          placedAt: w.placedAt,
          status: parsed.data.status,
          currency: w.customer.currency,
          grossSales: w.totals.grossSales,
          discountTotal: w.totals.discountTotal,
          netSales: w.totals.netSales,
          shippingCharged: w.totals.shippingCharged,
          taxTotal: w.totals.taxTotal,
          total: w.totals.total,
          customerName: w.customer.name,
          customerEmail: w.customer.email ?? '',
          b2bCustomerId: w.customer.id,
          fulfillmentCost: toMinor(parsed.data.fulfillmentCost),
          items: { create: w.items },
        },
      })
      await saveStandingPrices(tx, w.customer.id, w.pricesToSave)
    })

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof RangeError)
      return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the order' }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    if (!(await ownB2bOrder(id)))
      return NextResponse.json({ error: 'No such B2B order' }, { status: 404, headers: NO_STORE })

    await db.order.delete({ where: { id } }) // OrderItem cascades
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not delete the order' }, { status: 500, headers: NO_STORE })
  }
}
