import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { supportStats, type StatTicket } from '@/lib/support/stats'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/** A window nobody chose. Long enough to show a trend, short enough to stay quick. */
const DEFAULT_DAYS = 90

/**
 * The customer service figures.
 *
 * The one thing the helpdesk's own reporting cannot do is join a ticket to
 * what the customer actually bought - that is why the shop breakdown is
 * computed here, from the customer's own orders, rather than read from
 * Gorgias.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const days = Math.min(Math.max(Number(params.get('days')) || DEFAULT_DAYS, 1), 730)
    const from = new Date(Date.now() - days * 86_400_000)

    const tickets = await db.supportTicket.findMany({
      where: { createdAt: { gte: from } },
      select: {
        status: true, channel: true, language: true, tags: true, assigneeName: true,
        spam: true, createdAt: true, closedAt: true, firstResponseAt: true,
        satisfaction: true, customerEmail: true,
      },
    })

    // Which shop each customer belongs to, from their own orders. One query for
    // every address on the page rather than one per ticket.
    const emails = [...new Set(tickets.map((t) => t.customerEmail).filter((e): e is string => !!e))]
    const orders = emails.length
      ? await db.order.findMany({
          where: { customerEmail: { in: emails } },
          orderBy: { placedAt: 'desc' },
          select: { customerEmail: true, shop: { select: { name: true } } },
        })
      : []
    const shopOf = new Map<string, string>()
    for (const o of orders) {
      // Newest first, so the first one seen is their most recent shop.
      if (o.customerEmail && !shopOf.has(o.customerEmail)) shopOf.set(o.customerEmail, o.shop.name)
    }

    const rows: StatTicket[] = tickets.map((t) => ({
      status: t.status,
      channel: t.channel,
      language: t.language,
      tags: t.tags,
      assigneeName: t.assigneeName,
      spam: t.spam,
      createdAt: t.createdAt,
      closedAt: t.closedAt,
      firstResponseAt: t.firstResponseAt,
      satisfaction: t.satisfaction,
      shop: t.customerEmail ? (shopOf.get(t.customerEmail) ?? null) : null,
    }))

    const [state, ai] = await Promise.all([
      db.supportSyncState.findFirst(),
      db.aiConversation.groupBy({ by: ['decision'], _count: true }),
    ])

    return NextResponse.json(
      {
        days,
        stats: supportStats(rows),
        /** How many tickets could be tied to a customer we know. */
        matchedToCustomer: rows.filter((r) => r.shop !== null).length,
        ai: Object.fromEntries(ai.map((a) => [a.decision, a._count])),
        sync: state
          ? {
              ranAt: state.ranAt?.toISOString() ?? null,
              // True while five years of history is still walking backwards, so
              // the page can say the older figures are still filling in.
              backfilling: state.backfilling,
              oldestSeenAt: state.oldestSeenAt?.toISOString() ?? null,
              lastError: state.lastError,
            }
          : null,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the support figures' }, { status: 500, headers: NO_STORE })
  }
}
