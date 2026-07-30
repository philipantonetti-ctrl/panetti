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

const EMAIL = 'plan-giftroute-amb@example.local'
const MARK = '[gift-route-test]'
let ambassadorId = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}
const asMarketing = async () => {
  cookieValue.current = await signSession({
    userId: 'test-mkt', email: 'mkt@test.local', role: 'MARKETING', ambassadorId: null,
  })
}
const asAmbassador = async () => {
  cookieValue.current = await signSession({
    userId: 'test-amb', email: EMAIL, role: 'AMBASSADOR', ambassadorId,
  })
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/ambassador-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

async function cleanup() {
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

beforeEach(async () => {
  await cleanup()
  const a = await db.ambassador.create({
    data: { name: 'Gift Test', email: EMAIL, commissionRate: 0.1 },
  })
  ambassadorId = a.id
  await asAdmin()
})

afterEach(async () => {
  await cleanup()
  cookieValue.current = undefined
})

describe('POST /api/ambassador-products', () => {
  it('records a gift and it shows up in the overview', async () => {
    const res = await post({
      ambassadorId, sku: 'MACBL661', name: 'Advanced Comfort',
      quantity: 2, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(200)

    const overview = (await (await GET()).json()) as {
      overview: { sku: string; ambassadors: number; units: number }[]
    }
    const row = overview.overview.find((r) => r.sku === 'MACBL661')
    expect(row).toMatchObject({ ambassadors: 1, units: 2 })
  })

  it('stores the date at UTC midnight, like every other date here', async () => {
    await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X',
      quantity: 1, receivedAt: '2026-03-12',
    })
    const stored = await db.ambassadorProduct.findFirst({ where: { ambassadorId } })
    expect(stored!.receivedAt.toISOString()).toBe('2026-03-12T00:00:00.000Z')
  })

  it('refuses a quantity below one', async () => {
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 0, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('at least 1')
  })

  it('refuses an unparseable date', async () => {
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: 'not-a-date',
    })
    expect(res.status).toBe(400)
    // Assert WHICH rejection: a 400 for the wrong reason would otherwise pass.
    expect((await res.json()).error).toContain('date they got it')
  })

  it('refuses a note longer than 200 characters', async () => {
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1,
      receivedAt: '2026-03-12', note: 'x'.repeat(201),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('200 characters')
  })

  it('stores a blank note as null, never an empty string', async () => {
    // An empty string is the ONLY case that discriminates. With `note` omitted,
    // `d.note` is undefined, Prisma drops the key from the INSERT, and the
    // defaultless nullable column yields null under `||`, under `??`, and under
    // no fallback at all — so an omitted note proves nothing about the code.
    // An explicit '' is where they finally diverge: `'' || null` is null (what
    // we want), `'' ?? null` is '' (what the UI would then print as a blank
    // note line). This test fails the moment someone "modernises" || to ??.
    await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1,
      receivedAt: '2026-03-12', note: '',
    })
    const stored = await db.ambassadorProduct.findFirst({ where: { ambassadorId } })
    expect(stored!.note).toBeNull()
  })

  it('404s for an ambassador who does not exist', async () => {
    const res = await post({
      ambassadorId: 'nope', sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(404)
  })

  it('lets marketing record a gift — they run the program', async () => {
    await asMarketing()
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(200)
  })

  it('answers an ambassador with 403 on both verbs', async () => {
    await asAmbassador()
    expect((await GET()).status).toBe(403)
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/ambassador-products', () => {
  it('offers each SKU once, however many shops sell it', async () => {
    const shopA = await db.shop.create({ data: { name: `A ${MARK}`, currency: 'NOK' } })
    const shopB = await db.shop.create({ data: { name: `B ${MARK}`, currency: 'SEK' } })
    // The same physical product, listed in two shops — the exact situation the
    // whole sku-not-productId decision exists for.
    await db.product.create({
      data: { shopId: shopA.id, externalId: '1', sku: 'DUP-1', name: 'Duplicated Chair' },
    })
    await db.product.create({
      data: { shopId: shopB.id, externalId: '1', sku: 'DUP-1', name: 'Duplicated Chair' },
    })

    const body = (await (await GET()).json()) as { catalogue: { sku: string }[] }
    expect(body.catalogue.filter((c) => c.sku === 'DUP-1')).toHaveLength(1)
  })
})
