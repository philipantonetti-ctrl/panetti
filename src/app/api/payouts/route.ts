import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { rangeFromQuery } from '@/lib/api/range'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * Payouts arrive weekly, so a captured order should be inside one within a
 * week; a day of slack on top keeps the fresh weekend out of the list.
 */
const WAITING_AFTER_DAYS = 8

/** Statuses where the money was captured - what a payout should contain. */
const CAPTURED_STATUSES = ['completed', 'processing', 'shipping']

/**
 * The payouts list: one row per settlement Dintero paid out, with how many
 * of its orders we hold. The range logic is the analytics routes', helper
 * for helper, so the same preset always means the same days everywhere.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from: fromDay, to: toDay } = rangeFromQuery(params, new Date(), timezone)
    const dayOf = (d: Date) => d.toISOString().slice(0, 10)
    const start = zoneDayStartUtc(dayOf(fromDay), timezone)
    const end = zoneDayEndUtc(dayOf(toDay), timezone)
    const shopId = params.get('shop')

    const payouts = await db.payout.findMany({
      where: {
        ...(shopId ? { shopId } : {}),
        // A settlement announced but not yet paid has no settled date. It is
        // the most actionable row on the page, so it shows in every range
        // rather than hiding in the week nobody has selected yet.
        OR: [{ settledAt: { gte: start, lte: end } }, { settledAt: null }],
      },
      orderBy: [{ settledAt: { sort: 'desc', nulls: 'first' } }],
      include: { shop: { select: { name: true } } },
    })

    const lineCounts = await db.payoutLine.groupBy({
      by: ['payoutId'],
      where: { payoutId: { in: payouts.map((p) => p.id) } },
      _count: true,
    })
    const matchedCounts = await db.payoutLine.groupBy({
      by: ['payoutId'],
      where: { payoutId: { in: payouts.map((p) => p.id) }, orderId: { not: null } },
      _count: true,
    })
    const linesOf = new Map(lineCounts.map((c) => [c.payoutId, c._count]))
    const matchedOf = new Map(matchedCounts.map((c) => [c.payoutId, c._count]))

    // The reverse check: money we captured that no payout contains. Only
    // orders that went through Dintero (they carry its transaction id or
    // session reference - a B2B invoice or another gateway's order is not
    // this page's business), old enough that a weekly payout has had time.
    const connectedShopIds = (
      await db.dinteroConfig.findMany({ where: { active: true }, select: { shopId: true } })
    ).map((c) => c.shopId)
    const waitingWhere = {
      shopId: shopId ? shopId : { in: connectedShopIds },
      placedAt: { lte: new Date(Date.now() - WAITING_AFTER_DAYS * 24 * 60 * 60 * 1000) },
      status: { in: CAPTURED_STATUSES },
      voidedAt: null,
      payoutLines: { none: {} },
      OR: [
        { AND: [{ transactionId: { not: null } }, { transactionId: { not: '' } }] },
        { AND: [{ dinteroReference: { not: null } }, { dinteroReference: { not: '' } }] },
      ],
    }
    const waiting = await db.order.findMany({
      where: waitingWhere,
      orderBy: { placedAt: 'desc' },
      take: 200,
      select: {
        id: true, shopId: true, number: true, placedAt: true, status: true, total: true, currency: true,
        shop: { select: { name: true } },
      },
    })
    const waitingCount = await db.order.count({ where: waitingWhere })

    return NextResponse.json(
      {
        from: dayOf(fromDay),
        to: dayOf(toDay),
        connected: (await db.dinteroConfig.count({ where: { active: true } })) > 0,
        payouts: payouts.map((p) => ({
          id: p.id,
          shopId: p.shopId,
          shopName: p.shop.name,
          provider: p.provider,
          settledAt: p.settledAt?.toISOString() ?? null,
          periodStart: p.periodStart?.toISOString() ?? null,
          periodEnd: p.periodEnd?.toISOString() ?? null,
          currency: p.currency,
          amount: p.amount,
          capture: p.capture,
          refund: p.refund,
          fee: p.fee,
          reference: p.reference,
          linesPending: p.linesPending,
          orders: linesOf.get(p.id) ?? 0,
          matched: matchedOf.get(p.id) ?? 0,
        })),
        waiting: waiting.map((o) => ({
          id: o.id,
          shopId: o.shopId,
          number: o.number,
          shopName: o.shop.name,
          placedAt: o.placedAt.toISOString(),
          status: o.status,
          total: o.total,
          currency: o.currency,
        })),
        waitingCount,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the payouts' }, { status: 500, headers: NO_STORE })
  }
}
