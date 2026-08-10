import type { EngineResult } from '../../metrics/types'
import type { MarketingResult, MarketingShopRow } from '../../ads/marketing'
import { movingFact } from '../severity'
import type { Fact } from '../types'

/**
 * What the money did, per shop, against the equally-long period before.
 *
 * Every figure here already came out of `computeMetrics` and `buildMarketing`,
 * so a fact and the number on the Dashboard can never disagree — this file
 * compares, it does not calculate.
 */

export type MoneyFactsArgs = {
  now: EngineResult
  before: EngineResult
  nowMarketing: MarketingResult
  beforeMarketing: MarketingResult
  /** Days in the window, for turning a daily budget into a period budget. */
  days?: number
}

/**
 * The three fields this file reads, and only those.
 *
 * Deliberately NOT `Partial<MarketingShopRow>` forced back with `as`. That
 * cast claims three fields are all twenty-six, so a later read of a fourth
 * compiles cleanly and yields undefined — which reaches severity.ts as NaN,
 * and `NaN < MIN_SHARE` is false, so the materiality gate fails OPEN and a
 * junk fact ships. Narrowing the type makes that a compile error instead.
 */
type SpendFields = Pick<MarketingShopRow, 'spend' | 'roas' | 'dailyBudget'>

const EMPTY_MARKETING: SpendFields = { spend: 0, roas: null, dailyBudget: null }

export function moneyFacts(args: MoneyFactsArgs): Fact[] {
  const { now, before, nowMarketing, beforeMarketing } = args
  const days = args.days ?? 7

  // Every shop is measured against ONE baseline — the previous window's total
  // revenue — so a NOK store and a EUR one are ranked against each other rather
  // than each against itself.
  const baseline = before.total.netRevenue

  const beforeShop = new Map(before.byShop.map((s) => [s.shopId, s]))
  const nowMkt = new Map(nowMarketing.byShop.map((r) => [r.shopId, r]))
  const beforeMkt = new Map(beforeMarketing.byShop.map((r) => [r.shopId, r]))

  const facts: Fact[] = []
  const push = (fact: Fact | null) => {
    if (fact) facts.push(fact)
  }

  for (const shop of now.byShop) {
    const prior = beforeShop.get(shop.shopId)
    if (!prior) continue // a shop that did not exist last period has nothing to compare

    const where = { shopId: shop.shopId, shopName: shop.shopName, currency: now.displayCurrency }

    push(
      movingFact({
        ...where,
        id: `revenue:${shop.shopId}`,
        kind: 'REVENUE_MOVE',
        current: shop.netRevenue,
        previous: prior.netRevenue,
        unit: 'money',
        impact: shop.netRevenue - prior.netRevenue,
        baseline,
      }),
    )

    push(
      movingFact({
        ...where,
        id: `profit:${shop.shopId}`,
        kind: 'PROFIT_MOVE',
        current: shop.netProfit,
        previous: prior.netProfit,
        unit: 'money',
        impact: shop.netProfit - prior.netProfit,
        baseline,
      }),
    )

    // A margin is a ratio, so its own size says nothing about whether it
    // matters. What matters is the profit the change cost: two points off a
    // large shop beats ten off a small one, and this is how that gets said.
    push(
      movingFact({
        ...where,
        id: `margin:${shop.shopId}`,
        kind: 'MARGIN_MOVE',
        current: shop.netMargin,
        previous: prior.netMargin,
        unit: 'percent',
        currency: undefined,
        impact: (shop.netMargin - prior.netMargin) * shop.netRevenue,
        baseline,
      }),
    )

    const mkt = nowMkt.get(shop.shopId) ?? EMPTY_MARKETING
    const priorMkt = beforeMkt.get(shop.shopId) ?? EMPTY_MARKETING

    // ROAS is a ratio too, and it can move at constant spend. What decides
    // whether it matters is how much this shop actually spends: efficiency
    // halving on a budget of nothing is not news.
    if (mkt.roas !== null && priorMkt.roas !== null) {
      push(
        movingFact({
          ...where,
          currency: undefined,
          id: `roas:${shop.shopId}`,
          kind: 'ROAS_MOVE',
          current: mkt.roas,
          previous: priorMkt.roas,
          unit: 'ratio',
          impact: mkt.spend,
          baseline,
        }),
      )
    }

    // Only a shop that HAS a budget can be over or under it.
    if (mkt.dailyBudget !== null) {
      const budgeted = mkt.dailyBudget * days
      push(
        movingFact({
          ...where,
          id: `budget:${shop.shopId}`,
          kind: 'SPEND_VS_BUDGET',
          current: mkt.spend,
          previous: budgeted,
          unit: 'money',
          impact: mkt.spend - budgeted,
          baseline,
        }),
      )
    }
  }

  return facts
}
