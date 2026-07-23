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

const EMAIL = 'plan-currency-amb@example.local'
const MARK = '[currency-test]'
const NET = 250000 // 2 500,00 in the shop's own minor units

let ambId = ''
let nokShopId = ''

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
}

// A dated window the seeded FX table already covers, so nothing reaches out to
// the rate provider mid-test.
const portal = () => GET(new Request('http://localhost/api/portal?from=2026-03-01&to=2026-03-31'))

beforeEach(async () => {
  await wipe()
  const nok = await db.shop.create({ data: { name: `Norway ${MARK}`, currency: 'NOK' } })
  nokShopId = nok.id

  const amb = await db.ambassador.create({
    data: {
      name: 'Nordic', email: EMAIL, commissionRate: 0.1,
      codes: { create: { code: 'NORDIC500', shopId: nok.id } },
    },
  })
  ambId = amb.id

  await db.order.create({
    data: {
      shopId: nok.id, externalId: 'cur-1', number: 'cur-1',
      placedAt: new Date('2026-03-10T12:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: NET, discountTotal: 0, netSales: NET,
      shippingCharged: 0, taxTotal: 62500, total: NET + 62500, ambassadorId: amb.id,
    },
  })

  cookieValue.current = await signSession({
    userId: 'u-cur', email: EMAIL, role: 'AMBASSADOR', ambassadorId: amb.id,
  })
})

afterEach(wipe)

describe('the portal reports in the webshop’s own currency', () => {
  it('shows NOK, unconverted, for an ambassador who sells on one Norwegian store', async () => {
    const res = await portal()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.currency).toBe('NOK')
    // The shop's own money, untouched — not run through a USD rate.
    expect(body.sales).toBe(NET)
    expect(body.commission).toBe(Math.round(NET * 0.1))
    expect(body.recent[0].sales).toBe(NET)
  })

  it('consolidates to USD when their codes span currencies', async () => {
    const sek = await db.shop.create({ data: { name: `Sweden ${MARK}`, currency: 'SEK' } })
    await db.ambassadorCode.create({ data: { ambassadorId: ambId, code: 'NORDIC500', shopId: sek.id } })

    const body = await (await portal()).json()
    expect(body.currency).toBe('USD')
    // The NOK sale is now converted, so it is no longer the raw figure.
    expect(body.sales).not.toBe(NET)
  })

  it('still reports the VAT-free net sale, never the amount the customer paid', async () => {
    const body = await (await portal()).json()
    // The order charged NET + 62500 VAT; only the net belongs to the ambassador.
    expect(body.sales).toBe(NET)
    expect(body.sales).not.toBe(NET + 62500)
  })
})

// Keep the unused binding meaningful for readers of the fixture above.
void nokShopId
