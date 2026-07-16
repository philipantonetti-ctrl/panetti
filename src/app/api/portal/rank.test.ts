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

const EMAILS = ['plan-rank-1@example.local', 'plan-rank-2@example.local']
const SHOP_NAME = 'plan-rank-test-shop'
const ids: string[] = []
let shopId = ''

// The seed's 24 ambassadors all live at @ambassador.test (see prisma/seed.ts) — a
// stable, known set, distinct from every other test file's own @example.local
// fixtures. Scoping to it means our cleanup can never reactivate (or our setup
// never deactivates) an ambassador that a DIFFERENT, concurrently running test
// file created and is relying on — this suite runs against one shared live DB.
const SEEDED = { email: { endsWith: '@ambassador.test' } }

async function wipe() {
  await db.ambassador.deleteMany({ where: { email: { in: EMAILS } } })
  await db.shop.deleteMany({ where: { name: SHOP_NAME } }) // cascades: removes the orders we created too
  // One scenario below deliberately deactivates the whole SEEDED population, to
  // reproduce "everyone but me is deactivated". Always put it back.
  await db.ambassador.updateMany({ where: { ...SEEDED, active: false }, data: { active: true } })
}

let orderSeq = 0
/** A minimal, valid order for `ambassadorId`, dated today — always inside "this_month". */
async function mkOrder(ambassadorId: string, netSales: number) {
  orderSeq += 1
  await db.order.create({
    data: {
      shopId,
      externalId: `plan-rank-${orderSeq}`,
      number: `#plan-rank-${orderSeq}`,
      placedAt: new Date(),
      status: 'completed',
      currency: 'USD',
      grossSales: netSales,
      discountTotal: 0,
      netSales,
      shippingCharged: 0,
      taxTotal: 0,
      total: netSales,
      ambassadorId,
    },
  })
}

beforeEach(async () => {
  await wipe()
  ids.length = 0
  const shop = await db.shop.create({ data: { name: SHOP_NAME, currency: 'USD' } })
  shopId = shop.id
  for (const email of EMAILS) {
    const a = await db.ambassador.create({ data: { name: email, email, commissionRate: 0.1 } })
    const u = await db.user.create({
      data: { email, passwordHash: 'x', role: 'AMBASSADOR', ambassadorId: a.id },
    })
    ids.push(a.id)
    if (email === EMAILS[0]) {
      cookieValue.current = await signSession({
        userId: u.id, email, role: 'AMBASSADOR', ambassadorId: a.id,
      })
    }
  }
})

afterEach(wipe)

const portal = () => GET(new Request('http://localhost/api/portal?preset=this_month'))

describe('portal rank invariant', () => {
  // Whatever the population, you can never be 9th of 8.
  it('never reports a rank greater than the total', async () => {
    await mkOrder(ids[0], 1) // a real sale — puts me in the ranked population
    const res = await portal()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rank).toBeLessThanOrEqual(body.totalAmbassadors)
    expect(body.rank).toBeGreaterThanOrEqual(1)
  })

  it('holds when another ambassador is deactivated', async () => {
    await mkOrder(ids[0], 1)
    await mkOrder(ids[1], 999_999) // the other ambassador has real sales too
    await db.ambassador.update({ where: { id: ids[1] }, data: { active: false } })
    const body = await (await portal()).json()
    expect(body.rank).toBeLessThanOrEqual(body.totalAmbassadors)
    expect(body.rank).toBeGreaterThanOrEqual(1)
  })

  it('holds when I am deactivated myself', async () => {
    await mkOrder(ids[0], 1)
    await db.ambassador.update({ where: { id: ids[0] }, data: { active: false } })
    const body = await (await portal()).json()
    expect(body.rank).toBeLessThanOrEqual(body.totalAmbassadors)
    expect(body.rank).toBeGreaterThanOrEqual(1)
  })

  it('holds when EVERY other ambassador is deactivated', async () => {
    // A tiny sale of my own — every seeded ambassador with genuine sales this
    // month will still outrank it, so `better` stays large even as the old
    // active-only total collapses. Deactivate the seeded population plus my one
    // fellow test ambassador — i.e. everyone but me — never anyone else's fixture.
    await mkOrder(ids[0], 1)
    await db.ambassador.updateMany({ where: { OR: [SEEDED, { id: ids[1] }] }, data: { active: false } })
    const body = await (await portal()).json()
    expect(body.rank).toBeLessThanOrEqual(body.totalAmbassadors)
    expect(body.rank).toBeGreaterThanOrEqual(1)
  })

  // I have no orders in range, so I am absent from the groupBy population.
  it('holds when I have no sales at all in the range', async () => {
    const body = await (await portal()).json()
    // Nothing to rank me on — never a bogus number, but the invariant (if a
    // rank IS reported, it cannot exceed the total) still must not be violated.
    if (body.rank !== null) expect(body.rank).toBeLessThanOrEqual(body.totalAmbassadors)
    expect(body.totalAmbassadors).toBeGreaterThanOrEqual(1) // I am always counted in my own population
  })
})
