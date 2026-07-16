import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { POST, DELETE } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const EMAIL = 'plan-codes-amb@example.local'
let id = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const call = (fn: typeof POST | typeof DELETE, body: unknown, target = id) =>
  fn(
    new Request('http://localhost/api/ambassadors/x/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: target }) },
  )

beforeEach(async () => {
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
  const a = await db.ambassador.create({
    data: { name: 'Codes', email: EMAIL, commissionRate: 0.1, codes: { create: { code: 'FIRST10' } } },
  })
  id = a.id
})

afterEach(async () => {
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
})

describe('POST — add a code', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await call(POST, { code: 'HACK10' })).status).toBe(403)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1) // nothing written
  })

  it('refuses an ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'u', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'x',
    })
    expect((await call(POST, { code: 'HACK10' })).status).toBe(403)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  it('adds a code, uppercased', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'second20' })).status).toBe(200)
    const codes = await db.ambassadorCode.findMany({ where: { ambassadorId: id } })
    expect(codes.map((c) => c.code).sort()).toEqual(['FIRST10', 'SECOND20'])
  })

  it('rejects a duplicate code with 409, even in a different case', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'first10' })).status).toBe(409)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  it('404s for an unknown ambassador', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'ORPHAN10' }, 'does-not-exist')).status).toBe(404)
  })

  it('rejects an empty code', async () => {
    await asAdmin()
    expect((await call(POST, { code: '' })).status).toBe(400)
  })
})

describe('DELETE — remove a code', () => {
  it('refuses an anonymous caller', async () => {
    await asAdmin()
    await call(POST, { code: 'SECOND20' })
    const doomed = await db.ambassadorCode.findFirstOrThrow({ where: { code: 'SECOND20' } })

    cookieValue.current = undefined
    expect((await call(DELETE, { codeId: doomed.id })).status).toBe(403)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(2) // nothing deleted
  })

  it('removes a code when more than one remains', async () => {
    await asAdmin()
    await call(POST, { code: 'SECOND20' })
    const doomed = await db.ambassadorCode.findFirstOrThrow({ where: { code: 'SECOND20' } })
    expect((await call(DELETE, { codeId: doomed.id })).status).toBe(200)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  // An ambassador with no code can never earn again.
  it('refuses to delete the LAST code', async () => {
    await asAdmin()
    const only = await db.ambassadorCode.findFirstOrThrow({ where: { ambassadorId: id } })
    expect((await call(DELETE, { codeId: only.id })).status).toBe(400)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  // Codes must never be deletable across ambassadors.
  it("refuses to delete another ambassador's code", async () => {
    await asAdmin()
    const other = await db.ambassador.create({
      data: {
        name: 'Other', email: 'plan-codes-other@example.local', commissionRate: 0.1,
        codes: { create: [{ code: 'OTHERA10' }, { code: 'OTHERB10' }] },
      },
      include: { codes: true },
    })
    try {
      const victim = other.codes[0]
      // `id` (our ambassador) must not be able to delete a code belonging to `other`.
      const res = await call(DELETE, { codeId: victim.id })
      expect(res.status).not.toBe(200)
      expect(await db.ambassadorCode.count({ where: { ambassadorId: other.id } })).toBe(2)
    } finally {
      await db.ambassador.delete({ where: { id: other.id } })
    }
  })
})
