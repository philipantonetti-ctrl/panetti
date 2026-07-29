import { describe, expect, it } from 'vitest'
import { buildMarketing } from './marketing'
import { buildRateTable } from '../metrics/fx'
import { ZERO_FIGURES, type EngineResult } from '../metrics/types'

/** Two shops in USD display; NOK meta account on A, EUR google account on A, none on B. */

const rates = buildRateTable([
  { date: new Date('2026-07-01T00:00:00Z'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-01T00:00:00Z'), currency: 'EUR', rate: 1.0 },
  { date: new Date('2026-07-02T00:00:00Z'), currency: 'NOK', rate: 0.2 },
  { date: new Date('2026-07-02T00:00:00Z'), currency: 'EUR', rate: 1.1 },
])

const engine: EngineResult = {
  displayCurrency: 'USD',
  byShop: [
    { ...ZERO_FIGURES, shopId: 'shop-a', shopName: 'Alpha', orders: 10, grossRevenue: 500_00 },
    { ...ZERO_FIGURES, shopId: 'shop-b', shopName: 'Beta', orders: 4, grossRevenue: 200_00 },
  ],
  total: { ...ZERO_FIGURES, orders: 14, grossRevenue: 700_00 },
}

const accounts = [
  { id: 'acc-meta', shopId: 'shop-a', provider: 'meta', currency: 'NOK', dailyBudget: 500_00 },
  { id: 'acc-google', shopId: 'shop-a', provider: 'google', currency: 'EUR', dailyBudget: 20_00 },
]

const TO = new Date('2026-07-02T00:00:00Z')

const spendRow = (over: Partial<import('./marketing').SpendRow> & { accountId: string; date: Date; spend: number }) => ({
  impressions: 0,
  clicks: 0,
  linkClicks: 0,
  conversions: 0,
  conversionValue: 0,
  videoViews3s: 0,
  thruplays: 0,
  ...over,
})

const spend = [
  // 1000 NOK on the 1st at 0.1 -> $100.00; 1000 NOK on the 2nd at 0.2 -> $200.00
  spendRow({
    accountId: 'acc-meta',
    date: new Date('2026-07-01T00:00:00Z'),
    spend: 1000_00,
    impressions: 3000,
    clicks: 60,
    linkClicks: 45,
    conversions: 2,
    conversionValue: 4000_00, // NOK at 0.1 -> $400.00
    videoViews3s: 800,
    thruplays: 200,
  }),
  spendRow({
    accountId: 'acc-meta',
    date: new Date('2026-07-02T00:00:00Z'),
    spend: 1000_00,
    impressions: 1000,
    clicks: 40,
    linkClicks: 35,
    conversions: 1,
    conversionValue: 1000_00, // NOK at 0.2 -> $200.00
    videoViews3s: 200,
    thruplays: 50,
  }),
  // 50 EUR on the 2nd at 1.1 -> $55.00
  spendRow({
    accountId: 'acc-google',
    date: new Date('2026-07-02T00:00:00Z'),
    spend: 50_00,
    impressions: 500,
    clicks: 25,
    linkClicks: 25,
    conversions: 0.5,
    conversionValue: 100_00, // EUR at 1.1 -> $110.00
  }),
]

const series = [
  { date: '2026-07-01', netRevenue: 0, netProfit: 0, grossRevenue: 300_00 },
  { date: '2026-07-02', netRevenue: 0, netProfit: 0, grossRevenue: 400_00 },
]

describe('buildMarketing', () => {
  const result = buildMarketing({ accounts, spend, engine, series, rates, to: TO })

  it('converts each day of spend at that day\'s rate and splits by provider', () => {
    const alpha = result.byShop.find((r) => r.shopId === 'shop-a')!
    expect(alpha.metaSpend).toBe(300_00) // $100 + $200
    expect(alpha.googleSpend).toBe(55_00)
    expect(alpha.spend).toBe(355_00)
    expect(alpha.impressions).toBe(4500)
    expect(alpha.clicks).toBe(125)
  })

  it('computes ROAS, CPA, CPC and CTR against the dashboard\'s own figures', () => {
    const alpha = result.byShop.find((r) => r.shopId === 'shop-a')!
    expect(alpha.roas).toBeCloseTo(500_00 / 355_00, 10)
    expect(alpha.cpa).toBe(Math.round(355_00 / 10))
    expect(alpha.cpc).toBe(Math.round(355_00 / 125))
    expect(alpha.ctr).toBeCloseTo(125 / 4500, 10)
  })

  it("computes the platform's own metrics: purchases, value, P. ROAS, CPM and video ratios", () => {
    const alpha = result.byShop.find((r) => r.shopId === 'shop-a')!
    expect(alpha.conversions).toBeCloseTo(3.5, 10)
    // $400 + $200 + $110, each day at its own rate.
    expect(alpha.conversionValue).toBe(710_00)
    expect(alpha.platformRoas).toBeCloseTo(710_00 / 355_00, 10)
    expect(alpha.costPerPurchase).toBe(Math.round(355_00 / 3.5))
    expect(alpha.avgPurchaseValue).toBe(Math.round(710_00 / 3.5))
    expect(alpha.cpm).toBe(Math.round((355_00 / 4500) * 1000))
    expect(alpha.linkClicks).toBe(105)
    expect(alpha.costPerLinkClick).toBe(Math.round(355_00 / 105))
    expect(alpha.linkCtr).toBeCloseTo(105 / 4500, 10)
    expect(alpha.holdRate).toBeCloseTo(250 / 1000, 10)
  })

  it('sums current budgets at the range-end rate, from the accounts themselves', () => {
    const alpha = result.byShop.find((r) => r.shopId === 'shop-a')!
    // 500 NOK at the 2nd's 0.2 -> $100.00; 20 EUR at 1.1 -> $22.00.
    expect(alpha.dailyBudget).toBe(122_00)
    const beta = result.byShop.find((r) => r.shopId === 'shop-b')!
    expect(beta.dailyBudget).toBeNull()
    expect(result.total.dailyBudget).toBe(122_00)
  })

  it('gives a shop without ad accounts zero spend and honest dashes', () => {
    const beta = result.byShop.find((r) => r.shopId === 'shop-b')!
    expect(beta.spend).toBe(0)
    expect(beta.roas).toBeNull()
    expect(beta.platformRoas).toBeNull()
    expect(beta.cpa).toBeNull()
    expect(beta.costPerPurchase).toBeNull()
    expect(beta.cpm).toBeNull()
    expect(beta.cpc).toBeNull()
    expect(beta.ctr).toBeNull()
    expect(beta.holdRate).toBeNull()
    expect(beta.orders).toBe(4) // context still shown
  })

  it('totals across shops and keeps the engine\'s order totals', () => {
    expect(result.total.spend).toBe(355_00)
    expect(result.total.orders).toBe(14)
    expect(result.total.grossRevenue).toBe(700_00)
    expect(result.total.roas).toBeCloseTo(700_00 / 355_00, 10)
  })

  it('merges spend into the daily series by date', () => {
    expect(result.series).toEqual([
      { date: '2026-07-01', spend: 100_00, grossRevenue: 300_00 },
      { date: '2026-07-02', spend: 255_00, grossRevenue: 400_00 },
    ])
  })

  it('cross-converts when one shop is shown in its own currency', () => {
    const single = buildMarketing({
      accounts,
      spend,
      engine: {
        displayCurrency: 'NOK',
        byShop: [{ ...ZERO_FIGURES, shopId: 'shop-a', shopName: 'Alpha', orders: 10, grossRevenue: 5000_00 }],
        total: { ...ZERO_FIGURES, orders: 10, grossRevenue: 5000_00 },
      },
      series,
      rates,
      to: TO,
    })
    const alpha = single.byShop[0]
    // NOK spend passes through; 50 EUR on the 2nd crosses at 1.1/0.2 -> 275 NOK.
    expect(alpha.metaSpend).toBe(2000_00)
    expect(alpha.googleSpend).toBe(275_00)
  })

  it('ignores spend from accounts outside the current scope', () => {
    const scoped = buildMarketing({
      accounts: [],
      spend,
      engine,
      series,
      rates,
      to: TO,
    })
    expect(scoped.total.spend).toBe(0)
    expect(scoped.total.dailyBudget).toBeNull()
  })
})
