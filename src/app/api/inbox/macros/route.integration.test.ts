import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ userId: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))
const { currentUser } = await import('@/lib/auth/current-user')
const { GET, POST } = await import('./route')
const { PATCH, DELETE } = await import('./[id]/route')

const PREFIX = '[inbox-test] '

async function cleanup() {
  await db.macro.deleteMany({ where: { name: { startsWith: PREFIX } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  vi.mocked(currentUser).mockResolvedValue({ userId: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
})

const post = (body: unknown) => POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }))
const patch = (id: string, body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const del = (id: string) => DELETE(new Request('http://localhost/x', { method: 'DELETE' }), { params: Promise.resolve({ id }) })

describe('macros API', () => {
  it('creates, lists (with the variable list), edits and removes a macro', async () => {
    const created = await post({ name: `${PREFIX}Where is my order?`, language: 'en', body: 'Hi {{customer_name}}, order {{order_number}}.' })
    expect(created.status).toBe(200)
    const { macro } = await created.json()

    const listed = await (await GET()).json()
    expect(listed.variables).toContain('delivery_status')
    expect(listed.macros.map((m: { name: string }) => m.name)).toContain(`${PREFIX}Where is my order?`)

    expect((await patch(macro.id, { body: 'New body, no variables' })).status).toBe(200)
    expect((await db.macro.findUniqueOrThrow({ where: { id: macro.id } })).body).toBe('New body, no variables')

    expect((await del(macro.id)).status).toBe(200)
    expect(await db.macro.findUnique({ where: { id: macro.id } })).toBeNull()
    expect((await del(macro.id)).status).toBe(404)
  })

  it('refuses a variable it does not know, naming it', async () => {
    const res = await post({ name: `${PREFIX}Bad`, language: 'en', body: 'Hi {{shoe_size}}' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/shoe_size/)
  })

  it('refuses a duplicate name in the same language with a 409', async () => {
    await post({ name: `${PREFIX}Dup`, language: 'en', body: 'a' })
    expect((await post({ name: `${PREFIX}Dup`, language: 'en', body: 'b' })).status).toBe(409)
    expect((await post({ name: `${PREFIX}Dup`, language: 'nb', body: 'b' })).status).toBe(200)
  })

  it('is admin-only', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ userId: 'u2', email: 'x@y.z', role: 'MARKETING' } as never)
    expect((await GET()).status).toBe(403)
  })
})
