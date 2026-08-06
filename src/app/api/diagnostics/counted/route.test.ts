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

const MARK = '[counted-test]'
let shopId = ''

async function wipe() {
  await db.order.deleteMany({ where: { shop: { name: { contains: MARK } } } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

beforeEach(async () => {
  await wipe()
  shopId = (
    await db.shop.create({
      data: { name: `Sweden ${MARK}`, currency: 'SEK', timezone: 'Europe/Stockholm' },
    })
  ).id
})
afterEach(wipe)

const order = (
  number: string,
  placedAt: string,
  status: string,
  total: number,
  voidedAt: string | null = null,
) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status,
      currency: 'SEK', grossSales: total, discountTotal: 0, netSales: total,
      shippingCharged: 0, taxTotal: 0, total,
      ...(voidedAt ? { voidedAt: new Date(voidedAt) } : {}),
    },
  })

const get = (qs: string) => GET(new Request(`http://localhost/api/diagnostics/counted?${qs}`))

describe('GET /api/diagnostics/counted', () => {
  it('refuses a non-admin: it lists real orders and real money', async () => {
    cookieValue.current = undefined
    expect((await get('from=2026-08-05&to=2026-08-05')).status).toBe(403)
  })

  it('names the orders behind the count, and why each of the rest was dropped', async () => {
    await asAdmin()
    // The shape of the argument this exists to settle: the store shows four
    // orders on one day and the dashboard says a smaller number.
    await order('13752', '2026-08-05T06:26:00Z', 'cancelled', 569800, '2026-08-05T06:30:00Z')
    await order('13753', '2026-08-05T07:36:00Z', 'completed', 569800)
    await order('13754', '2026-08-05T13:40:00Z', 'completed', 569800)
    await order('13755', '2026-08-05T18:31:00Z', 'completed', 1049700)
    // Placed just before midnight in Stockholm the night before — the case
    // that reads as "an order went missing" when it is simply another day.
    await order('13751', '2026-08-04T21:10:00Z', 'completed', 569800)
    // Paid for by bank transfer and not yet cleared: real, but not revenue.
    await order('13756', '2026-08-05T19:00:00Z', 'on-hold', 569800)

    const body = await (await get(`from=2026-08-05&to=2026-08-05&shops=${shopId}`)).json()
    const shop = body.shops.find((s: { shopId: string }) => s.shopId === shopId)

    // The cancelled order appears TWICE on purpose — the sale on the day it was
    // placed and its reversal on the day it was cancelled — so the count nets it
    // away rather than pretending it never happened.
    expect(shop.counted.map((c: { order: string }) => c.order).sort()).toEqual([
      '13752', '13752', '13753', '13754', '13755',
    ])
    // Three real sales: 13752's +1 and -1 cancel each other out.
    expect(shop.orderCount).toBe(3)

    const dropped = Object.fromEntries(
      shop.notCounted.map((n: { order: string; reason: string }) => [n.order, n.reason]),
    )
    expect(dropped['13756']).toMatch(/not paid yet/)
    // The cancellation is not in notCounted: it IS counted, twice, netting to
    // zero — the sale on its day and the reversal on the day the money went back.
    expect(dropped['13752']).toBeUndefined()

    // 13751 was placed at 23:10 Stockholm the night before, so the range never
    // loads it at all. Absence would read as a lost order; it is shown as what
    // it is — the same order, one day earlier on this shop's clock.
    const outside = Object.fromEntries(
      shop.justOutside.map((n: { order: string; dayOnShopClock: string }) => [
        n.order,
        n.dayOnShopClock,
      ]),
    )
    expect(outside['13751']).toBe('2026-08-04')

    // Each order carries the day it lands on in the SHOP's clock, which is the
    // fact every one of these arguments has actually turned on.
    const late = shop.counted.find((c: { order: string }) => c.order === '13755')
    expect(late.dayOnShopClock).toBe('2026-08-05')
    expect(shop.timezone).toBe('Europe/Stockholm')
  })

  it('shows a cancellation as a sale and a reversal that cancel out', async () => {
    await asAdmin()
    await order('13752', '2026-08-05T06:26:00Z', 'cancelled', 569800, '2026-08-05T06:30:00Z')

    const body = await (await get(`from=2026-08-05&to=2026-08-05&shops=${shopId}`)).json()
    const shop = body.shops.find((s: { shopId: string }) => s.shopId === shopId)

    expect(shop.counted.map((c: { sign: number }) => c.sign).sort()).toEqual([-1, 1])
    expect(shop.orderCount).toBe(0) // the client's rule: a cancelled order is not a sale
  })
})
