import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { backfillNameKeys } from './name-key-backfill'

const TAG = '[name-key-backfill-test]'
const scoped = { shop: { name: { contains: TAG } } }
let shopId: string

async function cleanup() {
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Shop ${TAG}`, currency: 'NOK' } })).id
})

const order = (number: string, customerName: string | null, placedAt: string, customerNameKey: string | null = null) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName, customerNameKey,
    },
  })

describe('backfillNameKeys', () => {
  it('keys the rows that have a name and no key, newest first, and leaves the rest alone', async () => {
    const old = await order('NK-OLD', 'Röthke Martin', '2026-01-01T00:00:00Z')
    const fresh = await order('NK-NEW', 'Anitta Airi', '2026-09-01T00:00:00Z')
    const empty = await order('NK-EMPTY', '', '2026-08-01T00:00:00Z')
    const noName = await order('NK-NONAME', null, '2026-08-02T00:00:00Z')
    const keyed = await order('NK-KEYED', 'Someone Else', '2026-08-03T00:00:00Z', 'kept as is')

    expect(await backfillNameKeys(2)).toBe(2)
    const after = async (id: string) => (await db.order.findUnique({ where: { id }, select: { customerNameKey: true } }))?.customerNameKey
    expect(await after(fresh.id)).toBe('airi anitta')
    expect(await after(empty.id)).toBe('')
    expect(await after(old.id)).toBeNull()
    expect(await after(noName.id)).toBeNull()
    expect(await after(keyed.id)).toBe('kept as is')

    expect(await backfillNameKeys()).toBeGreaterThanOrEqual(1)
    expect(await after(old.id)).toBe('martin rothke')
    expect(await after(noName.id)).toBeNull()
  })
})
