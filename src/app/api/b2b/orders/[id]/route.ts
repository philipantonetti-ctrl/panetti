import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { VOIDED_STATUSES } from '@/lib/metrics/types'
import { VISMA_EXTERNAL_ID_PREFIX } from '@/lib/visma/b2b-sales'
import {
  buildOrderWrite,
  fulfillmentCostToStore,
  OrderBody,
  saveStandingPrices,
} from '../route'

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

/**
 * Only orders this app owns. A synced order is not ours to rewrite.
 *
 * `b2bCustomerId` alone stopped meaning that the moment `importVismaB2bSales`
 * shipped: an invoice imported from Visma carries one too, and it is exactly as
 * synced as a WooCommerce order. Visma is its source and the next
 * fifteen-minute run rewrites its money and its lines from the invoice, so an
 * edit accepted here would silently revert and a delete would come back on the
 * next upsert, taking any fulfillmentCost typed onto it in the meantime.
 */
const ownB2bOrder = (id: string) =>
  db.order.findFirst({
    where: {
      id,
      b2bCustomerId: { not: null },
      NOT: { externalId: { startsWith: VISMA_EXTERNAL_ID_PREFIX } },
    },
    select: { id: true, shopId: true, status: true, voidedAt: true },
  })

/**
 * One B2B order, in the shape the ORDER FORM speaks rather than the shape the
 * database holds. The list endpoint cannot serve this: it returns product
 * names for display, not the ids and discount breakdown needed to rebuild the
 * form, and widening it would cost every row of every page.
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const order = await db.order.findFirst({
      where: { id, b2bCustomerId: { not: null } },
      select: {
        id: true, number: true, status: true, placedAt: true, currency: true,
        shippingCharged: true, fulfillmentCost: true, b2bCustomerId: true,
        b2bCustomer: { select: { name: true } },
        items: {
          select: {
            productId: true, quantity: true, unitPrice: true,
            discountValue: true, discountKind: true,
          },
        },
      },
    })
    if (!order)
      return NextResponse.json({ error: 'No such B2B order' }, { status: 404, headers: NO_STORE })

    return NextResponse.json(
      {
        order: {
          id: order.id,
          number: order.number,
          status: order.status,
          // The form's date input speaks 'YYYY-MM-DD'; placedAt is UTC midnight.
          placedAt: order.placedAt.toISOString().slice(0, 10),
          customerId: order.b2bCustomerId!,
          customerName: order.b2bCustomer?.name ?? '',
          currency: order.currency,
          shippingCharged: order.shippingCharged,
          // null means "webshop order, use the shop's rate", which a B2B order
          // never is - but the column is nullable, so say 0 rather than null.
          // Null travels to the form as null, so re-opening an order nobody
          // costed shows an EMPTY box. Sent as 0 it would show a zero, and
          // saving would then store one - turning "nobody said" into "shipping
          // was free" by the act of looking at it.
          fulfillmentCost: order.fulfillmentCost,
          lines: order.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            // As stored: plain for PERCENT, minor units for AMOUNT.
            discountValue: i.discountValue ?? 0,
            discountKind: i.discountKind ?? 'PERCENT',
          })),
        },
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the order' }, { status: 500, headers: NO_STORE })
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const existing = await ownB2bOrder(id)
    if (!existing)
      return NextResponse.json({ error: 'No such B2B order' }, { status: 404, headers: NO_STORE })

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid order' }, { status: 400, headers: NO_STORE })

    const w = await buildOrderWrite(parsed.data)

    // An order's shop is fixed at creation, exactly like a B2B customer's own
    // shop: its history was reported under it. Refuse silently re-homing it -
    // the update below never writes shopId, so without this check the order
    // would keep its old shop while its customer and line items' products
    // belong to another.
    if (w.customer.shopId !== existing.shopId) {
      return NextResponse.json(
        { error: 'That customer belongs to a different shop. Delete this order and enter it under the right customer.' },
        { status: 400, headers: NO_STORE },
      )
    }

    // Same transition rule as the WooCommerce path: stamp when it becomes
    // voided, keep the stamp while it stays voided so an edit cannot move it,
    // and clear it when the order comes back to life.
    const wasVoided = VOIDED_STATUSES.includes(existing.status.toLowerCase() as never)
    const isVoided = VOIDED_STATUSES.includes(parsed.data.status as never)
    const voidedAt = isVoided ? (wasVoided ? existing.voidedAt : new Date()) : null

    // Lines are rewritten, not diffed - storeOrder()'s rule. `number` and
    // `externalId` are deliberately untouched: an edit is the same order.
    await db.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: id } })
      await tx.order.update({
        where: { id },
        data: {
          placedAt: w.placedAt,
          status: parsed.data.status,
          voidedAt,
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
          fulfillmentCost: fulfillmentCostToStore(parsed.data.fulfillmentCost),
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
