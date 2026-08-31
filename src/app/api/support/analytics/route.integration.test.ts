import { afterAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

/**
 * The ticket-to-order join, against real Postgres.
 *
 * Which SHOP a ticket's customer belongs to is the one figure the helpdesk
 * cannot produce for us, so it is the one worth proving on a real database
 * rather than a mock. The bug it guards against is silent: the two tables
 * store an address differently, and an exact match returns zero matches and no
 * error at all.
 *
 * Everything this file creates carries its own marker and is deleted by it.
 * Cleaning up by anything broader would take live rows with it, which has
 * happened here before.
 */

const MARK = 'analytics-join-test'
const EMAIL_AS_TYPED = 'Ole.Hansen@Example.NO'
const EMAIL_AS_STORED = 'ole.hansen@example.no'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN' }),
}))

async function cleanup() {
  await db.supportTicket.deleteMany({ where: { source: MARK } })
  await db.order.deleteMany({ where: { externalId: { startsWith: MARK } } })
}
afterAll(cleanup)

/** Unique to this test run, so a shared database cannot collide on the name. */
const AGENT_A = `${MARK} Alice`
const AGENT_B = `${MARK} Bob`

function ticket(externalId: string, over: Record<string, unknown> = {}) {
  return {
    source: MARK,
    externalId,
    status: 'open',
    subject: 'Question',
    tags: [] as string[],
    spam: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

/**
 * The Gorgias screenshots the client sent show the page he wants: pick an
 * agent, see only their numbers. The filter has to narrow EVERYTHING - the
 * tiles, the previous period, the backlog band - or the page shows one
 * agent's volume over the whole team's queue and the two halves disagree.
 */
describe('the agent filter', () => {
  it('lists the agents seen in the period, and narrows every figure to the one asked for', async () => {
    await cleanup()

    await db.supportTicket.create({
      data: ticket(`${MARK}-a1`, { assigneeName: AGENT_A }),
    })
    await db.supportTicket.create({
      data: ticket(`${MARK}-a2`, {
        assigneeName: AGENT_A,
        status: 'closed',
        closedAt: new Date(),
      }),
    })
    await db.supportTicket.create({
      data: ticket(`${MARK}-b1`, { assigneeName: AGENT_B }),
    })

    const { GET } = await import('./route')

    const all = await (await GET(new Request('http://localhost/api/support/analytics?days=30'))).json()
    expect(all.agents).toContain(AGENT_A)
    expect(all.agents).toContain(AGENT_B)

    const res = await GET(
      new Request(`http://localhost/api/support/analytics?days=30&agent=${encodeURIComponent(AGENT_A)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    // Every ticket on the page is Alice's: the tiles, and the breakdown.
    expect(body.stats.tickets).toBe(2)
    expect(body.stats.byAgent).toEqual([{ key: AGENT_A, tickets: 2 }])
    // The backlog band narrows too: only Alice's open ticket, at any age.
    expect(body.backlog.open).toBe(1)
    // The dropdown must not shrink to the filtered slice, or there is no way back.
    expect(body.agents).toContain(AGENT_B)
  })

  it('treats "none" as the unassigned pile, the way the inbox filter already does', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/support/analytics?days=30&agent=none'))
    const body = await res.json()
    // Unassigned tickets have no agent, so the agent breakdown is empty.
    expect(body.stats.byAgent).toEqual([])
  })
})

describe('the support analytics join', () => {
  it('ties a ticket to its shop even when the customer capitalised their own address', async () => {
    await cleanup()

    const shop = await db.shop.findFirst()
    if (!shop) return expect.fail('no shop to attach an order to')

    // An order keeps whatever was typed at checkout: woo/map.ts trims it and
    // stops there.
    const template = await db.order.findFirst()
    if (!template) return expect.fail('no order to copy the required columns from')
    await db.order.create({
      data: {
        ...template,
        id: undefined,
        shopId: shop.id,
        externalId: `${MARK}-1`,
        number: `${MARK}-1`,
        placedAt: new Date(),
        customerEmail: EMAIL_AS_TYPED,
      },
    })

    // A ticket's address is lowercased on the way in, for this very join.
    await db.supportTicket.create({
      data: {
        source: MARK,
        externalId: `${MARK}-t1`,
        status: 'open',
        subject: 'Where is my order',
        customerEmail: EMAIL_AS_STORED,
        tags: [],
        spam: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/support/analytics?days=30'))
    expect(res.status).toBe(200)
    const body = await res.json()

    const matched = body.stats.byShop.find((b: { key: string }) => b.key === shop.name)
    expect(matched, `expected the ticket to be tied to ${shop.name}`).toBeDefined()
    expect(body.matchedToCustomer).toBeGreaterThan(0)
  })
})
