import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { attributeExistingOrders } from './attribution'
import { db } from './db'

const MARK = '[attrib-test]'
const MINE = 'attrib-mine@example.local'
const THEIRS = 'attrib-theirs@example.local'

let shopA = ''
let shopB = ''
let mine = ''
let theirs = ''

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: { in: [MINE, THEIRS] } } })
}

const order = (shopId: string, externalId: string, couponCode: string | null, ambassadorId: string | null) =>
  db.order.create({
    data: {
      shopId, externalId, number: externalId, placedAt: new Date('2026-01-15'), status: 'completed',
      currency: 'NOK', grossSales: 10000, discountTotal: 0, netSales: 10000,
      shippingCharged: 0, taxTotal: 0, total: 10000, couponCode, ambassadorId,
    },
  })

beforeEach(async () => {
  await wipe()
  shopA = (await db.shop.create({ data: { name: `A ${MARK}`, currency: 'NOK' } })).id
  shopB = (await db.shop.create({ data: { name: `B ${MARK}`, currency: 'NOK' } })).id
  mine = (await db.ambassador.create({ data: { name: 'Mine', email: MINE, commissionRate: 0.1 } })).id
  theirs = (await db.ambassador.create({ data: { name: 'Theirs', email: THEIRS, commissionRate: 0.1 } })).id
})

afterEach(wipe)

describe('attributeExistingOrders', () => {
  it('links past orders that already carry the code on that store', async () => {
    await order(shopA, 'a-1', 'TEKGUIDE500', null)
    await order(shopA, 'a-2', 'TEKGUIDE500', null)

    const count = await attributeExistingOrders(mine, shopA, 'tekguide500') // case-insensitive
    expect(count).toBe(2)

    const linked = await db.order.findMany({ where: { shopId: shopA }, select: { ambassadorId: true } })
    expect(linked.every((o) => o.ambassadorId === mine)).toBe(true)
  })

  // The guarantee that must never break: an attribution already frozen onto an
  // order is history and is never rewritten.
  it('never steals an order already attributed to someone else', async () => {
    const taken = await order(shopA, 'a-3', 'TEKGUIDE500', theirs)

    const count = await attributeExistingOrders(mine, shopA, 'TEKGUIDE500')
    expect(count).toBe(0)

    const after = await db.order.findUniqueOrThrow({ where: { id: taken.id } })
    expect(after.ambassadorId).toBe(theirs)
  })

  it('leaves the same code on a DIFFERENT store alone', async () => {
    const other = await order(shopB, 'b-1', 'TEKGUIDE500', null)

    const count = await attributeExistingOrders(mine, shopA, 'TEKGUIDE500')
    expect(count).toBe(0)

    const after = await db.order.findUniqueOrThrow({ where: { id: other.id } })
    expect(after.ambassadorId).toBeNull()
  })

  it('leaves orders with a different code alone', async () => {
    const other = await order(shopA, 'a-4', 'SOMETHINGELSE', null)

    expect(await attributeExistingOrders(mine, shopA, 'TEKGUIDE500')).toBe(0)
    const after = await db.order.findUniqueOrThrow({ where: { id: other.id } })
    expect(after.ambassadorId).toBeNull()
  })
})
