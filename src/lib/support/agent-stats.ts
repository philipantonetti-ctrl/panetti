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

  /**
   * The message-mirror figures - the columns the Gorgias Agents page carries
   * that tickets alone cannot. All scoped to the window's tickets, so the
   * whole row tells one story. Zero until the message mirror has walked far
   * enough back; the page says so rather than showing confident zeroes.
   */
  /** Public messages they wrote on the window's tickets. Notes excluded. */
  messagesSent: number
  /** Distinct window tickets they wrote at least one public message on. */
  ticketsReplied: number
  /** Incoming public messages on the window's tickets ASSIGNED to them. */
  messagesReceived: number
  /** Median customer-message-to-their-reply gap. */
  medianResponseHours: number | null
  responseSample: number
  /**
   * Of the closed tickets they replied to, the share solved with a single
   * agent message in total - anyone's. Null until they have such a ticket.
   */
  oneTouchShare: number | null
  oneTouchSample: number
}

/** One mirrored message, as the route reads it back. */
export type MessageRow = {
  ticketExternalId: string
  fromAgent: boolean
  public: boolean
  senderName: string | null
  createdAt: Date
}

/** The window tickets' identities, for joining messages back on. */
export type TicketMeta = {
  externalId: string
  createdAt: Date
  closedAt: Date | null
  assigneeName: string | null
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
  /** The window tickets' mirrored messages, and the tickets' identities. */
  mirror: { messages: MessageRow[]; tickets: TicketMeta[] } = { messages: [], tickets: [] },
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

  // The message side, worked out once and joined on per agent below.
  const ticketOf = new Map(mirror.tickets.map((t) => [t.externalId, t]))
  const publicMsgs = mirror.messages
    .filter((m) => m.public && ticketOf.has(m.ticketExternalId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  /** Agent public messages per ticket, in time order. */
  const agentMsgsByTicket = new Map<string, MessageRow[]>()
  /** Incoming public messages per ticket, in time order. */
  const inboundByTicket = new Map<string, MessageRow[]>()
  for (const m of publicMsgs) {
    const bucket = m.fromAgent ? agentMsgsByTicket : inboundByTicket
    const list = bucket.get(m.ticketExternalId) ?? []
    list.push(m)
    bucket.set(m.ticketExternalId, list)
  }
  // A writer also earns a row: someone can answer tickets all week that are
  // assigned to somebody else, and vanishing for it would misread the team.
  for (const m of publicMsgs) {
    if (m.fromAgent && m.senderName && !byAgent.has(m.senderName)) byAgent.set(m.senderName, [])
  }

  const out: AgentRow[] = []
  for (const [agent, tickets] of byAgent) {
    const closed = tickets.filter((t) => t.closedAt !== null)
    const resolution = closed
      .map((t) => (t.closedAt!.getTime() - t.createdAt.getTime()) / HOUR)
      .filter((h) => h >= 0)
    const scored = tickets.filter((t) => t.satisfaction !== null)

    // Their writing, across the whole window population - not only the
    // tickets assigned to them, because answering someone else's ticket is
    // still work done.
    const sent = publicMsgs.filter((m) => m.fromAgent && m.senderName === agent)
    const repliedTickets = [...new Set(sent.map((m) => m.ticketExternalId))]

    // First reply: over tickets where THIS agent wrote the first agent
    // message, hours from the ticket's arrival. Falls back to the ticket's
    // own firstResponseAt when the mirror holds nothing for them - old
    // periods the message walk has not reached yet.
    const firstReplies: number[] = []
    for (const ticketId of repliedTickets) {
      const first = agentMsgsByTicket.get(ticketId)?.[0]
      if (!first || first.senderName !== agent) continue
      const meta = ticketOf.get(ticketId)
      if (!meta) continue
      const h = (first.createdAt.getTime() - meta.createdAt.getTime()) / HOUR
      if (h >= 0) firstReplies.push(h)
    }
    const ticketFallback = tickets
      .filter((t) => t.firstResponseAt !== null)
      .map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / HOUR)
      .filter((h) => h >= 0)
    const firstReply = firstReplies.length ? firstReplies : ticketFallback

    // Response time: every gap from a customer's message to THIS agent's
    // next reply on that ticket.
    const gaps: number[] = []
    for (const ticketId of repliedTickets) {
      const inbound = inboundByTicket.get(ticketId) ?? []
      for (const reply of (agentMsgsByTicket.get(ticketId) ?? []).filter((m) => m.senderName === agent)) {
        const lastInbound = [...inbound].reverse().find((m) => m.createdAt < reply.createdAt)
        if (!lastInbound) continue
        const h = (reply.createdAt.getTime() - lastInbound.createdAt.getTime()) / HOUR
        if (h >= 0) gaps.push(h)
      }
    }

    // One touch: of the closed tickets they replied to, solved with a single
    // agent message in total.
    const repliedClosed = repliedTickets.filter((id) => ticketOf.get(id)?.closedAt)
    const oneTouch = repliedClosed.filter((id) => (agentMsgsByTicket.get(id) ?? []).length === 1)

    const received = tickets.length
      ? publicMsgs.filter(
          (m) => !m.fromAgent && ticketOf.get(m.ticketExternalId)?.assigneeName === agent,
        ).length
      : 0

    out.push({
      agent,
      tickets: tickets.length,
      closed: closed.length,
      closedShare: allClosed > 0 ? closed.length / allClosed : null,
      medianResolutionHours: median(resolution),
      resolutionSample: resolution.length,
      medianFirstResponseHours: median(firstReply),
      firstResponseSample: firstReply.length,
      csat: scored.length ? scored.reduce((n, t) => n + t.satisfaction!, 0) / scored.length : null,
      csatSample: scored.length,
      openNow: openBy.get(agent) ?? 0,
      messagesSent: sent.length,
      ticketsReplied: repliedTickets.length,
      messagesReceived: received,
      medianResponseHours: median(gaps),
      responseSample: gaps.length,
      oneTouchShare: repliedClosed.length ? oneTouch.length / repliedClosed.length : null,
      oneTouchSample: repliedClosed.length,
    })
  }

  // Biggest closer first, then alphabetical so ties do not reshuffle.
  return out.sort((a, b) => b.closed - a.closed || a.agent.localeCompare(b.agent))
}
