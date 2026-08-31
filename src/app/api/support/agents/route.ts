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

    const [tickets, stillOpen] = await Promise.all([
      db.supportTicket.findMany({
        where: { createdAt: { gte: start, lte: end } },
        select: {
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
    ])

    const unassigned = tickets.filter((t) => !t.spam && !t.assigneeName).length

    return NextResponse.json(
      {
        days: daysInRange(fromDay, toDay),
        from: dayOf(fromDay),
        to: dayOf(toDay),
        agents: agentPerformance(tickets, stillOpen),
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
