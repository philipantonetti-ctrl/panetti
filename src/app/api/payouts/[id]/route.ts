import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/** One payout opened up: every order the money came from, matched or not. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const payout = await db.payout.findUnique({
      where: { id },
      include: {
        shop: { select: { name: true } },
        lines: {
          orderBy: [{ transactionDate: 'asc' }, { reference: 'asc' }],
          include: {
            order: { select: { number: true, placedAt: true, status: true, total: true } },
          },
        },
      },
    })
    if (!payout) return NextResponse.json({ error: 'That payout does not exist' }, { status: 404, headers: NO_STORE })

    return NextResponse.json(
      {
        id: payout.id,
        shopId: payout.shopId,
        shopName: payout.shop.name,
        provider: payout.provider,
        settledAt: payout.settledAt?.toISOString() ?? null,
        periodStart: payout.periodStart?.toISOString() ?? null,
        periodEnd: payout.periodEnd?.toISOString() ?? null,
        currency: payout.currency,
        amount: payout.amount,
        capture: payout.capture,
        refund: payout.refund,
        fee: payout.fee,
        reference: payout.reference,
        linesPending: payout.linesPending,
        lines: payout.lines.map((l) => ({
          id: l.id,
          reference: l.reference,
          reference2: l.reference2,
          amount: l.amount,
          capture: l.capture,
          refund: l.refund,
          fee: l.fee,
          transactionDate: l.transactionDate?.toISOString() ?? null,
          paymentType: l.paymentType,
          cardBrand: l.cardBrand,
          order: l.order
            ? {
                number: l.order.number,
                placedAt: l.order.placedAt.toISOString(),
                status: l.order.status,
                total: l.order.total,
              }
            : null,
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the payout' }, { status: 500, headers: NO_STORE })
  }
}
