import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import type { TranscriptMessage } from '@/lib/support/channel'

/**
 * The whole chat as the customer saw it, which is the one thing the review
 * page could not show: what the PERSON wrote. The assistant's own line has to
 * be told from a colleague's, or the page answers the question wrongly, which
 * is worse than not answering it.
 */
vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

let transcript: TranscriptMessage[] = []
let configured = true
vi.mock('@/lib/support/gorgias-channel', async () => {
  const actual = await vi.importActual<typeof import('@/lib/support/gorgias-channel')>('@/lib/support/gorgias-channel')
  return {
    ...actual,
    gorgiasChannel: () =>
      configured ? { name: 'gorgias', async transcript() { return transcript } } : null,
  }
})

const { GET } = await import('./route')

const TICKET = 'chatroute-1'
const m = (id: string, fromAgent: boolean, text: string, automatic = false): TranscriptMessage => ({
  id, fromAgent, text, at: `2026-09-25T09:4${id}:00Z`, automatic,
})

async function cleanup() {
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: 'chatroute-' } } })
  await db.aiChatSession.deleteMany({ where: { externalTicketId: { startsWith: 'chatroute-' } } })
  await db.shop.deleteMany({ where: { name: { startsWith: '[chatroute]' } } })
}
afterAll(cleanup)

let rowId = ''
beforeEach(async () => {
  await cleanup()
  configured = true
  transcript = [
    m('1', false, 'Hvor mange grader?'),
    m('2', true, 'Vi er tilbage om ca. 9 minutter.', true),
    m('3', true, 'Pizzetta Pro naar 450 grader.'),
    m('4', true, 'Hej, Selena her - jeg overtager.'),
  ]
  const shopId = (await db.shop.create({ data: { name: '[chatroute] Denmark', currency: 'DKK' } })).id
  const session = await db.aiChatSession.create({
    data: { shopId, source: 'gorgias', externalTicketId: TICKET },
  })
  rowId = (
    await db.aiConversation.create({
      data: {
        source: 'gorgias', externalTicketId: TICKET, externalMessageId: '1', sessionId: session.id, shopId,
        question: 'Hvor mange grader?', answer: 'Pizzetta Pro naar 450 grader.', decision: 'sent',
        externalReplyId: '3',
      },
    })
  ).id
})

const get = (id: string) =>
  GET(new Request(`http://localhost/api/support/conversations/${id}/chat`), { params: Promise.resolve({ id }) })

describe('GET /api/support/conversations/[id]/chat', () => {
  it('shows who said what, and tells the assistant from a colleague', async () => {
    const body = await (await get(rowId)).json()
    expect(body.messages.map((x: { who: string; text: string }) => [x.who, x.text])).toEqual([
      ['customer', 'Hvor mange grader?'],
      ['widget', 'Vi er tilbage om ca. 9 minutter.'],
      ['assistant', 'Pizzetta Pro naar 450 grader.'],
      ['person', 'Hej, Selena her - jeg overtager.'],
    ])
  })

  it('says so rather than showing half a chat when Gorgias is not configured', async () => {
    configured = false
    const res = await get(rowId)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.messages).toEqual([])
    expect(body.reason).toMatch(/gorgias/i)
  })

  it('has nothing to show for a practice run', async () => {
    const practice = await db.aiConversation.create({
      data: { source: 'sandbox', externalTicketId: 'chatroute-sandbox', question: 'practice', decision: 'sent' },
    })
    const body = await (await get(practice.id)).json()
    expect(body.messages).toEqual([])
    expect(body.reason).toMatch(/practice/i)
  })

  it('is 404 for a conversation that is not there', async () => {
    expect((await get('no-such-row')).status).toBe(404)
  })
})
