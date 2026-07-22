import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

// The store is never actually called in tests; we assert how the route behaves
// around the fetch, not WooCommerce itself.
const fetchCouponsMock = vi.fn()
vi.mock('@/lib/woo/client', () => ({ fetchCoupons: (...args: unknown[]) => fetchCouponsMock(...args) }))

const { GET } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')
const { encryptSecret } = await import('@/lib/secrets')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[coupon-test]' } } })
}
beforeEach(() => {
  cookieValue.current = undefined
  fetchCouponsMock.mockReset()
  return cleanup()
})
afterEach(cleanup)

const get = (qs: string) => GET(new Request(`http://localhost/api/coupons${qs}`))

const connectedShop = (name: string) =>
  db.shop.create({
    data: {
      name, currency: 'NOK', wooUrl: 'https://s.example',
      wooKey: encryptSecret('ck'), wooSecret: encryptSecret('cs'),
    },
  })

describe('GET /api/coupons', () => {
  it('refuses a non-admin', async () => {
    expect((await get('?shopId=x')).status).toBe(403)
  })

  it('needs a shopId', async () => {
    await asAdmin()
    expect((await get('')).status).toBe(400)
  })

  it('404 for an unknown store', async () => {
    await asAdmin()
    expect((await get('?shopId=nope')).status).toBe(404)
  })

  it('returns the store coupon codes', async () => {
    await asAdmin()
    const shop = await connectedShop('Coupons [coupon-test]')
    fetchCouponsMock.mockResolvedValue(['JOHN10', 'SUMMER'])

    const res = await get(`?shopId=${shop.id}`)
    expect(res.status).toBe(200)
    expect((await res.json()).codes).toEqual(['JOHN10', 'SUMMER'])
  })

  it('reports a store that will not answer, without crashing', async () => {
    await asAdmin()
    const shop = await connectedShop('Bad [coupon-test]')
    fetchCouponsMock.mockRejectedValue(new Error('boom'))
    expect((await get(`?shopId=${shop.id}`)).status).toBe(502)
  })

  it('400 for a store with no WooCommerce connection', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Unconnected [coupon-test]', currency: 'NOK' } })
    expect((await get(`?shopId=${shop.id}`)).status).toBe(400)
  })
})
