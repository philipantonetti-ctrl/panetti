import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

const { GET } = await import('./route')

const PREFIX = 'convroute-'
const PRACTICE_ONLY = 'convroute-practice-only'
async function cleanup() {
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: PREFIX } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  await db.aiConversation.createMany({
    data: [
      { source: 'gorgias', externalTicketId: `${PREFIX}1`, question: 'live', decision: 'sent' },
      // A decision nothing else in the suite uses, so "is practice counted?"
      // can be asked of the counts object directly rather than by comparing
      // two totals taken a moment apart while other files are writing rows.
      { source: 'sandbox', externalTicketId: `${PREFIX}sandbox:1`, question: 'practice', decision: PRACTICE_ONLY },
    ],
  })
})

const get = (qs: string) => GET(new Request(`http://localhost/api/support/conversations?${qs}`))

describe('GET /api/support/conversations', () => {
  it('leaves practice runs out of the list and the counts unless asked', async () => {
    const body = await (await get('decision=all')).json()
    const ours = body.conversations.filter((c: { externalTicketId: string }) => c.externalTicketId.startsWith(PREFIX))
    expect(ours.map((c: { question: string }) => c.question)).toEqual(['live'])

    // The practice row is the only row in the whole database with this
    // decision, so the counts having no such key is exactly the rule.
    expect(await db.aiConversation.count({ where: { decision: PRACTICE_ONLY } })).toBe(1)
    expect(body.counts).not.toHaveProperty(PRACTICE_ONLY)
    expect(body.counts).toHaveProperty('sent')
  })

  it('shows practice runs on request', async () => {
    const body = await (await get('decision=all&source=sandbox')).json()
    const ours = body.conversations.filter((c: { externalTicketId: string }) => c.externalTicketId.startsWith(PREFIX))
    expect(ours.map((c: { question: string; source: string }) => [c.question, c.source])).toEqual([['practice', 'sandbox']])
  })
})
