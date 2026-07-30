import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { DELETE } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const EMAIL = 'plan-giftdel-amb@example.local'
let ambassadorId = ''
let giftId = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const call = (target: string) =>
  DELETE(new Request('http://localhost/api/ambassador-products/x', { method: 'DELETE' }), {
    params: Promise.resolve({ id: target }),
  })

async function cleanup() {
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
}

beforeEach(async () => {
  await cleanup()
  const a = await db.ambassador.create({
    data: { name: 'Gift Del', email: EMAIL, commissionRate: 0.1 },
  })
  ambassadorId = a.id
  const g = await db.ambassadorProduct.create({
    data: {
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1,
      receivedAt: new Date('2026-03-12T00:00:00Z'),
    },
  })
  giftId = g.id
  await asAdmin()
})

afterEach(async () => {
  await cleanup()
  cookieValue.current = undefined
})

describe('DELETE /api/ambassador-products/[id]', () => {
  it('removes the record', async () => {
    expect((await call(giftId)).status).toBe(200)
    expect(await db.ambassadorProduct.count({ where: { ambassadorId } })).toBe(0)
  })

  it('404s for an id that is not there, so a no-op never reports success', async () => {
    const res = await call('does-not-exist')
    expect(res.status).toBe(404)
    // The real one is untouched.
    expect(await db.ambassadorProduct.count({ where: { ambassadorId } })).toBe(1)
  })

  it('answers an ambassador with 403', async () => {
    cookieValue.current = await signSession({
      userId: 'test-amb', email: EMAIL, role: 'AMBASSADOR', ambassadorId,
    })
    expect((await call(giftId)).status).toBe(403)
    expect(await db.ambassadorProduct.count({ where: { ambassadorId } })).toBe(1)
  })
})
