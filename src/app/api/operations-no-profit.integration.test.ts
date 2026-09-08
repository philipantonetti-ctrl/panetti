import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role } from '@/lib/auth/session'

/**
 * What a product costs us, and what an order earned, never reach the operations
 * manager's browser.
 *
 * The client's rule: he runs the five tabs in full and does not see profit. The
 * page hiding a column would not be that - the number would still be in the
 * JSON, one devtools tab away - so the four routes that compute a cost strip it
 * server-side, and this file proves the numbers are absent from the wire.
 *
 * Each case asserts BOTH directions on the same fixture: the admin still gets
 * the figure, and he does not. A test that only checked the absence would pass
 * just as happily against a route that had stopped computing anything at all.
 */

const state = vi.hoisted(() => ({ role: 'ADMIN' as Role }))

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: async () => ({
    userId: 'u1',
    email: 'someone@ecom.test',
    role: state.role,
    ambassadorId: null,
  }),
}))

const { db } = await import('@/lib/db')
const orders = await import('./orders/route')
const productAnalytics = await import('./products/analytics/route')
const products = await import('./products/route')
const b2bCustomer = await import('./b2b/customers/[id]/route')

const MARK = 'ops-no-profit-test'
const FROM = '2026-03-01'
const TO = '2026-03-31'
const PLACED = new Date('2026-03-10T10:00:00Z')

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.b2bCustomer.deleteMany({ where: { shopId: { in: ids } } })
  await db.order.deleteMany({ where: { shopId: { in: ids } } })
  await db.product.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
}
afterAll(cleanup)

type Fixture = { shopId: string; productId: string; customerId: string }

async function seed(): Promise<Fixture> {
  await cleanup()
  const shop = await db.shop.create({
    data: { name: `${MARK} NO`, currency: 'NOK', active: true, timezone: 'Europe/Oslo' },
  })
  const product = await db.product.create({
    data: {
      shopId: shop.id,
      externalId: 'p-1',
      sku: `${MARK}-SKU`,
      name: 'Pizza oven',
      lastPrice: 400000,
      catalogPrice: 500000,
      // The cost that must never leave the building.
      costs: {
        create: { costPerItem: 150000, handlingCost: 2500, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
      },
    },
  })
  await db.order.create({
    data: {
      shopId: shop.id,
      externalId: 'o-1',
      number: '7001',
      placedAt: PLACED,
      status: 'completed',
      currency: 'NOK',
      grossSales: 400000,
      discountTotal: 0,
      netSales: 400000,
      shippingCharged: 0,
      taxTotal: 100000,
      total: 500000,
      items: {
        create: {
          productId: product.id,
          sku: `${MARK}-SKU`,
          name: 'Pizza oven',
          quantity: 1,
          unitPrice: 400000,
          lineNetTotal: 400000,
        },
      },
    },
  })
  const customer = await db.b2bCustomer.create({
    data: {
      shopId: shop.id,
      name: `${MARK} Bakery`,
      currency: 'EUR',
      vatPercent: 0,
      prices: { create: { productId: product.id, unitPrice: 35000 } },
    },
  })
  return { shopId: shop.id, productId: product.id, customerId: customer.id }
}

/** Runs one request twice, once as each role, and hands back both bodies. */
async function bothWays<T>(call: () => Promise<Response>): Promise<{ admin: T; ops: T }> {
  state.role = 'ADMIN'
  const admin = (await (await call()).json()) as T
  state.role = 'OPERATIONS'
  const ops = (await (await call()).json()) as T
  state.role = 'ADMIN'
  return { admin, ops }
}

let fixture: Fixture
beforeEach(async () => {
  fixture = await seed()
})

describe('the Orders tab', () => {
  const call = (shopId: string) => () =>
    orders.GET(new Request(`http://localhost/api/orders?from=${FROM}&to=${TO}&shops=${shopId}`))

  it('gives the admin the per-order figures and gives him none', async () => {
    type Body = { orders: { number: string; figures: { profit: number } | null }[] }
    const { admin, ops } = await bothWays<Body>(call(fixture.shopId))

    const mine = admin.orders.find((o) => o.number === '7001')
    expect(mine?.figures?.profit, 'the admin still sees the profit').toBeTypeOf('number')

    const his = ops.orders.find((o) => o.number === '7001')
    expect(his, 'he still sees the order itself').toBeDefined()
    expect(his?.figures).toBeNull()
  })

  it('still shows him what the customer paid - that is not our margin', async () => {
    type Body = { orders: { number: string; total: number; netSales: number; taxTotal: number }[] }
    const { ops } = await bothWays<Body>(call(fixture.shopId))
    const his = ops.orders.find((o) => o.number === '7001')
    expect(his?.total).toBe(500000)
    expect(his?.netSales).toBe(400000)
    expect(his?.taxTotal).toBe(100000)
  })

  it('leaves no cost, fee, commission or margin anywhere in the JSON he receives', async () => {
    state.role = 'OPERATIONS'
    const raw = await (await call(fixture.shopId)()).text()
    for (const word of ['cogs', 'commission', 'margin', 'profit', 'fulfillment']) {
      expect(raw.toLowerCase(), `"${word}" reached him`).not.toContain(`"${word}"`)
    }
  })
})

describe('the Products tab', () => {
  const call = (shopId: string) => () =>
    productAnalytics.GET(
      new Request(`http://localhost/api/products/analytics?from=${FROM}&to=${TO}&shops=${shopId}`),
    )

  it('gives the admin COGS, profit and margin and gives him none', async () => {
    type Row = Record<string, unknown> & { sku: string; stores: Record<string, unknown>[] }
    type Body = { rows: Row[]; total: Record<string, unknown> }
    const { admin, ops } = await bothWays<Body>(call(fixture.shopId))

    const theirs = admin.rows.find((r) => r.sku === `${MARK}-SKU`)
    expect(theirs?.profit, 'the admin still sees the profit').toBeTypeOf('number')
    expect(theirs?.cogs).toBeTypeOf('number')

    const his = ops.rows.find((r) => r.sku === `${MARK}-SKU`)
    expect(his, 'he still sees the product row').toBeDefined()
    for (const key of ['cogs', 'profit', 'margin']) {
      expect(his, `row still carries ${key}`).not.toHaveProperty(key)
      expect(ops.total, `the totals row still carries ${key}`).not.toHaveProperty(key)
      expect(his!.stores[0], `the per-store row still carries ${key}`).not.toHaveProperty(key)
    }
  })

  it('still shows him what the product sold - quantity, orders and revenue', async () => {
    type Body = { rows: (Record<string, unknown> & { sku: string })[] }
    const { ops } = await bothWays<Body>(call(fixture.shopId))
    const his = ops.rows.find((r) => r.sku === `${MARK}-SKU`)
    expect(his?.quantity).toBe(1)
    expect(his?.netSales).toBe(400000)
    expect(his?.grossSales).toBeTypeOf('number')
  })
})

describe('the B2B customer page', () => {
  const call = (id: string) => () =>
    b2bCustomer.GET(new Request(`http://localhost/api/b2b/customers/${id}`), {
      params: Promise.resolve({ id }),
    })

  it('gives the admin "our cost" on each agreed price and gives him none', async () => {
    type Body = { customer: { prices: Record<string, unknown>[] } }
    const { admin, ops } = await bothWays<Body>(call(fixture.customerId))

    expect(admin.customer.prices[0].costPerItem).toBe(150000)
    expect(admin.customer.prices[0].handlingCost).toBe(2500)

    expect(ops.customer.prices[0], 'he still sees the agreed price').toMatchObject({ unitPrice: 35000 })
    expect(ops.customer.prices[0]).not.toHaveProperty('costPerItem')
    expect(ops.customer.prices[0]).not.toHaveProperty('handlingCost')
  })
})

describe('the product picker used when entering a B2B order', () => {
  const call = (shopId: string) => () =>
    products.GET(new Request(`http://localhost/api/products?shopId=${shopId}`))

  it('gives the admin the cost and its history and gives him neither', async () => {
    type Body = { products: Record<string, unknown>[] }
    const { admin, ops } = await bothWays<Body>(call(fixture.shopId))

    const theirs = admin.products.find((p) => p.sku === `${MARK}-SKU`.toUpperCase())
    expect(theirs?.costPerItem).toBe(150000)
    expect(theirs?.history).toHaveLength(1)

    const his = ops.products.find((p) => p.sku === `${MARK}-SKU`.toUpperCase())
    expect(his, 'the picker must still list the product').toBeDefined()
    for (const key of ['costPerItem', 'handlingCost', 'history', 'missingCost']) {
      expect(his, `picker still carries ${key}`).not.toHaveProperty(key)
    }
    // What the picker actually needs to do its job.
    expect(his!.id).toBeTypeOf('string')
    expect(his!.name).toBe('Pizza oven')
    expect(his!.sellingPrice).toBe(500000)
  })
})
