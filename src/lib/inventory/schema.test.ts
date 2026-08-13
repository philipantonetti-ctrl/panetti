import { describe, expect, it, afterEach } from 'vitest'
import { db } from '../db'

const SKU = `TEST-SCHEMA-${Date.now()}`

afterEach(async () => {
  await db.purchaseOrder.deleteMany({ where: { item: { sku: SKU } } })
  await db.supplyItem.deleteMany({ where: { sku: SKU } })
  await db.supplier.deleteMany({ where: { name: SKU } })
})

describe('purchasing tables', () => {
  it('unassigns products when a supplier is removed, and keeps their orders', async () => {
    // The whole point of SetNull. A supplier we stop using must not take the
    // record of what we bought from them with it.
    const supplier = await db.supplier.create({ data: { name: SKU } })
    const item = await db.supplyItem.create({
      data: { sku: SKU, name: 'Test', supplierId: supplier.id },
    })
    await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 600, orderedAt: new Date() },
    })

    await db.supplier.delete({ where: { id: supplier.id } })

    const after = await db.supplyItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(after.supplierId).toBeNull()
    expect(await db.purchaseOrder.count({ where: { supplyItemId: item.id } })).toBe(1)
  })

  it('refuses a second row for the same SKU', async () => {
    await db.supplyItem.create({ data: { sku: SKU, name: 'Test' } })
    await expect(db.supplyItem.create({ data: { sku: SKU, name: 'Again' } })).rejects.toThrow()
  })
})
