import { afterAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

/**
 * The per-agent cut against real Postgres: rows come back per assignee, the
 * unassigned pile is counted rather than silently dropped, and an agent's
 * old open tickets surface in openNow even when the window holds nothing of
 * theirs. Marker-scoped, like every integration test here.
 */
const MARK = 'agents-route-test'
const AGENT = `${MARK} Frida`

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN' }),
}))

async function cleanup() {
  await db.supportTicket.deleteMany({ where: { source: MARK } })
  await db.supportMessage.deleteMany({ where: { source: MARK } })
  await db.supportAgent.deleteMany({ where: { source: MARK } })
}
afterAll(cleanup)

describe('the agents route', () => {
  it('returns one row per agent and names the unassigned pile', async () => {
    await cleanup()

    await db.supportTicket.create({
      data: {
        source: MARK, externalId: `${MARK}-1`, status: 'closed', subject: 'x', tags: [],
        spam: false, assigneeName: AGENT,
        createdAt: new Date(), closedAt: new Date(), updatedAt: new Date(),
        satisfaction: 5,
      },
    })
    // An OLD open ticket of hers, outside any window: openNow must still see it.
    await db.supportTicket.create({
      data: {
        source: MARK, externalId: `${MARK}-2`, status: 'open', subject: 'x', tags: [],
        spam: false, assigneeName: AGENT,
        createdAt: new Date('2023-02-01T00:00:00Z'), updatedAt: new Date(),
      },
    })
    await db.supportTicket.create({
      data: {
        source: MARK, externalId: `${MARK}-3`, status: 'open', subject: 'x', tags: [],
        spam: false, assigneeName: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    })

    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/support/agents?days=30'))
    expect(res.status).toBe(200)
    const body = await res.json()

    const frida = body.agents.find((a: { agent: string }) => a.agent === AGENT)
    expect(frida).toBeDefined()
    expect(frida.tickets).toBe(1)
    expect(frida.closed).toBe(1)
    expect(frida.csat).toBe(5)
    expect(frida.openNow).toBe(1)
    expect(body.unassigned).toBeGreaterThan(0)
  })

  it('carries the message columns, computed from the mirror', async () => {
    const t1 = await db.supportTicket.findFirstOrThrow({ where: { source: MARK, externalId: `${MARK}-1` } })
    await db.supportMessage.createMany({
      data: [
        {
          source: MARK, externalId: `${MARK}-m1`, ticketExternalId: t1.externalId,
          fromAgent: false, public: true, senderName: null,
          createdAt: t1.createdAt,
        },
        {
          source: MARK, externalId: `${MARK}-m2`, ticketExternalId: t1.externalId,
          fromAgent: true, public: true, senderName: AGENT,
          createdAt: new Date(t1.createdAt.getTime() + 2 * 3_600_000),
        },
      ],
    })

    const { GET } = await import('./route')
    const body = await (await GET(new Request('http://localhost/api/support/agents?days=30'))).json()
    const frida = body.agents.find((a: { agent: string }) => a.agent === AGENT)

    expect(frida.messagesSent).toBe(1)
    expect(frida.ticketsReplied).toBe(1)
    expect(frida.messagesReceived).toBe(1)
    expect(frida.medianFirstResponseHours).toBe(2)
    expect(frida.medianResponseHours).toBe(2)
    // Her replied ticket is closed with exactly one agent message: one touch.
    expect(frida.oneTouchShare).toBe(1)
    expect(typeof body.messagesBackfilling).toBe('boolean')
  })

  /**
   * Found on the live page the hour it shipped: "Gorgias Bot" took the
   * fastest-first-reply crown at 5 minutes, because a machine writes messages
   * too. This page ranks PEOPLE; the helpdesk marks its machines with a bot
   * role, and mapAgent kept that role for exactly this moment.
   */
  it('never lists the helpdesk bots among the people', async () => {
    const BOT = `${MARK} Answer Bot`
    await db.supportAgent.create({
      data: { source: MARK, externalId: `${MARK}-bot`, name: BOT, role: 'bot' },
    })
    const t1 = await db.supportTicket.findFirstOrThrow({ where: { source: MARK, externalId: `${MARK}-1` } })
    await db.supportMessage.create({
      data: {
        source: MARK, externalId: `${MARK}-bm`, ticketExternalId: t1.externalId,
        fromAgent: true, public: true, senderName: BOT,
        createdAt: new Date(t1.createdAt.getTime() + 60_000),
      },
    })

    const { GET } = await import('./route')
    const body = await (await GET(new Request('http://localhost/api/support/agents?days=30'))).json()

    expect(body.agents.some((a: { agent: string }) => a.agent === BOT)).toBe(false)
    // The human is still there.
    expect(body.agents.some((a: { agent: string }) => a.agent === AGENT)).toBe(true)
  })
})
