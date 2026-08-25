import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, POST } = await import('./route')
const { DELETE } = await import('./[id]/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const ME = 'plan-users-me@example.local'
const NEW_ADMIN = 'plan-users-admin@example.local'
const NEW_MKT = 'plan-users-marketing@example.local'
let myId = ''

async function wipe() {
  await db.user.deleteMany({ where: { email: { in: [ME, NEW_ADMIN, NEW_MKT] } } })
}

const asMe = async () => {
  cookieValue.current = await signSession({
    userId: myId, email: ME, role: 'ADMIN', ambassadorId: null,
  })
}

beforeEach(async () => {
  await wipe()
  const me = await db.user.create({ data: { email: ME, passwordHash: 'x', role: 'ADMIN' } })
  myId = me.id
  await asMe()
})

afterEach(wipe)

const create = (body: unknown) =>
  POST(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const remove = (id: string) =>
  DELETE(new Request(`http://localhost/api/users/${id}`), { params: Promise.resolve({ id }) })

describe('staff logins', () => {
  it('creates an admin and a marketing login, stored hashed, and lists them', async () => {
    expect((await create({ email: NEW_ADMIN, role: 'ADMIN', password: 'longenough1' })).status).toBe(200)
    expect((await create({ email: NEW_MKT, role: 'MARKETING', password: 'longenough2' })).status).toBe(200)

    const admin = await db.user.findUniqueOrThrow({ where: { email: NEW_ADMIN } })
    expect(admin.role).toBe('ADMIN')
    expect(admin.passwordHash).not.toContain('longenough1')

    const list = await (await GET()).json()
    const emails = list.users.map((u: { email: string }) => u.email)
    expect(emails).toContain(NEW_ADMIN)
    expect(emails).toContain(NEW_MKT)
  })

  it('never lists ambassador logins - they are managed by invites', async () => {
    const list = await (await GET()).json()
    expect(list.users.every((u: { role: string }) => u.role !== 'AMBASSADOR')).toBe(true)
  })

  it('answers a taken email with readable words, not a 500', async () => {
    await create({ email: NEW_MKT, role: 'MARKETING', password: 'longenough2' })
    const res = await create({ email: NEW_MKT, role: 'ADMIN', password: 'longenough3' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('already')
  })

  it('refuses a short password with the rule in the message', async () => {
    const res = await create({ email: NEW_ADMIN, role: 'ADMIN', password: 'short' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('8')
  })

  it('refuses to delete your own login', async () => {
    const res = await remove(myId)
    expect(res.status).toBe(409)
    expect(await db.user.findUnique({ where: { id: myId } })).not.toBeNull()
  })

  it('deletes another staff login', async () => {
    await create({ email: NEW_MKT, role: 'MARKETING', password: 'longenough2' })
    const target = await db.user.findUniqueOrThrow({ where: { email: NEW_MKT } })
    expect((await remove(target.id)).status).toBe(200)
    expect(await db.user.findUnique({ where: { email: NEW_MKT } })).toBeNull()
  })

  it('is closed to marketing - minting logins is the admin chair', async () => {
    cookieValue.current = await signSession({
      userId: 'mkt-users', email: 'mkt@test.local', role: 'MARKETING', ambassadorId: null,
    })
    expect((await GET()).status).toBe(403)
    expect((await create({ email: NEW_ADMIN, role: 'ADMIN', password: 'longenough1' })).status).toBe(403)
  })
})
