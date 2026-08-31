import { describe, expect, it } from 'vitest'
import { agentPerformance } from './agent-stats'
import type { StatTicket } from './stats'

const HOUR = 3_600_000

function ticket(over: Partial<StatTicket> = {}): StatTicket {
  return {
    status: 'open',
    channel: 'email',
    language: null,
    tags: [],
    assigneeName: null,
    spam: false,
    createdAt: new Date('2026-08-01T09:00:00Z'),
    closedAt: null,
    firstResponseAt: null,
    satisfaction: null,
    ...over,
  }
}

const closedIn = (agent: string, hours: number, over: Partial<StatTicket> = {}) =>
  ticket({
    assigneeName: agent,
    status: 'closed',
    closedAt: new Date(new Date('2026-08-01T09:00:00Z').getTime() + hours * HOUR),
    ...over,
  })

describe('agentPerformance', () => {
  it('computes one honest row per agent, biggest closer first', () => {
    const rows = agentPerformance(
      [
        closedIn('Selena', 4, { satisfaction: 5, firstResponseAt: new Date('2026-08-01T10:00:00Z') }),
        closedIn('Selena', 8, { satisfaction: 4 }),
        ticket({ assigneeName: 'Selena' }), // hers, still open
        closedIn('Marvin', 20),
        // Unassigned tickets shape the denominators but are nobody's row.
        closedIn('', 1, { assigneeName: null }),
      ],
      [{ assigneeName: 'Selena' }, { assigneeName: 'Selena' }, { assigneeName: 'Marvin' }],
    )

    expect(rows.map((r) => r.agent)).toEqual(['Selena', 'Marvin'])
    const selena = rows[0]
    expect(selena.tickets).toBe(3)
    expect(selena.closed).toBe(2)
    // Share of EVERY closed ticket in the window (4), unassigned included.
    expect(selena.closedShare).toBeCloseTo(0.5)
    expect(selena.medianResolutionHours).toBe(6) // 4h and 8h
    expect(selena.csat).toBe(4.5)
    expect(selena.csatSample).toBe(2)
    expect(selena.medianFirstResponseHours).toBe(1)
    expect(selena.firstResponseSample).toBe(1)
    // Open at any age comes from the second list, not the window.
    expect(selena.openNow).toBe(2)
    expect(rows[1].openNow).toBe(1)
  })

  it('excludes spam from every figure, the same rule the dashboard keeps', () => {
    const rows = agentPerformance(
      [closedIn('Selena', 2), ticket({ assigneeName: 'Selena', spam: true })],
      [],
    )
    expect(rows[0].tickets).toBe(1)
  })

  it('says null where nothing was measured, never zero', () => {
    const rows = agentPerformance([ticket({ assigneeName: 'Dina' })], [])
    const dina = rows[0]
    expect(dina.medianResolutionHours).toBeNull()
    expect(dina.medianFirstResponseHours).toBeNull()
    expect(dina.csat).toBeNull()
    expect(dina.medianResponseHours).toBeNull()
    expect(dina.oneTouchShare).toBeNull()
  })

  /**
   * The Gorgias Agents columns the tickets alone cannot carry, computed from
   * the mirrored messages: what they wrote, how fast after the customer, and
   * how often one reply finished the job.
   */
  it('computes the message columns from the mirror', () => {
    const T0 = new Date('2026-08-01T09:00:00Z')
    const at = (h: number) => new Date(T0.getTime() + h * HOUR)
    const msg = (ticketId: string, fromAgent: boolean, hours: number, sender?: string, over: Record<string, unknown> = {}) => ({
      ticketExternalId: ticketId,
      fromAgent,
      public: true,
      senderName: sender ?? null,
      createdAt: at(hours),
      ...over,
    })

    const rows = agentPerformance(
      [
        ticket({ assigneeName: 'Selena' }),
        closedIn('Selena', 30),
      ],
      [],
      {
        tickets: [
          { externalId: 't1', createdAt: T0, closedAt: null, assigneeName: 'Selena' },
          { externalId: 't2', createdAt: T0, closedAt: at(30), assigneeName: 'Selena' },
        ],
        messages: [
          msg('t1', false, 0), // the customer opens t1
          msg('t1', true, 2, 'Selena'), // her first reply: 2h after arrival
          msg('t1', false, 3), // customer again
          msg('t1', true, 4, 'Selena'), // 1h gap
          msg('t2', false, 0),
          msg('t2', true, 1, 'Selena'), // one reply, ticket closed: one touch
          // A note never counts as a reply.
          msg('t2', true, 0.5, 'Selena', { public: false }),
        ],
      },
    )

    const selena = rows.find((r) => r.agent === 'Selena')!
    expect(selena.messagesSent).toBe(3)
    expect(selena.ticketsReplied).toBe(2)
    expect(selena.messagesReceived).toBe(3)
    // First replies: 2h on t1, 1h on t2 - median 1.5h.
    expect(selena.medianFirstResponseHours).toBe(1.5)
    // Gaps: t1 2h and 1h, t2 1h - median 1h.
    expect(selena.medianResponseHours).toBe(1)
    // Of her replied-and-closed tickets (t2 only), all were one touch.
    expect(selena.oneTouchShare).toBe(1)
    expect(selena.oneTouchSample).toBe(1)
  })

  it('gives a row to someone who only wrote, so their work does not vanish', () => {
    const rows = agentPerformance(
      [ticket({ assigneeName: 'Selena' })],
      [],
      {
        tickets: [{ externalId: 't1', createdAt: new Date('2026-08-01T09:00:00Z'), closedAt: null, assigneeName: 'Selena' }],
        messages: [
          {
            ticketExternalId: 't1', fromAgent: true, public: true,
            senderName: 'Miguel', createdAt: new Date('2026-08-01T10:00:00Z'),
          },
        ],
      },
    )
    const miguel = rows.find((r) => r.agent === 'Miguel')
    expect(miguel).toBeDefined()
    expect(miguel!.messagesSent).toBe(1)
    expect(miguel!.tickets).toBe(0)
  })
})
