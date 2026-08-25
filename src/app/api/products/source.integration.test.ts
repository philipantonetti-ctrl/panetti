import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { GET } from './route'

/**
 * Its own file, and registered in the serialized `delivery` project in
 * vitest.config.ts, because it flags `Shop.stockSource`. That flag is
 * workspace-wide: the moment any shop carries it, every caller of loadInventory
 * is scoped to that shop's catalogue, so run in the parallel `app` project this
 * file would empty rows other files are asserting on.
 */
const TAG = '[costs-source-test]'
const SKU = `CSR${Date.now()}`

async function cleanup() {
  await db.productCost.deleteMany({ where: { product: { shop: { name: { contains: TAG } } } } })
  await db.product.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: SKU } } })
}

beforeAll(async () => {
  await cleanup()

  const [panetti, mazzetti, sweden] = await Promise.all([
    db.shop.create({
      data: { name: `Panetti Norway ${TAG}`, currency: 'NOK', stockSource: true },
    }),
    db.shop.create({
      data: { name: `Mazzetti Norway ${TAG}`, currency: 'NOK', stockSource: true },
    }),
    db.shop.create({ data: { name: `Panetti Sweden ${TAG}`, currency: 'SEK' } }),
  ])

  await db.product.createMany({
    data: [
      { shopId: panetti.id, externalId: 'a1', sku: `${SKU}-SHARED`, name: 'Pizzaovn Pro' },
      { shopId: panetti.id, externalId: 'a2', sku: `${SKU}-PANETTI`, name: 'Pizzastein' },
      // The same product as the first row, spelled the way that shop spells it.
      // Two source shops are two catalogues; anything they share would otherwise
      // appear twice, which is the very complaint being answered.
      { shopId: mazzetti.id, externalId: 'b1', sku: ` ${SKU.toLowerCase()}-shared `, name: 'Pizzaovn' },
      { shopId: mazzetti.id, externalId: 'b2', sku: `${SKU}-MAZZETTI`, name: 'Massasjestol' },
      // Sold only outside Norway. Not in the combined list, and counted so the
      // page can say it is not showing everything.
      { shopId: sweden.id, externalId: 'c1', sku: `${SKU}-SWEDEN`, name: 'Air fryer bowl' },
    ],
  })
})

afterAll(cleanup)

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

async function sourceList() {
  const res = await GET(new Request('http://test/api/products?source=1'))
  expect(res.status).toBe(200)
  return (await res.json()) as {
    currency: string
    onlyElsewhere: number
    products: { sku: string; name: string }[]
  }
}

const mine = (skus: string[]) => skus.filter((s) => s.toUpperCase().startsWith(SKU))

describe('GET /api/products?source=1', () => {
  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue(null)
    expect((await GET(new Request('http://test/api/products?source=1'))).status).toBe(403)
  })

  /**
   * The client's sentence, finally answered where he wrote it: one row per
   * product, taken from the .no shops, instead of the same product once per
   * webshop.
   */
  it('lists each product once across every source shop', async () => {
    admin()
    const { products } = await sourceList()

    expect(mine(products.map((p) => p.sku)).sort()).toEqual(
      [`${SKU}-MAZZETTI`, `${SKU}-PANETTI`, `${SKU}-SHARED`].sort(),
    )
  })

  it('leaves out a product no source shop sells', async () => {
    admin()
    const { products } = await sourceList()

    expect(products.map((p) => p.sku)).not.toContain(`${SKU}-SWEDEN`)
  })

  /**
   * Counted rather than silently dropped. A page that shows 52 of 62 products
   * and says nothing reads as "that is all of them", which is the same lie as a
   * blank cell.
   */
  it('counts the products it is not showing', async () => {
    admin()
    const { onlyElsewhere } = await sourceList()

    expect(onlyElsewhere).toBeGreaterThanOrEqual(1)
  })

  it('reports the currency the figures are entered in', async () => {
    admin()
    expect((await sourceList()).currency).toBe('NOK')
  })

  it('still serves one shop at a time, so a product only Sweden sells stays costable', async () => {
    admin()
    const sweden = await db.shop.findFirstOrThrow({ where: { name: `Panetti Sweden ${TAG}` } })
    const res = await GET(new Request(`http://test/api/products?shopId=${sweden.id}`))
    const body = (await res.json()) as { products: { sku: string }[]; currency: string }

    expect(body.products.map((p) => p.sku)).toContain(`${SKU}-SWEDEN`)
    expect(body.currency).toBe('SEK')
  })
})

/**
 * A row in source mode stands for the product in every webshop, so it must not
 * wear one shop's spelling. Mazzetti lists the shared product as
 * " csr…-shared " - leading space, lower case - and returning that raw would put
 * stray whitespace on screen and make the row impossible to match against the
 * SKU every other part of the system keys on.
 */
describe('the SKU a row reports', () => {
  it('is trimmed and uppercased, not one shop’s spelling of it', async () => {
    admin()
    const { products } = await sourceList()
    const shared = products.filter((p) => p.sku.includes('-SHARED'))

    expect(shared).toHaveLength(1)
    expect(shared[0].sku).toBe(`${SKU}-SHARED`)
  })
})
