import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { POST } = await import('./route')
const { testSession } = await import('@/lib/auth/test-session')
const { verifyReset } = await import('@/lib/auth/reset')
const { db } = await import('@/lib/db')

const ME = 'plan-resetlink-me@example.local'
const OPS = 'plan-resetlink-ops@example.local'
const TARGET = 'plan-resetlink-target@example.local'
let myId = ''
let opsId = ''
let targetId = ''

async function wipe() {
  await db.user.deleteMany({ where: { email: { in: [ME, OPS, TARGET] } } })
}

const signInAs = async (userId: string, email: string, role: 'ADMIN' | 'OPERATIONS') => {
  cookieValue.current = await testSession({ userId, email, role, ambassadorId: null })
}

beforeEach(async () => {
  await wipe()
  myId = (await db.user.create({ data: { email: ME, passwordHash: 'x', role: 'ADMIN' } })).id
  opsId = (await db.user.create({ data: { email: OPS, passwordHash: 'x', role: 'OPERATIONS' } })).id
  targetId = (
    await db.user.create({ data: { email: TARGET, passwordHash: '$2b$fake-hash', role: 'MARKETING' } })
  ).id
  await signInAs(myId, ME, 'ADMIN')
  vi.stubEnv('APP_URL', 'https://panetti.vercel.app')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  cookieValue.current = undefined
  await wipe()
})

const ask = (body: unknown) =>
  POST(
    new Request('http://localhost/api/users/reset-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('an admin minting a reset link by hand', () => {
  it('gets a live-site link whose token really identifies that login', async () => {
    const res = await ask({ email: TARGET })
    expect(res.status).toBe(200)
    const { link } = (await res.json()) as { link: string }
    expect(link.startsWith('https://panetti.vercel.app/reset/')).toBe(true)
    const token = link.slice('https://panetti.vercel.app/reset/'.length)
    expect(await verifyReset(token)).toMatchObject({ userId: targetId })
  })

  it('finds the login whatever case the address is typed in', async () => {
    const res = await ask({ email: TARGET.toUpperCase() })
    expect(res.status).toBe(200)
  })

  it('says so when no login has that address - the admin is trusted with that fact', async () => {
    const res = await ask({ email: 'plan-resetlink-nobody@example.local' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toMatch(/no login/i)
  })

  it('refuses the operations manager', async () => {
    await signInAs(opsId, OPS, 'OPERATIONS')
    expect((await ask({ email: TARGET })).status).toBe(403)
  })

  it('refuses anyone not signed in', async () => {
    cookieValue.current = undefined
    expect((await ask({ email: TARGET })).status).toBe(403)
  })

  it('refuses something that is not an address', async () => {
    expect((await ask({ email: 'nope' })).status).toBe(400)
  })
})
