import type { StatTicket } from './stats'

/**
 * One agent's period, computed from tickets we hold - the same rows the
 * dashboard reads, cut by assignee.
 *
 * Deliberately ONLY figures the tickets can honestly carry: closed counts,
 * response and resolution medians, satisfaction, and the open pile. Gorgias's
 * own Agents page also shows online time and per-message counts; we do not
 * hold that data, and a column that guesses would be a wrong number wearing
 * a right one.
 */
export type AgentRow = {
  agent: string
  /** Non-spam tickets assigned to them that ARRIVED in the window. */
  tickets: number
  /** Of those, closed. */
  closed: number
  /** Their share of EVERY closed ticket in the window, unassigned included. */
  closedShare: number | null
  medianResolutionHours: number | null
  resolutionSample: number
  medianFirstResponseHours: number | null
  firstResponseSample: number
  /** Average score, 1 to 5, over answered surveys only. */
  csat: number | null
  csatSample: number
  /** Their open tickets RIGHT NOW, at any age - the backlog rule, per person. */
  openNow: number
}

const HOUR = 3_600_000

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * @param windowRows Every ticket that arrived in the period, all assignees,
 *   spam included (it is filtered here so the rule lives in one place).
 * @param openAtAnyAge Every open non-spam ticket right now regardless of age,
 *   reduced to its assignee - the per-person version of the backlog band.
 */
export function agentPerformance(
  windowRows: StatTicket[],
  openAtAnyAge: { assigneeName: string | null }[],
): AgentRow[] {
  const rows = windowRows.filter((t) => !t.spam)
  const allClosed = rows.filter((t) => t.closedAt !== null).length

  const openBy = new Map<string, number>()
  for (const t of openAtAnyAge) {
    if (!t.assigneeName) continue
    openBy.set(t.assigneeName, (openBy.get(t.assigneeName) ?? 0) + 1)
  }

  const byAgent = new Map<string, StatTicket[]>()
  for (const t of rows) {
    if (!t.assigneeName) continue
    const list = byAgent.get(t.assigneeName) ?? []
    list.push(t)
    byAgent.set(t.assigneeName, list)
  }
  // An agent holding old open tickets but nothing new still earns a row:
  // their pile is exactly what a manager opens this page to find.
  for (const agent of openBy.keys()) {
    if (!byAgent.has(agent)) byAgent.set(agent, [])
  }

  const out: AgentRow[] = []
  for (const [agent, tickets] of byAgent) {
    const closed = tickets.filter((t) => t.closedAt !== null)
    const resolution = closed
      .map((t) => (t.closedAt!.getTime() - t.createdAt.getTime()) / HOUR)
      .filter((h) => h >= 0)
    const responded = tickets.filter((t) => t.firstResponseAt !== null)
    const response = responded
      .map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / HOUR)
      .filter((h) => h >= 0)
    const scored = tickets.filter((t) => t.satisfaction !== null)

    out.push({
      agent,
      tickets: tickets.length,
      closed: closed.length,
      closedShare: allClosed > 0 ? closed.length / allClosed : null,
      medianResolutionHours: median(resolution),
      resolutionSample: resolution.length,
      medianFirstResponseHours: median(response),
      firstResponseSample: response.length,
      csat: scored.length ? scored.reduce((n, t) => n + t.satisfaction!, 0) / scored.length : null,
      csatSample: scored.length,
      openNow: openBy.get(agent) ?? 0,
    })
  }

  // Biggest closer first, then alphabetical so ties do not reshuffle.
  return out.sort((a, b) => b.closed - a.closed || a.agent.localeCompare(b.agent))
}
