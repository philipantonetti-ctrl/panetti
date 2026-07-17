import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { POST } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/shops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[post-test]' } } })
}
beforeEach(cleanup)
afterEach(cleanup)

describe('POST /api/shops', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await post({ name: 'Nope [post-test]', currency: 'NOK' })).status).toBe(403)
  })

  it('refuses an ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'u', email: 'amb@test.local', role: 'AMBASSADOR', ambassadorId: 'x',
    })
    expect((await post({ name: 'Nope [post-test]', currency: 'NOK' })).status).toBe(403)
  })

  it('creates a shop with no credentials, ready to connect', async () => {
    await asAdmin()
    const res = await post({ name: 'Panetti Norway [post-test]', currency: 'nok' })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.shop).toMatchObject({ name: 'Panetti Norway [post-test]', currency: 'NOK' })
    expect(body.shop.id).toBeTruthy()

    const saved = await db.shop.findFirstOrThrow({ where: { name: 'Panetti Norway [post-test]' } })
    expect(saved.currency).toBe('NOK') // uppercased
    expect(saved.wooUrl).toBeNull()
    expect(saved.active).toBe(true)
  })

  it('rejects an empty name', async () => {
    await asAdmin()
    expect((await post({ name: '   ', currency: 'NOK' })).status).toBe(400)
  })

  it('rejects a made-up currency code', async () => {
    await asAdmin()
    expect((await post({ name: 'Bad Currency [post-test]', currency: 'KRONER' })).status).toBe(400)
  })

  it('rejects a duplicate name, even with different casing', async () => {
    await asAdmin()
    await post({ name: 'Twice [post-test]', currency: 'NOK' })
    const res = await post({ name: 'TWICE [post-test]', currency: 'SEK' })
    expect(res.status).toBe(409)
  })
})
