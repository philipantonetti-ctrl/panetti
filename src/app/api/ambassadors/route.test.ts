import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, POST } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/ambassadors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

const EMAIL = 'plan-test-amb@example.local'

async function cleanup() {
  const existing = await db.ambassador.findUnique({ where: { email: EMAIL } })
  if (existing) await db.ambassador.delete({ where: { id: existing.id } })
}

beforeEach(cleanup)
afterEach(cleanup)

describe('GET /api/ambassadors', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await GET()).status).toBe(403)
  })

  it('refuses an ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'u', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'x',
    })
    expect((await GET()).status).toBe(403)
  })

  it('allows an admin', async () => {
    await asAdmin()
    expect((await GET()).status).toBe(200)
  })
})

describe('POST /api/ambassadors', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({ name: 'X', email: EMAIL, commissionPercent: 10, code: 'X10' })).status).toBe(403)
  })

  it('stores 10 percent as the fraction 0.1', async () => {
    await asAdmin()
    const res = await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, code: 'PLANTEST10' })
    expect(res.status).toBe(200)

    const saved = await db.ambassador.findUniqueOrThrow({ where: { email: EMAIL } })
    expect(saved.commissionRate).toBeCloseTo(0.1)
  })

  it('uppercases the code and creates it alongside the ambassador', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 15, code: 'lower10' })

    const saved = await db.ambassador.findUniqueOrThrow({
      where: { email: EMAIL }, include: { codes: true },
    })
    expect(saved.codes).toHaveLength(1)
    expect(saved.codes[0].code).toBe('LOWER10')
    expect(saved.commissionRate).toBeCloseTo(0.15)
  })

  it('rejects a commission percent above 100', async () => {
    await asAdmin()
    expect((await post({ name: 'X', email: EMAIL, commissionPercent: 1000, code: 'X10' })).status).toBe(400)
  })

  it('rejects a duplicate email with 409', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, code: 'DUPE1' })
    const again = await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, code: 'DUPE2' })
    expect(again.status).toBe(409)
  })

  it('gives a new ambassador an invite link, since they have no login yet', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, code: 'INVITE10' })

    const body = await (await GET()).json()
    const row = body.ambassadors.find((a: { email: string }) => a.email === EMAIL)
    expect(row.onboarded).toBe(false)
    expect(row.invitePath).toMatch(/^\/invite\/.+/)
    expect(row.commissionPercent).toBeCloseTo(10)
  })
})
