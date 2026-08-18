import { describe, it, expect } from 'vitest'
import { previousRange, deltaPct, dailySeries } from './trend'
import { computeMetrics } from './engine'
import { buildRateTable } from './fx'
import type { CostBook, EngineOrder, EngineShop } from './types'

const day = (d: Date) => d.toISOString().slice(0, 10)

describe('previousRange', () => {
  it('is the same length, immediately before', () => {
    // 1-7 Jul is 7 days -> the 7 days before it are 24-30 Jun.
    const prev = previousRange(new Date('2026-07-01'), new Date('2026-07-07'))
    expect(day(prev.from)).toBe('2026-06-24')
    expect(day(prev.to)).toBe('2026-06-30')
  })

  it('handles a single day', () => {
    const prev = previousRange(new Date('2026-07-14'), new Date('2026-07-14'))
    expect(day(prev.from)).toBe('2026-07-13')
    expect(day(prev.to)).toBe('2026-07-13')
  })

  it('crosses a month boundary without drifting', () => {
    const prev = previousRange(new Date('2026-03-01'), new Date('2026-03-31'))
    expect(day(prev.to)).toBe('2026-02-28')
    expect(day(prev.from)).toBe('2026-01-29') // 31 days back from 28 Feb
  })
})

describe('deltaPct', () => {
  it('is the change against the period before', () => {
    expect(deltaPct(110, 100)).toBeCloseTo(0.1, 6)
    expect(deltaPct(90, 100)).toBeCloseTo(-0.1, 6)
  })

  it('is null when there is nothing to compare against — never Infinity', () => {
    // Growing from zero is not "+∞%", it is simply not a percentage.
    expect(deltaPct(500, 0)).toBeNull()
    expect(deltaPct(0, 0)).toBeNull()
  })

  it('handles a negative previous period without lying about the direction', () => {
    // Last month lost 100, this month lost 50: that is an improvement.
    expect(deltaPct(-50, -100)).toBeGreaterThan(0)
  })
})

describe('dailySeries', () => {
  const shops: EngineShop[] = [{ id: 's1', name: 'Shop', currency: 'USD' }]
  const rates = buildRateTable([{ date: new Date('2026-07-01'), currency: 'USD', rate: 1 }])
  const costs: CostBook = new Map([
    ['p1', [{ costPerItem: 1000, handlingCost: 0, effectiveFrom: new Date('2026-01-01') }]],
  ])

  // voidedOn, when given, makes this a refunded order: status flips to 'refunded'
  // and voidedAt is set, matching how a real refunded order looks to the engine.
  function order(id: string, on: string, voidedOn?: string): EngineOrder {
    return {
      id, shopId: 's1', placedAt: new Date(on), status: voidedOn ? 'refunded' : 'completed', currency: 'USD',
      costCurrency: 'USD',
      voidedAt: voidedOn ? new Date(voidedOn) : undefined,
      grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0, taxTotal: 2500, total: 12500,
      ambassadorId: null, commissionRate: 0,
      items: [{ productId: 'p1', sku: 'PANPIZPRO', quantity: 1, lineNetTotal: 10000 }],
    }
  }

  const input = {
    shops,
    orders: [order('a', '2026-07-01'), order('b', '2026-07-01'), order('c', '2026-07-03')],
    expenses: [],
    costs,
    rates,
    displayCurrency: 'USD',
    from: new Date('2026-07-01'),
    to: new Date('2026-07-03'),
  }

  it('returns one point per day in the range, even days with no orders', () => {
    const series = dailySeries(input)
    expect(series.map((p) => p.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it('puts each day’s revenue on that day', () => {
    const series = dailySeries(input)
    expect(series[0].netRevenue).toBe(20000) // two orders
    expect(series[1].netRevenue).toBe(0) // quiet day
    expect(series[2].netRevenue).toBe(10000)
  })

  it('computes profit per day, costs included', () => {
    const series = dailySeries(input)
    expect(series[0].netProfit).toBe(20000 - 2000) // 2 x 1000 cogs
    expect(series[2].netProfit).toBe(10000 - 1000)
  })

  it('charges each day only its own ad spend', () => {
    // The chart sits directly above the table. If a day's profit point did not
    // carry that day's spend, the line and the Net profit column would disagree
    // on the same screen.
    const series = dailySeries({
      ...input,
      adSpend: [
        { shopId: 's1', date: new Date('2026-07-01'), spend: 5000, currency: 'USD' },
        { shopId: 's1', date: new Date('2026-07-03'), spend: 3000, currency: 'USD' },
      ],
    })

    expect(series[0].netProfit).toBe(20000 - 2000 - 5000) // two orders, their cogs, its ads
    expect(series[1].netProfit).toBe(0) // quiet day: no orders and no spend
    expect(series[2].netProfit).toBe(10000 - 1000 - 3000)
  })

  it('adds the daily profit points up to the whole-range profit', () => {
    const withAds = {
      ...input,
      adSpend: [
        { shopId: 's1', date: new Date('2026-07-01'), spend: 5000, currency: 'USD' },
        { shopId: 's1', date: new Date('2026-07-03'), spend: 3000, currency: 'USD' },
      ],
    }
    const summed = dailySeries(withAds).reduce((n, p) => n + p.netProfit, 0)
    expect(computeMetrics(withAds).total.netProfit).toBe(summed)
  })

  it('adds up to the same total as the whole-range figure', () => {
    const series = dailySeries(input)
    const summed = series.reduce((n, p) => n + p.netRevenue, 0)
    expect(summed).toBe(30000)
  })

  // The fast path buckets orders by their zoned day; that bucketing MUST match
  // the engine's own day boundaries, or a late-night order lands on the wrong bar.
  it('places an order on its shop-timezone day, not its UTC day', () => {
    const nyShops: EngineShop[] = [{ id: 's1', name: 'NY', currency: 'USD' }]
    const shopTimezones = new Map([['s1', 'America/New_York']])
    // 02:00 UTC on Jul 2 is 22:00 on Jul 1 in New York.
    const tzInput = {
      ...input,
      shops: nyShops,
      orders: [order('x', '2026-07-02T02:00:00Z')],
      shopTimezones,
      from: new Date('2026-07-01'),
      to: new Date('2026-07-02'),
    }
    const byDate = Object.fromEntries(dailySeries(tzInput).map((p) => [p.date, p.netRevenue]))
    expect(byDate['2026-07-01']).toBe(10000) // its New York day
    expect(byDate['2026-07-02']).toBe(0)
  })

  // A refunded order is not a sale on any day, so the chart shows it nowhere —
  // no spike on the sale day, no trough on the refund day.
  it('leaves no mark at all for an order that was refunded', () => {
    const range = { from: new Date('2026-07-01'), to: new Date('2026-07-10') }
    const refundInput = { ...input, ...range, orders: [order('r', '2026-07-01', '2026-07-08')] }

    const series = dailySeries(refundInput)
    const byDate = Object.fromEntries(series.map((p) => [p.date, p.netRevenue]))
    const summed = series.reduce((n, p) => n + p.netRevenue, 0)
    const { total } = computeMetrics({ ...refundInput, orders: refundInput.orders })

    expect(byDate['2026-07-01']).toBe(0)
    expect(byDate['2026-07-08']).toBe(0)
    expect(summed).toBe(total.netRevenue) // series and header must agree
    expect(total.netRevenue).toBe(0)
  })

  // The case that forced the rule: an order placed OUTSIDE the visible window
  // and refunded inside it. Booking the reversal on its own day dragged the
  // chart — and the header — below zero for a day whose own orders were fine.
  it('never dips a day for a refund belonging to an order outside the window', () => {
    const range = { from: new Date('2026-07-01'), to: new Date('2026-07-10') }
    const refundInput = { ...input, ...range, orders: [order('r', '2026-04-02', '2026-07-03')] }

    const series = dailySeries(refundInput)
    const byDate = Object.fromEntries(series.map((p) => [p.date, p.netRevenue]))
    const summed = series.reduce((n, p) => n + p.netRevenue, 0)
    const { total } = computeMetrics({ ...refundInput, orders: refundInput.orders })

    expect(byDate['2026-07-03']).toBe(0) // April's order cannot touch July
    expect(series.every((p) => p.netRevenue === 0)).toBe(true)
    expect(summed).toBe(total.netRevenue)
    expect(total.netRevenue).toBe(0)
  })

  // Regression guard: an ordinary order that is never voided must still land on
  // exactly one day, exactly as it did before voidedAt bucketing was added.
  it('leaves a plain unrefunded order exactly where it always was', () => {
    const range = { from: new Date('2026-07-01'), to: new Date('2026-07-10') }
    const liveInput = { ...input, ...range, orders: [order('a', '2026-07-05')] }

    const series = dailySeries(liveInput)
    const byDate = Object.fromEntries(series.map((p) => [p.date, p.netRevenue]))

    expect(byDate['2026-07-05']).toBe(10000)
    expect(series.filter((p) => p.netRevenue !== 0)).toHaveLength(1) // one day, not two
    expect(series.reduce((n, p) => n + p.netRevenue, 0)).toBe(10000)
  })
})
