import { describe, expect, it, afterEach } from 'vitest'
import { db } from '../db'
import { loadInventory, outstanding } from './load'

const TAG = `TEST-LOAD-${Date.now()}`
const SKU = `${TAG}-A`
const TODAY = new Date('2026-08-13T00:00:00Z')

afterEach(async () => {
  await db.orderItem.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.order.deleteMany({ where: { shop: { name: { startsWith: TAG } } } })
  await db.purchaseOrder.deleteMany({ where: { item: { sku: { startsWith: TAG } } } })
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.product.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

async function sell(shopName: string, sku: string, stock: number | null, units: number, daysAgo: number, country: string) {
  const shop =
    (await db.shop.findFirst({ where: { name: shopName } })) ??
    (await db.shop.create({ data: { name: shopName, currency: 'NOK' } }))
  const product =
    (await db.product.findFirst({ where: { shopId: shop.id, sku } })) ??
    (await db.product.create({
      data: { shopId: shop.id, externalId: `${shopName}-${sku}`, sku, name: 'Pasta Maker',
              stockQuantity: stock, stockUpdatedAt: new Date() },
    }))
  const order = await db.order.create({
    data: {
      shopId: shop.id, externalId: `${sku}-${daysAgo}-${shopName}`, number: `${daysAgo}`,
      placedAt: new Date(TODAY.getTime() - daysAgo * 86400000), status: 'completed',
      currency: 'NOK', grossSales: 0, discountTotal: 0, netSales: 0,
      shippingCharged: 0, taxTotal: 0, total: 0, shippingCountry: country,
    },
  })
  await db.orderItem.create({
    data: { orderId: order.id, productId: product.id, sku, name: 'Pasta Maker',
            quantity: units, unitPrice: 0, lineNetTotal: 0 },
  })
}

describe('loadInventory', () => {
  it('sums demand across shops, because they share one warehouse', async () => {
    await sell(`${TAG}-no`, SKU, 100, 60, 5, 'NO')
    await sell(`${TAG}-se`, SKU, 100, 60, 5, 'SE')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const view = await loadInventory(TODAY)
    const row = view.rows.find((r) => r.sku === SKU)!
    expect(row.burn).toBeCloseTo(2) // 120 units over 60 days
    expect(row.stock.quantity).toBe(100) // agreed, not summed
  })

  it('does not count a cancelled order as demand', async () => {
    await sell(`${TAG}-no`, SKU, 100, 600, 5, 'NO')
    await db.order.updateMany({ where: { shop: { name: `${TAG}-no` } }, data: { status: 'cancelled' } })
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.burn).toBe(0)
  })

  it('shows which country is burning the stock', async () => {
    await sell(`${TAG}-no`, SKU, 100, 90, 5, 'NO')
    await sell(`${TAG}-de`, SKU, 100, 10, 5, 'DE')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.byCountry[0]).toEqual({ country: 'NO', units: 90 })
  })

  it('names products whose SKU cannot be used instead of dropping them', async () => {
    const shop = await db.shop.create({ data: { name: `${TAG}-bad`, currency: 'NOK' } })
    await db.product.create({
      data: { shopId: shop.id, externalId: 'x', sku: '0', name: `${TAG} Massage Chair` },
    })
    const view = await loadInventory(TODAY)
    expect(view.unusable.some((u) => u.name === `${TAG} Massage Chair`)).toBe(true)
    expect(view.rows.some((r) => r.sku === '0')).toBe(false)
  })

  it('counts an open purchase order and ignores a received one', async () => {
    await sell(`${TAG}-no`, SKU, 100, 600, 5, 'NO')
    const item = await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })
    await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 500, orderedAt: TODAY,
              eta: new Date(TODAY.getTime() + 3 * 86400000) },
    })
    await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 9999, orderedAt: TODAY,
              eta: new Date(TODAY.getTime() + 4 * 86400000), receivedAt: TODAY },
    })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    // 100 on hand at 10 a day, plus 500 landing on day 3, empties on day 59.
    // Pinned exactly, because all three ways this can break land elsewhere:
    // dropping arrivals gives day 9, counting the received order gives no
    // run-out at all, and a mishandled ETA moves the date.
    const asDay = (d: Date) => d.toISOString().slice(0, 10)
    expect(asDay(row.forecast.runsOutOn!)).toBe(asDay(new Date(TODAY.getTime() + 59 * 86400000)))
  })

  it('sorts the soonest run-out first', async () => {
    await sell(`${TAG}-no`, SKU, 10, 600, 5, 'NO')
    await sell(`${TAG}-no`, `${TAG}-B`, 100000, 600, 5, 'NO')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Urgent' } })
    await db.supplyItem.create({ data: { sku: `${TAG}-B`, name: 'Fine' } })

    const rows = (await loadInventory(TODAY)).rows.filter((r) => r.sku.startsWith(TAG))
    expect(rows[0].sku).toBe(SKU)
  })

  it('ignores a deactivated shop, whose stock can never refresh again', async () => {
    // The sync only visits active shops, so a deactivated one's stockQuantity
    // freezes at its last reading. Unfiltered, that frozen figure keeps voting
    // in agreeStock and its old orders keep adding demand that is not happening.
    await sell(`${TAG}-no`, SKU, 100, 60, 5, 'NO')
    await sell(`${TAG}-dead`, SKU, 999, 6000, 5, 'NO')
    await db.shop.updateMany({ where: { name: `${TAG}-dead` }, data: { active: false } })
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.stock.quantity).toBe(100)   // not 999
    expect(row.burn).toBeCloseTo(1)        // 60 units over 60 days, not 6060
  })

  it('keeps a product with no run-out date, and sorts it after those that have one', async () => {
    await sell(`${TAG}-no`, SKU, 10, 600, 5, 'NO') // sells fast, runs out in days
    await db.supplyItem.create({ data: { sku: SKU, name: 'Urgent' } })

    // Stocked but never sold, so burn is zero and it never runs out. It must
    // still appear — a product that stopped selling is worth seeing — and it
    // must sort behind everything that does have a date.
    const shop = await db.shop.findFirstOrThrow({ where: { name: `${TAG}-no` } })
    await db.product.create({
      data: {
        shopId: shop.id, externalId: `${TAG}-quiet`, sku: `${TAG}-QUIET`,
        name: 'Quiet', stockQuantity: 500, stockUpdatedAt: new Date(),
      },
    })
    await db.supplyItem.create({ data: { sku: `${TAG}-QUIET`, name: 'Quiet' } })

    const rows = (await loadInventory(TODAY)).rows.filter((r) => r.sku.startsWith(TAG))
    expect(rows.map((r) => r.sku)).toEqual([SKU, `${TAG}-QUIET`])
    expect(rows[1].forecast.runsOutOn).toBeNull()
    expect(rows[1].forecast.note).toBe('not selling')
  })

  // One integration test for the wiring: that load.ts really selects
  // receivedQuantity and really passes the outstanding amount to the forecast.
  //
  // Deliberately ONE. loadInventory reads every Product, Shop and OrderItem in
  // the database, so every call is a chance to collide with another test file
  // deleting a row mid-query — "Inconsistent query result: Field shop is
  // required" is what that collision looks like. The arithmetic itself is pure
  // and is tested exhaustively below, without touching Postgres at all.
  //
  // The assertion is an EQUIVALENCE rather than a hand-computed date: "800
  // ordered with 300 landed behaves exactly like 500 on the water" is the actual
  // claim, and it stays true however the burn window is later tuned.
  it('counts only what has not landed yet, so received units are not counted twice', async () => {
    const five = `${TAG}-FIVE`, split = `${TAG}-SPLIT`, eight = `${TAG}-EIGHT`

    // Identical demand for each: 600 units over the 60-day window, so 10 a day.
    // Deliberately brisk — at a slower rate 100 on the shelf plus any of these
    // orders outlasts the 365-day horizon, every date comes back null, and the
    // comparison below cannot tell 500 from 800.
    for (const sku of [five, split, eight]) await sell(`${TAG}-no`, sku, 100, 600, 5, 'NO')

    for (const [sku, data] of [
      [five, { quantity: 500 }],
      [split, { quantity: 800, receivedQuantity: 300 }],
      [eight, { quantity: 800 }],
    ] as const) {
      const item = await db.supplyItem.create({ data: { sku, name: 'Pasta Maker' } })
      await db.purchaseOrder.create({
        data: {
          supplyItemId: item.id,
          orderedAt: new Date('2026-07-01T00:00:00Z'),
          eta: new Date('2026-08-20T00:00:00Z'),
          ...data,
        },
      })
    }

    const rows = (await loadInventory(TODAY)).rows
    const runsOut = (sku: string) => rows.find((r) => r.sku === sku)!.forecast.runsOutOn

    expect(runsOut(five)).not.toBeNull()
    expect(runsOut(eight)).not.toBeNull()

    // 500 still coming, not 800.
    expect(runsOut(split)).toEqual(runsOut(five))
    // And the two really are distinguishable, or the assertion above proves nothing.
    expect(runsOut(eight)).not.toEqual(runsOut(five))
  })
})

// Pure, so no database and no chance of colliding with anything.
describe('outstanding', () => {
  it('subtracts what has landed from what was ordered', () => {
    expect(outstanding({ quantity: 800, receivedQuantity: 300 })).toBe(500)
  })

  it('is zero once everything has arrived', () => {
    expect(outstanding({ quantity: 800, receivedQuantity: 800 })).toBe(0)
  })

  it('never goes negative, because an over-receipt must not cancel another order', () => {
    expect(outstanding({ quantity: 800, receivedQuantity: 900 })).toBe(0)
  })

  it('counts the whole quantity for a hand-entered row, which tracks no receipts', () => {
    expect(outstanding({ quantity: 500, receivedQuantity: null })).toBe(500)
  })

  it('treats an explicit zero exactly as it treats a null', () => {
    expect(outstanding({ quantity: 500, receivedQuantity: 0 })).toBe(
      outstanding({ quantity: 500, receivedQuantity: null }),
    )
  })
})
/**
 * These live in this file rather than their own on purpose.
 *
 * `stockSource` is workspace-wide state: the moment ANY shop carries it, every
 * caller of loadInventory is scoped. Vitest runs the tests inside one file
 * sequentially, and this is the only file that calls loadInventory against the
 * database — the inventory route's test mocks it — so keeping them here is what
 * stops a flagged shop in one file emptying the rows another file is asserting
 * on. The afterEach above deletes these shops, which returns the workspace to
 * "nothing flagged" between tests.
 */
describe('loadInventory, when some shops are named as the stock source', () => {
  /** A shop with one product, optionally the source of truth for stock. */
  async function stock(
    shopName: string,
    sku: string,
    quantity: number | null,
    productName: string,
    stockSource = false,
  ) {
    const shop =
      (await db.shop.findFirst({ where: { name: shopName } })) ??
      (await db.shop.create({ data: { name: shopName, currency: 'NOK', stockSource } }))
    await db.product.create({
      data: {
        shopId: shop.id, externalId: `${shopName}-${sku}`, sku, name: productName,
        stockQuantity: quantity, stockUpdatedAt: new Date(),
      },
    })
    return shop
  }

  it('lists only the products the source shops carry', async () => {
    await stock(`${TAG}-src`, SKU, 100, 'Pizza Oven', true)
    await stock(`${TAG}-other`, `${TAG}-ONLYTHERE`, 50, 'Something Else')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pizza Oven' } })
    await db.supplyItem.create({ data: { sku: `${TAG}-ONLYTHERE`, name: 'Something Else' } })

    const skus = (await loadInventory(TODAY)).rows.filter((r) => r.sku.startsWith(TAG)).map((r) => r.sku)
    expect(skus).toContain(SKU)
    expect(skus).not.toContain(`${TAG}-ONLYTHERE`)
  })

  it('believes only the source shop when the shops disagree', async () => {
    // The exact shape of the real complaint: five mirrors of one warehouse, one
    // of which has drifted. Naming the source ends the vote.
    await stock(`${TAG}-src`, SKU, 906, 'Pizza Oven', true)
    await stock(`${TAG}-drifted`, SKU, 939, 'Pizza Oven')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pizza Oven' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.stock.quantity).toBe(906)
    expect(row.stock.disagrees).toBe(false)
  })

  it('takes the product name from the source shop, not from whichever shop was first', async () => {
    // Why the Forecast listed Norwegian products as "Hierontatuoli" and
    // "Pizzaugnsskydd": the name was whatever the database happened to return
    // first, frozen into SupplyItem and never updated.
    await stock(`${TAG}-fi`, SKU, 100, 'Hierontatuoli')
    await stock(`${TAG}-src`, SKU, 100, 'Massasjestol', true)
    await db.supplyItem.create({ data: { sku: SKU, name: 'Hierontatuoli' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.name).toBe('Massasjestol')
  })

  it('still counts sales from EVERY shop, which is the whole point', async () => {
    await stock(`${TAG}-src`, SKU, 100, 'Pizza Oven', true)
    // 60 units in Norway and 60 in Sweden, over 60 days, is 2 a day. Scoping
    // demand to the source shop would halve it and order half the container.
    await sell(`${TAG}-src`, SKU, 100, 60, 5, 'NO')
    await sell(`${TAG}-se`, SKU, 100, 60, 5, 'SE')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pizza Oven' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.burn).toBeCloseTo(2)
    expect(row.byCountry.map((c) => c.country).sort()).toEqual(['NO', 'SE'])
  })

  it('falls back to every active shop when no shop is named', async () => {
    // The state on the day this ships. Nothing is flagged yet, so the tabs must
    // look exactly as they did before — an empty page would read as data loss.
    await stock(`${TAG}-a`, SKU, 100, 'Pizza Oven')
    await stock(`${TAG}-b`, `${TAG}-B`, 50, 'Other')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pizza Oven' } })
    await db.supplyItem.create({ data: { sku: `${TAG}-B`, name: 'Other' } })

    const skus = (await loadInventory(TODAY)).rows.filter((r) => r.sku.startsWith(TAG)).map((r) => r.sku)
    expect(skus).toContain(SKU)
    expect(skus).toContain(`${TAG}-B`)
  })

  it('ignores a source shop that has been deactivated', async () => {
    // Same reason the unscoped path ignores one: a deactivated shop is never
    // synced again, so its reading is frozen and must not be the source of truth.
    await stock(`${TAG}-src`, SKU, 100, 'Pizza Oven', true)
    await stock(`${TAG}-dead`, SKU, 999, 'Pizza Oven', true)
    await db.shop.updateMany({ where: { name: `${TAG}-dead` }, data: { active: false } })
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pizza Oven' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.stock.quantity).toBe(100)
  })

  /**
   * The page has to be able to SAY where its figures came from. Two scopes are
   * mixed on one screen — stock from the named shops, sales from every shop —
   * and no number on the page reveals which is which.
   */
  it('reports which shops the stock came from, named and in order', async () => {
    await stock(`${TAG}-b-src`, SKU, 100, 'Pizza Oven', true)
    await stock(`${TAG}-a-src`, SKU, 100, 'Pizza Oven', true)
    await stock(`${TAG}-other`, SKU, 100, 'Pizza Oven')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pizza Oven' } })

    const view = await loadInventory(TODAY)
    expect(view.stockFrom).toContain(`${TAG}-a-src`)
    expect(view.stockFrom).toContain(`${TAG}-b-src`)
    expect(view.stockFrom).not.toContain(`${TAG}-other`)
    // Alphabetical, so the sentence it builds does not reshuffle between loads.
    expect([...view.stockFrom].sort()).toEqual(view.stockFrom)
  })

  it('reports no named source when nobody has chosen one', async () => {
    await stock(`${TAG}-a`, SKU, 100, 'Pizza Oven')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pizza Oven' } })

    expect((await loadInventory(TODAY)).stockFrom).toEqual([])
  })

  it('counts the active shops, so the page can say how many fed the sales', async () => {
    await stock(`${TAG}-a`, SKU, 100, 'Pizza Oven')
    await stock(`${TAG}-off`, `${TAG}-B`, 100, 'Other')
    await db.shop.updateMany({ where: { name: `${TAG}-off` }, data: { active: false } })

    // Scoped to this tag rather than asserted as a total: other test files
    // create and delete shops in parallel, so any global count is a race.
    const view = await loadInventory(TODAY)
    const mine = await db.shop.count({ where: { name: { startsWith: TAG }, active: true } })
    expect(view.shopCount).toBeGreaterThanOrEqual(mine)
    expect(view.shopCount).toBe(await db.shop.count({ where: { active: true } }))
  })
})
