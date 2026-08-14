import { describe, expect, it, afterEach } from 'vitest'
import { db } from '../db'
import { loadInventory } from './load'

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

  // What an order contributes as incoming stock. These assert EQUIVALENCES
  // rather than hand-computed dates: "800 ordered with 300 landed behaves
  // exactly like 500 on the water" is the actual claim, and it stays true
  // however the burn window or the cover default is later tuned.
  const orderShape = (itemId: string) => ({
    supplyItemId: itemId,
    orderedAt: new Date('2026-07-01T00:00:00Z'),
    eta: new Date('2026-08-20T00:00:00Z'),
  })
  const runsOut = async () =>
    (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!.forecast.runsOutOn

  it('counts only what has not landed yet, so received units are not counted twice', async () => {
    // 600 units over the 60-day window is 10 a day. Deliberately brisk: at a
    // slower rate 100 on the shelf plus either order outlasts the 365-day
    // horizon, both dates come back null, and the test cannot tell 500 from 800.
    await sell(`${TAG}-no`, SKU, 100, 600, 5, 'NO')
    const item = await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })
    const po = orderShape(item.id)

    await db.purchaseOrder.create({ data: { ...po, quantity: 500 } })
    const asFiveHundred = await runsOut()

    await db.purchaseOrder.deleteMany({ where: { supplyItemId: item.id } })
    await db.purchaseOrder.create({ data: { ...po, quantity: 800, receivedQuantity: 300 } })
    const asEightMinusThree = await runsOut()

    await db.purchaseOrder.deleteMany({ where: { supplyItemId: item.id } })
    await db.purchaseOrder.create({ data: { ...po, quantity: 800 } })
    const asEightHundred = await runsOut()

    // Null on either side would make the comparison meaningless.
    expect(asFiveHundred).not.toBeNull()
    expect(asEightHundred).not.toBeNull()

    // 500 still coming, not 800.
    expect(asEightMinusThree).toEqual(asFiveHundred)
    // And the two really are distinguishable, or the assertion above proves nothing.
    expect(asEightHundred).not.toEqual(asFiveHundred)
  })

  it('never lets an over-receipt subtract from incoming stock', async () => {
    await sell(`${TAG}-no`, SKU, 100, 600, 5, 'NO')
    const item = await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const withNoOrderAtAll = await runsOut()

    // 900 landed against 800 ordered contributes zero, never minus one hundred,
    // so the row must forecast exactly as it does with no order at all.
    await db.purchaseOrder.create({
      data: { ...orderShape(item.id), quantity: 800, receivedQuantity: 900 },
    })
    expect(await runsOut()).toEqual(withNoOrderAtAll)
  })

  it('leaves a hand-entered order counting its whole quantity', async () => {
    // The regression guard for the new column. Every row that exists today has
    // no receivedQuantity, and must forecast exactly as it did before the column
    // was added — which is to say, identically to one that has received nothing.
    await sell(`${TAG}-no`, SKU, 100, 600, 5, 'NO')
    const item = await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })
    const po = orderShape(item.id)

    await db.purchaseOrder.create({ data: { ...po, quantity: 500, receivedQuantity: 0 } })
    const explicitZero = await runsOut()
    // A null on both sides would make the comparison vacuous.
    expect(explicitZero).not.toBeNull()

    await db.purchaseOrder.deleteMany({ where: { supplyItemId: item.id } })
    const created = await db.purchaseOrder.create({ data: { ...po, quantity: 500 } })
    expect(created.receivedQuantity).toBeNull()

    expect(await runsOut()).toEqual(explicitZero)
  })
})
