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
})
