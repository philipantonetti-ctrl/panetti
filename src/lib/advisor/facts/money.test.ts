import { describe, expect, it } from 'vitest'
import { ZERO_FIGURES, type EngineResult, type ShopFigures } from '@/lib/metrics/types'
import type { MarketingResult, MarketingShopRow } from '@/lib/ads/marketing'
import { moneyFacts } from './money'

const shop = (over: Partial<ShopFigures>): ShopFigures => ({
  ...ZERO_FIGURES,
  shopId: 'shop_se',
  shopName: 'Panetti Sweden',
  ...over,
})

const engine = (rows: ShopFigures[]): EngineResult => ({
  displayCurrency: 'USD',
  byShop: rows,
  total: { ...ZERO_FIGURES, netRevenue: rows.reduce((n, r) => n + r.netRevenue, 0) },
})

const mktRow = (over: Partial<MarketingShopRow>): MarketingShopRow =>
  ({
    shopId: 'shop_se',
    shopName: 'Panetti Sweden',
    spend: 0,
    dailyBudget: null,
    metaSpend: 0,
    googleSpend: 0,
    impressions: 0,
    clicks: 0,
    linkClicks: 0,
    conversions: 0,
    conversionValue: 0,
    videoViews3s: 0,
    thruplays: 0,
    orders: 0,
    grossRevenue: 0,
    roas: null,
    platformRoas: null,
    cpa: null,
    costPerPurchase: null,
    avgPurchaseValue: null,
    cpm: null,
    cpc: null,
    costPerLinkClick: null,
    ctr: null,
    linkCtr: null,
    holdRate: null,
    ...over,
  }) as MarketingShopRow

const marketing = (rows: MarketingShopRow[]): MarketingResult => ({
  displayCurrency: 'USD',
  byShop: rows,
  total: mktRow({ shopId: '', shopName: 'Total' }),
  // Empty on purpose: moneyFacts reads byShop, never the per-platform split.
  byPlatform: [],
  series: [],
})

const empty = marketing([])

describe('moneyFacts', () => {
  it('reports a material revenue fall', () => {
    const facts = moneyFacts({
      now: engine([shop({ netRevenue: 820_000 })]),
      before: engine([shop({ netRevenue: 1_000_000 })]),
      nowMarketing: empty,
      beforeMarketing: empty,
    })

    const revenue = facts.find((f) => f.kind === 'REVENUE_MOVE')
    expect(revenue).toBeDefined()
    expect(revenue!.id).toBe('revenue:shop_se')
    expect(revenue!.deltaPct).toBeCloseTo(-0.18)
    expect(revenue!.currency).toBe('USD')
  })

  it('says nothing about a shop that barely moved', () => {
    const facts = moneyFacts({
      now: engine([shop({ netRevenue: 990_000 })]),
      before: engine([shop({ netRevenue: 1_000_000 })]),
      nowMarketing: empty,
      beforeMarketing: empty,
    })
    expect(facts).toEqual([])
  })

  it('reports a ROAS fall, scored by how much this shop actually spends', () => {
    const facts = moneyFacts({
      now: engine([shop({ netRevenue: 1_000_000 })]),
      before: engine([shop({ netRevenue: 1_000_000 })]),
      nowMarketing: marketing([mktRow({ roas: 4.9, spend: 60_000 })]),
      beforeMarketing: marketing([mktRow({ roas: 7.4, spend: 60_000 })]),
    })

    const roas = facts.find((f) => f.kind === 'ROAS_MOVE')
    expect(roas).toBeDefined()
    expect(roas!.current).toBe(4.9)
    expect(roas!.previous).toBe(7.4)
    expect(roas!.unit).toBe('ratio')
  })

  it('ignores a ROAS move on a shop that spends almost nothing', () => {
    const facts = moneyFacts({
      now: engine([shop({ netRevenue: 1_000_000 })]),
      before: engine([shop({ netRevenue: 1_000_000 })]),
      nowMarketing: marketing([mktRow({ roas: 1, spend: 500 })]),
      beforeMarketing: marketing([mktRow({ roas: 8, spend: 500 })]),
    })
    expect(facts.find((f) => f.kind === 'ROAS_MOVE')).toBeUndefined()
  })

  it('reports spend running over its daily budget', () => {
    // 7 days at a 10_000 budget is 70_000; 95_000 is 36% over.
    const facts = moneyFacts({
      now: engine([shop({ netRevenue: 1_000_000 })]),
      before: engine([shop({ netRevenue: 1_000_000 })]),
      nowMarketing: marketing([mktRow({ spend: 95_000, dailyBudget: 10_000 })]),
      beforeMarketing: marketing([mktRow({ spend: 70_000, dailyBudget: 10_000 })]),
      days: 7,
    })

    const budget = facts.find((f) => f.kind === 'SPEND_VS_BUDGET')
    expect(budget).toBeDefined()
    expect(budget!.previous).toBe(70_000)
    expect(budget!.current).toBe(95_000)
  })

  it('says nothing about a budget nobody set', () => {
    const facts = moneyFacts({
      now: engine([shop({ netRevenue: 1_000_000 })]),
      before: engine([shop({ netRevenue: 1_000_000 })]),
      nowMarketing: marketing([mktRow({ spend: 95_000, dailyBudget: null })]),
      beforeMarketing: marketing([mktRow({ spend: 70_000, dailyBudget: null })]),
      days: 7,
    })
    expect(facts.find((f) => f.kind === 'SPEND_VS_BUDGET')).toBeUndefined()
  })

  it('reports a margin squeeze by the profit it cost, not by the ratio', () => {
    const facts = moneyFacts({
      now: engine([shop({ netRevenue: 1_000_000, netProfit: 100_000, netMargin: 0.1 })]),
      before: engine([shop({ netRevenue: 1_000_000, netProfit: 200_000, netMargin: 0.2 })]),
      nowMarketing: empty,
      beforeMarketing: empty,
    })

    const margin = facts.find((f) => f.kind === 'MARGIN_MOVE')
    expect(margin).toBeDefined()
    expect(margin!.unit).toBe('percent')
    expect(margin!.current).toBeCloseTo(0.1)
  })
})
