import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { loadMetricsInput } from './load'
import { computeMetrics } from '../metrics/engine'

const MARKER = '[load-affiliate-test]'

async function wipe() {
  await db.affiliateAccount.deleteMany({ where: { name: { contains: MARKER } } })
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}
beforeEach(wipe)
afterEach(wipe)

describe('loadMetricsInput affiliate', () => {
  it('hands the engine the grouped affiliate rows, and profit moves by them', async () => {
    const shop = await db.shop.create({ data: { name: `${MARKER} shop`, currency: 'NOK' } })
    const account = await db.affiliateAccount.create({
      data: {
        externalId: `load-aff-${Date.now()}`,
        name: `${MARKER} Panetti`,
        token: 'plain-token',
        // Inactive: invisible to any forced syncAll in parallel test files.
        active: false,
      },
    })
    await db.affiliateTransaction.create({
      data: {
        accountId: account.id,
        externalId: '1',
        date: new Date('2026-01-02'),
        market: 'NO',
        shopId: shop.id,
        channelId: '1',
        channelName: 'Forbrukertesten.com',
        status: 'new',
        commission: 12835,
        brokerageFee: 1925,
        orderValue: 85564,
        currency: 'NOK',
      },
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id],
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    })
    expect(input.affiliate).toEqual([
      { shopId: shop.id, date: new Date('2026-01-02T00:00:00.000Z'), amount: 14760, currency: 'NOK' },
    ])

    // One shop -> display currency is the shop's own NOK; no FX in the way.
    const result = computeMetrics(input)
    expect(result.total.affiliate).toBe(14760)
    expect(result.total.netProfit).toBe(-14760)
  })
})
