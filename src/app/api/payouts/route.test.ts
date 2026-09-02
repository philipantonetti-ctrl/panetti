import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN' }),
}))

const { db } = await import('@/lib/db')
const { GET } = await import('./route')

const MARK = 'payouts-route-test'

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.payout.deleteMany({ where: { shopId: { in: ids } } })
  await db.dinteroConfig.deleteMany({ where: { shopId: { in: ids } } })
  await db.order.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
}
afterAll(cleanup)
beforeEach(cleanup)

const get = (qs = '') => GET(new Request(`http://localhost/api/payouts${qs}`))

describe('payouts list', () => {
  it('returns the range payouts with order counts, and how many we matched', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
    await db.dinteroConfig.create({
      data: { shopId: shop.id, accountId: 'P12345678', clientId: 'x', clientSecret: 'y' },
    })
    const order = await db.order.create({
      data: {
        shopId: shop.id, externalId: 'w1', number: '3041', placedAt: new Date('2026-08-18T10:00:00Z'),
        status: 'completed', currency: 'NOK', grossSales: 5000, discountTotal: 0, netSales: 5000,
        shippingCharged: 0, taxTotal: 1250, total: 6250,
      },
    })
    const payout = await db.payout.create({
      data: {
        shopId: shop.id, externalId: 's1', provider: 'dintero_payout',
        settledAt: new Date('2026-08-28T09:00:00Z'),
        periodStart: new Date('2026-08-17T00:00:00Z'), periodEnd: new Date('2026-08-23T23:59:59Z'),
        currency: 'NOK', amount: 9800, capture: 10000, refund: 0, fee: 200,
        reference: 'DINTERO-42', linesPending: false,
      },
    })
    await db.payoutLine.createMany({
      data: [
        { payoutId: payout.id, transactionId: 't1', reference: '3041', amount: 4900, capture: 5000, refund: 0, fee: 100, orderId: order.id },
        { payoutId: payout.id, transactionId: 't2', reference: '9999', amount: 4900, capture: 5000, refund: 0, fee: 100 },
      ],
    })

    const res = await get('?from=2026-08-01&to=2026-08-31')
    const body = await res.json()

    expect(body.connected).toBe(true)
    const row = body.payouts.find((p: { id: string }) => p.id === payout.id)
    expect(row).toMatchObject({
      shopName: `${MARK} NO`, currency: 'NOK', amount: 9800, fee: 200,
      reference: 'DINTERO-42', orders: 2, matched: 1,
    })
  })

  it('keeps a payout outside the range off the page, except one not yet paid', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
    await db.payout.create({
      data: {
        shopId: shop.id, externalId: 'old', settledAt: new Date('2025-01-05T09:00:00Z'),
        currency: 'NOK', amount: 1, capture: 1, refund: 0, fee: 0,
      },
    })
    await db.payout.create({
      data: { shopId: shop.id, externalId: 'unpaid', settledAt: null, currency: 'NOK', amount: 2, capture: 2, refund: 0, fee: 0 },
    })

    const body = await (await get('?from=2026-08-01&to=2026-08-31')).json()
    const ids = body.payouts.map((p: { shopName: string; amount: number }) => p.amount)
    expect(ids).toContain(2)
    expect(ids).not.toContain(1)
  })

  it('narrows to one shop when asked', async () => {
    const a = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
    const b = await db.shop.create({ data: { name: `${MARK} SE`, currency: 'SEK' } })
    for (const s of [a, b]) {
      await db.payout.create({
        data: {
          shopId: s.id, externalId: 's1', settledAt: new Date('2026-08-28T09:00:00Z'),
          currency: 'NOK', amount: 5, capture: 5, refund: 0, fee: 0,
        },
      })
    }

    const body = await (await get(`?from=2026-08-01&to=2026-08-31&shop=${a.id}`)).json()
    expect(body.payouts).toHaveLength(1)
    expect(body.payouts[0].shopId).toBe(a.id)
  })
})

describe('orders waiting for a payout', () => {
  it('lists a Dintero-paid order older than eight days that no payout contains', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} wait`, currency: 'SEK' } })
    await db.dinteroConfig.create({
      data: { shopId: shop.id, accountId: 'P11114428', clientId: 'x', clientSecret: 'y' },
    })
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
    const base = {
      shopId: shop.id, status: 'completed', currency: 'SEK', grossSales: 5000, discountTotal: 0,
      netSales: 5000, shippingCharged: 0, taxTotal: 1250, total: 6250,
    }
    // Paid through Dintero, 12 days old, in no payout: the one to worry about.
    const worrying = await db.order.create({
      data: { ...base, externalId: '9001', number: '9001', placedAt: days(12), transactionId: 'P1.a' },
    })
    // Placed before the earliest settlement Dintero's API still serves: there
    // is no payout it could have been in, so it is history, not a debt.
    const ancient = await db.order.create({
      data: { ...base, externalId: '9000', number: '9000', placedAt: new Date('2023-01-10T10:00:00Z'), transactionId: 'P1.z' },
    })
    // Too young to worry - payouts come weekly.
    const young = await db.order.create({
      data: { ...base, externalId: '9002', number: '9002', placedAt: days(3), transactionId: 'P1.b' },
    })
    // Not paid through Dintero at all (no gateway marker): not this page's business.
    const other = await db.order.create({
      data: { ...base, externalId: '9003', number: '9003', placedAt: days(12), transactionId: '' },
    })
    // Old and Dintero-paid, but inside a payout already.
    const paid = await db.order.create({
      data: { ...base, externalId: '9004', number: '9004', placedAt: days(12), transactionId: 'P1.c' },
    })
    const payout = await db.payout.create({
      data: {
        shopId: shop.id, externalId: 's-w', currency: 'SEK', amount: 1, capture: 1, refund: 0, fee: 0,
        periodStart: new Date('2024-06-01T00:00:00Z'),
      },
    })
    await db.payoutLine.create({
      data: { payoutId: payout.id, transactionId: 'P1.c', reference: 'x', amount: 1, capture: 1, refund: 0, fee: 0, orderId: paid.id },
    })

    const body = await (await get(`?from=2026-08-01&to=2026-08-31&shop=${shop.id}`)).json()

    const ids = body.waiting.map((w: { id: string }) => w.id)
    expect(ids).toContain(worrying.id)
    expect(ids).not.toContain(young.id)
    expect(ids).not.toContain(other.id)
    expect(ids).not.toContain(paid.id)
    expect(ids).not.toContain(ancient.id)
    const row = body.waiting.find((w: { id: string }) => w.id === worrying.id)
    expect(row).toMatchObject({ number: '9001', shopName: `${MARK} wait`, currency: 'SEK', total: 6250 })
    expect(body.waitingCount).toBe(1)
  })
})
