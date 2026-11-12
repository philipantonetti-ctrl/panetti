import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./route')
const { testSession } = await import('@/lib/auth/test-session')
const { db } = await import('@/lib/db')

/**
 * An ambassador compared our "13" with the shop's "15" and nobody could say
 * which two orders were missing. Their own page now lists them, with why.
 */

const EMAIL = 'plan-notcounted-amb@example.local'
const OTHER = 'plan-notcounted-other@example.local'
const MARK = '[not-counted-test]'

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: { in: [EMAIL, OTHER] } } })
}

const october = () => GET(new Request('http://localhost/api/portal?from=2026-10-01&to=2026-10-31'))

beforeEach(async () => {
  await wipe()
  const shop = await db.shop.create({ data: { name: `Germany ${MARK}`, currency: 'EUR' } })
  const me = await db.ambassador.create({
    data: { name: 'Andi', email: EMAIL, commissionRate: 0.1, codes: { create: { code: 'ANDI50', shopId: shop.id } } },
  })
  const other = await db.ambassador.create({
    data: { name: 'Other', email: OTHER, commissionRate: 0.1, codes: { create: { code: 'OTHER50', shopId: shop.id } } },
  })
  const order = (n: string, status: string, ambassadorId: string) => ({
    shopId: shop.id, externalId: `nc-${n}`, number: n,
    placedAt: new Date('2026-10-05T12:00:00Z'), status, currency: 'EUR',
    grossSales: 10000, discountTotal: 0, netSales: 10000,
    shippingCharged: 0, taxTotal: 0, total: 12500, couponCode: 'ANDI50', ambassadorId,
  })
  await db.order.createMany({
    data: [
      order('301', 'completed', me.id),
      order('302', 'cancelled', me.id),
      order('303', 'failed', me.id),
      order('304', 'cancelled', other.id), // someone else's: never shown
    ],
  })
  cookieValue.current = await testSession({
    userId: 'u-nc', email: EMAIL, role: 'AMBASSADOR', ambassadorId: me.id,
  })
})

afterEach(wipe)

describe('orders with my code that do not count', () => {
  it('lists them with the reason, next to the ones that count', async () => {
    const body = await (await october()).json()
    expect(body.orders).toBe(1)
    expect(body.used).toBe(3)
    expect(body.notCounted.map((o: { number: string }) => o.number).sort()).toEqual(['302', '303'])
    const cancelled = body.notCounted.find((o: { number: string }) => o.number === '302')
    expect(cancelled).toMatchObject({ reason: 'Cancelled', statusLabel: 'Cancelled', shop: `Germany ${MARK}` })
  })

  it('shows the order number on the counted orders too, so they can be compared', async () => {
    const body = await (await october()).json()
    expect(body.recent.map((o: { number: string }) => o.number)).toEqual(['301'])
  })

  it('never carries money or customer details for an order that does not count', async () => {
    const body = await (await october()).json()
    for (const o of body.notCounted) {
      expect(Object.keys(o).sort()).toEqual(['date', 'id', 'number', 'reason', 'shop', 'statusLabel'])
    }
  })
})
