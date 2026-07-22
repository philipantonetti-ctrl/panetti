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
const OTHER_EMAIL = 'plan-test-amb-2@example.local'

let shopId = ''
let otherShopId = ''

async function cleanup() {
  await db.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } })
  await db.ambassador.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } })
  await db.shop.deleteMany({ where: { name: { contains: '[amb-test]' } } })
}

beforeEach(async () => {
  await cleanup()
  const a = await db.shop.create({ data: { name: 'A [amb-test]', currency: 'NOK' } })
  const b = await db.shop.create({ data: { name: 'B [amb-test]', currency: 'SEK' } })
  shopId = a.id
  otherShopId = b.id
})
afterEach(cleanup)

describe('GET /api/ambassadors', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await GET()).status).toBe(403)
  })

  it('allows an admin', async () => {
    await asAdmin()
    expect((await GET()).status).toBe(200)
  })

  it('reports each code with the store it belongs to', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, shopId, code: 'STORECODE10' })

    const body = await (await GET()).json()
    const row = body.ambassadors.find((a: { email: string }) => a.email === EMAIL)
    expect(row.codes[0]).toMatchObject({ code: 'STORECODE10', shopId, shopName: 'A [amb-test]' })
  })
})

describe('POST /api/ambassadors', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({ name: 'X', email: EMAIL, commissionPercent: 10, shopId, code: 'X10' })).status).toBe(403)
  })

  it('needs a store for the code', async () => {
    await asAdmin()
    expect((await post({ name: 'X', email: EMAIL, commissionPercent: 10, code: 'X10' })).status).toBe(400)
  })

  it('uppercases the code and ties it to the chosen store', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 15, shopId, code: 'lower10' })

    const saved = await db.ambassador.findUniqueOrThrow({
      where: { email: EMAIL }, include: { codes: true },
    })
    expect(saved.codes).toHaveLength(1)
    expect(saved.codes[0]).toMatchObject({ code: 'LOWER10', shopId })
    expect(saved.commissionRate).toBeCloseTo(0.15)
  })

  it('rejects a commission percent above 100', async () => {
    await asAdmin()
    expect((await post({ name: 'X', email: EMAIL, commissionPercent: 1000, shopId, code: 'X10' })).status).toBe(400)
  })

  it('rejects a duplicate email with 409', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, shopId, code: 'DUPE1' })
    const again = await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, shopId, code: 'DUPE2' })
    expect(again.status).toBe(409)
  })

  it('lets an admin be an ambassador too — same email is allowed and tracked', async () => {
    await asAdmin()
    // The admin's own email already has a login. Creating an ambassador on it is
    // fine: the code is tracked without a separate ambassador login, and the admin
    // already sees the numbers on their dashboard.
    await db.user.create({ data: { email: EMAIL, passwordHash: 'x', role: 'ADMIN' } })
    const res = await post({ name: 'Owner', email: EMAIL, commissionPercent: 10, shopId, code: 'OWNER10' })
    expect(res.status).toBe(200)
    expect(await db.ambassador.findUnique({ where: { email: EMAIL } })).not.toBeNull()
  })

  it('rejects the same code on the SAME store with 409', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, shopId, code: 'SAME10' })
    const again = await post({ name: 'Other', email: OTHER_EMAIL, commissionPercent: 10, shopId, code: 'same10' })
    expect(again.status).toBe(409)
  })

  it('ALLOWS the same code on a DIFFERENT store (Sweden JOHN10 vs Norway JOHN10)', async () => {
    await asAdmin()
    const one = await post({ name: 'John NO', email: EMAIL, commissionPercent: 10, shopId, code: 'JOHN10' })
    const two = await post({ name: 'John SE', email: OTHER_EMAIL, commissionPercent: 10, shopId: otherShopId, code: 'JOHN10' })
    expect(one.status).toBe(200)
    expect(two.status).toBe(200)
  })

  it('gives a new ambassador an invite link, since they have no login yet', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, shopId, code: 'INVITE10' })

    const body = await (await GET()).json()
    const row = body.ambassadors.find((a: { email: string }) => a.email === EMAIL)
    expect(row.onboarded).toBe(false)
    expect(row.invitePath).toMatch(/^\/invite\/.+/)
    expect(row.commissionPercent).toBeCloseTo(10)
  })

  it('returns a clean percent, with no float artifacts', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 7, shopId, code: 'SEVEN7' })

    const body = await (await GET()).json()
    const row = body.ambassadors.find((a: { email: string }) => a.email === EMAIL)
    expect(row.commissionPercent).toBe(7)
    expect(String(row.commissionPercent)).toBe('7')
  })
})
