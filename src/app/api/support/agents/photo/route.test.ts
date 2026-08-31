import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN' }),
}))

const MARK = 'photo-route-test'
const PNG = `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString('base64')}`

async function cleanup() {
  await db.supportAgent.deleteMany({ where: { OR: [{ source: MARK }, { name: { startsWith: MARK } }] } })
}
afterAll(cleanup)
beforeEach(cleanup)

const post = (body: unknown) =>
  import('./route').then(({ POST }) =>
    POST(new Request('http://localhost/api/support/agents/photo', { method: 'POST', body: JSON.stringify(body) })),
  )

describe('setting an agent photo by hand', () => {
  it('stores the picture on the helpdesk row that carries the name', async () => {
    await db.supportAgent.create({
      data: { source: MARK, externalId: 'a1', name: `${MARK} Selena` },
    })

    const res = await post({ agent: `${MARK} Selena`, image: PNG })
    expect(res.status).toBe(200)

    const row = await db.supportAgent.findFirstOrThrow({ where: { source: MARK, externalId: 'a1' } })
    expect(row.avatarData).toBe(PNG)
  })

  it('creates a manual row for a name the helpdesk list does not carry', async () => {
    const res = await post({ agent: `${MARK} Ghost`, image: PNG })
    expect(res.status).toBe(200)
    const row = await db.supportAgent.findFirstOrThrow({ where: { name: `${MARK} Ghost` } })
    expect(row.source).toBe('manual')
    expect(row.avatarData).toBe(PNG)
  })

  it('refuses anything that is not a small image', async () => {
    expect((await post({ agent: `${MARK} X`, image: 'data:text/html;base64,PGI+' })).status).toBe(400)
    const huge = `data:image/png;base64,${'A'.repeat(600_000)}`
    expect((await post({ agent: `${MARK} X`, image: huge })).status).toBe(400)
  })
})
