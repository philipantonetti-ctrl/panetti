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
const OTHER = 'plan-codes-other@example.local'
let id = ''
let shopId = ''
let otherShopId = ''

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

async function cleanup() {
  await db.ambassador.deleteMany({ where: { email: { in: [EMAIL, OTHER] } } })
  await db.shop.deleteMany({ where: { name: { contains: '[codes-test]' } } })
}

beforeEach(async () => {
  await cleanup()
  const a = await db.shop.create({ data: { name: 'A [codes-test]', currency: 'NOK' } })
  const b = await db.shop.create({ data: { name: 'B [codes-test]', currency: 'SEK' } })
  shopId = a.id
  otherShopId = b.id
  const amb = await db.ambassador.create({
    data: { name: 'Codes', email: EMAIL, commissionRate: 0.1, codes: { create: { code: 'FIRST10', shopId } } },
  })
  id = amb.id
})

afterEach(cleanup)

describe('POST — add a code', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await call(POST, { code: 'HACK10', shopId })).status).toBe(403)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  it('refuses an ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'u', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'x',
    })
    expect((await call(POST, { code: 'HACK10', shopId })).status).toBe(403)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  it('adds a code on a store, uppercased', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'second20', shopId })).status).toBe(200)
    const codes = await db.ambassadorCode.findMany({ where: { ambassadorId: id } })
    expect(codes.map((c) => c.code).sort()).toEqual(['FIRST10', 'SECOND20'])
    expect(codes.every((c) => c.shopId === shopId)).toBe(true)
  })

  it('needs a store', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'NOSHOP10' })).status).toBe(400)
  })

  it('rejects the same code on the SAME store with 409', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'first10', shopId })).status).toBe(409)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  it('ALLOWS the same code on a DIFFERENT store', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'FIRST10', shopId: otherShopId })).status).toBe(200)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(2)
  })

  it('404s for an unknown ambassador', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'ORPHAN10', shopId }, 'does-not-exist')).status).toBe(404)
  })

  it('rejects an empty code', async () => {
    await asAdmin()
    expect((await call(POST, { code: '', shopId })).status).toBe(400)
  })
})

describe('DELETE — remove a code', () => {
  it('refuses an anonymous caller', async () => {
    await asAdmin()
    await call(POST, { code: 'SECOND20', shopId })
    const doomed = await db.ambassadorCode.findFirstOrThrow({ where: { code: 'SECOND20' } })

    cookieValue.current = undefined
    expect((await call(DELETE, { codeId: doomed.id })).status).toBe(403)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(2)
  })

  it('removes a code when more than one remains', async () => {
    await asAdmin()
    await call(POST, { code: 'SECOND20', shopId })
    const doomed = await db.ambassadorCode.findFirstOrThrow({ where: { code: 'SECOND20' } })
    expect((await call(DELETE, { codeId: doomed.id })).status).toBe(200)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  it('refuses to delete the LAST code', async () => {
    await asAdmin()
    const only = await db.ambassadorCode.findFirstOrThrow({ where: { ambassadorId: id } })
    expect((await call(DELETE, { codeId: only.id })).status).toBe(400)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  it("refuses to delete another ambassador's code", async () => {
    await asAdmin()
    await call(POST, { code: 'MINE20', shopId })
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(2)

    const other = await db.ambassador.create({
      data: {
        name: 'Other', email: OTHER, commissionRate: 0.1,
        codes: { create: [{ code: 'OTHERA10', shopId }, { code: 'OTHERB10', shopId }] },
      },
      include: { codes: true },
    })
    const victim = other.codes[0]
    const res = await call(DELETE, { codeId: victim.id })
    expect(res.status).toBe(404)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: other.id } })).toBe(2)
  })

  it('404s for a codeId that does not exist at all', async () => {
    await asAdmin()
    await call(POST, { code: 'MINE20', shopId })
    expect((await call(DELETE, { codeId: 'no-such-code-id' })).status).toBe(404)
  })
})
