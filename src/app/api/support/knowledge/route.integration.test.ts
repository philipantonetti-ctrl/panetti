import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))
const { GET } = await import('./route')
const { DELETE } = await import('./[id]/route')

const TAG = '[knowledge-route-test]'
async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { title: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(cleanup)

describe('the knowledge list and a website row', () => {
  it('says where a row came from, and refuses to delete a website row', async () => {
    const row = await db.knowledgeItem.create({ data: { kind: 'product', title: `Site ${TAG}`, body: 'x', source: 'website', sourceUrl: 'https://panetti.no/p/', sourceKey: `${TAG}:1`, readAt: new Date('2026-09-10T05:14:00Z') } })
    const body = await (await GET()).json()
    const item = body.items.find((i: { id: string }) => i.id === row.id)
    expect(item).toMatchObject({ source: 'website', sourceUrl: 'https://panetti.no/p/', readAt: '2026-09-10T05:14:00.000Z' })

    const res = await DELETE(new Request('http://localhost'), { params: Promise.resolve({ id: row.id }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This was read from the website; turn it off instead, or untick its page')
    expect(await db.knowledgeItem.findUnique({ where: { id: row.id } })).not.toBeNull()
  })
})
