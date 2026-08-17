import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { POST } from './route'

// Unique to THIS file: shops and products are shared with every other test in
// the `app` project, which runs them in parallel against one local Postgres.
const TAG = '[cost-spread-test]'
const SKU = `CST${Date.now()}`

let norwayProductId = ''
let swedenProductId = ''
let danishProductId = ''

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

async function cleanup() {
  await db.productCost.deleteMany({ where: { product: { shop: { name: { contains: TAG } } } } })
  await db.product.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeAll(async () => {
  await cleanup()

  // Two shops on the SAME currency, so the fan-out can be tested without
  // writing to the shared FxRate table — the conversion arithmetic itself is
  // covered by cost-spread.test.ts, which needs no database at all.
  const [no, se, dk] = await Promise.all([
    db.shop.create({ data: { name: `Panetti Norway ${TAG}`, currency: 'NOK' } }),
    db.shop.create({ data: { name: `Mazzetti Norway ${TAG}`, currency: 'NOK' } }),
    // A currency we hold no rate for in the test database, so this one must be
    // refused rather than written through unconverted.
    db.shop.create({ data: { name: `Panetti Zimbabwe ${TAG}`, currency: 'ZWL' } }),
  ])

  const made = await Promise.all([
    db.product.create({
      data: { shopId: no.id, externalId: 'x-no', sku: SKU, name: 'Pizzaovn Pro' },
    }),
    // Deliberately lower case with stray spaces. Product stores the SKU exactly
    // as the shop spelled it, and comparing raw is how a sibling gets missed —
    // which would silently leave one webshop on the old cost.
    db.product.create({
      data: { shopId: se.id, externalId: 'x-se', sku: ` ${SKU.toLowerCase()} `, name: 'Pizzaugn' },
    }),
    db.product.create({
      data: { shopId: dk.id, externalId: 'x-zw', sku: SKU, name: 'Pizza Oven' },
    }),
  ])
  norwayProductId = made[0].id
  swedenProductId = made[1].id
  danishProductId = made[2].id
})

afterAll(cleanup)

const body = (costPerItem: number, handlingCost = 0) => ({
  costPerItem,
  handlingCost,
  costApply: { apply: 'FUTURE' as const },
  handlingApply: { apply: 'FUTURE' as const },
})

const post = (id: string, payload: ReturnType<typeof body>) =>
  POST(
    new Request(`http://test/api/products/${id}/cost`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id }) },
  )

const costsOf = (productId: string) =>
  db.productCost.findMany({ where: { productId }, orderBy: { effectiveFrom: 'asc' } })

describe('POST /api/products/[id]/cost', () => {
  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue(null)
    expect((await post(norwayProductId, body(100))).status).toBe(403)
  })

  /**
   * The client's complaint, in the one place it was literally true: a cost had
   * to be typed once per webshop, nine times for one physical product, because
   * ProductCost hangs off a per-shop Product row.
   */
  it('applies a cost entered once to the same SKU in every webshop', async () => {
    admin()
    const res = await post(norwayProductId, body(1599, 24))
    expect(res.status).toBe(200)

    for (const id of [norwayProductId, swedenProductId]) {
      const [point] = await costsOf(id)
      expect(point.costPerItem).toBe(159_900)
      expect(point.handlingCost).toBe(2_400)
    }
  })

  it('says how many webshops it reached, so an invisible write can be checked', async () => {
    admin()
    const out = await (await post(norwayProductId, body(1599, 24))).json()

    // Norway and the other Norwegian shop. Zimbabwe is refused, below.
    expect(out.shops).toBe(2)
  })

  /**
   * Not crossConvert, which returns the amount UNCONVERTED when a rate is
   * missing. Writing 159,900 NOK into a ZWL product as though it were ZWL is an
   * enormous error wearing the clothes of an ordinary number: nothing on any
   * page looks wrong, and every profit figure that product touches is wrong from
   * then on.
   */
  it('refuses a shop it holds no rate for, and names it rather than guessing', async () => {
    admin()
    const out = await (await post(norwayProductId, body(1599, 24))).json()

    expect(out.skipped).toEqual([
      { shopName: `Panetti Zimbabwe ${TAG}`, currency: 'ZWL' },
    ])
    expect(await costsOf(danishProductId)).toEqual([])
  })

  it('matches a sibling SKU however the shop cased or spaced it', async () => {
    admin()
    await post(norwayProductId, body(2000))

    const [point] = await costsOf(swedenProductId)
    expect(point.costPerItem).toBe(200_000)
  })

  /**
   * Entering the cost from any shop's row has to reach the others. The client
   * picks a webshop from a dropdown and will not think about which row he is
   * standing on.
   */
  it('spreads from whichever shop’s row the cost was entered on', async () => {
    admin()
    await post(swedenProductId, body(3000))

    const [point] = await costsOf(norwayProductId)
    expect(point.costPerItem).toBe(300_000)
  })

  it('leaves an unrelated product alone', async () => {
    admin()
    const other = await db.product.create({
      data: {
        shopId: (await db.shop.findFirstOrThrow({ where: { name: `Panetti Norway ${TAG}` } })).id,
        externalId: 'x-other',
        sku: `${SKU}-DIFFERENT`,
        name: 'Something else',
      },
    })

    await post(norwayProductId, body(4000))

    expect(await costsOf(other.id)).toEqual([])
  })
})
