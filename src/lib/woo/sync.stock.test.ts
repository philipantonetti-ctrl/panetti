import { describe, expect, it, afterEach } from 'vitest'
import { db } from '../db'
import { storeCatalog } from './sync'

const SKU = `TEST-STOCK-${Date.now()}`

afterEach(async () => {
  await db.product.deleteMany({ where: { sku: SKU } })
  await db.shop.deleteMany({ where: { name: SKU } })
})

describe('storeCatalog', () => {
  it('writes price and stock, and stamps when stock was read', async () => {
    const shop = await db.shop.create({ data: { name: SKU, currency: 'NOK' } })
    const product = await db.product.create({
      data: { shopId: shop.id, externalId: '77', sku: SKU, name: 'Test' },
    })

    await storeCatalog(shop.id, new Map([['77', { price: 64900, stock: 95 }]]))

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.catalogPrice).toBe(64900)
    expect(after.stockQuantity).toBe(95)
    expect(after.stockUpdatedAt).not.toBeNull()
  })

  it('records a stock reading of null without wiping the stamp of a real one', async () => {
    // A store that stops managing stock should stop claiming a figure, but the
    // write must still be recorded so the page can say when we last looked.
    const shop = await db.shop.create({ data: { name: SKU, currency: 'NOK' } })
    const product = await db.product.create({
      data: { shopId: shop.id, externalId: '78', sku: SKU, name: 'Test' },
    })

    await storeCatalog(shop.id, new Map([['78', { price: null, stock: null }]]))

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.stockQuantity).toBeNull()
    expect(after.stockUpdatedAt).not.toBeNull()
  })

  it('leaves a product the catalogue did not mention completely alone', async () => {
    const shop = await db.shop.create({ data: { name: SKU, currency: 'NOK' } })
    const product = await db.product.create({
      data: { shopId: shop.id, externalId: '79', sku: SKU, name: 'Test', catalogPrice: 500 },
    })

    await storeCatalog(shop.id, new Map([['other', { price: 1, stock: 1 }]]))

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.catalogPrice).toBe(500)
    expect(after.stockUpdatedAt).toBeNull()
  })

  it('treats a fractional quantity as unknown rather than throwing into a swallowed catch', async () => {
    const shop = await db.shop.create({ data: { name: SKU, currency: 'NOK' } })
    const product = await db.product.create({
      data: { shopId: shop.id, externalId: '80', sku: SKU, name: 'Test' },
    })

    await storeCatalog(shop.id, new Map([['80', { price: null, stock: 2.5 }]]))

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.stockQuantity).toBeNull()
    expect(after.stockUpdatedAt).not.toBeNull()
  })
})
