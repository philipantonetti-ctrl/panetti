import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET: getAmbassadors } = await import('@/app/api/ambassadors/route')
const { GET: getPortal } = await import('@/app/api/portal/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const MINE = 'plan-reads-mine@example.local'
const THEIRS = 'plan-reads-theirs@example.local'
let mineId = ''
let theirsId = ''

async function cleanup() {
  await db.ambassador.deleteMany({ where: { email: { in: [MINE, THEIRS] } } })
}

beforeEach(async () => {
  await cleanup()
  const mine = await db.ambassador.create({
    data: { name: 'Mine', email: MINE, commissionRate: 0.1 },
  })
  const theirs = await db.ambassador.create({
    data: { name: 'Theirs', email: THEIRS, commissionRate: 0.1 },
  })
  mineId = mine.id
  theirsId = theirs.id

  await db.ambassadorProduct.create({
    data: {
      ambassadorId: mineId, sku: 'MPX-001', name: 'Pro X', quantity: 2,
      receivedAt: new Date('2026-03-12T00:00:00Z'), note: 'internal only',
    },
  })
  await db.ambassadorProduct.create({
    data: {
      ambassadorId: theirsId, sku: 'MACBL661', name: 'Advanced Comfort', quantity: 1,
      receivedAt: new Date('2026-04-01T00:00:00Z'),
    },
  })
})

afterEach(async () => {
  await cleanup()
  cookieValue.current = undefined
})

describe('GET /api/ambassadors', () => {
  it('carries each ambassador their products', async () => {
    cookieValue.current = await signSession({
      userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
    })

    const body = (await (await getAmbassadors()).json()) as {
      ambassadors: { id: string; products: { sku: string; quantity: number; note: string | null }[] }[]
    }
    const row = body.ambassadors.find((a) => a.id === mineId)
    expect(row!.products).toEqual([
      expect.objectContaining({ sku: 'MPX-001', quantity: 2, note: 'internal only' }),
    ])
  })
})

describe('GET /api/portal', () => {
  const portal = () => getPortal(new Request('http://localhost/api/portal?preset=this_month'))

  it('shows an ambassador their own products and nobody else’s', async () => {
    cookieValue.current = await signSession({
      userId: 'test-amb', email: MINE, role: 'AMBASSADOR', ambassadorId: mineId,
    })

    const body = (await (await portal()).json()) as {
      products: { sku: string; quantity: number }[]
    }
    expect(body.products).toHaveLength(1)
    expect(body.products[0]).toMatchObject({ sku: 'MPX-001', quantity: 2 })
  })

  it('never sends the internal note to the ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'test-amb', email: MINE, role: 'AMBASSADOR', ambassadorId: mineId,
    })

    const body = (await (await portal()).json()) as { products: Record<string, unknown>[] }
    expect(body.products[0]).not.toHaveProperty('note')
  })
})
