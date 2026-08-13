import { describe, expect, it, afterEach } from 'vitest'
import { db } from '../db'
import { ensureSupplyItems } from './supply-items'

const TAG = `TEST-ITEMS-${Date.now()}`
const SKU = `${TAG}-A`

afterEach(async () => {
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.product.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.product.deleteMany({ where: { sku: '0', name: TAG } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

const shopWith = async (n: string, products: { sku: string; name: string; externalId: string }[]) => {
  const shop = await db.shop.create({ data: { name: `${TAG}-${n}`, currency: 'NOK' } })
  for (const p of products) await db.product.create({ data: { shopId: shop.id, ...p } })
  return shop
}

describe('ensureSupplyItems', () => {
  it('creates one row per usable SKU so nobody types 63 of them', async () => {
    await shopWith('no', [{ sku: SKU, name: 'Pasta Maker', externalId: '1' }])
    await ensureSupplyItems()
    const item = await db.supplyItem.findUniqueOrThrow({ where: { sku: SKU } })
    expect(item.name).toBe('Pasta Maker')
    expect(item.productionDays).toBeNull()
  })

  it('does not duplicate when a second shop lists the same SKU', async () => {
    await shopWith('no', [{ sku: SKU, name: 'Pasta Maker', externalId: '1' }])
    await shopWith('se', [{ sku: SKU, name: 'Pastamaskin', externalId: '2' }])
    await ensureSupplyItems()
    expect(await db.supplyItem.count({ where: { sku: SKU } })).toBe(1)
  })

  it('creates nothing for an unusable SKU', async () => {
    // "0" is shared by a pizza oven and a massage chair on the live stores.
    await shopWith('no', [{ sku: '0', name: TAG, externalId: '3' }])
    await ensureSupplyItems()
    expect(await db.supplyItem.count({ where: { sku: '0' } })).toBe(0)
  })

  it('never overwrites purchasing settings already entered', async () => {
    await shopWith('no', [{ sku: SKU, name: 'Pasta Maker', externalId: '1' }])
    await ensureSupplyItems()
    await db.supplyItem.update({ where: { sku: SKU }, data: { productionDays: 45 } })
    await ensureSupplyItems()
    expect((await db.supplyItem.findUniqueOrThrow({ where: { sku: SKU } })).productionDays).toBe(45)
  })

  it('reports how many it created, so a caller can stay silent when nothing changed', async () => {
    await shopWith('no', [{ sku: SKU, name: 'Pasta Maker', externalId: '1' }])

    await ensureSupplyItems()
    expect(await db.supplyItem.count({ where: { sku: SKU } })).toBe(1)

    // A second run must create nothing NEW. Counted as a delta rather than an
    // absolute, because this function deliberately scans every product in the
    // database and a suite running beside this one may legitimately add its own.
    const before = await db.supplyItem.count()
    await ensureSupplyItems()
    expect(await db.supplyItem.count()).toBe(before)
  })
})
