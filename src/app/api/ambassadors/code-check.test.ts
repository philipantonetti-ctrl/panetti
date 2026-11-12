import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./code-check/route')
const { testSession } = await import('@/lib/auth/test-session')
const { db } = await import('@/lib/db')

const MARK = '[code-check-test]'
const SELLER = 'code-check-seller@example.local'
let shopId = ''

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: SELLER } })
}

const order = (n: string, status: string, day: string, extra: Record<string, unknown> = {}) => ({
  shopId, externalId: `cc-${n}`, number: n,
  placedAt: new Date(`${day}T12:00:00Z`), status, currency: 'EUR',
  grossSales: 10000, discountTotal: 0, netSales: 10000,
  shippingCharged: 0, taxTotal: 0, total: 12500, couponCode: 'ANDI50', ...extra,
})

beforeEach(async () => {
  await wipe()
  const shop = await db.shop.create({ data: { name: `Shop ${MARK}`, currency: 'EUR' } })
  shopId = shop.id
  const seller = await db.ambassador.create({
    data: {
      name: 'Code Seller', email: SELLER, commissionRate: 0.1,
      codes: { create: { code: 'ANDI50', shopId } },
    },
  })
  await db.order.createMany({
    data: [
      order('101', 'completed', '2026-10-02', { ambassadorId: seller.id }),
      order('102', 'processing', '2026-10-03', { ambassadorId: seller.id }),
      order('103', 'cancelled', '2026-10-04', { ambassadorId: seller.id }),
      order('104', 'pending', '2026-10-05', { ambassadorId: seller.id }),
      order('105', 'completed', '2026-09-01', { ambassadorId: seller.id }), // outside the period
      order('106', 'completed', '2026-10-06', { couponCode: 'OTHER' }), // another code
    ],
  })
  cookieValue.current = await testSession({
    userId: 'mkt-cc', email: 'mkt@test.local', role: 'MARKETING', ambassadorId: null,
  })
})

afterEach(wipe)

const check = (code: string) =>
  GET(new Request(`http://localhost/api/ambassadors/code-check?code=${encodeURIComponent(code)}&from=2026-10-01&to=2026-10-31`))

describe('code check for staff', () => {
  it('lists every order with the code in the period, and says which count and why', async () => {
    const res = await check('andi50') // typed in lower case, as the shop shows it
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.code).toBe('ANDI50')
    expect(body.used).toBe(4)
    expect(body.counted).toBe(2)
    const byNumber = Object.fromEntries(body.orders.map((o: { number: string }) => [o.number, o]))
    expect(Object.keys(byNumber).sort()).toEqual(['101', '102', '103', '104'])
    expect(byNumber['101']).toMatchObject({ counts: true, reason: null, statusLabel: 'Completed' })
    expect(byNumber['103']).toMatchObject({ counts: false, reason: 'Cancelled' })
    expect(byNumber['104']).toMatchObject({ counts: false, reason: 'Not paid', statusLabel: 'Pending payment' })
  })

  it('says which ambassador the code belongs to', async () => {
    const body = await (await check('ANDI50')).json()
    expect(body.linkedTo).toEqual([{ ambassador: 'Code Seller', shop: `Shop ${MARK}` }])
  })

  it('flags a code no ambassador has, so its sales are not lost silently', async () => {
    await db.order.create({ data: order('201', 'completed', '2026-10-10', { couponCode: 'BLACK100' }) })
    const body = await (await check('black100')).json()
    expect(body.linkedTo).toEqual([])
    expect(body.used).toBe(1)
  })

  it('asks for a code instead of listing every order', async () => {
    const res = await check('  ')
    expect(res.status).toBe(400)
  })

  it('answers an ambassador with 403', async () => {
    cookieValue.current = await testSession({
      userId: 'amb-cc', email: 'amb@test.local', role: 'AMBASSADOR', ambassadorId: 'a-x',
    })
    expect((await check('ANDI50')).status).toBe(403)
  })
})
