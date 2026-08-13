// src/app/api/inventory/write.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { PUT as putItem } from './items/route'
import { POST as postSupplier } from './suppliers/route'

const TAG = `TEST-WRITE-${Date.now()}`
const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

afterEach(async () => {
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.supplier.deleteMany({ where: { name: { startsWith: TAG } } })
})

const post = (body: unknown) =>
  new Request('http://test', { method: 'POST', body: JSON.stringify(body) })

describe('inventory write routes', () => {
  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValue(null)
    expect((await postSupplier(post({ name: TAG }))).status).toBe(403)
  })

  it('creates a supplier', async () => {
    admin()
    const res = await postSupplier(post({ name: `${TAG}-supplier` }))
    expect(res.status).toBe(200)
    expect(await db.supplier.count({ where: { name: `${TAG}-supplier` } })).toBe(1)
  })

  it('refuses a supplier with no name rather than creating a blank one', async () => {
    admin()
    expect((await postSupplier(post({ name: '  ' }))).status).toBe(400)
  })

  it('saves purchasing settings against a SKU', async () => {
    admin()
    await db.supplyItem.create({ data: { sku: `${TAG}-A`, name: 'Test' } })
    const res = await putItem(
      new Request('http://test', {
        method: 'PUT',
        body: JSON.stringify({
          sku: `${TAG}-A`, productionDays: 30, deliveryDays: 40,
          moq: 500, unitsPerContainer: 1000, coverDays: null, supplierId: null,
        }),
      }),
    )
    expect(res.status).toBe(200)
    const item = await db.supplyItem.findUniqueOrThrow({ where: { sku: `${TAG}-A` } })
    expect(item.productionDays).toBe(30)
    expect(item.unitsPerContainer).toBe(1000)
  })

  it('refuses a negative lead time', async () => {
    admin()
    await db.supplyItem.create({ data: { sku: `${TAG}-B`, name: 'Test' } })
    const res = await putItem(
      new Request('http://test', {
        method: 'PUT',
        body: JSON.stringify({ sku: `${TAG}-B`, productionDays: -5 }),
      }),
    )
    expect(res.status).toBe(400)
  })
})
