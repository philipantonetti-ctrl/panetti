import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

const { GET } = await import('./route')

const PREFIX = 'convroute-'
async function cleanup() {
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: PREFIX } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  await db.aiConversation.createMany({
    data: [
      { source: 'gorgias', externalTicketId: `${PREFIX}1`, question: 'live', decision: 'sent' },
      { source: 'sandbox', externalTicketId: `${PREFIX}sandbox:1`, question: 'practice', decision: 'sent' },
    ],
  })
})

const get = (qs: string) => GET(new Request(`http://localhost/api/support/conversations?${qs}`))

describe('GET /api/support/conversations', () => {
  it('leaves practice runs out of the list and the counts unless asked', async () => {
    const body = await (await get('decision=all')).json()
    const ours = body.conversations.filter((c: { externalTicketId: string }) => c.externalTicketId.startsWith(PREFIX))
    expect(ours.map((c: { question: string }) => c.question)).toEqual(['live'])
    // Counts are over everything, so only prove the practice row is not among them.
    const practice = await db.aiConversation.count({ where: { source: 'sandbox' } })
    const live = await db.aiConversation.count({ where: { source: { not: 'sandbox' } } })
    expect(Object.values(body.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(live)
    expect(practice).toBeGreaterThan(0)
  })

  it('shows practice runs on request', async () => {
    const body = await (await get('decision=all&source=sandbox')).json()
    const ours = body.conversations.filter((c: { externalTicketId: string }) => c.externalTicketId.startsWith(PREFIX))
    expect(ours.map((c: { question: string; source: string }) => [c.question, c.source])).toEqual([['practice', 'sandbox']])
  })
})
