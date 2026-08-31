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
  })
})
