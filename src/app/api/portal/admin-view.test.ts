import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const ADMIN_EMAIL = 'plan-adminportal@example.local'
const SHOP = 'plan-adminportal-shop'
let shopId = ''
let ambId = ''

async function wipe() {
  await db.shop.deleteMany({ where: { name: SHOP } }) // cascades its orders + codes
  await db.ambassador.deleteMany({ where: { email: ADMIN_EMAIL } })
}

beforeEach(async () => {
  await wipe()
  const shop = await db.shop.create({ data: { name: SHOP, currency: 'USD' } })
  shopId = shop.id
  const amb = await db.ambassador.create({
    data: {
      name: 'Owner Amb',
      email: ADMIN_EMAIL,
      commissionRate: 0.1,
      codes: { create: { code: 'OWNERSELF', shopId } },
    },
  })
  ambId = amb.id
  await db.order.create({
    data: {
      shopId, externalId: 'ap-1', number: '#ap-1', placedAt: new Date(), status: 'completed',
      currency: 'USD', grossSales: 10000, discountTotal: 0, netSales: 10000,
      shippingCharged: 0, taxTotal: 0, total: 10000, ambassadorId: ambId,
    },
  })
})

afterEach(wipe)

const portalAs = async (role: 'ADMIN' | 'AMBASSADOR', email: string, ambassadorId: string | null) => {
  cookieValue.current = await signSession({ userId: 'u', email, role, ambassadorId })
  return GET(new Request('http://localhost/api/portal?preset=this_month'))
}

describe('an admin viewing their own ambassador portal', () => {
  it('shows the ambassador that shares the admin email', async () => {
    const res = await portalAs('ADMIN', ADMIN_EMAIL, null)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('Owner Amb')
    expect(body.codes).toContain('OWNERSELF')
    expect(body.sales).toBeGreaterThan(0) // the order above is theirs
  })

  it('an admin with no ambassador of their own gets a clear 404, not a crash', async () => {
    const res = await portalAs('ADMIN', 'plan-adminportal-none@example.local', null)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/ambassador/i)
  })

  it('a signed-out visitor still cannot read the portal', async () => {
    cookieValue.current = undefined
    expect((await GET(new Request('http://localhost/api/portal?preset=this_month'))).status).toBe(403)
  })
})
