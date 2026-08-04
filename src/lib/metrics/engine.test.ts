import { describe, it, expect } from 'vitest'
import { computeMetrics } from './engine'
import { buildRateTable } from './fx'
import type { CostBook, EngineAdSpend, EngineExpense, EngineOrder, EngineShop } from './types'

const shops: EngineShop[] = [
  { id: 'no', name: 'Mazzetti.no', currency: 'NOK' },
  { id: 'se', name: 'Mazzetti.se', currency: 'SEK' },
]

// 1 NOK = 0.10 USD, 1 SEK = 0.09 USD
const rates = buildRateTable([
  { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-01'), currency: 'SEK', rate: 0.09 },
])

// Product p1 costs 100.00 kr/item + 10.00 kr handling from 1 Jan 2026.
const costs: CostBook = new Map([
  ['p1', [{ costPerItem: 10000, handlingCost: 1000, effectiveFrom: new Date('2026-01-01') }]],
])

function order(over: Partial<EngineOrder> = {}): EngineOrder {
  return {
    id: 'o1',
    shopId: 'no',
    placedAt: new Date('2026-07-01'),
    status: 'completed',
    currency: 'NOK',
    costCurrency: 'NOK',
    grossSales: 100000, // 1000.00 kr before discount
    discountTotal: 10000, //  100.00 kr discount
    netSales: 90000, //  900.00 kr  <- commission base
    shippingCharged: 5000, //   50.00 kr
    taxTotal: 22500, //  225.00 kr VAT — never revenue
    total: 117500, // what the customer was charged, incl VAT
    ambassadorId: null,
    commissionRate: 0,
    items: [{ productId: 'p1', quantity: 2, lineNetTotal: 90000 }],
    ...over,
  }
}

describe('computeMetrics', () => {
  it('computes profit for one shop in its own currency', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order()],
      expenses: [],
      costs,
      rates,
      displayCurrency: 'NOK',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
    })

    const t = res.total
    expect(t.orders).toBe(1)
    expect(t.netSales).toBe(90000) // 900 kr
    expect(t.netRevenue).toBe(95000) // + 50 kr shipping
    expect(t.cogs).toBe(22000) // 2 x (10000 + 1000)
    expect(t.commission).toBe(0) // unattributed
    expect(t.netProfit).toBe(73000) // 95000 - 22000
    expect(t.netMargin).toBeCloseTo(73000 / 95000, 6)
    expect(t.avgOrderValue).toBe(95000)
  })

  it('never counts VAT as revenue', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [order()], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    // taxTotal was 22500 and appears nowhere in revenue or profit.
    expect(res.total.netRevenue).toBe(95000)
    expect(res.total.netProfit).toBe(73000)
  })

  it('pays 10% commission on net sales, not on gross and not on shipping', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order({ ambassadorId: 'a1', commissionRate: 0.1 })],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.commission).toBe(9000) // 10% of 90000 netSales
    expect(res.total.ambassadorSales).toBe(90000)
    expect(res.total.netProfit).toBe(73000 - 9000)
  })

  it('excludes refunded and cancelled orders from everything', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [
        order({ id: 'good' }),
        order({ id: 'refunded', status: 'refunded', ambassadorId: 'a1', commissionRate: 0.1 }),
        order({ id: 'cancelled', status: 'cancelled' }),
      ],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.orders).toBe(1) // only the good one
    expect(res.total.netSales).toBe(90000)
    expect(res.total.commission).toBe(0) // the refunded order earns nothing
  })

  it('excludes unpaid orders — pending and on-hold — until Woo marks them paid', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [
        order({ id: 'paid', status: 'processing', ambassadorId: 'a1', commissionRate: 0.1 }),
        order({ id: 'awaiting-payment', status: 'pending', ambassadorId: 'a1', commissionRate: 0.1 }),
        order({ id: 'bank-transfer', status: 'on-hold' }),
      ],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    // Money that has not arrived is not revenue: one order, one commission.
    expect(res.total.orders).toBe(1)
    expect(res.total.netSales).toBe(90000)
    expect(res.total.commission).toBe(9000)
  })

  it('subtracts operational expenses for the selected range', () => {
    const expense: EngineExpense = {
      id: 'e1', shopId: 'no', amount: 3100000, currency: 'NOK',
      recurrence: 'MONTHLY', startDate: new Date('2026-01-01'), endDate: null, active: true,
    }
    const res = computeMetrics({
      shops: [shops[0]], orders: [order()], expenses: [expense], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    // 31 000 kr / 31 days = 1 000 kr for the single selected day
    expect(res.total.operationalExpenses).toBe(100000)
    expect(res.total.netProfit).toBe(73000 - 100000) // this day runs at a loss
  })

  it('consolidates several shops into USD using each order own-date rate', () => {
    const res = computeMetrics({
      shops,
      orders: [
        order({ id: 'n1', shopId: 'no', currency: 'NOK' }),
        order({ id: 's1', shopId: 'se', currency: 'SEK' }),
      ],
      expenses: [], costs, rates,
      displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    const no = res.byShop.find((s) => s.shopId === 'no')!
    const se = res.byShop.find((s) => s.shopId === 'se')!

    expect(no.netSales).toBe(9000) // 90000 øre x 0.10
    expect(se.netSales).toBe(8100) // 90000 öre x 0.09
    expect(res.total.netSales).toBe(17100) // and the total adds up
    expect(res.displayCurrency).toBe('USD')
  })

  it('returns a row for a shop with no orders rather than dropping it', () => {
    const res = computeMetrics({
      shops, orders: [order({ shopId: 'no' })], expenses: [], costs, rates,
      displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    const se = res.byShop.find((s) => s.shopId === 'se')!
    expect(se.orders).toBe(0)
    expect(se.netRevenue).toBe(0)
  })

  it('reports zero margin instead of dividing by zero when there is no revenue', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.netMargin).toBe(0)
    expect(res.total.avgOrderValue).toBe(0)
    expect(Number.isNaN(res.total.netMargin)).toBe(false)
  })

  it('costs an order with a product that has no cost entered as zero, not as a crash', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order({ items: [{ productId: 'unknown-product', quantity: 3, lineNetTotal: 90000 }] })],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.cogs).toBe(0)
    expect(res.total.netProfit).toBe(95000) // full revenue, no cost known
  })

  it('ignores orders outside the selected date range', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order({ placedAt: new Date('2026-06-30') }), order({ id: 'in', placedAt: new Date('2026-07-01') })],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.orders).toBe(1)
  })

  it('reports VAT for the period without letting it touch profit', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [
        order(),
        order({ id: 'refunded', status: 'refunded' }), // contributes no tax either
      ],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.taxes).toBe(22500) // the one live order's VAT
    expect(res.total.netProfit).toBe(73000) // unchanged — VAT is not a cost
    expect(res.byShop[0].taxes).toBe(22500)
  })

  it('converts VAT at each order own-date rate like every other figure', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [order()], expenses: [], costs, rates,
      displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.taxes).toBe(2250) // 22 500 øre x 0.10
  })
  it('charges fulfillment per order at the rate in force that day', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order(), order({ id: 'o2' })],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
      fulfillmentRates: new Map([['no', [
        { perOrder: 30000, effectiveFrom: new Date('2026-01-01') },
        { perOrder: 40000, effectiveFrom: new Date('2026-08-01') }, // future - must not apply
      ]]]),
    })
    expect(res.total.fulfillment).toBe(60000) // 2 orders x 300 kr
    expect(res.total.netProfit).toBe(2 * 73000 - 60000)
  })

  it('charges the gateway fee on the charged total, fixed part crossed from EUR', () => {
    const withEur = buildRateTable([
      { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
      { date: new Date('2026-07-01'), currency: 'EUR', rate: 1.2 },
    ])
    const res = computeMetrics({
      shops: [shops[0]], orders: [order()], expenses: [], costs, rates: withEur,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
      processingFee: { percent: 0.6, fixedMinor: 10, currency: 'EUR' },
    })
    // 0.6% of 117500 = 705; fixed 0.10 EUR -> NOK at 1.2/0.1 = x12 -> 120
    expect(res.total.transactionFees).toBe(705 + 120)
    expect(res.total.netProfit).toBe(73000 - 825)
  })
  it('buckets each shop in its own timezone when overrides exist', () => {
    const res = computeMetrics({
      shops,
      orders: [
        // 22:30 UTC = 00:30 next day in Oslo.
        order({ id: 'n1', shopId: 'no', currency: 'NOK', placedAt: new Date('2026-06-30T22:30:00Z') }),
        order({ id: 's1', shopId: 'se', currency: 'SEK', placedAt: new Date('2026-06-30T22:30:00Z') }),
      ],
      expenses: [], costs, rates,
      displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
      shopTimezones: new Map([['no', 'Europe/Oslo']]), // se falls back to UTC
    })
    const no = res.byShop.find((s) => s.shopId === 'no')!
    const se = res.byShop.find((s) => s.shopId === 'se')!
    expect(no.orders).toBe(1) // counts on 1 July in Oslo
    expect(se.orders).toBe(0) // still 30 June in UTC
  })

  // A business customer invoiced in EUR, buying from a NOK shop. Product costs
  // live in the SHOP's currency, so reading them as the order's would multiply
  // COGS by the EUR/NOK rate — about tenfold — and show a large false loss.
  it('reads product costs in the SHOP currency, not the order currency', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order({ currency: 'EUR', costCurrency: 'NOK' })],
      expenses: [],
      costs,
      rates: buildRateTable([
        { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
        { date: new Date('2026-07-01'), currency: 'EUR', rate: 1.1 },
      ]),
      displayCurrency: 'NOK',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
    })

    // 2 x (100.00 + 10.00) kr = 220.00 kr, displayed in kr — unchanged.
    // Converted from EUR it would have been 2 420.00 kr.
    expect(res.total.cogs).toBe(22000)
  })

  it('charges an invoiced B2B order no gateway fee', () => {
    const input = {
      shops: [shops[0]],
      expenses: [],
      costs,
      rates,
      displayCurrency: 'NOK',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
      processingFee: { percent: 2, fixedMinor: 300, currency: 'NOK' },
    }

    const webshop = computeMetrics({ ...input, orders: [order()] })
    expect(webshop.total.transactionFees).toBe(2650) // 2% of 1175.00 + 3.00

    const b2b = computeMetrics({ ...input, orders: [order({ chargesGatewayFee: false })] })
    expect(b2b.total.transactionFees).toBe(0)
    // The fee it did not pay is profit it keeps.
    expect(b2b.total.netProfit).toBe(webshop.total.netProfit + 2650)
  })

  it('uses a B2B order’s own shipping cost instead of the shop’s rate', () => {
    const input = {
      shops: [shops[0]],
      expenses: [],
      costs,
      rates,
      displayCurrency: 'NOK',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
      fulfillmentRates: new Map([
        ['no', [{ perOrder: 9900, effectiveFrom: new Date('2026-01-01') }]],
      ]),
    }

    expect(computeMetrics({ ...input, orders: [order()] }).total.fulfillment).toBe(9900)
    expect(
      computeMetrics({ ...input, orders: [order({ fulfillmentCost: 45000 })] }).total.fulfillment,
    ).toBe(45000)
    // Zero is a real answer — "we did not ship it" — not "fall back to the rate".
    expect(
      computeMetrics({ ...input, orders: [order({ fulfillmentCost: 0 })] }).total.fulfillment,
    ).toBe(0)
  })
})

describe('computeMetrics and ad spend', () => {
  // Two USD shops and no orders, so every figure below is the ad spend and
  // nothing else. NOK moves between the two days, which is how "converted at
  // its own day's rate" gets proved rather than assumed.
  const adShops: EngineShop[] = [
    { id: 's1', name: 'Shop one', currency: 'USD' },
    { id: 's2', name: 'Shop two', currency: 'USD' },
  ]
  const adRates = buildRateTable([
    { date: new Date('2026-07-01'), currency: 'USD', rate: 1 },
    { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
    { date: new Date('2026-07-02'), currency: 'NOK', rate: 0.2 },
  ])

  const spend = (over: Partial<EngineAdSpend> = {}): EngineAdSpend => ({
    shopId: 's1',
    date: new Date('2026-07-01'),
    spend: 10000, // 100.00 kr
    currency: 'NOK',
    ...over,
  })

  const run = (adSpend?: EngineAdSpend[]) =>
    computeMetrics({
      shops: adShops,
      orders: [],
      expenses: [],
      costs: new Map(),
      rates: adRates,
      adSpend,
      displayCurrency: 'USD',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-02'),
    })

  it('converts each day of spend at that day’s own rate', () => {
    const res = run([spend(), spend({ date: new Date('2026-07-02') })])
    // 100.00 kr at 0.10 = $10.00; the same 100.00 kr next day at 0.20 = $20.00.
    // A single range-wide rate would give $20.00 or $40.00, never $30.00.
    expect(res.byShop[0].marketing).toBe(3000)
  })

  it('takes marketing straight out of net profit', () => {
    const res = run([spend()])
    expect(res.total.marketing).toBe(1000)
    expect(res.total.netProfit).toBe(-1000) // nothing sold: the spend is the whole loss
  })

  it('gives a shop with no ad account a zero, not a missing figure', () => {
    const res = run([spend()])
    expect(res.byShop[1].shopId).toBe('s2')
    expect(res.byShop[1].marketing).toBe(0)
  })

  it('ignores spend outside the range', () => {
    const res = run([
      spend({ date: new Date('2026-06-30') }), // the day before
      spend({ date: new Date('2026-07-03') }), // the day after
      spend(),
    ])
    expect(res.total.marketing).toBe(1000)
  })

  it('never lets one shop’s spend land on another', () => {
    const res = run([spend({ shopId: 's2', spend: 50000 })])
    expect(res.byShop[0].marketing).toBe(0)
    expect(res.byShop[1].marketing).toBe(5000)
  })

  it('sums marketing across shops in the total', () => {
    const res = run([spend(), spend({ shopId: 's2', spend: 20000 })])
    expect(res.total.marketing).toBe(1000 + 2000)
  })

  it('is zero when no ad spend is supplied at all', () => {
    // Every existing caller passes no adSpend. Their profit must not move.
    const res = run(undefined)
    expect(res.total.marketing).toBe(0)
    expect(res.total.netProfit).toBe(0)
  })
})
