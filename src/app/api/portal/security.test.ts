import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { assertAmbassadorAccess, canViewAmbassador, AuthError } from '@/lib/auth/guard'
import type { SessionUser } from '@/lib/auth/session'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

/**
 * The single most important rule in the system:
 * an ambassador can NEVER see another ambassador's money.
 * If this test ever fails, the product is broken and must not ship.
 */
const emma: SessionUser = { userId: 'u2', email: 'emma@x.c', role: 'AMBASSADOR', ambassadorId: 'emma-id' }
const johan: SessionUser = { userId: 'u3', email: 'johan@x.c', role: 'AMBASSADOR', ambassadorId: 'johan-id' }
const admin: SessionUser = { userId: 'u1', email: 'a@x.c', role: 'ADMIN', ambassadorId: null }

describe('ambassador data isolation', () => {
  it('lets Emma see Emma', () => {
    expect(() => assertAmbassadorAccess(emma, 'emma-id')).not.toThrow()
  })

  it('STOPS Emma seeing Johan', () => {
    expect(() => assertAmbassadorAccess(emma, 'johan-id')).toThrow(AuthError)
  })

  it('STOPS Johan seeing Emma', () => {
    expect(() => assertAmbassadorAccess(johan, 'emma-id')).toThrow(AuthError)
  })

  it('STOPS a logged-out visitor seeing anyone', () => {
    expect(() => assertAmbassadorAccess(null, 'emma-id')).toThrow(AuthError)
  })

  it('lets an admin see anyone', () => {
    expect(canViewAmbassador(admin, 'emma-id')).toBe(true)
    expect(canViewAmbassador(admin, 'johan-id')).toBe(true)
  })

  it('an ambassador with no linked ambassador record can see nobody', () => {
    const orphan: SessionUser = { userId: 'u9', email: 'x@x.c', role: 'AMBASSADOR', ambassadorId: null }
    expect(canViewAmbassador(orphan, 'emma-id')).toBe(false)
  })
})

// The rule above holds at the guard function. This proves it holds
// end-to-end, through the real portal route, against a real B2B order.
const TAG = '[portal-test]'
const AMB_EMAIL = 'security-b2b-amb@example.local'
let shopId = ''
let ambassadorId = ''

// FK-safe order: Order.b2bCustomer is onDelete: Restrict, so orders must go
// before their B2B customers, which must go before the shops they belong to.
async function cleanup() {
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.b2bCustomer.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.ambassador.deleteMany({ where: { email: AMB_EMAIL } }) // cascades its codes
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeEach(async () => {
  await cleanup()
  const shop = await db.shop.create({ data: { name: `Security shop ${TAG}`, currency: 'EUR' } })
  shopId = shop.id
  const amb = await db.ambassador.create({
    data: {
      name: 'Security Amb', email: AMB_EMAIL, commissionRate: 0.1,
      codes: { create: { code: 'SECURITY1', shopId } },
    },
  })
  ambassadorId = amb.id
})
afterEach(cleanup)

const asAmbassador = async (qs = '') => {
  cookieValue.current = await signSession({
    userId: 'sec-amb', email: AMB_EMAIL, role: 'AMBASSADOR', ambassadorId,
  })
  return GET(new Request(`http://localhost/api/portal${qs}`))
}

describe('a B2B order through the real portal route', () => {
  it('never shows a B2B order to an ambassador, or pays commission on one', async () => {
    // A B2B order carries no coupon and no ambassadorId by construction. Pin it,
    // because "by construction" is exactly the kind of claim that quietly stops
    // being true.
    const customer = await db.b2bCustomer.create({
      data: { shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 0 },
    })
    await db.order.create({
      data: {
        shopId, externalId: 'b2b:B-0001', number: 'B-0001', placedAt: new Date('2026-07-01'),
        status: 'completed', currency: 'EUR', grossSales: 100000, discountTotal: 0,
        netSales: 100000, shippingCharged: 0, taxTotal: 0, total: 100000,
        customerName: `Nordic ${TAG}`, customerEmail: '', b2bCustomerId: customer.id,
      },
    })

    const body = await (await asAmbassador('?from=2026-07-01&to=2026-07-31')).json()
    expect(body.sales).toBe(0)
    expect(body.commission).toBe(0)
    expect(JSON.stringify(body)).not.toContain('B-0001')
  })
})
