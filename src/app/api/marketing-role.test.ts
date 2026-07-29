import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET: listAmbassadors, POST: createAmbassador } = await import('./ambassadors/route')
const { GET: metrics } = await import('./metrics/route')
const { GET: orders } = await import('./orders/route')
const { GET: settings } = await import('./settings/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const MARK = '[mkt-role-test]'
const AMB_EMAIL = 'plan-mkt-role-amb@example.local'

async function wipe() {
  await db.ambassador.deleteMany({ where: { email: AMB_EMAIL } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

beforeEach(async () => {
  await wipe()
  cookieValue.current = await signSession({
    userId: 'mkt-1', email: 'mkt@test.local', role: 'MARKETING', ambassadorId: null,
  })
})

afterEach(wipe)

/**
 * The marketing role in one file: the ambassador half of the house opens,
 * every financial door still answers 403.
 */
describe('what marketing may do', () => {
  it('lists ambassadors', async () => {
    const res = await listAmbassadors()
    expect(res.status).toBe(200)
    expect(Array.isArray((await res.json()).ambassadors)).toBe(true)
  })

  it('creates an ambassador with a code, like an admin would', async () => {
    const shop = await db.shop.create({ data: { name: `Shop ${MARK}`, currency: 'NOK' } })
    const res = await createAmbassador(
      new Request('http://localhost/api/ambassadors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'From Marketing', email: AMB_EMAIL, commissionPercent: 10,
          shopId: shop.id, code: 'MKTROLE10',
        }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await db.ambassador.count({ where: { email: AMB_EMAIL } })).toBe(1)
  })
})

describe('what marketing may never see', () => {
  it('the dashboard metrics answer 403', async () => {
    const res = await metrics(new Request('http://localhost/api/metrics?preset=this_month'))
    expect(res.status).toBe(403)
  })

  it('the orders answer 403', async () => {
    const res = await orders(new Request('http://localhost/api/orders'))
    expect(res.status).toBe(403)
  })

  it('the workspace settings answer 403', async () => {
    const res = await settings()
    expect(res.status).toBe(403)
  })
})
