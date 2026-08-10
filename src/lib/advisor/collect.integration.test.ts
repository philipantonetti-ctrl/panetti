import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { collectFacts } from './collect'

const day = (iso: string) => new Date(`${iso}T00:00:00Z`)
const NOW = day('2026-08-10')

let shopId = ''
let productId = ''

async function order(number: string, placedAt: Date, netSales: number) {
  return db.order.create({
    data: {
      shopId,
      externalId: `adv-${number}`,
      number,
      placedAt,
      status: 'completed',
      currency: 'NOK',
      grossSales: netSales,
      discountTotal: 0,
      netSales,
      shippingCharged: 0,
      taxTotal: 0,
      total: netSales,
      items: {
        create: [
          { productId, sku: 'ADV-1', name: 'Advisor Test Product', quantity: 1, unitPrice: netSales, lineNetTotal: netSales },
        ],
      },
    },
  })
}

beforeAll(async () => {
  const shop = await db.shop.create({ data: { name: 'Advisor Test Shop', currency: 'NOK' } })
  shopId = shop.id
  const product = await db.product.create({
    data: { shopId, externalId: 'adv-1', sku: 'ADV-1', name: 'Advisor Test Product' },
  })
  productId = product.id

  // Previous window (27 Jul – 2 Aug): 1_000_000 NOK.
  await order('A1', day('2026-07-29'), 1_000_000)
  // Current window (3 – 9 Aug): 400_000 NOK — a 60% fall.
  await order('A2', day('2026-08-05'), 400_000)
})

afterAll(async () => {
  await db.order.deleteMany({ where: { shopId } })
  await db.product.deleteMany({ where: { shopId } })
  await db.shop.delete({ where: { id: shopId } })
})

describe('collectFacts', () => {
  it('describes the seven days ending yesterday', async () => {
    const { from, to } = await collectFacts(NOW)
    expect(to.toISOString().slice(0, 10)).toBe('2026-08-09')
    expect(from.toISOString().slice(0, 10)).toBe('2026-08-03')
  })

  it('finds the revenue fall in the test shop', async () => {
    const { facts } = await collectFacts(NOW)
    const revenue = facts.find((f) => f.kind === 'REVENUE_MOVE' && f.shopId === shopId)
    expect(revenue).toBeDefined()
    expect(revenue!.deltaPct).toBeLessThan(-0.5)
  })

  it('flags the product that has no cost on file', async () => {
    const { facts } = await collectFacts(NOW)
    const uncosted = facts.find((f) => f.kind === 'UNCOSTED_PRODUCTS' && f.shopId === shopId)
    expect(uncosted).toBeDefined()
    expect(uncosted!.current).toBeGreaterThanOrEqual(1)
  })

  it('gives every fact an id unique within one briefing', async () => {
    const { facts } = await collectFacts(NOW)
    expect(new Set(facts.map((f) => f.id)).size).toBe(facts.length)
  })

  it('never drops a trust warning to make room for a move', async () => {
    const { facts } = await collectFacts(NOW)
    const moves = facts.filter((f) => f.kind !== 'UNCOSTED_PRODUCTS' && f.kind !== 'SHOP_SYNC_FAILING' && f.kind !== 'MISSING_FX')
    expect(moves.length).toBeLessThanOrEqual(40)
    expect(facts.some((f) => f.kind === 'UNCOSTED_PRODUCTS')).toBe(true)
  })
})
