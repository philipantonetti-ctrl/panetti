import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { gorgiasCredentials } from '@/lib/support/client'
import { backlogHealth, supportStats, type StatTicket } from '@/lib/support/stats'
import { rangeFromQuery } from '@/lib/api/range'
import { daysInRange } from '@/lib/dates'
import { previousRange } from '@/lib/metrics/trend'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

const FIELDS = {
  status: true, channel: true, language: true, tags: true, assigneeName: true,
  spam: true, createdAt: true, closedAt: true, firstResponseAt: true,
  satisfaction: true, customerEmail: true,
} as const

/**
 * The customer service figures.
 *
 * The one thing the helpdesk's own reporting cannot do is join a ticket to
 * what the customer actually bought - that is why the shop breakdown is
 * computed here, from the customer's own orders, rather than read from
 * Gorgias.
 *
 * Three windows go back, because one number on its own is not an answer.
 * `stats` is the period asked for, `previous` is the equally long period
 * immediately before it so every headline figure can say which way it moved,
 * and `backlog` ignores windows entirely: a ticket open since spring is the
 * most urgent thing on the page and the one a 90 day window hides.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const now = new Date()
    const { timezone } = await getSetting()

    // The same range logic the dashboard uses, from the same helper: a preset
    // or an explicit from/to, resolved against today in the WORKSPACE zone. Two
    // pages that both say "this month" must mean the same days.
    const { from: fromDay, to: toDay } = rangeFromQuery(params, now, timezone)
    const before = previousRange(fromDay, toDay)
    const days = daysInRange(fromDay, toDay)

    // A range names calendar DAYS as UTC midnights; a ticket has an instant. The
    // day has to be opened out to the real start and end of that day on the
    // workspace clock, or an Oslo evening falls into the wrong bucket.
    const dayOf = (d: Date) => d.toISOString().slice(0, 10)
    const start = zoneDayStartUtc(dayOf(fromDay), timezone)
    const end = zoneDayEndUtc(dayOf(toDay), timezone)
    const prevStart = zoneDayStartUtc(dayOf(before.from), timezone)
    const prevEnd = zoneDayEndUtc(dayOf(before.to), timezone)

    /**
     * One agent's slice of the page, or everyone's. 'none' is the unassigned
     * pile, the same sentinel the inbox filter already uses; a name can never
     * collide with it because Gorgias would have to employ someone called
     * "none". The filter narrows EVERY figure - the tiles, the previous
     * period, the backlog band - or the page would show one agent's volume
     * over the whole team's queue and the halves would disagree.
     */
    const agent = params.get('agent')
    const assignee = agent === null ? undefined : agent === 'none' ? null : agent

    const [tickets, earlier, stillOpen] = await Promise.all([
      db.supportTicket.findMany({
        where: { createdAt: { gte: start, lte: end }, assigneeName: assignee },
        select: FIELDS,
      }),
      db.supportTicket.findMany({
        where: { createdAt: { gte: prevStart, lte: prevEnd }, assigneeName: assignee },
        select: FIELDS,
      }),
      // Every open ticket at any age, narrowed to the agent when one is chosen.
      db.supportTicket.findMany({
        where: { closedAt: null, spam: false, assigneeName: assignee },
        select: { createdAt: true },
      }),
      // The dropdown's options: every agent the PERIOD saw, unfiltered on
      // purpose - a dropdown built from the filtered slice would shrink to
      // the one name chosen and leave no way back to the rest.
    ])
    const seen = await db.supportTicket.findMany({
      where: { createdAt: { gte: start, lte: end }, assigneeName: { not: null }, spam: false },
      select: { assigneeName: true },
      distinct: ['assigneeName'],
    })
    const agents = seen
      .map((t) => t.assigneeName!)
      .sort((a, b) => a.localeCompare(b))

    // Which shop each customer belongs to, from their own orders. One query for
    // every address on the page rather than one per ticket.
    //
    // Matched without regard to case, and keyed lowercase on both sides. The
    // two tables disagree: a ticket's address is lowercased as it is stored
    // (support/map.ts) precisely for this join, while an order keeps whatever
    // the customer typed at checkout (woo/map.ts trims but does not lower). An
    // exact match therefore drops every customer who capitalised their own
    // name, silently and without any sign that it happened.
    const emails = [...new Set(tickets.map((t) => t.customerEmail?.toLowerCase()).filter((e): e is string => !!e))]
    const orders = emails.length
      ? await db.order.findMany({
          where: { customerEmail: { in: emails, mode: 'insensitive' } },
          orderBy: { placedAt: 'desc' },
          select: { customerEmail: true, shop: { select: { name: true } } },
        })
      : []
    const shopOf = new Map<string, string>()
    for (const o of orders) {
      // Newest first, so the first one seen is their most recent shop.
      const key = o.customerEmail?.toLowerCase()
      if (key && !shopOf.has(key)) shopOf.set(key, o.shop.name)
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
      shop: t.customerEmail ? (shopOf.get(t.customerEmail.toLowerCase()) ?? null) : null,
    }))

    const [state, ai] = await Promise.all([
      db.supportSyncState.findFirst(),
      db.aiConversation.groupBy({ by: ['decision'], _count: true }),
    ])

    return NextResponse.json(
      {
        days,
        timezone,
        /**
         * Whether the helpdesk keys reach this running app at all.
         *
         * Without it an empty page has two very different causes that look
         * identical: nothing configured, or configured and the first import
         * has not run. Telling them apart took a round of messages with the
         * client, which is exactly what the page should have answered itself.
         */
        configured: gorgiasCredentials() !== null,
        /**
         * The window's first and last calendar day on the workspace clock. The
         * chart needs these to draw quiet days: a day with no tickets never
         * appears in `perDay`, and without the axis the browser would close the
         * gap and make a silent week look busy.
         */
        from: dayOf(fromDay),
        to: dayOf(toDay),
        previousFrom: dayOf(before.from),
        previousTo: dayOf(before.to),
        /** Everyone the period saw, for the agent dropdown. */
        agents,
        stats: supportStats(rows, timezone),
        /**
         * The period before, for the deltas. Computed without the shop join:
         * no comparison on the page needs it, and it would double the order
         * query for a figure nobody reads.
         */
        previous: supportStats(
          earlier.map((t) => ({ ...t, shop: null })),
          timezone,
        ),
        backlog: backlogHealth(stillOpen, now),
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
