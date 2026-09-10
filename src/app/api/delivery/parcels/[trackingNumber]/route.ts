import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * A person attaches a parcel to an order, or declares it is not a customer
 * parcel at all. The machine refuses whenever two orders could be right; this
 * is the person choosing. Operations and admin both may: it is their queue.
 */
const Body = z.union([
  z.object({ orderId: z.string().trim().min(1) }),
  z.object({ dismiss: z.literal(true) }),
])

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: NO_STORE })

export async function PATCH(req: Request, { params }: { params: Promise<{ trackingNumber: string }> }) {
  try {
    const user = await currentUser()
    assertOperations(user)
    const { trackingNumber } = await params

    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return bad('Send an order to link to, or dismiss: true')

    const parcel = await db.shipment.findUnique({
      where: { trackingNumber },
      select: { id: true, orderId: true },
    })
    if (!parcel) return bad('We hold no parcel with that number', 404)
    if (parcel.orderId) return bad('This parcel is already linked to an order')

    if ('dismiss' in parsed.data) {
      await db.shipment.update({
        where: { id: parcel.id },
        data: {
          terminal: true,
          nextPollAt: null,
          dismissedAt: new Date(),
          unlinkedReason: `Not a customer parcel (dismissed by ${user.email})`,
        },
      })
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }

    const order = await db.order.findUnique({
      where: { id: parsed.data.orderId },
      select: { id: true, shop: { select: { deliveryTrackingFrom: true } } },
    })
    if (!order) return bad('That order does not exist')
    if (!order.shop.deliveryTrackingFrom) return bad('That order belongs to a shop that is not delivery-tracked')

    await db.shipment.update({
      where: { id: parcel.id },
      data: {
        orderId: order.id,
        linkSource: 'MANUAL',
        unlinkedReason: null,
        dismissedAt: null,
        terminal: false,
        // Due now, so the next poll reads the parcel as the order's.
        nextPollAt: new Date(),
      },
    })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return bad(e.message, 403)
    console.error(e)
    return bad('Could not update this parcel', 500)
  }
}
