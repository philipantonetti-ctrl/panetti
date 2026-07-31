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

  // Codes usually run for months before anyone is added as an ambassador here.
  // Those sales are theirs, so adding them must not open an empty portal.
  it('links a new ambassador to the sales their code already made', async () => {
    await asAdmin()
    await db.order.create({
      data: {
        shopId, externalId: 'past-1', number: 'past-1', placedAt: new Date('2026-01-10'),
        status: 'completed', currency: 'NOK', grossSales: 10000, discountTotal: 0, netSales: 10000,
        shippingCharged: 0, taxTotal: 0, total: 10000, couponCode: 'HISTORIC10',
      },
    })

    const res = await post({ name: 'Late', email: EMAIL, commissionPercent: 10, shopId, code: 'historic10' })
    expect(res.status).toBe(200)
    expect((await res.json()).linkedOrders).toBe(1)

    const amb = await db.ambassador.findUniqueOrThrow({ where: { email: EMAIL } })
    const past = await db.order.findFirstOrThrow({ where: { externalId: 'past-1' } })
    expect(past.ambassadorId).toBe(amb.id)
  })

  it('gives a new ambassador an invite link, since they have no login yet', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, shopId, code: 'INVITE10' })

    const body = await (await GET()).json()
    const row = body.ambassadors.find((a: { email: string }) => a.email === EMAIL)
    expect(row.onboarded).toBe(false)
    expect(row.emailHasLogin).toBe(false)
    expect(row.invitePath).toMatch(/^\/invite\/.+/)
    expect(row.commissionPercent).toBeCloseTo(10)
  })

  // The owner's case: their email is already the admin login, so an invite could
  // never work. Say so, and do not offer a link that is guaranteed to fail.
  it('flags an ambassador whose email already has a login, and mints no invite for them', async () => {
    await asAdmin()
    await db.user.create({ data: { email: EMAIL, passwordHash: 'x', role: 'ADMIN' } })
    await post({ name: 'Owner', email: EMAIL, commissionPercent: 10, shopId, code: 'OWNER10' })

    const body = await (await GET()).json()
    const row = body.ambassadors.find((a: { email: string }) => a.email === EMAIL)
    expect(row.emailHasLogin).toBe(true)
    expect(row.onboarded).toBe(false) // no login is linked to THIS ambassador
    expect(row.invitePath).toBeNull()
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

describe('POST /api/ambassadors with products', () => {
  // Synthetic SKUs, never a real catalogue one: the seed gifts real products,
  // and a test that counted those would pass or fail on someone else's data.
  const SKU_A = 'CREATE-TEST-SKU-A'
  const SKU_B = 'CREATE-TEST-SKU-B'

  it('records what the new ambassador was sent, in the same write', async () => {
    await asAdmin()
    const res = await post({
      name: 'Gifted', email: EMAIL, commissionPercent: 10, shopId, code: 'GIFT10',
      products: [
        { sku: SKU_A, name: 'Chair', quantity: 2, receivedAt: '2026-03-12', note: 'launch batch' },
        { sku: SKU_B, name: 'Gun', quantity: 1, receivedAt: '2026-04-01' },
      ],
    })
    expect(res.status).toBe(200)

    const amb = await db.ambassador.findUnique({
      where: { email: EMAIL },
      include: { products: { orderBy: { sku: 'asc' } } },
    })
    expect(amb!.products).toHaveLength(2)
    expect(amb!.products[0]).toMatchObject({ sku: SKU_A, name: 'Chair', quantity: 2, note: 'launch batch' })
    // UTC midnight, the convention every dated value here follows.
    expect(amb!.products[0].receivedAt.toISOString()).toBe('2026-03-12T00:00:00.000Z')
    // An omitted note is null, not the string "undefined".
    expect(amb!.products[1].note).toBeNull()
  })

  it('creates an ambassador with no products exactly as it always did', async () => {
    await asAdmin()
    const res = await post({ name: 'Plain', email: EMAIL, commissionPercent: 10, shopId, code: 'PLAIN10' })
    expect(res.status).toBe(200)

    const amb = await db.ambassador.findUnique({ where: { email: EMAIL }, include: { products: true } })
    expect(amb!.products).toHaveLength(0)
  })

  it('refuses a quantity below one, and names the field rather than the form', async () => {
    await asAdmin()
    const res = await post({
      name: 'Bad', email: EMAIL, commissionPercent: 10, shopId, code: 'BADQTY10',
      products: [{ sku: SKU_A, name: 'Chair', quantity: 0, receivedAt: '2026-03-12' }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Quantity must be at least 1')
    // Refused before anything was written.
    expect(await db.ambassador.findUnique({ where: { email: EMAIL } })).toBeNull()
  })

  it('refuses a date it cannot read, rather than storing Invalid Date', async () => {
    await asAdmin()
    const res = await post({
      name: 'Bad', email: EMAIL, commissionPercent: 10, shopId, code: 'BADDATE10',
      products: [{ sku: SKU_A, name: 'Chair', quantity: 1, receivedAt: 'the other tuesday' }],
    })
    expect(res.status).toBe(400)
    expect(await db.ambassador.findUnique({ where: { email: EMAIL } })).toBeNull()
  })

  it('leaves nothing behind when the code is already taken', async () => {
    // A refused create writes neither the ambassador nor its gifts. Note what
    // this does and does not prove: the 409 comes from the ambassador insert
    // itself, so a two-step create-then-gift version would pass this too. The
    // failure a single nested write actually rules out is the other order —
    // ambassador written, gifts fail, 500 returned, and the retry meets "that
    // email is taken" with no way to finish the job. That one is prevented by
    // construction, not by this test.
    await asAdmin()
    await post({ name: 'First', email: OTHER_EMAIL, commissionPercent: 10, shopId, code: 'TAKEN10' })

    const before = await db.ambassadorProduct.count({ where: { sku: SKU_A } })
    const res = await post({
      name: 'Second', email: EMAIL, commissionPercent: 10, shopId, code: 'TAKEN10',
      products: [{ sku: SKU_A, name: 'Chair', quantity: 1, receivedAt: '2026-03-12' }],
    })

    expect(res.status).toBe(409)
    expect(await db.ambassadorProduct.count({ where: { sku: SKU_A } })).toBe(before)
    expect(await db.ambassador.findUnique({ where: { email: EMAIL } })).toBeNull()
  })
})
