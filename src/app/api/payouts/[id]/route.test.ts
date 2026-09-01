import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN' }),
}))

const { db } = await import('@/lib/db')
const { GET } = await import('./route')

const MARK = 'payout-detail-test'

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.payout.deleteMany({ where: { shopId: { in: ids } } })
  await db.order.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
}
afterAll(cleanup)
beforeEach(cleanup)

const get = (id: string) =>
  GET(new Request(`http://localhost/api/payouts/${id}`), { params: Promise.resolve({ id }) })

describe('one payout opened up', () => {
  it('lists every line with its matched order, and the unmatched named as such', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
    const order = await db.order.create({
      data: {
        shopId: shop.id, externalId: 'w1', number: '3041', placedAt: new Date('2026-08-18T10:00:00Z'),
        status: 'completed', currency: 'NOK', grossSales: 5000, discountTotal: 0, netSales: 5000,
        shippingCharged: 0, taxTotal: 1250, total: 6250,
      },
    })
    const payout = await db.payout.create({
      data: {
        shopId: shop.id, externalId: 's1', settledAt: new Date('2026-08-28T09:00:00Z'),
        currency: 'NOK', amount: 9800, capture: 10000, refund: 0, fee: 200, linesPending: false,
      },
    })
    await db.payoutLine.createMany({
      data: [
        { payoutId: payout.id, transactionId: 't1', reference: '3041', amount: 4900, capture: 5000, refund: 0, fee: 100, transactionDate: new Date('2026-08-18'), orderId: order.id },
        { payoutId: payout.id, transactionId: 't2', reference: '9999', amount: 4900, capture: 5000, refund: 0, fee: 100, transactionDate: new Date('2026-08-19') },
      ],
    })

    const body = await (await get(payout.id)).json()

    expect(body.shopName).toBe(`${MARK} NO`)
    expect(body.lines).toHaveLength(2)
    expect(body.lines[0].order).toMatchObject({ number: '3041', status: 'completed', total: 6250 })
    expect(body.lines[1].order).toBeNull()
  })

  it('answers 404 for a payout that does not exist', async () => {
    expect((await get('nope')).status).toBe(404)
  })
})
