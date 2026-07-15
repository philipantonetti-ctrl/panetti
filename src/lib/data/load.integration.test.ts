import { describe, it, expect } from 'vitest'
import { loadMetricsInput } from './load'
import { computeMetrics } from '../metrics'
import { db } from '../db'

// These run against the seeded database. Run `npm run db:seed` first.
describe('engine against the seeded database', () => {
  it('produces figures for every shop over the last 6 months', async () => {
    const from = new Date('2026-01-01')
    const to = new Date('2026-07-14')

    const input = await loadMetricsInput({ from, to })
    const res = computeMetrics(input)

    expect(input.shops.length).toBe(11)
    expect(res.displayCurrency).toBe('USD') // several shops -> USD
    expect(res.byShop).toHaveLength(11)
    expect(res.total.orders).toBeGreaterThan(0)
    expect(res.total.netRevenue).toBeGreaterThan(0)
    expect(res.total.cogs).toBeGreaterThan(0) // costs were seeded, so COGS must be real
  })

  it('shows a single shop in its own currency', async () => {
    const shop = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })

    const input = await loadMetricsInput({
      shopIds: [shop.id],
      from: new Date('2026-01-01'),
      to: new Date('2026-07-14'),
    })
    const res = computeMetrics(input)

    expect(res.displayCurrency).toBe('NOK')
    expect(res.byShop).toHaveLength(1)
  })

  it('never counts a refunded order', async () => {
    const from = new Date('2026-01-01')
    const to = new Date('2026-07-14')

    const input = await loadMetricsInput({ from, to })
    const res = computeMetrics(input)

    const refunded = input.orders.filter((o) => o.status === 'refunded').length
    expect(refunded).toBeGreaterThan(0) // the seed must actually contain some

    const counted = input.orders.filter((o) => !['refunded', 'cancelled', 'failed', 'trash'].includes(o.status))
    expect(res.total.orders).toBe(counted.length)
  })

  it('a narrower date range never produces more revenue than a wider one', async () => {
    const wide = computeMetrics(await loadMetricsInput({ from: new Date('2026-01-01'), to: new Date('2026-07-14') }))
    const narrow = computeMetrics(await loadMetricsInput({ from: new Date('2026-07-01'), to: new Date('2026-07-14') }))

    expect(narrow.total.netRevenue).toBeLessThanOrEqual(wide.total.netRevenue)
    expect(narrow.total.orders).toBeLessThanOrEqual(wide.total.orders)
  })
})
