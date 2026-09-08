import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role } from '@/lib/auth/session'

/**
 * Every door the operations manager needs, and every door he must not have.
 *
 * The five tabs he was given call fifteen routes between them. Each one used to
 * say `assertAdmin`, so opening the tabs without opening the routes would have
 * shipped five pages that draw nothing. This file is the list, in one place, of
 * which routes changed hands - and, as importantly, which did not.
 *
 * The refusals assert the exact status and message, because that is the whole
 * behaviour. The admissions assert only that the door opened (`not 403`): what
 * happens after the guard is each route's own test's business, and several of
 * these answer 400 or 404 to the deliberately empty requests below.
 */

const state = vi.hoisted(() => ({ role: 'ADMIN' as Role | null }))

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: async () =>
    state.role === null
      ? null
      : { userId: 'u1', email: `${state.role.toLowerCase()}@ecom.test`, role: state.role, ambassadorId: null },
}))

// The two routes that would otherwise reach out of the process: a full webshop
// sync, and a warehouse file upload that asks Bring about every parcel in it.
vi.mock('@/lib/woo/sync', () => ({
  syncAllShops: async () => [],
  syncShop: async () => ({ shopId: 's', added: 0 }),
}))
vi.mock('@/lib/bring/import', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bring/import')>('@/lib/bring/import')
  return { ...actual, importWarehouseFile: async () => ({ matched: 0, unmatched: 0 }) }
})

const orders = await import('./orders/route')
const sync = await import('./sync/route')
const delivery = await import('./delivery/route')
const deliveryImport = await import('./delivery/import/route')
const carrierCost = await import('./delivery/carrier-cost/route')
const products = await import('./products/route')
const productAnalytics = await import('./products/analytics/route')
const inventory = await import('./inventory/route')
const inventoryItems = await import('./inventory/items/route')
const purchaseOrders = await import('./inventory/purchase-orders/route')
const suppliers = await import('./inventory/suppliers/route')
const b2bCustomers = await import('./b2b/customers/route')
const b2bCustomer = await import('./b2b/customers/[id]/route')
const b2bOrders = await import('./b2b/orders/route')
const b2bOrder = await import('./b2b/orders/[id]/route')

// Doors he must not have. Imported here so the refusals are proved against the
// real routes rather than assumed from the guard's unit test.
const dashboard = await import('./metrics/route')
const payouts = await import('./payouts/route')
const users = await import('./users/route')
const expenses = await import('./expenses/route')
const marketing = await import('./marketing/route')
const productCost = await import('./products/[id]/cost/route')
const ambassadors = await import('./ambassadors/route')

const url = (path: string) => new Request(`http://localhost${path}`)
const json = (path: string, body: unknown, method = 'POST') =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

/** Deliberately empty or nonsense bodies: nothing here may write anything. */
const HIS_DOORS: [string, () => Promise<Response>][] = [
  ['GET /api/orders', () => orders.GET(url('/api/orders?from=2026-01-01&to=2026-01-02'))],
  ['POST /api/sync', () => sync.POST(url('/api/sync'))],
  ['GET /api/delivery', () => delivery.GET(url('/api/delivery?from=2026-01-01&to=2026-01-02'))],
  ['POST /api/delivery/import', () => deliveryImport.POST(new Request('http://localhost/api/delivery/import', { method: 'POST', body: new FormData() }))],
  ['GET /api/delivery/carrier-cost', () => carrierCost.GET(url('/api/delivery/carrier-cost?from=2026-01-01&to=2026-01-02'))],
  ['PUT /api/delivery/carrier-cost', () => carrierCost.PUT(json('/api/delivery/carrier-cost', {}, 'PUT'))],
  ['GET /api/products', () => products.GET(url('/api/products?source=1'))],
  ['GET /api/products/analytics', () => productAnalytics.GET(url('/api/products/analytics?from=2026-01-01&to=2026-01-02'))],
  ['GET /api/inventory', () => inventory.GET(url('/api/inventory'))],
  ['GET /api/inventory/items', () => inventoryItems.GET()],
  ['PUT /api/inventory/items', () => inventoryItems.PUT(json('/api/inventory/items', {}, 'PUT'))],
  ['GET /api/inventory/purchase-orders', () => purchaseOrders.GET()],
  ['POST /api/inventory/purchase-orders', () => purchaseOrders.POST(json('/api/inventory/purchase-orders', {}))],
  ['PUT /api/inventory/purchase-orders', () => purchaseOrders.PUT(json('/api/inventory/purchase-orders', {}, 'PUT'))],
  ['DELETE /api/inventory/purchase-orders', () => purchaseOrders.DELETE(json('/api/inventory/purchase-orders', {}, 'DELETE'))],
  ['GET /api/inventory/suppliers', () => suppliers.GET()],
  ['POST /api/inventory/suppliers', () => suppliers.POST(json('/api/inventory/suppliers', {}))],
  ['DELETE /api/inventory/suppliers', () => suppliers.DELETE(json('/api/inventory/suppliers', {}, 'DELETE'))],
  ['GET /api/b2b/customers', () => b2bCustomers.GET(url('/api/b2b/customers'))],
  ['POST /api/b2b/customers', () => b2bCustomers.POST(json('/api/b2b/customers', {}))],
  ['GET /api/b2b/customers/[id]', () => b2bCustomer.GET(url('/api/b2b/customers/nope'), ctx('nope'))],
  ['PATCH /api/b2b/customers/[id]', () => b2bCustomer.PATCH(json('/api/b2b/customers/nope', {}, 'PATCH'), ctx('nope'))],
  ['DELETE /api/b2b/customers/[id]', () => b2bCustomer.DELETE(url('/api/b2b/customers/nope'), ctx('nope'))],
  ['POST /api/b2b/orders', () => b2bOrders.POST(json('/api/b2b/orders', {}))],
  ['GET /api/b2b/orders/[id]', () => b2bOrder.GET(url('/api/b2b/orders/nope'), ctx('nope'))],
  ['PATCH /api/b2b/orders/[id]', () => b2bOrder.PATCH(json('/api/b2b/orders/nope', {}, 'PATCH'), ctx('nope'))],
  ['DELETE /api/b2b/orders/[id]', () => b2bOrder.DELETE(url('/api/b2b/orders/nope'), ctx('nope'))],
]

/** The owner's house: company money, the ad accounts, and minting logins. */
const NOT_HIS_DOORS: [string, () => Promise<Response>][] = [
  ['GET /api/metrics', () => dashboard.GET(url('/api/metrics?from=2026-01-01&to=2026-01-02'))],
  ['GET /api/payouts', () => payouts.GET(url('/api/payouts?from=2026-01-01&to=2026-01-02'))],
  ['GET /api/users', () => users.GET()],
  ['POST /api/users', () => users.POST(json('/api/users', { email: 'x@y.z', role: 'ADMIN', password: 'password123' }))],
  ['GET /api/expenses', () => expenses.GET(url('/api/expenses'))],
  ['GET /api/marketing', () => marketing.GET(url('/api/marketing?from=2026-01-01&to=2026-01-02'))],
  ['POST /api/products/[id]/cost', () => productCost.POST(json('/api/products/p1/cost', {}), ctx('p1'))],
  ['GET /api/ambassadors', () => ambassadors.GET()],
]

beforeEach(() => {
  state.role = 'ADMIN'
})
afterEach(() => {
  state.role = 'ADMIN'
})

describe('the operations manager reaches every route his five tabs call', () => {
  for (const [name, call] of HIS_DOORS) {
    it(`opens ${name}`, async () => {
      state.role = 'OPERATIONS'
      const res = await call()
      expect(res.status, `${name} refused him`).not.toBe(403)
    })
  }
})

describe('the operations manager is refused the owner\'s routes', () => {
  for (const [name, call] of NOT_HIS_DOORS) {
    it(`refuses ${name}`, async () => {
      state.role = 'OPERATIONS'
      const res = await call()
      expect(res.status, name).toBe(403)
      // 'Staff only' on the ambassador route, which guards with assertStaff.
      expect(((await res.json()) as { error: string }).error).toMatch(/^(Admins|Staff) only$/)
    })
  }
})

describe('nobody else gained anything', () => {
  for (const role of ['MARKETING', 'AMBASSADOR'] as const) {
    it(`still refuses ${role} on every operations route`, async () => {
      state.role = role
      for (const [name, call] of HIS_DOORS) {
        const res = await call()
        expect(res.status, name).toBe(403)
      }
    })
  }

  it('still refuses a logged-out visitor on every operations route', async () => {
    state.role = null
    for (const [name, call] of HIS_DOORS) {
      const res = await call()
      expect(res.status, name).toBe(403)
    }
  })

  it('leaves the admin able to open all of them', async () => {
    state.role = 'ADMIN'
    for (const [name, call] of [...HIS_DOORS, ...NOT_HIS_DOORS]) {
      const res = await call()
      expect(res.status, name).not.toBe(403)
    }
  })
})
