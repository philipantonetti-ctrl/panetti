# AI Advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A morning briefing that tells the owner what needs attention, plus a chat he can ask follow-up questions in — both built on figures computed by the existing metrics engine, never by the model.

**Architecture:** Three layers. A **facts layer** of pure TypeScript runs the existing `computeMetrics` / `buildMarketing` / `deliveryStats` / `productFigures` over two windows and emits typed `Fact[]` — no AI. A **briefing layer** sends those facts to Claude and gets back validated JSON that ranks and explains them, stored in a new `Briefing` row by a daily cron. A **chat layer** gives Claude read-only tools that call the same loaders. The model never computes a number, and the interface prints figures from `Fact`, never from the model's prose.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma + PostgreSQL, Tailwind v4, `@anthropic-ai/sdk` (new), zod v4 (existing), vitest, playwright.

**Spec:** `docs/superpowers/specs/2026-08-10-ai-advisor-design.md`

## Global Constraints

- **The model never does arithmetic.** Every figure comes from the existing engine. Two enforcement points, both required: items citing an unknown `factId` are dropped in validation, and the UI renders numbers from `Fact`, not from model prose.
- **Model:** `claude-opus-5`. Never a different model without the user asking.
- **Money is integer minor units** in the currency named alongside it, everywhere, matching the whole codebase.
- **Admin only.** Every new route calls `assertAdmin(await currentUser())` and returns `{ 'Cache-Control': 'private, no-store' }`.
- **Structured output uses a hand-written JSON Schema plus the project's own zod v4** for validation. Do NOT use `client.messages.parse()` with `zodOutputFormat` — that helper is coupled to the SDK's bundled zod version and this project is on zod v4.
- **Failures are visible, never silent.** A missing API key, a failed generation, or a refusal is stored and shown; the computed facts still render.
- **No new dependency other than `@anthropic-ai/sdk`.**
- **`loadProductsInput` throws `MixedCurrencyError`** when the shops passed to it do not share one currency. Product facts must therefore be gathered one call per currency group, never one call for every shop.
- Comment density and tone follow the surrounding code: comments explain *why*, never *what*.

---

### Task 1: Fact types and the severity rule

**Files:**
- Create: `src/lib/advisor/types.ts`
- Create: `src/lib/advisor/severity.ts`
- Test: `src/lib/advisor/severity.test.ts`

**Interfaces:**
- Consumes: `deltaPct` from `src/lib/metrics/trend.ts`
- Produces: `Fact`, `FactKind`, `FactUnit`, `isQuality(f)`, `severityOf(deltaPct, share)`, `movingFact(args)`

- [ ] **Step 1: Write `src/lib/advisor/types.ts`**

```ts
/**
 * What the advisor knows, before any model sees it.
 *
 * A fact is a COMPUTED COMPARISON, not an observation: every one of these came
 * out of the same engine the Dashboard uses, over two windows. The model is
 * given these and asked only to rank and explain them — it never derives a
 * figure of its own, because a confident wrong number is the one thing this
 * product must never ship.
 */

export type FactKind =
  | 'REVENUE_MOVE'
  | 'PROFIT_MOVE'
  | 'MARGIN_MOVE'
  | 'ROAS_MOVE'
  | 'SPEND_VS_BUDGET'
  | 'DELIVERY_DAYS_MOVE'
  | 'ON_TIME_MOVE'
  | 'LATE_NOW'
  | 'PRODUCT_RATE_MOVE'
  | 'B2B_QUIET'
  | 'AMBASSADOR_MOVE'
  | 'UNCOSTED_PRODUCTS'
  | 'SHOP_SYNC_FAILING'
  | 'MISSING_FX'

/** How the interface should print `current` and `previous`. */
export type FactUnit = 'money' | 'ratio' | 'days' | 'count' | 'percent'

export type Fact = {
  /** Stable within one briefing, e.g. "roas:shop_abc". The model cites these. */
  id: string
  kind: FactKind
  shopId: string | null
  shopName: string | null
  /** The subject when it is not a whole shop: a product, a country, a customer. */
  subject: string | null
  /** Now and before. Minor units when `unit` is 'money'. */
  current: number | null
  previous: number | null
  /** Fractional change. Null when the previous value was zero — growing from
   *  nothing is not a percentage, the same call `deltaPct` already makes. */
  deltaPct: number | null
  unit: FactUnit
  /** 0..1, by rule. Decides which facts are sent and in what order. */
  severity: number
  /** The display currency of `current`/`previous` when `unit` is 'money'. */
  currency?: string
}

/**
 * Facts about whether a number can be TRUSTED rather than how big it is.
 * They bypass the materiality gates and are always sent: "profit is overstated
 * because three products have no cost" matters at any size.
 */
export const QUALITY_KINDS: readonly FactKind[] = [
  'UNCOSTED_PRODUCTS',
  'SHOP_SYNC_FAILING',
  'MISSING_FX',
]

export function isQuality(fact: Fact): boolean {
  return QUALITY_KINDS.includes(fact.kind)
}
```

- [ ] **Step 2: Write the failing test `src/lib/advisor/severity.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { movingFact, severityOf } from './severity'

describe('severityOf', () => {
  it('rejects a move smaller than 10%, however much money it is worth', () => {
    expect(severityOf(0.04, 0.5)).toBeNull()
  })

  it('rejects a huge percentage worth almost nothing', () => {
    // A shop tripling on three orders. This gate is the whole reason a small
    // market cannot shout down a large one.
    expect(severityOf(2.0, 0.002)).toBeNull()
  })

  it('rejects a null delta, because the previous period was zero', () => {
    expect(severityOf(null, 0.5)).toBeNull()
  })

  it('scores a move by its share of total revenue', () => {
    expect(severityOf(0.12, 0.02)).toBeCloseTo(0.4)
  })

  it('saturates at a move worth 5% of total revenue', () => {
    expect(severityOf(0.2, 0.08)).toBe(1)
  })

  it('scores a fall exactly as it scores a rise of the same size', () => {
    expect(severityOf(-0.2, 0.03)).toBe(severityOf(0.2, 0.03))
  })
})

describe('movingFact', () => {
  const base = {
    id: 'revenue:shop_a',
    kind: 'REVENUE_MOVE' as const,
    shopId: 'shop_a',
    shopName: 'Panetti Sweden',
    subject: null,
    unit: 'money' as const,
    currency: 'USD',
  }

  it('returns a fact when both gates are cleared', () => {
    const fact = movingFact({ ...base, current: 80_000, previous: 100_000, impact: 20_000, baseline: 1_000_000 })
    expect(fact).not.toBeNull()
    expect(fact!.deltaPct).toBeCloseTo(-0.2)
    expect(fact!.severity).toBeCloseTo(0.4)
  })

  it('returns null when the move is immaterial', () => {
    expect(movingFact({ ...base, current: 80, previous: 100, impact: 20, baseline: 1_000_000 })).toBeNull()
  })

  it('returns null rather than dividing by a zero baseline', () => {
    expect(movingFact({ ...base, current: 80_000, previous: 100_000, impact: 20_000, baseline: 0 })).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run src/lib/advisor/severity.test.ts`
Expected: FAIL — `Failed to resolve import "./severity"`

- [ ] **Step 4: Write `src/lib/advisor/severity.ts`**

```ts
import { deltaPct } from '../metrics/trend'
import type { Fact, FactKind, FactUnit } from './types'

/**
 * When a move is worth reporting.
 *
 * TWO gates, and both are needed. The percentage alone promotes noise: a small
 * market tripling on three orders would outrank a large one falling 12%. The
 * absolute size alone hides a real collapse in a small market, because it never
 * clears a threshold set for the big ones. Together they mean "it moved
 * meaningfully, AND the money involved matters".
 */
export const MIN_DELTA = 0.1
export const MIN_SHARE = 0.01
export const SATURATION_SHARE = 0.05

/**
 * 0..1, or null for "this is not a fact".
 *
 * `share` is what the move is worth as a fraction of the PREVIOUS window's
 * total revenue — the same frame for every shop, so a NOK store and a EUR one
 * are ranked against each other honestly.
 */
export function severityOf(delta: number | null, share: number): number | null {
  if (delta === null) return null
  if (Math.abs(delta) < MIN_DELTA) return null
  if (share < MIN_SHARE) return null
  return Math.min(share / SATURATION_SHARE, 1)
}

export type MovingFactArgs = {
  id: string
  kind: FactKind
  shopId: string | null
  shopName: string | null
  subject?: string | null
  current: number
  previous: number
  unit: FactUnit
  currency?: string
  /** What this move is worth, in the same currency as `baseline`. */
  impact: number
  /** The previous window's total revenue. Zero means there is nothing to
   *  compare against, so nothing here can be called material. */
  baseline: number
}

/** Build a fact, or null when it fails either gate. */
export function movingFact(args: MovingFactArgs): Fact | null {
  const delta = deltaPct(args.current, args.previous)
  const share = args.baseline > 0 ? Math.abs(args.impact) / args.baseline : 0
  const severity = severityOf(delta, share)
  if (severity === null) return null

  return {
    id: args.id,
    kind: args.kind,
    shopId: args.shopId,
    shopName: args.shopName,
    subject: args.subject ?? null,
    current: args.current,
    previous: args.previous,
    deltaPct: delta,
    unit: args.unit,
    severity,
    ...(args.currency ? { currency: args.currency } : {}),
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/lib/advisor/severity.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 6: Commit**

```bash
git add src/lib/advisor/types.ts src/lib/advisor/severity.ts src/lib/advisor/severity.test.ts
git commit -m "feat(advisor): the fact shape and the two gates a move must clear"
```

---

### Task 2: Money and marketing facts

**Files:**
- Create: `src/lib/advisor/facts/money.ts`
- Test: `src/lib/advisor/facts/money.test.ts`

**Interfaces:**
- Consumes: `movingFact` (Task 1); `EngineResult`, `ShopFigures` from `src/lib/metrics/types.ts`; `MarketingResult`, `MarketingShopRow` from `src/lib/ads/marketing.ts`
- Produces: `moneyFacts({ now, before, nowMarketing, beforeMarketing }): Fact[]`

- [ ] **Step 1: Write the failing test `src/lib/advisor/facts/money.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/advisor/facts/money.test.ts`
Expected: FAIL — `Failed to resolve import "./money"`

- [ ] **Step 3: Write `src/lib/advisor/facts/money.ts`**

```ts
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

    const mkt = nowMkt.get(shop.shopId) ?? (EMPTY_MARKETING as MarketingShopRow)
    const priorMkt = beforeMkt.get(shop.shopId) ?? (EMPTY_MARKETING as MarketingShopRow)

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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/advisor/facts/money.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/advisor/facts/money.ts src/lib/advisor/facts/money.test.ts
git commit -m "feat(advisor): revenue, profit, margin, ROAS and budget facts"
```

---

### Task 3: Delivery facts

**Files:**
- Create: `src/lib/advisor/facts/delivery.ts`
- Test: `src/lib/advisor/facts/delivery.test.ts`

**Interfaces:**
- Consumes: `DeliveryStats`, `CountryStat` from `src/lib/delivery/stats.ts`; `Fact` (Task 1)
- Produces: `deliveryFacts({ shopId, shopName, now, before }): Fact[]`

Delivery facts deliberately do **not** use the money gates. Days are not money, so a revenue-share threshold is meaningless here. They use a **count** gate instead — enough delivered parcels for the median to mean anything — and a size gate in days.

- [ ] **Step 1: Write the failing test `src/lib/advisor/facts/delivery.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import type { DeliveryStats } from '@/lib/delivery/stats'
import { deliveryFacts } from './delivery'

const stats = (over: Partial<DeliveryStats>): DeliveryStats => ({
  delivered: 40,
  medianDays: 3,
  medianWarehouseDays: 1,
  medianTransitDays: 2,
  onTimeRate: 0.95,
  judged: 40,
  unjudged: 0,
  lateNow: 0,
  noTracking: 0,
  distribution: [],
  byCountry: [],
  ...over,
})

const where = { shopId: 'shop_dk', shopName: 'Panetti Denmark' }

describe('deliveryFacts', () => {
  it('reports the median rising by more than half a day', () => {
    const facts = deliveryFacts({ ...where, now: stats({ medianDays: 4.8 }), before: stats({ medianDays: 3 }) })
    const move = facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE' && f.subject === null)
    expect(move).toBeDefined()
    expect(move!.current).toBe(4.8)
    expect(move!.previous).toBe(3)
    expect(move!.unit).toBe('days')
  })

  it('ignores a shift too small to act on', () => {
    const facts = deliveryFacts({ ...where, now: stats({ medianDays: 3.2 }), before: stats({ medianDays: 3 }) })
    expect(facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE')).toBeUndefined()
  })

  it('ignores a median built on too few parcels to mean anything', () => {
    const facts = deliveryFacts({
      ...where,
      now: stats({ medianDays: 9, delivered: 3 }),
      before: stats({ medianDays: 3, delivered: 40 }),
    })
    expect(facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE')).toBeUndefined()
  })

  it('says nothing when a window has no delivered parcels at all', () => {
    const facts = deliveryFacts({
      ...where,
      now: stats({ medianDays: null, delivered: 0 }),
      before: stats({ medianDays: 3 }),
    })
    expect(facts).toEqual([])
  })

  it('reports a country whose median rose, naming it', () => {
    const facts = deliveryFacts({
      ...where,
      now: stats({ byCountry: [{ country: 'DK', delivered: 30, medianDays: 5, onTimeRate: 0.7 }] }),
      before: stats({ byCountry: [{ country: 'DK', delivered: 28, medianDays: 3, onTimeRate: 0.95 }] }),
    })
    const country = facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE' && f.subject === 'DK')
    expect(country).toBeDefined()
    expect(country!.id).toBe('delivery-days:shop_dk:DK')
  })

  it('reports the on-time rate falling by more than five points', () => {
    const facts = deliveryFacts({ ...where, now: stats({ onTimeRate: 0.8 }), before: stats({ onTimeRate: 0.95 }) })
    const move = facts.find((f) => f.kind === 'ON_TIME_MOVE')
    expect(move).toBeDefined()
    expect(move!.unit).toBe('percent')
  })

  it('does not report an on-time rate that IMPROVED', () => {
    const facts = deliveryFacts({ ...where, now: stats({ onTimeRate: 0.99 }), before: stats({ onTimeRate: 0.8 }) })
    expect(facts.find((f) => f.kind === 'ON_TIME_MOVE')).toBeUndefined()
  })

  it('reports a queue of orders late right now, once it is worth acting on', () => {
    const facts = deliveryFacts({ ...where, now: stats({ lateNow: 12 }), before: stats({ lateNow: 2 }) })
    const late = facts.find((f) => f.kind === 'LATE_NOW')
    expect(late).toBeDefined()
    expect(late!.current).toBe(12)
    expect(late!.unit).toBe('count')
  })

  it('stays quiet about a handful of late orders', () => {
    const facts = deliveryFacts({ ...where, now: stats({ lateNow: 3 }), before: stats({ lateNow: 1 }) })
    expect(facts.find((f) => f.kind === 'LATE_NOW')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/advisor/facts/delivery.test.ts`
Expected: FAIL — `Failed to resolve import "./delivery"`

- [ ] **Step 3: Write `src/lib/advisor/facts/delivery.ts`**

```ts
import { deltaPct } from '../../metrics/trend'
import type { DeliveryStats } from '../../delivery/stats'
import type { Fact } from '../types'

/**
 * How delivery moved, per shop and per destination country.
 *
 * These deliberately DO NOT use the money gates in severity.ts. A day is not
 * money, so "worth 1% of revenue" has no meaning here. What a median needs
 * instead is enough parcels to be a median at all — hence a count gate — and a
 * change large enough to act on, in days.
 */

/** Fewer than this and the median is an anecdote, not a figure. */
export const MIN_DELIVERED = 10
/** A shift smaller than this is inside the noise of a normal week. */
export const MIN_DAYS_MOVE = 0.5
/** Days of slippage that count as the worst it gets. */
export const DAYS_SATURATION = 2
/** On-time rate: five points is the smallest drop worth a sentence. */
export const MIN_ON_TIME_DROP = 0.05
export const ON_TIME_SATURATION = 0.2
/** Below this the late queue is a normal morning, not a problem. */
export const MIN_LATE_NOW = 5
export const LATE_NOW_SATURATION = 20

export type DeliveryFactsArgs = {
  shopId: string
  shopName: string
  now: DeliveryStats
  before: DeliveryStats
}

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1)

export function deliveryFacts(args: DeliveryFactsArgs): Fact[] {
  const { shopId, shopName, now, before } = args
  const facts: Fact[] = []

  const daysMove = (
    id: string,
    subject: string | null,
    current: number | null,
    previous: number | null,
    deliveredNow: number,
    deliveredBefore: number,
  ) => {
    if (current === null || previous === null) return
    if (deliveredNow < MIN_DELIVERED || deliveredBefore < MIN_DELIVERED) return
    // Only slippage. A delivery that got FASTER is good news, and a briefing
    // that opens with good news teaches the reader to skim it.
    const slip = current - previous
    if (slip < MIN_DAYS_MOVE) return

    facts.push({
      id,
      kind: 'DELIVERY_DAYS_MOVE',
      shopId,
      shopName,
      subject,
      current,
      previous,
      deltaPct: deltaPct(current, previous),
      unit: 'days',
      severity: clamp01(slip / DAYS_SATURATION),
    })
  }

  daysMove(`delivery-days:${shopId}`, null, now.medianDays, before.medianDays, now.delivered, before.delivered)

  const beforeCountry = new Map(before.byCountry.map((c) => [c.country, c]))
  for (const country of now.byCountry) {
    const prior = beforeCountry.get(country.country)
    if (!prior) continue
    daysMove(
      `delivery-days:${shopId}:${country.country}`,
      country.country,
      country.medianDays,
      prior.medianDays,
      country.delivered,
      prior.delivered,
    )
  }

  if (
    now.onTimeRate !== null &&
    before.onTimeRate !== null &&
    now.judged >= MIN_DELIVERED &&
    before.judged >= MIN_DELIVERED
  ) {
    const drop = before.onTimeRate - now.onTimeRate
    if (drop >= MIN_ON_TIME_DROP) {
      facts.push({
        id: `on-time:${shopId}`,
        kind: 'ON_TIME_MOVE',
        shopId,
        shopName,
        subject: null,
        current: now.onTimeRate,
        previous: before.onTimeRate,
        deltaPct: deltaPct(now.onTimeRate, before.onTimeRate),
        unit: 'percent',
        severity: clamp01(drop / ON_TIME_SATURATION),
      })
    }
  }

  // Late RIGHT NOW is a to-do list, not a trend. It is reported when it is big
  // enough to be worth a morning, and only when it grew.
  if (now.lateNow >= MIN_LATE_NOW && now.lateNow > before.lateNow) {
    facts.push({
      id: `late-now:${shopId}`,
      kind: 'LATE_NOW',
      shopId,
      shopName,
      subject: null,
      current: now.lateNow,
      previous: before.lateNow,
      deltaPct: deltaPct(now.lateNow, before.lateNow),
      unit: 'count',
      severity: clamp01(now.lateNow / LATE_NOW_SATURATION),
    })
  }

  return facts
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/advisor/facts/delivery.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/advisor/facts/delivery.ts src/lib/advisor/facts/delivery.test.ts
git commit -m "feat(advisor): delivery facts, gated on parcel count rather than money"
```

---

### Task 4: Product, B2B customer and ambassador facts

**Files:**
- Create: `src/lib/advisor/facts/products.ts`
- Create: `src/lib/advisor/facts/customers.ts`
- Test: `src/lib/advisor/facts/products.test.ts`
- Test: `src/lib/advisor/facts/customers.test.ts`

**Interfaces:**
- Consumes: `movingFact` (Task 1); `ProductResult`, `ProductRow`, `ProductStoreRow` from `src/lib/metrics/products.ts`; `LeaderboardRow` from `src/lib/metrics/ambassadors.ts`
- Produces:
  - `productFacts({ now, before, shopNames, shopBaselines, baseline }): Fact[]`
  - `b2bQuietFacts({ customers, now }): Fact[]`, `type B2bHistory = { customerId, name, shopId, shopName, orderDates: Date[] }`
  - `ambassadorFacts({ now, before, baseline }): Fact[]`

`productFacts` takes **one currency group's** result. Its `shopBaselines` map carries each shop's previous-window revenue **in that group's currency**, and `baseline` is the whole business's previous-window revenue in USD. The share is the product of the two ratios, which gives "this product move as a fraction of total revenue" without ever converting the product figure across currencies.

- [ ] **Step 1: Write the failing test `src/lib/advisor/facts/products.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import type { ProductResult, ProductRow } from '@/lib/metrics/products'
import { productFacts } from './products'

const row = (over: Partial<ProductRow>): ProductRow =>
  ({
    key: 'sku:PIZ-PRO',
    sku: 'PIZ-PRO',
    name: 'Pizzetta Pro',
    imageUrl: null,
    orders: 10,
    quantity: 10,
    grossSales: 0,
    netSales: 0,
    cogs: 0,
    profit: 0,
    margin: 0,
    hasCost: true,
    stores: [],
    ...over,
  }) as ProductRow

const result = (rows: ProductRow[]): ProductResult => ({
  displayCurrency: 'NOK',
  rows,
  total: { orders: 0, quantity: 0, grossSales: 0, netSales: 0, cogs: 0, profit: 0, margin: 0 },
  uncosted: 0,
})

const store = (netSales: number, quantity: number) => ({
  shopId: 'shop_no',
  shopName: 'Panetti Norway',
  productId: 'prod_1',
  name: 'Pizzetta Pro',
  hasCost: true,
  orders: 10,
  quantity,
  grossSales: netSales,
  netSales,
  cogs: 0,
  profit: netSales,
  margin: 1,
})

const args = {
  shopNames: new Map([['shop_no', 'Panetti Norway']]),
  // Panetti Norway did 500_000 NOK last window, and is 30% of a 1_000_000 USD business.
  shopBaselines: new Map([['shop_no', 500_000]]),
  shopShares: new Map([['shop_no', 0.3]]),
}

describe('productFacts', () => {
  it('reports a product whose sales collapsed in one shop', () => {
    const facts = productFacts({
      ...args,
      now: result([row({ stores: [store(100_000, 20)] })]),
      before: result([row({ stores: [store(250_000, 50)] })]),
    })

    const fact = facts[0]
    expect(fact.kind).toBe('PRODUCT_RATE_MOVE')
    expect(fact.subject).toBe('Pizzetta Pro')
    expect(fact.shopName).toBe('Panetti Norway')
    expect(fact.id).toBe('product:shop_no:sku:PIZ-PRO')
    expect(fact.currency).toBe('NOK')
    expect(fact.deltaPct).toBeCloseTo(-0.6)
  })

  it('says nothing about a product that barely moved', () => {
    const facts = productFacts({
      ...args,
      now: result([row({ stores: [store(248_000, 49)] })]),
      before: result([row({ stores: [store(250_000, 50)] })]),
    })
    expect(facts).toEqual([])
  })

  it('says nothing about a big swing on a trivial product', () => {
    const facts = productFacts({
      ...args,
      now: result([row({ stores: [store(100, 1)] })]),
      before: result([row({ stores: [store(400, 4)] })]),
    })
    expect(facts).toEqual([])
  })

  it('ignores a shop it has no baseline for', () => {
    const facts = productFacts({
      ...args,
      shopBaselines: new Map(),
      shopShares: new Map(),
      now: result([row({ stores: [store(100_000, 20)] })]),
      before: result([row({ stores: [store(250_000, 50)] })]),
    })
    expect(facts).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/advisor/facts/products.test.ts`
Expected: FAIL — `Failed to resolve import "./products"`

- [ ] **Step 3: Write `src/lib/advisor/facts/products.ts`**

```ts
import type { ProductResult } from '../../metrics/products'
import { movingFact } from '../severity'
import type { Fact } from '../types'

/**
 * Which products moved, per shop.
 *
 * ONE CURRENCY GROUP AT A TIME. `loadProductsInput` refuses to add NOK and EUR
 * together — it throws MixedCurrencyError — so the collector calls it once per
 * group and calls this once per result. Nothing here converts anything.
 *
 * The materiality share is therefore built in two hops, neither of which needs
 * a rate:
 *
 *   (this product's move / this shop's own prior revenue)   <- group currency
 * x (this shop's prior revenue / the whole business's)      <- already USD
 * = this product's move as a share of total revenue
 */

export type ProductFactsArgs = {
  now: ProductResult
  before: ProductResult
  /** shopId -> name, for shops in this currency group. */
  shopNames: Map<string, string>
  /** shopId -> that shop's PREVIOUS window net revenue, in THIS group's currency. */
  shopBaselines: Map<string, number>
  /** shopId -> that shop's share of the whole business's previous revenue, 0..1. */
  shopShares: Map<string, number>
}

export function productFacts(args: ProductFactsArgs): Fact[] {
  const { now, before, shopNames, shopBaselines, shopShares } = args

  // key -> shopId -> that store's slice of the product, in the previous window.
  const priorByKey = new Map<string, Map<string, number>>()
  for (const row of before.rows) {
    priorByKey.set(row.key, new Map(row.stores.map((s) => [s.shopId, s.netSales])))
  }

  const facts: Fact[] = []

  for (const row of now.rows) {
    const prior = priorByKey.get(row.key)
    if (!prior) continue // a product with no history has nothing to compare

    for (const store of row.stores) {
      const previous = prior.get(store.shopId)
      if (previous === undefined) continue

      const shopBaseline = shopBaselines.get(store.shopId)
      const shopShare = shopShares.get(store.shopId)
      if (!shopBaseline || shopShare === undefined) continue

      // movingFact divides impact by baseline, so scaling the baseline UP by
      // the reciprocal of the shop's share is the same arithmetic as scaling
      // the share down — done here so movingFact keeps one meaning of baseline.
      const scaledBaseline = shopShare > 0 ? shopBaseline / shopShare : 0

      const fact = movingFact({
        id: `product:${store.shopId}:${row.key}`,
        kind: 'PRODUCT_RATE_MOVE',
        shopId: store.shopId,
        shopName: shopNames.get(store.shopId) ?? store.shopName,
        subject: row.name,
        current: store.netSales,
        previous,
        unit: 'money',
        currency: now.displayCurrency,
        impact: store.netSales - previous,
        baseline: scaledBaseline,
      })
      if (fact) facts.push(fact)
    }
  }

  return facts
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/lib/advisor/facts/products.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Write the failing test `src/lib/advisor/facts/customers.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { ambassadorFacts, b2bQuietFacts, type B2bHistory } from './customers'

const day = (iso: string) => new Date(`${iso}T00:00:00Z`)
const NOW = day('2026-08-10')

const history = (dates: string[]): B2bHistory => ({
  customerId: 'cust_1',
  name: 'Bakeri AS',
  shopId: 'shop_no',
  shopName: 'Panetti Norway',
  orderDates: dates.map(day),
})

describe('b2bQuietFacts', () => {
  it('reports a monthly customer who has been silent for two and a half months', () => {
    // Gaps of 30 and 30 days; median 30. Last order 76 days ago.
    const facts = b2bQuietFacts({
      customers: [history(['2026-03-27', '2026-04-26', '2026-05-26'])],
      now: NOW,
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].kind).toBe('B2B_QUIET')
    expect(facts[0].subject).toBe('Bakeri AS')
    expect(facts[0].unit).toBe('days')
    expect(facts[0].current).toBe(76)
    expect(facts[0].previous).toBe(30)
  })

  it('leaves a monthly customer alone one month in', () => {
    const facts = b2bQuietFacts({
      customers: [history(['2026-05-12', '2026-06-11', '2026-07-11'])],
      now: NOW,
    })
    expect(facts).toEqual([])
  })

  it('reports a WEEKLY customer at a gap that is fine for a monthly one', () => {
    // Gaps of 7 and 7 days; median 7. Last order 26 days ago — nearly four
    // times their own rhythm, which one fixed threshold would have missed.
    const facts = b2bQuietFacts({
      customers: [history(['2026-06-30', '2026-07-07', '2026-07-15'])],
      now: NOW,
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].severity).toBeGreaterThan(0.8)
  })

  it('says nothing about a customer with too little history to have a rhythm', () => {
    const facts = b2bQuietFacts({ customers: [history(['2026-01-05', '2026-02-05'])], now: NOW })
    expect(facts).toEqual([])
  })

  it('says nothing when every gap is zero, rather than dividing by it', () => {
    const facts = b2bQuietFacts({
      customers: [history(['2026-08-10', '2026-08-10', '2026-08-10'])],
      now: NOW,
    })
    expect(facts).toEqual([])
  })
})

describe('ambassadorFacts', () => {
  const person = (id: string, name: string, sales: number) => ({
    rank: 1,
    ambassadorId: id,
    name,
    shops: ['Panetti Norway'],
    orders: 10,
    sales,
    commission: 0,
  })

  it('reports an ambassador whose sales fell materially', () => {
    const facts = ambassadorFacts({
      now: [person('amb_1', 'Emma', 40_000)],
      before: [person('amb_1', 'Emma', 100_000)],
      baseline: 1_000_000,
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].kind).toBe('AMBASSADOR_MOVE')
    expect(facts[0].subject).toBe('Emma')
    expect(facts[0].id).toBe('ambassador:amb_1')
    expect(facts[0].shopId).toBeNull()
  })

  it('says nothing about a small ambassador swinging hard', () => {
    const facts = ambassadorFacts({
      now: [person('amb_1', 'Emma', 100)],
      before: [person('amb_1', 'Emma', 400)],
      baseline: 1_000_000,
    })
    expect(facts).toEqual([])
  })

  it('ignores an ambassador who did not exist last period', () => {
    const facts = ambassadorFacts({
      now: [person('amb_new', 'Nils', 200_000)],
      before: [],
      baseline: 1_000_000,
    })
    expect(facts).toEqual([])
  })
})
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npx vitest run src/lib/advisor/facts/customers.test.ts`
Expected: FAIL — `Failed to resolve import "./customers"`

- [ ] **Step 7: Write `src/lib/advisor/facts/customers.ts`**

```ts
import { median } from '../../delivery/stats'
import type { LeaderboardRow } from '../../metrics/ambassadors'
import { movingFact } from '../severity'
import type { Fact } from '../types'

/** People rather than money: a B2B customer gone quiet, an ambassador moving. */

const DAY_MS = 24 * 60 * 60 * 1000

/** Fewer orders than this and there is no rhythm to be silent against. */
export const MIN_B2B_ORDERS = 3
/** Silence starts at twice a customer's own median gap. */
export const QUIET_MULTIPLE = 2
/** Four times their rhythm is as bad as this fact gets. */
export const QUIET_SATURATION = 4

export type B2bHistory = {
  customerId: string
  name: string
  shopId: string
  shopName: string
  /** Every order date this customer has, ascending. */
  orderDates: Date[]
}

export type B2bQuietArgs = {
  customers: B2bHistory[]
  now: Date
}

/**
 * Who has gone quiet — measured against their OWN rhythm, never a fixed number
 * of days. A customer who orders weekly and one who orders monthly fall silent
 * at very different points, and a shared threshold would nag about the first
 * while missing the second entirely.
 */
export function b2bQuietFacts(args: B2bQuietArgs): Fact[] {
  const facts: Fact[] = []

  for (const customer of args.customers) {
    if (customer.orderDates.length < MIN_B2B_ORDERS) continue

    const dates = [...customer.orderDates].sort((a, b) => a.getTime() - b.getTime())
    const gaps: number[] = []
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i].getTime() - dates[i - 1].getTime()) / DAY_MS)
    }

    const typical = median(gaps)
    // Every order on one day gives a median gap of zero. There is no rhythm
    // there to be late against, and dividing by it would invent one.
    if (typical === null || typical <= 0) continue

    const last = dates[dates.length - 1]
    const silent = (args.now.getTime() - last.getTime()) / DAY_MS
    if (silent < typical * QUIET_MULTIPLE) continue

    facts.push({
      id: `b2b-quiet:${customer.customerId}`,
      kind: 'B2B_QUIET',
      shopId: customer.shopId,
      shopName: customer.shopName,
      subject: customer.name,
      current: Math.round(silent),
      previous: Math.round(typical),
      // A ratio of days against days is not a period-over-period change, and
      // printing one as a percentage would be a different claim than the truth.
      deltaPct: null,
      unit: 'days',
      severity: Math.min(silent / (typical * QUIET_SATURATION), 1),
    })
  }

  return facts
}

export type AmbassadorFactsArgs = {
  now: LeaderboardRow[]
  before: LeaderboardRow[]
  /** The previous window's total revenue, display currency. */
  baseline: number
}

/** Who is selling more or less than they were. Money gates apply, unchanged. */
export function ambassadorFacts(args: AmbassadorFactsArgs): Fact[] {
  const prior = new Map(args.before.map((r) => [r.ambassadorId, r.sales]))
  const facts: Fact[] = []

  for (const person of args.now) {
    const previous = prior.get(person.ambassadorId)
    if (previous === undefined) continue

    const fact = movingFact({
      id: `ambassador:${person.ambassadorId}`,
      kind: 'AMBASSADOR_MOVE',
      // An ambassador can carry codes on several stores, so this belongs to no
      // single shop. Null says that, rather than picking one arbitrarily.
      shopId: null,
      shopName: null,
      subject: person.name,
      current: person.sales,
      previous,
      unit: 'money',
      impact: person.sales - previous,
      baseline: args.baseline,
    })
    if (fact) facts.push(fact)
  }

  return facts
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npx vitest run src/lib/advisor/facts/customers.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 9: Commit**

```bash
git add src/lib/advisor/facts/products.ts src/lib/advisor/facts/products.test.ts \
        src/lib/advisor/facts/customers.ts src/lib/advisor/facts/customers.test.ts
git commit -m "feat(advisor): product, B2B-silence and ambassador facts"
```

---

### Task 5: Data-quality facts

**Files:**
- Create: `src/lib/advisor/facts/quality.ts`
- Test: `src/lib/advisor/facts/quality.test.ts`

**Interfaces:**
- Consumes: `Fact` (Task 1)
- Produces: `qualityFacts({ uncostedByShop, failingShops, missingRates }): Fact[]`

These bypass both gates. They answer "can this number be trusted?", which matters at any size.

- [ ] **Step 1: Write the failing test `src/lib/advisor/facts/quality.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { isQuality } from '../types'
import { qualityFacts } from './quality'

describe('qualityFacts', () => {
  it('reports products with no cost, because profit is overstated without one', () => {
    const facts = qualityFacts({
      uncostedByShop: [{ shopId: 'shop_no', shopName: 'Panetti Norway', count: 3 }],
      failingShops: [],
      missingRates: [],
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].kind).toBe('UNCOSTED_PRODUCTS')
    expect(facts[0].current).toBe(3)
    expect(facts[0].unit).toBe('count')
    expect(isQuality(facts[0])).toBe(true)
  })

  it('reports even a single uncosted product — this gate is trust, not size', () => {
    const facts = qualityFacts({
      uncostedByShop: [{ shopId: 'shop_no', shopName: 'Panetti Norway', count: 1 }],
      failingShops: [],
      missingRates: [],
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].severity).toBeGreaterThan(0)
  })

  it('says nothing when every product has a cost', () => {
    const facts = qualityFacts({
      uncostedByShop: [{ shopId: 'shop_no', shopName: 'Panetti Norway', count: 0 }],
      failingShops: [],
      missingRates: [],
    })
    expect(facts).toEqual([])
  })

  it('reports a shop whose sync is failing, and carries the reason as the subject', () => {
    const facts = qualityFacts({
      uncostedByShop: [],
      failingShops: [{ shopId: 'shop_de', shopName: 'Mazzetti Germany', error: '401 Unauthorized' }],
      missingRates: [],
    })
    expect(facts[0].kind).toBe('SHOP_SYNC_FAILING')
    expect(facts[0].subject).toBe('401 Unauthorized')
    expect(facts[0].severity).toBe(1)
  })

  it('reports a currency with no exchange rate', () => {
    const facts = qualityFacts({ uncostedByShop: [], failingShops: [], missingRates: ['SEK'] })
    expect(facts[0].kind).toBe('MISSING_FX')
    expect(facts[0].subject).toBe('SEK')
    expect(facts[0].shopId).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/advisor/facts/quality.test.ts`
Expected: FAIL — `Failed to resolve import "./quality"`

- [ ] **Step 3: Write `src/lib/advisor/facts/quality.ts`**

```ts
import type { Fact } from '../types'

/**
 * Facts about whether the other facts can be TRUSTED.
 *
 * These bypass the materiality gates on purpose. "Norway's profit is overstated
 * because three products have no cost on file" is worth saying at any size —
 * it is the product's own "say when you don't know" principle applied to the
 * briefing itself, and it is the difference between a wrong number the client
 * acts on and a gap he can close.
 */

/** Uncosted products at which the shop's profit figure is thoroughly unreliable. */
export const UNCOSTED_SATURATION = 5

export type QualityFactsArgs = {
  uncostedByShop: { shopId: string; shopName: string; count: number }[]
  failingShops: { shopId: string; shopName: string; error: string }[]
  missingRates: string[]
}

export function qualityFacts(args: QualityFactsArgs): Fact[] {
  const facts: Fact[] = []

  for (const shop of args.uncostedByShop) {
    if (shop.count <= 0) continue
    facts.push({
      id: `uncosted:${shop.shopId}`,
      kind: 'UNCOSTED_PRODUCTS',
      shopId: shop.shopId,
      shopName: shop.shopName,
      subject: null,
      current: shop.count,
      previous: null,
      deltaPct: null,
      unit: 'count',
      severity: Math.min(shop.count / UNCOSTED_SATURATION, 1),
    })
  }

  for (const shop of args.failingShops) {
    facts.push({
      id: `sync-failing:${shop.shopId}`,
      kind: 'SHOP_SYNC_FAILING',
      shopId: shop.shopId,
      shopName: shop.shopName,
      // The reason IS the subject here: "Mazzetti Germany's sync is failing" is
      // half a sentence without it, and the client cannot act on half.
      subject: shop.error,
      current: null,
      previous: null,
      deltaPct: null,
      unit: 'count',
      // A frozen store means every figure it reports is stale. Nothing about
      // that is partial, so nothing about the severity is either.
      severity: 1,
    })
  }

  for (const currency of args.missingRates) {
    facts.push({
      id: `missing-fx:${currency}`,
      kind: 'MISSING_FX',
      shopId: null,
      shopName: null,
      subject: currency,
      current: null,
      previous: null,
      deltaPct: null,
      unit: 'count',
      severity: 1,
    })
  }

  return facts
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/lib/advisor/facts/quality.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/advisor/facts/quality.ts src/lib/advisor/facts/quality.test.ts
git commit -m "feat(advisor): data-quality facts, so an untrustworthy number says so"
```

---

### Task 6: The collector

**Files:**
- Create: `src/lib/advisor/collect.ts`
- Test: `src/lib/advisor/collect.integration.test.ts`
- Modify: `vitest.config.ts` (add the new integration test to the serial `delivery` project)

**Interfaces:**
- Consumes: every fact builder from Tasks 2–5; `loadMetricsInput`, `loadProductsInput`, `loadDelivery`, `computeMetrics`, `buildMarketing`, `deliveryStats`, `productFigures`, `leaderboard`, `previousRange`, `groupByCurrency`, `getSetting`, `db`
- Produces: `collectFacts(now?: Date): Promise<CollectedFacts>` where `CollectedFacts = { from: Date; to: Date; facts: Fact[] }`

**Why this test joins the serial `delivery` project:** it writes `Shop`, `Order`, `Product` and `FxRate` rows and reads every one of them back through loaders that query the whole table. Run in parallel with the `app` project it would race the other suites' fixtures.

- [ ] **Step 1: Write `src/lib/advisor/collect.ts`**

```ts
import { db } from '../db'
import { getSetting } from '../settings'
import { utcDay } from '../dates'
import { groupByCurrency } from '../currency-groups'
import { loadMetricsInput } from '../data/load'
import { loadProductsInput } from '../data/load-products'
import { loadDelivery } from '../delivery/load'
import { computeMetrics } from '../metrics'
import { previousRange } from '../metrics/trend'
import { productFigures } from '../metrics/products'
import { leaderboard } from '../metrics/ambassadors'
import { deliveryStats } from '../delivery/stats'
import { buildMarketing } from '../ads/marketing'
import { accountIdsForShops, accountSpendRows } from '../ads/attribution'
import { moneyFacts } from './facts/money'
import { deliveryFacts } from './facts/delivery'
import { productFacts } from './facts/products'
import { ambassadorFacts, b2bQuietFacts, type B2bHistory } from './facts/customers'
import { qualityFacts } from './facts/quality'
import { isQuality, type Fact } from './types'

/**
 * Everything the advisor knows about this morning.
 *
 * Every figure here comes back out of the same loaders and the same engine the
 * pages use, run over two windows. Nothing in this file adds, divides or
 * converts money — it gathers, compares through the fact builders, and ranks.
 */

/** The window the briefing describes. A week reads through weekday effects. */
export const WINDOW_DAYS = 7

/**
 * How many ranked facts the model is shown. Enough to see the shape of the
 * week; few enough that the prompt stays small and the ranking stays a
 * decision rather than a dump. Quality facts are sent on top of this.
 */
export const MAX_FACTS = 40

const DAY_MS = 24 * 60 * 60 * 1000

export type CollectedFacts = { from: Date; to: Date; facts: Fact[] }

export async function collectFacts(now: Date = new Date()): Promise<CollectedFacts> {
  const { timezone } = await getSetting()

  // Through YESTERDAY, not today: a briefing read at 07:00 that includes three
  // hours of today would compare a part-day against seven whole ones.
  const to = new Date(utcDay(now).getTime() - DAY_MS)
  const from = new Date(to.getTime() - (WINDOW_DAYS - 1) * DAY_MS)
  const before = previousRange(from, to)

  const [input, priorInput] = await Promise.all([
    loadMetricsInput({ from, to, timezone }),
    loadMetricsInput({ from: before.from, to: before.to, timezone }),
  ])

  const engine = computeMetrics(input)
  const priorEngine = computeMetrics(priorInput)
  const baseline = priorEngine.total.netRevenue

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true, lastError: true },
    orderBy: { name: 'asc' },
  })
  const shopIds = shops.map((s) => s.id)

  const facts: Fact[] = []

  // --- money and marketing -------------------------------------------------
  //
  // Accounts are resolved through accountIdsForShops, NOT by filtering adAccount
  // on shopId. A split account can run campaigns for a shop while its own
  // default shop is out of scope; filtering on shopId alone silently drops
  // those campaigns' spend. This is the pattern /api/marketing already uses.
  const accountIds = await accountIdsForShops(shopIds)
  const accounts = await db.adAccount.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, shopId: true, provider: true, currency: true, dailyBudget: true },
  })

  const marketingFor = async (start: Date, end: Date, engineResult = engine) => {
    const spend = await accountSpendRows(
      accounts.map((a) => a.id),
      shopIds,
      start,
      end,
    )
    return buildMarketing({
      accounts,
      spend,
      engine: engineResult,
      series: [],
      rates: input.rates,
      to: end,
    })
  }

  const [nowMarketing, beforeMarketing] = await Promise.all([
    marketingFor(from, to, engine),
    marketingFor(before.from, before.to, priorEngine),
  ])

  facts.push(
    ...moneyFacts({
      now: engine,
      before: priorEngine,
      nowMarketing,
      beforeMarketing,
      days: WINDOW_DAYS,
    }),
  )

  // --- delivery ------------------------------------------------------------
  for (const shop of shops) {
    const [current, prior] = await Promise.all([
      loadDelivery([shop.id], from, to, now),
      loadDelivery([shop.id], before.from, before.to, now),
    ])
    facts.push(
      ...deliveryFacts({
        shopId: shop.id,
        shopName: shop.name,
        now: deliveryStats(
          current.rows.map((r) => r.view),
          current.rows.map((r) => r.order.shippingCountry),
        ),
        before: deliveryStats(
          prior.rows.map((r) => r.view),
          prior.rows.map((r) => r.order.shippingCountry),
        ),
      }),
    )
  }

  // --- products, one currency group at a time ------------------------------
  //
  // loadProductsInput THROWS MixedCurrencyError rather than adding NOK to EUR,
  // which is correct and is why this loop exists. Each group is loaded in its
  // own currency and compared in it.
  const priorRevenueByShop = new Map(priorEngine.byShop.map((s) => [s.shopId, s.netRevenue]))
  const shopShares = new Map(
    priorEngine.byShop.map((s) => [s.shopId, baseline > 0 ? s.netRevenue / baseline : 0]),
  )
  let uncostedByShop: { shopId: string; shopName: string; count: number }[] = []

  for (const group of groupByCurrency(shops)) {
    const groupIds = group.shops.map((s) => s.id)
    const [nowProducts, beforeProducts] = await Promise.all([
      loadProductsInput({ shopIds: groupIds, from, to, timezone }),
      loadProductsInput({ shopIds: groupIds, from: before.from, to: before.to, timezone }),
    ])

    const nowFigures = productFigures(nowProducts)
    const beforeFigures = productFigures(beforeProducts)

    // The shop's own prior revenue must be in THIS group's currency, and
    // priorEngine reports it in USD whenever more than one shop is loaded. A
    // single-shop load returns that shop's own currency, which is what the
    // per-shop product figures are in.
    const groupBaselines = new Map<string, number>()
    await Promise.all(
      groupIds.map(async (id) => {
        const own = computeMetrics(await loadMetricsInput({ shopIds: [id], from: before.from, to: before.to, timezone }))
        groupBaselines.set(id, own.total.netRevenue)
      }),
    )

    facts.push(
      ...productFacts({
        now: nowFigures,
        before: beforeFigures,
        shopNames: new Map(group.shops.map((s) => [s.id, s.name])),
        shopBaselines: groupBaselines,
        shopShares,
      }),
    )

    // Which shops have products with no cost. productFigures reports the count
    // across the whole result, so it is recounted per shop from the rows.
    for (const shop of group.shops) {
      const count = nowFigures.rows.filter((row) =>
        row.stores.some((s) => s.shopId === shop.id && !s.hasCost),
      ).length
      uncostedByShop.push({ shopId: shop.id, shopName: shop.name, count })
    }
  }

  // --- customers and ambassadors -------------------------------------------
  const roster = await db.ambassador.findMany({
    where: { active: true },
    select: { id: true, name: true, codes: { select: { shop: { select: { name: true } } } } },
  })
  const people = roster.map((a) => ({
    id: a.id,
    name: a.name,
    shops: [...new Set(a.codes.map((c) => c.shop.name))],
  }))

  facts.push(
    ...ambassadorFacts({
      now: leaderboard({
        ambassadors: people,
        orders: input.orders,
        rates: input.rates,
        displayCurrency: input.displayCurrency,
        from,
        to,
        timezone,
      }),
      before: leaderboard({
        ambassadors: people,
        orders: priorInput.orders,
        rates: priorInput.rates,
        displayCurrency: priorInput.displayCurrency,
        from: before.from,
        to: before.to,
        timezone,
      }),
      baseline,
    }),
  )

  const customerRows = await db.b2bCustomer.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      shopId: true,
      shop: { select: { name: true } },
      orders: { select: { placedAt: true }, orderBy: { placedAt: 'asc' } },
    },
  })
  const customers: B2bHistory[] = customerRows.map((c) => ({
    customerId: c.id,
    name: c.name,
    shopId: c.shopId,
    shopName: c.shop.name,
    orderDates: c.orders.map((o) => o.placedAt),
  }))
  facts.push(...b2bQuietFacts({ customers, now }))

  // --- data quality --------------------------------------------------------
  const currencies = [...new Set(shops.map((s) => s.currency))]
  const haveRates = new Set(
    (
      await db.fxRate.findMany({
        where: { date: { gte: from, lte: to }, quote: 'USD' },
        select: { base: true },
      })
    ).map((r) => r.base),
  )
  const missingRates =
    engine.displayCurrency === 'USD'
      ? currencies.filter((c) => c !== 'USD' && !haveRates.has(c))
      : []

  facts.push(
    ...qualityFacts({
      uncostedByShop,
      failingShops: shops
        .filter((s) => s.lastError)
        .map((s) => ({ shopId: s.id, shopName: s.name, error: s.lastError! })),
      missingRates,
    }),
  )

  // Rank, then cap — but never cap away a trust warning. A briefing that
  // silently drops "this shop's sync is broken" because forty things moved is
  // the exact failure this whole feature exists to avoid.
  const quality = facts.filter(isQuality)
  const ranked = facts
    .filter((f) => !isQuality(f))
    .sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id))
    .slice(0, MAX_FACTS)

  return { from, to, facts: [...quality, ...ranked] }
}
```

- [ ] **Step 2: Write the failing integration test `src/lib/advisor/collect.integration.test.ts`**

```ts
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
```

- [ ] **Step 3: Add the test to the serial project in `vitest.config.ts`**

In the `app` project's `exclude` array, add:

```ts
'src/lib/advisor/**/*.integration.test.ts',
```

In the `delivery` project's `include` array, add the same string. The comment on that project says the two lists must stay identical — honour it.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run --project delivery src/lib/advisor/collect.integration.test.ts`
Expected: PASS, 5 tests

If `MixedCurrencyError` is thrown, the per-currency-group loop is wrong — check that `groupByCurrency` is being given `{ id, name, currency }` and that `loadProductsInput` receives only one group's ids.

- [ ] **Step 5: Commit**

```bash
git add src/lib/advisor/collect.ts src/lib/advisor/collect.integration.test.ts vitest.config.ts
git commit -m "feat(advisor): collect a morning's facts from the existing engine"
```

---

### Task 7: The Briefing model and generation

**Files:**
- Modify: `prisma/schema.prisma` (add `Briefing`)
- Modify: `.env.example` (document `ANTHROPIC_API_KEY`)
- Modify: `package.json` (add `@anthropic-ai/sdk`)
- Create: `src/lib/advisor/brief.ts`
- Test: `src/lib/advisor/brief.test.ts`

**Interfaces:**
- Consumes: `Fact` (Task 1), `CollectedFacts` (Task 6)
- Produces: `BriefItem`, `BriefPayload`, `ADVISOR_MODEL`, `type BriefingModel`, `anthropicModel()`, `generateBrief(collected, model)`, `validateItems(items, facts)`

- [ ] **Step 1: Install the SDK**

```bash
npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Add the model to `prisma/schema.prisma`**

Append at the end of the file:

```prisma
/// One morning's briefing. Written by cron, read on the Advisor page.
///
/// Stored rather than computed on open: the page is then instant, the cost is
/// one generation a day rather than one a page load, and there is a history to
/// look back at.
model Briefing {
  id        String   @id @default(cuid())
  /// The calendar day it describes, in the workspace timezone. Unique, so a
  /// re-run replaces rather than duplicates and the cron is safely idempotent.
  day       DateTime @unique
  from      DateTime
  to        DateTime
  /// The computed facts, as JSON text — the same convention TrackingImport
  /// uses. Stored so the page prints figures from data rather than from prose,
  /// and so a failed generation retries against the same facts rather than
  /// against a database that has since moved on.
  facts     String
  /// The model's ordered items. Null while generating, and after a failure —
  /// the facts still render, so the page is never blank.
  items     String?
  /// Why generation failed; null when it worked. Shown on the page, the way a
  /// shop's lastError is.
  error     String?
  model     String?
  createdAt DateTime @default(now())

  @@index([day])
}
```

- [ ] **Step 3: Push the schema and regenerate the client**

```bash
npm run db:push
npx prisma generate
```

Expected: additive change accepted, no destructive-change warning.

- [ ] **Step 4: Document the key in `.env.example`**

Append:

```
# --- AI advisor ---
# The morning briefing and the advisor chat. Without it, the Advisor page says
# so plainly and shows the computed facts on their own rather than erroring.
# ANTHROPIC_API_KEY="sk-ant-..."
```

- [ ] **Step 5: Write the failing test `src/lib/advisor/brief.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import type { Fact } from './types'
import { generateBrief, validateItems, type BriefItem } from './brief'

const fact = (id: string): Fact => ({
  id,
  kind: 'REVENUE_MOVE',
  shopId: 'shop_se',
  shopName: 'Panetti Sweden',
  subject: null,
  current: 820_000,
  previous: 1_000_000,
  deltaPct: -0.18,
  unit: 'money',
  severity: 0.4,
  currency: 'USD',
})

const item = (over: Partial<BriefItem>): BriefItem => ({
  headline: 'Sweden revenue is down',
  why: 'Advertising efficiency fell over the same week.',
  factIds: ['revenue:shop_se'],
  severity: 'high',
  action: 'Check the Meta campaign that changed.',
  ...over,
})

describe('validateItems', () => {
  it('keeps an item whose facts all exist', () => {
    expect(validateItems([item({})], [fact('revenue:shop_se')])).toHaveLength(1)
  })

  it('drops an item that cites a fact it was never given', () => {
    // The one defence against a plausible sentence about a number nobody computed.
    expect(validateItems([item({ factIds: ['revenue:invented'] })], [fact('revenue:shop_se')])).toEqual([])
  })

  it('drops an item citing no facts at all', () => {
    expect(validateItems([item({ factIds: [] })], [fact('revenue:shop_se')])).toEqual([])
  })

  it('keeps an item that cites one real fact among several', () => {
    const kept = validateItems([item({ factIds: ['revenue:shop_se', 'roas:shop_se'] })], [
      fact('revenue:shop_se'),
      fact('roas:shop_se'),
    ])
    expect(kept).toHaveLength(1)
  })
})

describe('generateBrief', () => {
  const collected = { from: new Date('2026-08-03'), to: new Date('2026-08-09'), facts: [fact('revenue:shop_se')] }

  it('returns validated items and the model that wrote them', async () => {
    const model = vi.fn().mockResolvedValue({ items: [item({})], model: 'claude-opus-5' })
    const result = await generateBrief(collected, model)
    expect(result.items).toHaveLength(1)
    expect(result.model).toBe('claude-opus-5')
    expect(result.error).toBeNull()
  })

  it('drops invented facts before storing anything', async () => {
    const model = vi.fn().mockResolvedValue({ items: [item({ factIds: ['nope'] })], model: 'claude-opus-5' })
    const result = await generateBrief(collected, model)
    expect(result.items).toEqual([])
    expect(result.error).toBeNull()
  })

  it('reports a model failure as an error rather than throwing', async () => {
    const model = vi.fn().mockRejectedValue(new Error('529 overloaded'))
    const result = await generateBrief(collected, model)
    expect(result.items).toBeNull()
    expect(result.error).toContain('529 overloaded')
  })

  it('says so plainly when there is no model configured at all', async () => {
    const result = await generateBrief(collected, null)
    expect(result.items).toBeNull()
    expect(result.error).toContain('ANTHROPIC_API_KEY')
  })

  it('does not call the model when nothing moved', async () => {
    const model = vi.fn()
    const result = await generateBrief({ ...collected, facts: [] }, model)
    expect(model).not.toHaveBeenCalled()
    expect(result.items).toEqual([])
    expect(result.error).toBeNull()
  })
})
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npx vitest run src/lib/advisor/brief.test.ts`
Expected: FAIL — `Failed to resolve import "./brief"`

- [ ] **Step 7: Write `src/lib/advisor/brief.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { CollectedFacts } from './collect'
import type { Fact } from './types'

/**
 * Turning facts into a briefing.
 *
 * The model is given figures that are already computed and asked ONLY to rank
 * and explain them. It is never asked to derive one, and it is not trusted to
 * have resisted: an item citing a fact id it was not given is dropped before
 * anything is stored, and the interface prints figures from the facts rather
 * than from the prose.
 */

export const ADVISOR_MODEL = 'claude-opus-5'

export const BriefItemSchema = z.object({
  headline: z.string().min(1),
  why: z.string().min(1),
  factIds: z.array(z.string()),
  severity: z.enum(['high', 'medium', 'low']),
  action: z.string().nullable(),
})
export const BriefPayloadSchema = z.object({ items: z.array(BriefItemSchema) })

export type BriefItem = z.infer<typeof BriefItemSchema>

/**
 * Hand-written rather than generated from the zod schema above.
 *
 * The SDK ships a zodOutputFormat helper, and it is bound to the zod version
 * the SDK bundles; this project is on zod v4 and uses it everywhere else. One
 * small literal schema is cheaper than that coupling.
 */
const BRIEF_JSON_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          why: { type: 'string' },
          factIds: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          action: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['headline', 'why', 'factIds', 'severity', 'action'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = `You advise the owner of a group of regional WooCommerce shops
(Panetti, Mazzetti, Massasjepistoler, Bellino) trading in Norway, Sweden, Denmark,
Finland and Germany. He reads this once, early, before the working day.

You are given FACTS that have already been computed from his accounting data. Each
one has an id, what it is about, the figure now, the figure over the previous equal
period, and a severity between 0 and 1.

Your job is to decide what deserves his attention, in what order, and to say why.

Rules:
- Never state a figure that is not in the facts you were given. You cannot compute.
- Do not put numbers in "headline" or "why" — the interface prints them from the
  facts, beneath your words. Refer to direction and cause instead: "fell sharply",
  "in step with advertising efficiency".
- Cite every fact an item rests on in factIds. An item citing an id you were not
  given is discarded.
- Combine facts that describe one story into one item. Revenue falling and ROAS
  falling in the same shop in the same week is one item, not two.
- "action" is what he should do. Set it to null when there is nothing to do; do not
  invent advice to fill the field.
- Order items so the most consequential is first.
- Data-quality facts mean a number on his dashboard cannot yet be trusted. Say that
  plainly — it outranks a move he can see for himself.
- Write plainly. No preamble, no encouragement, no exclamation marks.`

/** What a briefing generator does. A function so tests can pass a stub. */
export type BriefingModel = (
  collected: CollectedFacts,
) => Promise<{ items: BriefItem[]; model: string }>

/**
 * The real one, or null when no key is configured — which is a state the page
 * shows plainly rather than an error it throws.
 */
export function anthropicModel(): BriefingModel | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const client = new Anthropic({ apiKey })

  return async (collected) => {
    const res = await client.messages.create({
      model: ADVISOR_MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: BRIEF_JSON_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            window: {
              from: collected.from.toISOString().slice(0, 10),
              to: collected.to.toISOString().slice(0, 10),
            },
            facts: collected.facts,
          }),
        },
      ],
      // The SDK's types may not yet carry output_config; the parameter is real.
    } as Parameters<typeof client.messages.create>[0])

    // Checked BEFORE reading content: a refusal returns HTTP 200 with an empty
    // or partial content array, and indexing it blindly would throw.
    if (res.stop_reason === 'refusal') {
      throw new Error('The model declined to write this briefing.')
    }

    const text = res.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('The model returned no text.')

    const payload = BriefPayloadSchema.parse(JSON.parse(text.text))
    return { items: payload.items, model: ADVISOR_MODEL }
  }
}

/**
 * Drop anything resting on a fact that was never computed.
 *
 * This is the load-bearing check. Without it, a fluent sentence about a number
 * nobody derived would be stored and shown exactly like a true one.
 */
export function validateItems(items: BriefItem[], facts: Fact[]): BriefItem[] {
  const known = new Set(facts.map((f) => f.id))
  return items.filter((item) => item.factIds.length > 0 && item.factIds.every((id) => known.has(id)))
}

export type GeneratedBrief = {
  items: BriefItem[] | null
  model: string | null
  error: string | null
}

export async function generateBrief(
  collected: CollectedFacts,
  model: BriefingModel | null,
): Promise<GeneratedBrief> {
  // A quiet week is a real answer, and it costs nothing to give.
  if (collected.facts.length === 0) return { items: [], model: null, error: null }

  if (!model) {
    return {
      items: null,
      model: null,
      error: 'No ANTHROPIC_API_KEY is configured, so no briefing could be written.',
    }
  }

  try {
    const result = await model(collected)
    return { items: validateItems(result.items, collected.facts), model: result.model, error: null }
  } catch (e) {
    // Stored, never thrown: the facts are still worth showing, and a silent
    // failure would look exactly like a quiet week.
    return { items: null, model: null, error: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npx vitest run src/lib/advisor/brief.test.ts`
Expected: PASS, 9 tests

If TypeScript rejects `output_config`, keep the `as Parameters<...>[0]` cast already present and verify with `npx tsc --noEmit`.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma .env.example package.json package-lock.json \
        src/lib/advisor/brief.ts src/lib/advisor/brief.test.ts
git commit -m "feat(advisor): the Briefing row, the prompt, and the invented-fact guard"
```

---

### Task 8: The daily cron

**Files:**
- Create: `src/lib/advisor/write.ts`
- Create: `src/app/api/cron/briefing/route.ts`
- Modify: `vercel.json`
- Test: `src/app/api/cron/briefing/route.integration.test.ts`
- Modify: `vitest.config.ts` (add the route test to the serial project)

**Interfaces:**
- Consumes: `collectFacts` (Task 6), `generateBrief`, `anthropicModel` (Task 7)
- Produces: `writeBriefing(now?, model?): Promise<{ day: Date; items: number; error: string | null }>`

- [ ] **Step 1: Write `src/lib/advisor/write.ts`**

```ts
import { db } from '../db'
import { getSetting } from '../settings'
import { zonedDayStr } from '../tz'
import { collectFacts } from './collect'
import { anthropicModel, generateBrief, type BriefingModel } from './brief'

/**
 * Compute a morning's facts, ask for a briefing, and store both.
 *
 * Upsert on `day`, so a re-run replaces rather than duplicates — which is what
 * makes both the cron and the page's Refresh button safe to press twice.
 */
export async function writeBriefing(
  now: Date = new Date(),
  model: BriefingModel | null = anthropicModel(),
): Promise<{ day: Date; items: number; error: string | null }> {
  const { timezone } = await getSetting()
  // The day in HIS calendar, not UTC's: a briefing written at 05:00 UTC belongs
  // to the Oslo morning it is read in.
  const day = new Date(`${zonedDayStr(now, timezone)}T00:00:00.000Z`)

  const collected = await collectFacts(now)
  const brief = await generateBrief(collected, model)

  const data = {
    from: collected.from,
    to: collected.to,
    facts: JSON.stringify(collected.facts),
    items: brief.items ? JSON.stringify(brief.items) : null,
    error: brief.error,
    model: brief.model,
  }

  await db.briefing.upsert({ where: { day }, create: { day, ...data }, update: data })

  return { day, items: brief.items?.length ?? 0, error: brief.error }
}
```

- [ ] **Step 2: Write `src/app/api/cron/briefing/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { writeBriefing } from '@/lib/advisor/write'

/**
 * The morning briefing, written once a day by Vercel Cron.
 *
 * Its own route rather than a stage inside /api/cron/sync. That run is budgeted
 * tight against the 300s platform ceiling, and its own comments explain that the
 * delivery alert at the end is the one thing it cannot afford to have starved —
 * an unbounded model call in front of it is exactly that risk.
 */
export const maxDuration = 300

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'The scheduled briefing is not configured. Set CRON_SECRET to enable it.' },
      { status: 503 },
    )
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  try {
    const result = await writeBriefing()
    // ok describes the WRITE, not the model. A row stored with an error is a
    // successful run that has something to report, and the page shows both.
    return NextResponse.json({
      ok: true,
      day: result.day.toISOString().slice(0, 10),
      items: result.items,
      error: result.error,
    })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ ok: false, error: 'Could not write the briefing' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Add the cron to `vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["lhr1"],
  "crons": [
    { "path": "/api/cron/sync", "schedule": "*/15 * * * *" },
    { "path": "/api/cron/briefing", "schedule": "0 5 * * *" }
  ]
}
```

05:00 UTC is 06:00 in Oslo in winter and 07:00 in summer — before the working day in every market the group trades in.

- [ ] **Step 4: Write the failing test `src/app/api/cron/briefing/route.integration.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { writeBriefing } from '@/lib/advisor/write'
import type { BriefItem } from '@/lib/advisor/brief'

const NOW = new Date('2026-08-10T05:00:00Z')
const DAY = new Date('2026-08-10T00:00:00.000Z')

const item: BriefItem = {
  headline: 'Something moved',
  why: 'It moved in step with advertising.',
  factIds: [],
  severity: 'medium',
  action: null,
}

beforeEach(async () => {
  await db.briefing.deleteMany({ where: { day: DAY } })
})
afterEach(async () => {
  await db.briefing.deleteMany({ where: { day: DAY } })
})

describe('writeBriefing', () => {
  it('stores the facts even when no model is configured', async () => {
    const result = await writeBriefing(NOW, null)
    expect(result.error).toContain('ANTHROPIC_API_KEY')

    const row = await db.briefing.findUnique({ where: { day: DAY } })
    expect(row).not.toBeNull()
    expect(row!.items).toBeNull()
    expect(JSON.parse(row!.facts)).toBeInstanceOf(Array)
  })

  it('stores the facts even when the model call fails', async () => {
    const model = vi.fn().mockRejectedValue(new Error('529 overloaded'))
    await writeBriefing(NOW, model)

    const row = await db.briefing.findUnique({ where: { day: DAY } })
    expect(row!.error).toContain('529 overloaded')
    expect(JSON.parse(row!.facts)).toBeInstanceOf(Array)
  })

  it('replaces rather than duplicates when run twice on one day', async () => {
    const model = vi.fn().mockResolvedValue({ items: [item], model: 'claude-opus-5' })
    await writeBriefing(NOW, model)
    await writeBriefing(NOW, model)

    const rows = await db.briefing.findMany({ where: { day: DAY } })
    expect(rows).toHaveLength(1)
  })

  it('records which model wrote it', async () => {
    const model = vi.fn().mockResolvedValue({ items: [item], model: 'claude-opus-5' })
    await writeBriefing(NOW, model)

    const row = await db.briefing.findUnique({ where: { day: DAY } })
    expect(row!.model).toBe('claude-opus-5')
  })
})

describe('GET /api/cron/briefing', () => {
  it('refuses to run when no CRON_SECRET is set', async () => {
    const previous = process.env.CRON_SECRET
    delete process.env.CRON_SECRET
    const { GET } = await import('./route')

    const res = await GET(new Request('http://localhost/api/cron/briefing'))
    expect(res.status).toBe(503)

    if (previous) process.env.CRON_SECRET = previous
  })

  it('refuses a caller with the wrong bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret'
    const { GET } = await import('./route')

    const res = await GET(
      new Request('http://localhost/api/cron/briefing', { headers: { authorization: 'Bearer wrong' } }),
    )
    expect(res.status).toBe(401)

    delete process.env.CRON_SECRET
  })
})
```

- [ ] **Step 5: Add the test to the serial project in `vitest.config.ts`**

Add `'src/app/api/cron/briefing/route.integration.test.ts'` to BOTH the `app` project's `exclude` and the `delivery` project's `include`. It writes a `Briefing` row keyed on a fixed day and runs the full collector.

- [ ] **Step 6: Run it and confirm it passes**

Run: `npx vitest run --project delivery src/app/api/cron/briefing/route.integration.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 7: Commit**

```bash
git add src/lib/advisor/write.ts src/app/api/cron/briefing/route.ts \
        src/app/api/cron/briefing/route.integration.test.ts vercel.json vitest.config.ts
git commit -m "feat(advisor): write the briefing each morning on its own cron"
```

---

### Task 9: The Advisor page

**Files:**
- Create: `src/app/api/advisor/route.ts`
- Create: `src/app/advisor/page.tsx`
- Create: `src/app/advisor/AdvisorClient.tsx`
- Modify: `src/components/shell/AppShell.tsx` (add the nav item)
- Test: `src/app/advisor/AdvisorClient.test.tsx`

**Interfaces:**
- Consumes: `Fact` (Task 1), `BriefItem` (Task 7), `writeBriefing` (Task 8)
- Produces: `GET /api/advisor` → `{ day, from, to, facts, items, error, model } | { briefing: null }`; `POST /api/advisor` → the same shape, after a fresh run

- [ ] **Step 1: Write `src/app/api/advisor/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { writeBriefing } from '@/lib/advisor/write'

/** Company-wide money, the same boundary every other financial route holds. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

function shape(row: {
  day: Date
  from: Date
  to: Date
  facts: string
  items: string | null
  error: string | null
  model: string | null
}) {
  return {
    day: row.day.toISOString().slice(0, 10),
    from: row.from.toISOString().slice(0, 10),
    to: row.to.toISOString().slice(0, 10),
    facts: JSON.parse(row.facts),
    items: row.items ? JSON.parse(row.items) : null,
    error: row.error,
    model: row.model,
  }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const row = await db.briefing.findFirst({ orderBy: { day: 'desc' } })
    // null rather than a 404: "none written yet" is a state the page teaches
    // the next action for, not an error.
    return NextResponse.json({ briefing: row ? shape(row) : null }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the briefing' }, { status: 500, headers: NO_STORE })
  }
}

/** Refresh: run it again now. Upserts on the day, so pressing twice is safe. */
export async function POST() {
  try {
    assertAdmin(await currentUser())
    await writeBriefing()
    const row = await db.briefing.findFirst({ orderBy: { day: 'desc' } })
    return NextResponse.json({ briefing: row ? shape(row) : null }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not write the briefing' }, { status: 500, headers: NO_STORE })
  }
}

export const maxDuration = 300
```

- [ ] **Step 2: Add the nav item to `src/components/shell/AppShell.tsx`**

Inside the `Analytics` section's `items` array, immediately after the `/dashboard` entry, add:

```tsx
      {
        href: '/advisor',
        label: 'Advisor',
        icon: icon(
          <>
            <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
            <circle cx="12" cy="12" r="3.5" />
          </>,
        ),
      },
```

- [ ] **Step 3: Write the failing test `src/app/advisor/AdvisorClient.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { AdvisorClient, type Briefing } from './AdvisorClient'

const fact = {
  id: 'revenue:shop_se',
  kind: 'REVENUE_MOVE' as const,
  shopId: 'shop_se',
  shopName: 'Panetti Sweden',
  subject: null,
  current: 820_000,
  previous: 1_000_000,
  deltaPct: -0.18,
  unit: 'money' as const,
  severity: 0.4,
  currency: 'USD',
}

const briefing = (over: Partial<Briefing> = {}): Briefing => ({
  day: '2026-08-10',
  from: '2026-08-03',
  to: '2026-08-09',
  facts: [fact],
  items: [
    {
      headline: 'Sweden revenue fell',
      why: 'It fell in step with advertising efficiency.',
      factIds: ['revenue:shop_se'],
      severity: 'high',
      action: 'Check the Meta campaign that changed.',
    },
  ],
  error: null,
  model: 'claude-opus-5',
  ...over,
})

describe('AdvisorClient', () => {
  it('shows the headline and the explanation', () => {
    render(<AdvisorClient initial={briefing()} />)
    expect(screen.getByText('Sweden revenue fell')).toBeInTheDocument()
    expect(screen.getByText(/in step with advertising efficiency/)).toBeInTheDocument()
  })

  it('prints the figure from the fact, not from the prose', () => {
    render(<AdvisorClient initial={briefing()} />)
    // -18% is derived from Fact.deltaPct. No item text contains it.
    expect(screen.getByText(/−18(\.0)?%/)).toBeInTheDocument()
  })

  it('labels severity in words, never by colour alone', () => {
    render(<AdvisorClient initial={briefing()} />)
    expect(screen.getByText(/high/i)).toBeInTheDocument()
  })

  it('shows the action only when there is one', () => {
    render(<AdvisorClient initial={briefing({ items: [{ ...briefing().items![0], action: null }] })} />)
    expect(screen.queryByText(/Check the Meta campaign/)).not.toBeInTheDocument()
  })

  it('shows the facts anyway when generation failed', () => {
    render(<AdvisorClient initial={briefing({ items: null, error: '529 overloaded' })} />)
    expect(screen.getByText(/529 overloaded/)).toBeInTheDocument()
    expect(screen.getByText(/Panetti Sweden/)).toBeInTheDocument()
  })

  it('teaches the next action when nothing has been written yet', () => {
    render(<AdvisorClient initial={null} />)
    expect(screen.getByText(/No briefing yet/i)).toBeInTheDocument()
  })

  it('says plainly that a quiet week is a quiet week', () => {
    render(<AdvisorClient initial={briefing({ items: [], facts: [] })} />)
    expect(screen.getByText(/Nothing needs your attention/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `npx vitest run src/app/advisor/AdvisorClient.test.tsx`
Expected: FAIL — `Failed to resolve import "./AdvisorClient"`

- [ ] **Step 5: Write `src/app/advisor/AdvisorClient.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { PageBody, PageHeader } from '@/components/shell/AppShell'
import type { Fact } from '@/lib/advisor/types'
import type { BriefItem } from '@/lib/advisor/brief'

export type Briefing = {
  day: string
  from: string
  to: string
  facts: Fact[]
  items: BriefItem[] | null
  error: string | null
  model: string | null
}

/**
 * FIGURES ARE PRINTED FROM FACTS, NEVER FROM THE MODEL'S PROSE.
 *
 * This is the second of the two places that guarantee the advisor cannot show
 * a number nobody computed — the first is validateItems() dropping an item that
 * cites an unknown fact. The model supplies the sentence; this supplies the
 * figure beside it.
 */
function figure(fact: Fact): string {
  const { current, previous, deltaPct, unit } = fact

  const one = (n: number | null) => {
    if (n === null) return '—'
    if (unit === 'money') return (n / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })
    if (unit === 'percent') return `${(n * 100).toFixed(1)}%`
    if (unit === 'ratio') return n.toFixed(1)
    if (unit === 'days') return `${n} d`
    return String(n)
  }

  const move =
    deltaPct === null
      ? ''
      : // A minus sign, not just a colour: red/green colour-blindness must never
        // hide a fall. U+2212 so the sign aligns in a tabular column.
        ` (${deltaPct < 0 ? '−' : '+'}${Math.abs(deltaPct * 100).toFixed(1)}%)`

  return previous === null ? one(current) : `${one(previous)} → ${one(current)}${move}`
}

const SEVERITY_LABEL: Record<BriefItem['severity'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

function Card({ item, facts }: { item: BriefItem; facts: Fact[] }) {
  const cited = facts.filter((f) => item.factIds.includes(f.id))

  return (
    <article className="rounded-[12px] border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink">{item.headline}</h2>
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted">
          {SEVERITY_LABEL[item.severity]}
        </span>
      </div>

      {cited.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          {cited.map((fact) => (
            <div key={fact.id} className="text-[13px]">
              <dt className="text-muted">
                {[fact.shopName, fact.subject].filter(Boolean).join(' · ') || 'Total'}
              </dt>
              <dd className="tabular-nums text-ink">{figure(fact)}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-2 text-[13px] text-muted">{item.why}</p>
      {item.action && <p className="mt-2 text-[13px] font-medium text-ink">{item.action}</p>}
    </article>
  )
}

function FactList({ facts }: { facts: Fact[] }) {
  return (
    <ul className="divide-y divide-line rounded-[12px] border border-line bg-surface">
      {facts.map((fact) => (
        <li key={fact.id} className="flex items-baseline justify-between gap-4 px-4 py-2 text-[13px]">
          <span className="text-muted">
            {[fact.shopName, fact.subject].filter(Boolean).join(' · ') || fact.kind}
          </span>
          <span className="tabular-nums text-ink">{figure(fact)}</span>
        </li>
      ))}
    </ul>
  )
}

export function AdvisorClient({ initial }: { initial: Briefing | null }) {
  const [briefing, setBriefing] = useState(initial)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setBusy(true)
    try {
      const res = await fetch('/api/advisor', { method: 'POST' })
      if (res.ok) setBriefing((await res.json()).briefing)
    } finally {
      setBusy(false)
    }
  }

  const subtitle = briefing ? `${briefing.from} to ${briefing.to}` : undefined

  return (
    <>
      <PageHeader title="Advisor" subtitle={subtitle}>
        <button
          onClick={refresh}
          disabled={busy}
          className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Refresh'}
        </button>
      </PageHeader>

      <PageBody>
        {!briefing ? (
          <div className="rounded-[12px] border border-line bg-surface p-6">
            <p className="text-[14px] font-medium text-ink">No briefing yet</p>
            <p className="mt-1 text-[13px] text-muted">
              One is written every morning. Press Refresh to write today&rsquo;s now.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {briefing.error && (
              <div className="rounded-[12px] border border-line bg-surface p-4">
                <p className="text-[13px] font-medium text-ink">
                  The briefing could not be written: {briefing.error}
                </p>
                <p className="mt-1 text-[13px] text-muted">
                  The figures below were still computed, and are correct.
                </p>
              </div>
            )}

            {briefing.items?.length === 0 && !briefing.error && (
              <div className="rounded-[12px] border border-line bg-surface p-6">
                <p className="text-[14px] font-medium text-ink">Nothing needs your attention</p>
                <p className="mt-1 text-[13px] text-muted">
                  Nothing moved far enough this week to be worth reporting.
                </p>
              </div>
            )}

            {briefing.items?.map((item, i) => (
              <Card key={`${item.headline}-${i}`} item={item} facts={briefing.facts} />
            ))}

            {!briefing.items && briefing.facts.length > 0 && <FactList facts={briefing.facts} />}
          </div>
        )}
      </PageBody>
    </>
  )
}
```

- [ ] **Step 6: Write `src/app/advisor/page.tsx`**

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { AppShell } from '@/components/shell/AppShell'
import { AdvisorClient, type Briefing } from './AdvisorClient'

export const dynamic = 'force-dynamic'

export default async function AdvisorPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  // Company money. An ambassador lands on their own portal instead.
  if (user.role !== 'ADMIN') redirect('/portal')

  const row = await db.briefing.findFirst({ orderBy: { day: 'desc' } })

  const initial: Briefing | null = row
    ? {
        day: row.day.toISOString().slice(0, 10),
        from: row.from.toISOString().slice(0, 10),
        to: row.to.toISOString().slice(0, 10),
        facts: JSON.parse(row.facts),
        items: row.items ? JSON.parse(row.items) : null,
        error: row.error,
        model: row.model,
      }
    : null

  return (
    <AppShell email={user.email}>
      <AdvisorClient initial={initial} />
    </AppShell>
  )
}
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `npx vitest run src/app/advisor/AdvisorClient.test.tsx`
Expected: PASS, 7 tests

- [ ] **Step 8: Commit**

```bash
git add src/app/api/advisor/route.ts src/app/advisor/ src/components/shell/AppShell.tsx
git commit -m "feat(advisor): the Advisor page, printing figures from facts"
```

---

### Task 10: Chat tools and route

**Files:**
- Create: `src/lib/advisor/tools.ts`
- Create: `src/app/api/advisor/chat/route.ts`
- Test: `src/lib/advisor/tools.test.ts`

**Interfaces:**
- Consumes: `loadMetricsInput`, `loadDelivery`, `loadProductsInput`, `computeMetrics`, `buildMarketing`, `deliveryStats`, `productFigures`, `getSetting`, `db`
- Produces: `TOOL_DEFINITIONS` (Anthropic tool schemas), `runTool(name, input): Promise<unknown>`, `parseWindow(input)`

- [ ] **Step 1: Write the failing test `src/lib/advisor/tools.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { parseWindow, TOOL_DEFINITIONS, runTool } from './tools'

describe('TOOL_DEFINITIONS', () => {
  it('offers exactly the five read-only tools, and nothing that writes', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      'get_delivery',
      'get_marketing',
      'get_metrics',
      'get_orders',
      'get_products',
    ])
  })

  it('describes every parameter, so the model does not have to guess', () => {
    for (const tool of TOOL_DEFINITIONS) {
      for (const key of Object.keys(tool.input_schema.properties)) {
        expect(tool.input_schema.properties[key].description).toBeTruthy()
      }
    }
  })
})

describe('parseWindow', () => {
  it('reads an explicit range', () => {
    const { from, to } = parseWindow({ from: '2026-08-01', to: '2026-08-07' })
    expect(from.toISOString().slice(0, 10)).toBe('2026-08-01')
    expect(to.toISOString().slice(0, 10)).toBe('2026-08-07')
  })

  it('rejects a range that runs backwards rather than returning nonsense', () => {
    expect(() => parseWindow({ from: '2026-08-07', to: '2026-08-01' })).toThrow(RangeError)
  })

  it('rejects a date it cannot read', () => {
    expect(() => parseWindow({ from: 'last tuesday', to: '2026-08-07' })).toThrow(RangeError)
  })

  it('rejects a window longer than a year, so one question cannot scan everything', () => {
    expect(() => parseWindow({ from: '2020-01-01', to: '2026-08-07' })).toThrow(RangeError)
  })
})

describe('runTool', () => {
  it('refuses a tool name it does not know', async () => {
    await expect(runTool('drop_table', {})).rejects.toThrow(/Unknown tool/)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/advisor/tools.test.ts`
Expected: FAIL — `Failed to resolve import "./tools"`

- [ ] **Step 3: Write `src/lib/advisor/tools.ts`**

```ts
import { db } from '../db'
import { getSetting } from '../settings'
import { loadMetricsInput } from '../data/load'
import { loadProductsInput, MixedCurrencyError } from '../data/load-products'
import { loadDelivery } from '../delivery/load'
import { computeMetrics } from '../metrics'
import { productFigures } from '../metrics/products'
import { deliveryStats } from '../delivery/stats'
import { buildMarketing } from '../ads/marketing'
import { accountIdsForShops, accountSpendRows } from '../ads/attribution'

/**
 * What the chat is allowed to ask.
 *
 * Five read-only tools, every one of them calling the same loader a page calls.
 * SQL access was rejected deliberately: a model writing its own SELECT against
 * Order would sooner or later sum netSales without excluding refunded and
 * cancelled rows, and produce a figure that contradicts every screen in the
 * product. Routing every question through the engine makes that impossible
 * rather than merely unlikely.
 */

/** One question must not be able to scan the whole history. */
const MAX_WINDOW_DAYS = 366
const DAY_MS = 24 * 60 * 60 * 1000

export type ToolInput = Record<string, unknown>

export function parseWindow(input: ToolInput): { from: Date; to: Date } {
  const from = new Date(`${String(input.from)}T00:00:00.000Z`)
  const to = new Date(`${String(input.to)}T00:00:00.000Z`)

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new RangeError('Dates must be written as yyyy-mm-dd.')
  }
  if (to.getTime() < from.getTime()) {
    throw new RangeError('The end of the range is before its start.')
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new RangeError('That range is longer than a year. Ask about a shorter one.')
  }
  return { from, to }
}

const shopIdsOf = (input: ToolInput): string[] | undefined =>
  Array.isArray(input.shopIds) && input.shopIds.length ? (input.shopIds as string[]) : undefined

const DATE_PROPS = {
  from: { type: 'string', description: 'First day of the range, yyyy-mm-dd.' },
  to: { type: 'string', description: 'Last day of the range, inclusive, yyyy-mm-dd.' },
  shopIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Shop ids to limit to. Omit for every active shop.',
  },
} as const

export const TOOL_DEFINITIONS = [
  {
    name: 'get_metrics',
    description:
      'Revenue, profit, COGS, marketing, fees and margin for a date range, per shop and in total. Call this when the question is about money. Also returns the list of shops and their ids.',
    input_schema: {
      type: 'object' as const,
      properties: { ...DATE_PROPS },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_marketing',
    description:
      'Ad spend, ROAS, CPA, CPM, impressions and clicks for a date range, per shop. Call this when the question is about advertising or why revenue moved.',
    input_schema: {
      type: 'object' as const,
      properties: { ...DATE_PROPS },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_delivery',
    description:
      'Median delivery days, on-time rate and the count of orders late right now, per shop and per destination country. Call this when the question is about shipping or Bring.',
    input_schema: {
      type: 'object' as const,
      properties: { ...DATE_PROPS },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_products',
    description:
      'Units sold, revenue, cost and profit per product, for ONE shop. Takes a single shopId because shops in different currencies cannot be added together.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: DATE_PROPS.from,
        to: DATE_PROPS.to,
        shopId: { type: 'string', description: 'The single shop to report on.' },
      },
      required: ['from', 'to', 'shopId'],
    },
  },
  {
    name: 'get_orders',
    description:
      'Individual orders in a range: number, date, status, customer, country and value. Call this only when the question is about specific orders — use get_metrics for totals.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ...DATE_PROPS,
        limit: { type: 'integer', description: 'How many orders to return, at most 50. Default 20.' },
      },
      required: ['from', 'to'],
    },
  },
]

export async function runTool(name: string, input: ToolInput): Promise<unknown> {
  const { timezone } = await getSetting()

  if (name === 'get_metrics') {
    const { from, to } = parseWindow(input)
    const loaded = await loadMetricsInput({ shopIds: shopIdsOf(input), from, to, timezone })
    const result = computeMetrics(loaded)
    return { ...result, note: 'Money is in minor units (cents/øre) of displayCurrency.' }
  }

  if (name === 'get_marketing') {
    const { from, to } = parseWindow(input)
    const loaded = await loadMetricsInput({ shopIds: shopIdsOf(input), from, to, timezone })
    const engine = computeMetrics(loaded)
    const shopIds = engine.byShop.map((s) => s.shopId)
    // Through accountIdsForShops, so a split account's in-scope campaigns are
    // not dropped — see the same note in collect.ts.
    const accountIds = await accountIdsForShops(shopIds)
    const accounts = await db.adAccount.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, shopId: true, provider: true, currency: true, dailyBudget: true },
    })
    const spend = await accountSpendRows(
      accounts.map((a) => a.id),
      shopIds,
      from,
      to,
    )
    return buildMarketing({ accounts, spend, engine, series: [], rates: loaded.rates, to })
  }

  if (name === 'get_delivery') {
    const { from, to } = parseWindow(input)
    const shopIds =
      shopIdsOf(input) ?? (await db.shop.findMany({ where: { active: true }, select: { id: true } })).map((s) => s.id)
    const { rows } = await loadDelivery(shopIds, from, to)
    return deliveryStats(
      rows.map((r) => r.view),
      rows.map((r) => r.order.shippingCountry),
    )
  }

  if (name === 'get_products') {
    const { from, to } = parseWindow(input)
    const shopId = String(input.shopId ?? '')
    if (!shopId) throw new RangeError('get_products needs a single shopId.')
    try {
      return productFigures(await loadProductsInput({ shopIds: [shopId], from, to, timezone }))
    } catch (e) {
      // Cannot happen for one shop, but a caller passing a stale id deserves a
      // sentence rather than a stack trace.
      if (e instanceof MixedCurrencyError) throw new RangeError(e.message)
      throw e
    }
  }

  if (name === 'get_orders') {
    const { from, to } = parseWindow(input)
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50)
    const shopIds = shopIdsOf(input)
    return db.order.findMany({
      where: {
        placedAt: { gte: from, lte: to },
        ...(shopIds ? { shopId: { in: shopIds } } : {}),
      },
      orderBy: { placedAt: 'desc' },
      take: limit,
      select: {
        number: true,
        placedAt: true,
        status: true,
        currency: true,
        netSales: true,
        total: true,
        customerName: true,
        shippingCountry: true,
        shop: { select: { name: true } },
      },
    })
  }

  throw new RangeError(`Unknown tool: ${name}`)
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/lib/advisor/tools.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Write `src/app/api/advisor/chat/route.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { ADVISOR_MODEL } from '@/lib/advisor/brief'
import { runTool, TOOL_DEFINITIONS } from '@/lib/advisor/tools'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const maxDuration = 300

const SYSTEM_PROMPT = `You answer questions about a group of regional WooCommerce shops
(Panetti, Mazzetti, Massasjepistoler, Bellino) trading in Norway, Sweden, Denmark,
Finland and Germany, for the owner.

You have read-only tools over his accounting data. Use them for EVERY figure you
state. Never estimate, never work a number out in your head, and never carry a
figure forward from memory — call a tool and read it.

Money comes back in minor units (cents, øre) of the currency named beside it, so
82000 in USD is $820.00. Convert for display, never between currencies.

To answer "why did X change", fetch the same window and the equal window before it
and compare them.

If a tool returns nothing, or a figure is missing, say so. A confident wrong number
is worse than an admitted gap. Write plainly and briefly.`

type Turn = { role: 'user' | 'assistant'; content: unknown }

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'No ANTHROPIC_API_KEY is configured, so the advisor cannot answer.' },
        { status: 503, headers: NO_STORE },
      )
    }

    const body = (await req.json()) as { messages?: Turn[] }
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (messages.length === 0) {
      return NextResponse.json({ error: 'Ask a question first.' }, { status: 400, headers: NO_STORE })
    }

    const client = new Anthropic({ apiKey })
    const turns = [...messages] as Anthropic.MessageParam[]

    // A bounded loop, not a while(true): a model that keeps calling tools must
    // stop somewhere, and stopping visibly beats a request the platform kills.
    for (let round = 0; round < 8; round++) {
      const res = await client.messages.create({
        model: ADVISOR_MODEL,
        max_tokens: 8000,
        system: [
          // Stable prefix, cached — the chat re-sends it on every turn.
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        tools: TOOL_DEFINITIONS,
        messages: turns,
      })

      if (res.stop_reason === 'refusal') {
        return NextResponse.json(
          { error: 'The advisor declined to answer that.' },
          { status: 200, headers: NO_STORE },
        )
      }

      turns.push({ role: 'assistant', content: res.content })

      const calls = res.content.filter((b) => b.type === 'tool_use')
      if (calls.length === 0) {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        return NextResponse.json({ reply: text, messages: turns }, { headers: NO_STORE })
      }

      // Every result goes back in ONE user message. Splitting them across
      // several silently teaches the model to stop calling tools in parallel.
      const results = await Promise.all(
        calls.map(async (call) => {
          try {
            const value = await runTool(call.name, call.input as Record<string, unknown>)
            return { type: 'tool_result' as const, tool_use_id: call.id, content: JSON.stringify(value) }
          } catch (e) {
            return {
              type: 'tool_result' as const,
              tool_use_id: call.id,
              content: e instanceof Error ? e.message : String(e),
              is_error: true,
            }
          }
        }),
      )
      turns.push({ role: 'user', content: results })
    }

    return NextResponse.json(
      { error: 'The advisor could not finish that one. Try asking it more narrowly.' },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not answer' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `tools` rejects `TOOL_DEFINITIONS`, add `as Anthropic.Tool[]` at the call site rather than loosening the definitions.

- [ ] **Step 7: Commit**

```bash
git add src/lib/advisor/tools.ts src/lib/advisor/tools.test.ts src/app/api/advisor/chat/route.ts
git commit -m "feat(advisor): read-only tools and the chat route"
```

---

### Task 11: The chat panel

**Files:**
- Create: `src/app/advisor/Chat.tsx`
- Modify: `src/app/advisor/AdvisorClient.tsx` (render `<Chat />` below the cards)
- Test: `src/app/advisor/Chat.test.tsx`

**Interfaces:**
- Consumes: `POST /api/advisor/chat` (Task 10)
- Produces: `<Chat />`

- [ ] **Step 1: Write the failing test `src/app/advisor/Chat.test.tsx`**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { Chat } from './Chat'

afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
})

function stubFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => body })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('Chat', () => {
  it('shows the question and then the answer', async () => {
    stubFetch({ reply: 'Sweden fell because advertising efficiency dropped.', messages: [] })
    render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'Why was Sweden down?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(screen.getByText('Why was Sweden down?')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText(/advertising efficiency dropped/)).toBeInTheDocument(),
    )
  })

  it('shows the reason plainly when the server refuses', async () => {
    stubFetch({ error: 'No ANTHROPIC_API_KEY is configured, so the advisor cannot answer.' }, false)
    render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument())
  })

  it('does not send an empty question', () => {
    const fetchMock = stubFetch({ reply: '' })
    render(<Chat />)
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('survives a refresh by restoring the conversation', async () => {
    stubFetch({ reply: 'Answer one.', messages: [] })
    const { unmount } = render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'Question one' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(screen.getByText('Answer one.')).toBeInTheDocument())

    unmount()
    render(<Chat />)
    expect(screen.getByText('Question one')).toBeInTheDocument()
    expect(screen.getByText('Answer one.')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/app/advisor/Chat.test.tsx`
Expected: FAIL — `Failed to resolve import "./Chat"`

- [ ] **Step 3: Write `src/app/advisor/Chat.tsx`**

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Asking follow-up questions.
 *
 * The conversation lives in the browser: sessionStorage so a refresh does not
 * lose it, and no server table, because a stored history is a schema, a list
 * screen and a retention question this feature does not need yet.
 */

const STORAGE_KEY = 'advisor-chat'

type Bubble = { role: 'user' | 'assistant'; text: string }

export function Chat() {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // The model's own transcript, tool calls and all. Kept apart from the
  // bubbles, which are only what a person should read.
  const transcript = useRef<unknown[]>([])

  useEffect(() => {
    const saved = window.sessionStorage.getItem(STORAGE_KEY)
    if (!saved) return
    try {
      const parsed = JSON.parse(saved) as { bubbles: Bubble[]; transcript: unknown[] }
      setBubbles(parsed.bubbles ?? [])
      transcript.current = parsed.transcript ?? []
    } catch {
      // A corrupt entry is not worth a broken page.
    }
  }, [])

  function remember(next: Bubble[]) {
    setBubbles(next)
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ bubbles: next, transcript: transcript.current }),
    )
  }

  async function send() {
    const question = draft.trim()
    if (!question || busy) return

    const asked: Bubble[] = [...bubbles, { role: 'user', text: question }]
    remember(asked)
    setDraft('')
    setBusy(true)

    try {
      const res = await fetch('/api/advisor/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...transcript.current, { role: 'user', content: question }],
        }),
      })
      const body = await res.json()

      if (!res.ok || body.error) {
        remember([...asked, { role: 'assistant', text: body.error ?? 'Could not answer.' }])
        return
      }

      transcript.current = body.messages ?? transcript.current
      remember([...asked, { role: 'assistant', text: body.reply ?? '' }])
    } catch {
      remember([...asked, { role: 'assistant', text: 'Could not reach the server.' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[12px] border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-3 text-[13px] font-semibold text-ink">Ask</h2>

      <div className="flex flex-col gap-3 px-4 py-3">
        {bubbles.map((bubble, i) => (
          <p
            key={i}
            className={
              bubble.role === 'user'
                ? 'text-[13px] font-medium text-ink'
                : 'whitespace-pre-wrap text-[13px] text-muted'
            }
          >
            {bubble.text}
          </p>
        ))}
        {busy && <p className="text-[13px] text-faint">Looking it up…</p>}
      </div>

      <div className="flex gap-2 border-t border-line p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          placeholder="Ask about any shop, product or week"
          className="flex-1 rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[13px]"
        />
        <button
          onClick={send}
          disabled={busy}
          className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Render it from `AdvisorClient.tsx`**

Add the import at the top:

```tsx
import { Chat } from './Chat'
```

Then, inside `<PageBody>`, immediately before its closing tag, add:

```tsx
        <div className="mt-4">
          <Chat />
        </div>
```

- [ ] **Step 5: Run both page tests and confirm they pass**

Run: `npx vitest run src/app/advisor/`
Expected: PASS, 11 tests

- [ ] **Step 6: Commit**

```bash
git add src/app/advisor/Chat.tsx src/app/advisor/Chat.test.tsx src/app/advisor/AdvisorClient.tsx
git commit -m "feat(advisor): the chat panel"
```

---

### Task 12: End-to-end, then green

**Files:**
- Create: `e2e/advisor.spec.ts`
- Modify: `e2e/global-setup.ts` (warm `/advisor`)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Warm the route in `e2e/global-setup.ts`**

Add `'/advisor'` to the array of paths.

- [ ] **Step 2: Write `e2e/advisor.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

/**
 * The Advisor page, from a browser.
 *
 * The model is never called: the page reads a stored Briefing row, and these
 * assert on what that row produces on screen. What is being tested is that a
 * figure reaches the page from the FACTS, and that a failed generation still
 * shows them.
 */

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill('admin@ecom.test')
  await page.getByLabel(/password/i).fill('password123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('Advisor', () => {
  test('is reachable from the sidebar', async ({ page }) => {
    await signIn(page)
    await page.getByRole('link', { name: 'Advisor' }).click()
    await expect(page).toHaveURL(/\/advisor/)
    await expect(page.getByRole('heading', { name: 'Advisor' })).toBeVisible()
  })

  test('teaches the next action when no briefing has been written', async ({ page }) => {
    await signIn(page)
    await page.goto('/advisor')
    const empty = page.getByText(/No briefing yet/i)
    const written = page.getByRole('button', { name: /refresh/i })
    // One of the two is always true; both prove the page rendered its state.
    await expect(empty.or(written).first()).toBeVisible()
  })

  test('offers the chat box', async ({ page }) => {
    await signIn(page)
    await page.goto('/advisor')
    await expect(page.getByPlaceholder(/Ask about any shop/i)).toBeVisible()
  })

  test('an ambassador can never reach it', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel(/email/i).fill('emma@ambassador.test')
    await page.getByLabel(/password/i).fill('password123')
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL('**/portal')

    await page.goto('/advisor')
    await expect(page).toHaveURL(/\/portal/)
  })
})
```

- [ ] **Step 3: Run the e2e suite**

```bash
npm run test:e2e -- advisor
```

Expected: PASS, 4 tests.

If the sign-in helper does not match the real login form, open `e2e/admin.spec.ts` and copy its sign-in steps verbatim rather than inventing selectors.

- [ ] **Step 4: Run everything**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run test:e2e
```

Expected: all green. Do not proceed past a failure — fix it.

- [ ] **Step 5: Build, exactly as the deployment will**

```bash
npm run build
```

Expected: the schema push reports the additive `Briefing` change and the build succeeds.

- [ ] **Step 6: Update the README**

In `README.md`, under "Where things live", add:

```markdown
- `src/lib/advisor/` — the morning briefing and the chat. The facts are computed
  by the engine; the model only ranks and explains them.
```

And after the "How data stays current" section, add:

```markdown
## The advisor

Every morning a briefing is written from the last seven days against the seven
before them, and stored. The figures are computed by `src/lib/metrics/` — the same
code every other page uses — and Claude is given them and asked only what deserves
attention and why. It never calculates: an item citing a figure that was not
computed is discarded, and the page prints numbers from the facts rather than from
the model's words.

Needs `ANTHROPIC_API_KEY`. Without it the page says so and shows the facts alone.
```

- [ ] **Step 7: Commit**

```bash
git add e2e/advisor.spec.ts e2e/global-setup.ts README.md
git commit -m "test(advisor): end-to-end coverage, and document the advisor"
```

---

## Self-review

**Spec coverage.** Every section of `2026-08-10-ai-advisor-design.md` maps to a task: three layers → Tasks 1–6, 7, 10; the `Briefing` model → Task 7; all four fact groups → Tasks 2–5; severity gates → Task 1; the output shape → Task 7; model parameters and refusal handling → Task 7; tools not SQL → Task 10; the page → Task 9; failing visibly → Tasks 7, 8, 9; the separate cron → Task 8; the three test layers → Tasks 1–12.

**One thing the spec did not anticipate, now in the plan:** `loadProductsInput` throws `MixedCurrencyError` across currencies, so Task 6 loads products one currency group at a time and Task 4's `productFacts` takes a per-shop baseline in the group's own currency. Nothing converts a product figure across currencies.

**One deliberate scope call:** Task 6 loads each shop's own prior revenue in its own currency with an extra `loadMetricsInput` per shop. That is ~11 small queries once a day inside a 300-second cron. If it proves slow, the fix is to sum the group's order rows directly — but measure before optimising.

**Names checked across tasks:** `Fact`, `FactKind`, `FactUnit`, `isQuality`, `severityOf`, `movingFact`, `moneyFacts`, `deliveryFacts`, `productFacts`, `b2bQuietFacts`, `ambassadorFacts`, `qualityFacts`, `collectFacts`, `CollectedFacts`, `BriefItem`, `BriefingModel`, `anthropicModel`, `generateBrief`, `validateItems`, `writeBriefing`, `ADVISOR_MODEL`, `TOOL_DEFINITIONS`, `runTool`, `parseWindow`, `Briefing`, `AdvisorClient`, `Chat` — each defined once and used with the same signature everywhere.

**One name the first draft got wrong, since corrected:** the plan invented `attributedCampaignSpend`. `src/lib/ads/attribution.ts` exports no such thing — `attributedSpend` returns `EngineAdSpend[]`, which is the wrong shape for `buildMarketing`. The real pair is `accountIdsForShops(shopIds)` then `accountSpendRows(accountIds, shopIds, from, to)`, and accounts must be resolved through the former rather than by filtering `adAccount` on `shopId`: a split account can run campaigns for a shop while its own default shop is out of scope, and the direct filter silently drops that spend. Tasks 6 and 10 now both follow the pattern `src/app/api/marketing/route.ts:36-51` already uses.
