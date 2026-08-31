import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { agentPerformance } from '@/lib/support/agent-stats'
import { rangeFromQuery } from '@/lib/api/range'
import { daysInRange } from '@/lib/dates'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * The Agents page: one row per person, from the same tickets the dashboard
 * reads. The range logic is the analytics route's, helper for helper, so the
 * same preset on the two pages always means the same days.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const now = new Date()
    const { timezone } = await getSetting()

    const { from: fromDay, to: toDay } = rangeFromQuery(params, now, timezone)
    const dayOf = (d: Date) => d.toISOString().slice(0, 10)
    const start = zoneDayStartUtc(dayOf(fromDay), timezone)
    const end = zoneDayEndUtc(dayOf(toDay), timezone)

    const [tickets, stillOpen, people, syncState] = await Promise.all([
      db.supportTicket.findMany({
        where: { createdAt: { gte: start, lte: end } },
        select: {
          externalId: true,
          status: true, channel: true, language: true, tags: true, assigneeName: true,
          spam: true, createdAt: true, closedAt: true, firstResponseAt: true, satisfaction: true,
        },
      }),
      // Open at any age, per person - the backlog rule the dashboard's amber
      // band uses, cut by assignee.
      db.supportTicket.findMany({
        where: { closedAt: null, spam: false, assigneeName: { not: null } },
        select: { assigneeName: true },
      }),
      // The helpdesk's people, for two joins: the profile photo BYTES the
      // sync fetched (data URIs - Gorgias's picture bucket refuses the open
      // internet), and the ROLE, which is what tells a person from the
      // helpdesk's own answering machines.
      db.supportAgent.findMany({
        select: { name: true, avatarData: true, role: true },
      }),
      db.supportSyncState.findFirst({ select: { messageBackfilling: true } }),
    ])

    // The window tickets' mirrored messages, for the columns tickets alone
    // cannot carry. Scoped by ticket, not by date: a reply written after the
    // window still belongs to the window's ticket.
    const messages = await db.supportMessage.findMany({
      where: { ticketExternalId: { in: tickets.map((t) => t.externalId) } },
      select: {
        ticketExternalId: true, fromAgent: true, public: true, senderName: true, createdAt: true,
      },
    })

    const photoOf = new Map<string, string>()
    for (const p of people) {
      if (p.name && p.avatarData) photoOf.set(p.name, p.avatarData)
    }

    // Machines write messages too, and the hour this page shipped "Gorgias
    // Bot" took the fastest-first-reply crown at five minutes. This page
    // ranks PEOPLE: anything the helpdesk marks with a bot role stays off it.
    // The name test is a second net for bot accounts the user list has not
    // carried yet - a real person called Bot would be a remarkable hire.
    const machines = new Set(
      people
        .filter((p) => p.name && (p.role?.includes('bot') || /\bbot\b/i.test(p.name)))
        .map((p) => p.name!),
    )

    const unassigned = tickets.filter((t) => !t.spam && !t.assigneeName).length

    return NextResponse.json(
      {
        days: daysInRange(fromDay, toDay),
        from: dayOf(fromDay),
        to: dayOf(toDay),
        agents: agentPerformance(tickets, stillOpen, {
          messages,
          tickets: tickets
            .filter((t) => !t.spam)
            .map((t) => ({
              externalId: t.externalId,
              createdAt: t.createdAt,
              closedAt: t.closedAt,
              assigneeName: t.assigneeName,
            })),
        })
          .filter((a) => !machines.has(a.agent))
          .map((a) => ({
            ...a,
            avatarUrl: photoOf.get(a.agent) ?? null,
          })),
        /** True while the message mirror is still walking its year of history. */
        messagesBackfilling: syncState?.messageBackfilling ?? true,
        /**
         * Named, not silent: on this account most tickets carry no assignee,
         * and a page of four small rows would otherwise read as the whole
         * story when it is a fifth of it.
         */
        unassigned,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the agent figures' }, { status: 500, headers: NO_STORE })
  }
}
