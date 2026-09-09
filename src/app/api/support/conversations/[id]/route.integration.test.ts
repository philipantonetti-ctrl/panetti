import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { PATCH } from './route'

/**
 * The HTTP edge of the correction loop. examples.integration.test.ts proves
 * promoteCorrection() itself; this proves the route actually calls it - that
 * a non-blank correction in the request body reaches it, that the success
 * shape carries the new knowledgeItemId, and that an unknown conversation
 * 404s through the same path a rating-only PATCH already used.
 */
const TAG = '[patch-route-test]'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { body: { contains: TAG } } })
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: 'PATCHROUTE-' } } })
}
afterAll(cleanup)
beforeEach(cleanup)

describe('PATCH /api/support/conversations/[id]', () => {
  it('promotes a non-blank correction to an example and reports its id', async () => {
    const conv = await db.aiConversation.create({
      data: {
        source: 'sandbox', externalTicketId: 'PATCHROUTE-1', question: 'Kan I sende til Bornholm?',
        language: 'da', decision: 'drafted',
      },
    })

    const res = await PATCH(
      new Request(`http://localhost/api/support/conversations/${conv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ rating: 'bad', correction: `Ja, med Bring. ${TAG}` }),
      }),
      { params: Promise.resolve({ id: conv.id }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, knowledgeItemId: expect.any(String) })

    const item = await db.knowledgeItem.findUniqueOrThrow({ where: { id: body.knowledgeItemId } })
    expect(item.kind).toBe('example')
    expect(item.language).toBe('da')

    const updated = await db.aiConversation.findUniqueOrThrow({ where: { id: conv.id } })
    expect(updated.rating).toBe('bad')
    expect(updated.correction).toContain('Bring')
  })

  it('404s a correction for an unknown conversation, and creates nothing', async () => {
    const res = await PATCH(
      new Request('http://localhost/api/support/conversations/no-such-conversation', {
        method: 'PATCH',
        body: JSON.stringify({ correction: `Foo ${TAG}` }),
      }),
      { params: Promise.resolve({ id: 'no-such-conversation' }) },
    )

    expect(res.status).toBe(404)
    expect(await db.knowledgeItem.count({ where: { body: { contains: TAG } } })).toBe(0)
  })

  it('a rating-only PATCH on a real row updates the rating and promotes nothing', async () => {
    const conv = await db.aiConversation.create({
      data: {
        source: 'sandbox', externalTicketId: 'PATCHROUTE-2', question: 'Et andet spørgsmål?',
        language: 'da', decision: 'drafted',
      },
    })

    const res = await PATCH(
      new Request(`http://localhost/api/support/conversations/${conv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ rating: 'good' }),
      }),
      { params: Promise.resolve({ id: conv.id }) },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const updated = await db.aiConversation.findUniqueOrThrow({ where: { id: conv.id } })
    expect(updated.rating).toBe('good')
    expect(await db.knowledgeItem.count({ where: { body: { contains: TAG } } })).toBe(0)
  })
})
