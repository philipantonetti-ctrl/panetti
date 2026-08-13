// src/lib/inventory/load.test.ts
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
    // 100 on hand + 500 incoming at 10/day = far short of the 9999 row's effect.
    expect(row.forecast.runsOutOn).not.toBeNull()
    expect(row.forecast.runsOutOn!.getTime()).toBeLessThan(TODAY.getTime() + 100 * 86400000)
  })

  it('sorts the soonest run-out first', async () => {
    await sell(`${TAG}-no`, SKU, 10, 600, 5, 'NO')
    await sell(`${TAG}-no`, `${TAG}-B`, 100000, 600, 5, 'NO')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Urgent' } })
    await db.supplyItem.create({ data: { sku: `${TAG}-B`, name: 'Fine' } })

    const rows = (await loadInventory(TODAY)).rows.filter((r) => r.sku.startsWith(TAG))
    expect(rows[0].sku).toBe(SKU)
  })
})
