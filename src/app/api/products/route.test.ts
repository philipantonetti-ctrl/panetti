import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { GET } from './route'

// Unique to THIS file: shops and products are shared with every other test in
// the `app` project, which runs them in parallel against one local Postgres.
const TAG = '[products-hide-test]'
const SKU = `PHT${Date.now()}`

let shopId: string

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

async function cleanup() {
  await db.productCost.deleteMany({ where: { product: { shop: { name: { contains: TAG } } } } })
  await db.product.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: SKU } } })
}

beforeAll(async () => {
  await cleanup()
  const shop = await db.shop.create({ data: { name: `Shop ${TAG}`, currency: 'NOK' } })
  shopId = shop.id

  await db.product.createMany({
    data: [
      { shopId, externalId: 'p-keep', sku: `${SKU}-KEEP`, name: 'Pizza oven' },
      { shopId, externalId: 'p-hide', sku: `${SKU}-HIDE`, name: 'Spare part' },
      // Deliberately lower case. Product stores the SKU exactly as the shop
      // spells it; SupplyItem stores it normalised. If the two are compared raw,
      // this row escapes hiding and the client sees a part he told us to forget.
      { shopId, externalId: 'p-case', sku: `${SKU}-case`, name: 'Spare bolt' },
      { shopId, externalId: 'p-none', sku: `${SKU}-NONE`, name: 'Never had a supply row' },
    ],
  })

  await db.supplyItem.createMany({
    data: [
      { sku: `${SKU}-KEEP`, name: 'Pizza oven', active: true },
      { sku: `${SKU}-HIDE`, name: 'Spare part', active: false },
      { sku: `${SKU}-CASE`, name: 'Spare bolt', active: false },
    ],
  })
})

afterAll(cleanup)

const skus = async () => {
  const res = await GET(new Request(`http://test/api/products?shopId=${shopId}`))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { products: { sku: string }[] }
  return body.products.map((p) => p.sku)
}

describe('GET /api/products', () => {
  it('leaves out a product hidden on the suppliers page', async () => {
    admin()
    expect(await skus()).not.toContain(`${SKU}-HIDE`)
  })

  it('still returns a product nobody hid', async () => {
    admin()
    expect(await skus()).toContain(`${SKU}-KEEP`)
  })

  it('matches the SKU case-insensitively, because SupplyItem stores it normalised', async () => {
    admin()
    expect(await skus()).not.toContain(`${SKU}-case`)
  })

  it('keeps a product that has no purchasing row at all', async () => {
    // ensureSupplyItems skips a blank or all-zeros SKU, so such a product can
    // never be hidden. It must still be costable - silently dropping it would
    // lose money on every order of it.
    admin()
    expect(await skus()).toContain(`${SKU}-NONE`)
  })
})
