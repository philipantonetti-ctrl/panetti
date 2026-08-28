import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { customerContext } from '@/lib/inbox/context'
import { formatMoney } from '@/lib/money'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * What Gorgias shows an agent about the person who just wrote in.
 *
 * Gorgias stays the inbox; this is our half of the arrangement. It calls this
 * URL with the customer's email when a ticket is opened and renders the JSON
 * as cards in the sidebar, so an agent never leaves Gorgias to find an order
 * number or a tracking link.
 *
 * Every figure comes from `customerContext()`, the same function our own
 * screens use, which reads the delivery verdict from the same `deliveryFor()`
 * the Delivery page prints. One implementation, so the agent and the owner can
 * never be told different things about the same parcel.
 *
 * Read-only. Nothing here writes, and nothing here reaches Gorgias.
 */

/**
 * NOT admin-only, deliberately: Gorgias is a machine and has no session. A
 * shared secret in a header is the whole of the authentication - the same
 * arrangement api/delivery/inbound and api/inbox/inbound already run on - so
 * it is compared in constant time and nothing is read before it passes.
 */
function authorised(req: Request): boolean {
  const expected = process.env.GORGIAS_WIDGET_SECRET
  if (!expected) return false
  const given = req.headers.get('X-Panetti-Secret') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // A length mismatch leaks only that one bit, exactly as the throw would.
  // This avoids timingSafeEqual turning a bad secret into a 500.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** "1 x Massasjepistol Pro X, 2 x Pizzastein", as a person would say it. */
const productLine = (products: { name: string; quantity: number }[]): string =>
  products.map((p) => `${p.quantity} x ${p.name}`).join(', ')

export async function GET(req: Request) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401, headers: NO_STORE })
  }

  const email = new URL(req.url).searchParams.get('email')?.trim()
  if (!email) {
    return NextResponse.json({ error: 'Which customer?' }, { status: 400, headers: NO_STORE })
  }

  try {
    // No ticket to exclude: our own inbox's conversations are all worth
    // counting here, since this reader is looking at a Gorgias one.
    const context = await customerContext(email, '')

    if (!context.customer) {
      // 200, not 404. Gorgias hides a widget whose response carries nothing,
      // and an error would read to the agent as a broken integration rather
      // than as a customer who has never ordered.
      return NextResponse.json({ found: false, customer: null, orders: [] }, { headers: NO_STORE })
    }

    return NextResponse.json(
      {
        found: true,
        customer: {
          name: context.customer.name,
          email: context.customer.email,
          phone: context.customer.phone,
          country: context.customer.country,
          /** How often they have written before, so an agent knows the history. */
          conversations: context.previousTickets.length,
        },
        orders: context.orders.map((o) => {
          // The newest parcel: the one an agent is asked about.
          const parcel = o.parcels[0] ?? null
          return {
            number: o.number,
            shop: o.shop,
            placedAt: o.placedAt.slice(0, 10),
            status: o.status,
            /** As the shop reports it. We know the order, never the bank. */
            refunded: o.refunded,
            // Formatted here, not in minor units: an agent should never have to
            // divide by a hundred while a customer waits.
            total: formatMoney(o.total, o.currency),
            products: productLine(o.products),
            tracking: parcel?.number ?? null,
            carrier: parcel?.carrier ?? null,
            trackingUrl: parcel?.url ?? null,
            /** Null where our own screens show a dash rather than a guess. */
            delivery: o.deliveryPhrase,
          }
        }),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: 'Could not read the customer' }, { status: 500, headers: NO_STORE })
  }
}
