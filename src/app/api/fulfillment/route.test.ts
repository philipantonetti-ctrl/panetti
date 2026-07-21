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

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[fulfillment-test]' } } })
}
beforeEach(cleanup)
afterEach(cleanup)

const del = (id: string) =>
  DELETE(new Request(`http://localhost/api/fulfillment?id=${id}`, { method: 'DELETE' }))

describe('DELETE /api/fulfillment', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await del('whatever')).status).toBe(403)
  })

  it('returns 404 for a rate that does not exist', async () => {
    await asAdmin()
    expect((await del('nope-no-such-id')).status).toBe(404)
  })

  it('deletes a rate', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Rate [fulfillment-test]', currency: 'NOK' } })
    const post = await POST(new Request('http://localhost/api/fulfillment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: shop.id, perOrder: 300, effectiveFrom: '2026-01-01' }),
    }))
    expect(post.status).toBe(200)
    const rate = await db.fulfillmentRate.findFirstOrThrow({ where: { shopId: shop.id } })

    expect((await del(rate.id)).status).toBe(200)
    expect(await db.fulfillmentRate.findUnique({ where: { id: rate.id } })).toBeNull()
  })
})
