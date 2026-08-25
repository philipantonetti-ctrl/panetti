# Marketing as a cost, ROAS on the dashboard - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the two dead columns (Shipping, Net revenue) from the dashboard's Compare table, and put Meta + Google ad spend in it as a real cost that reduces Net profit, with a ROAS column whose Total row is the blended figure.

**Architecture:** Marketing enters through the metrics engine, not the browser. `Figures` gains a `marketing` field; `MetricsInput` gains an optional `adSpend` array that `loadMetricsInput` fills from `AdAccount` + `AdSpend`. The engine filters those rows by date itself, so `dailySeries` (which re-runs the engine once per day for the Trend chart) and the previous-period comparison both pick marketing up with no extra wiring. ROAS is *not* an engine field - it is a ratio of two figures already on the row, derived in `CompareTable`, which makes the footer cell the blended ROAS for free.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Prisma 6 / Postgres, Vitest (`npm test`), Playwright (`npm run test:e2e`), Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-04-marketing-cost-and-roas-design.md`

## Global Constraints

- **All money is integer minor units.** Never introduce a float amount. Any division that produces money passes through `Math.round`.
- **Money converts at its own day's rate**, never the range's - history must never shift when a rate moves.
- **A ratio with a zero denominator prints `-`, never `0.00×`.** This rule is already set by `ratios()` in `src/lib/ads/marketing.ts` and must not be broken here.
- **`adSpend` is optional on `MetricsInput`.** Absent means marketing is 0 and net profit is exactly what it was, so every existing caller and test keeps working untouched.
- **Never run the dev server piped to another command** (e.g. `| head`) - it wedges the process and holds port 3000.
- Test runner is `npx vitest run <path>` for a single file, `npm test` for the suite. Integration tests need `npm run db:seed` to have been run against the local test database.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

### Task 1: `marketing` becomes a figure the engine computes

**Files:**
- Modify: `src/lib/metrics/types.ts` (add `EngineAdSpend`; add `marketing` to `Figures` and `ZERO_FIGURES`)
- Modify: `src/lib/metrics/engine.ts` (add `adSpend` to `MetricsInput`; sum it; subtract it from `netProfit`; add it to `totalOf`)
- Test: `src/lib/metrics/engine.test.ts` (new `describe` block appended)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type EngineAdSpend = { shopId: string; date: Date; spend: number; currency: string }` exported from `src/lib/metrics/types.ts`
  - `Figures.marketing: number`
  - `MetricsInput.adSpend?: EngineAdSpend[]`

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to the end of `src/lib/metrics/engine.test.ts`. Add `EngineAdSpend` to the existing type-only import at the top of the file:

```ts
import type { CostBook, EngineAdSpend, EngineExpense, EngineOrder, EngineShop } from './types'
```

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/metrics/engine.test.ts`

Expected: FAIL - TypeScript rejects `EngineAdSpend` (not exported) and `adSpend` (not a property of `MetricsInput`), and `res.total.marketing` is `undefined`.

- [ ] **Step 3: Add the types**

In `src/lib/metrics/types.ts`, add this type after `EngineExpense`:

```ts
/**
 * One day of one ad account's spend, in the ACCOUNT's own billing currency -
 * which need not be its shop's: a Norwegian store can run a EUR ad account.
 * `date` is plain UTC midnight, the way Meta and Google report a day.
 */
export type EngineAdSpend = {
  shopId: string
  date: Date
  spend: number
  currency: string
}
```

In the same file, add one field to `Figures`, between `cogs` and `operationalExpenses`:

```ts
  cogs: number // product cost + handling combined
  marketing: number // Meta and Google ad spend, at each day's own rate
  operationalExpenses: number
```

And the matching entry in `ZERO_FIGURES`, in the same position:

```ts
  cogs: 0,
  marketing: 0,
  operationalExpenses: 0,
```

- [ ] **Step 4: Sum the spend in the engine**

In `src/lib/metrics/engine.ts`:

Add `EngineAdSpend` to the existing type import block from `./types`.

Add the field to `MetricsInput`, after `processingFee`:

```ts
  /**
   * One row per ad account per day. Absent means no ads ran (or the caller does
   * not care), which makes marketing 0 and leaves net profit exactly as it was.
   */
  adSpend?: EngineAdSpend[]
```

Add this helper beside `fulfillmentOn`:

```ts
/**
 * Ad spend is dated by plain UTC day, the way the platforms report it - unlike
 * an order, which belongs to its shop's own calendar day.
 */
function spendInRange(date: Date, from: Date, to: Date): boolean {
  const d = utcDay(date).getTime()
  return d >= utcDay(from).getTime() && d <= utcDay(to).getTime()
}
```

In `computeMetrics`, immediately before `const byShop: ShopFigures[] = shops.map(...)`:

```ts
  // Grouped once, not per shop per day: dailySeries calls this function for
  // every day in the range over these same rows, so a filter nested inside the
  // shop loop is shops x rows x days of work for one number.
  const spendByShop = new Map<string, EngineAdSpend[]>()
  for (const row of input.adSpend ?? []) {
    const list = spendByShop.get(row.shopId)
    if (list) list.push(row)
    else spendByShop.set(row.shopId, [row])
  }
```

Inside the `shops.map` callback, after the `transactionFees` block and before `const netRevenue = ...`:

```ts
    // Ad spend converts at ITS OWN day's rate, exactly as an order does, so a
    // rate move never rewrites last month's marketing cost. crossConvert, not
    // convert, because an account can bill in a currency that is neither the
    // shop's nor USD - and because buildMarketing converts the same rows the
    // same way, which is what keeps this page and the Marketing page agreeing.
    const marketing = sum(
      (spendByShop.get(shop.id) ?? [])
        .filter((r) => spendInRange(r.date, from, to))
        .map((r) => crossConvert(r.spend, r.currency, displayCurrency, r.date, rates)),
    )
```

Change `netProfit`:

```ts
    const netProfit =
      netRevenue - cogs - fulfillment - transactionFees - marketing - operationalExpenses - commission
```

Add `marketing` to the returned object, after `cogs`:

```ts
      cogs,
      marketing,
      fulfillment,
```

In `totalOf`, add it in the same relative position:

```ts
    cogs: add((r) => r.cogs),
    marketing: add((r) => r.marketing),
    operationalExpenses: add((r) => r.operationalExpenses),
```

Update the formula in the `computeMetrics` doc comment:

```
 *   net profit   = net revenue - cogs - fulfillment - fees - marketing - operational expenses - commission
```

and add a line to the same comment block, after the `fees` line:

```
 *   marketing    = Meta + Google spend, at each day's own rate
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/metrics/engine.test.ts`
Expected: PASS - all seven new cases plus every pre-existing case in the file.

- [ ] **Step 6: Run the whole suite - nothing else may move**

Run: `npm test`

Expected: PASS. Every other test constructs figures via `...ZERO_FIGURES` or passes no `adSpend`, so marketing is 0 and no profit assertion anywhere changes. If a test fails on a net-profit figure, something in Step 4 is subtracting spend that was never supplied - fix that rather than editing the assertion.

- [ ] **Step 7: Commit**

```bash
git add src/lib/metrics/types.ts src/lib/metrics/engine.ts src/lib/metrics/engine.test.ts
git commit -m "feat: charge Meta and Google spend to net profit

Marketing was the largest cost in the business and the only one missing
from the engine, so every profit figure on the dashboard was overstated
by whatever the ads cost. Spend converts at its own day's rate, like an
order does, so a rate move never rewrites last month.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: the Trend chart's daily profit carries the day's own spend

**Files:**
- Test: `src/lib/metrics/trend.test.ts` (one case appended to the existing `dailySeries` describe)

**Interfaces:**
- Consumes: `MetricsInput.adSpend` and `Figures.marketing` from Task 1.
- Produces: nothing new. This task is a guarantee, not a feature.

This task adds **no implementation code**. Task 1 put the date filtering inside the engine precisely so that `dailySeries` - which calls `computeMetrics({ ...input, orders: <that day's> })` with `from = to = day` - picks the right day's spend by itself. This test is what proves that, and what fails if a later change moves the filtering out to the callers.

- [ ] **Step 1: Write the failing test**

Append to the `describe('dailySeries', ...)` block in `src/lib/metrics/trend.test.ts`, after `'computes profit per day, costs included'`:

```ts
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
```

Add `computeMetrics` to the imports at the top of the file:

```ts
import { computeMetrics } from './engine'
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/lib/metrics/trend.test.ts`

Expected: PASS immediately, with no implementation change. Task 1's engine-side range filter is what makes this true.

If either case FAILS, the bug is in Task 1, not here - the spend is being summed over the whole range on every day, or not at all. Fix `spendInRange` / the `spendByShop` grouping in `src/lib/metrics/engine.ts` rather than weakening the test.

- [ ] **Step 3: Commit**

```bash
git add src/lib/metrics/trend.test.ts
git commit -m "test: the trend chart's daily profit carries that day's ad spend

The chart sits above the table, so a day's point and the Net profit
column must not be able to disagree. Locks the date filtering inside
the engine, where dailySeries gets it for free.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: the loader supplies the ad spend

**Files:**
- Modify: `src/lib/data/load.ts`
- Test: `src/lib/data/load.integration.test.ts` (three cases appended to the `loadMetricsInput and B2B orders` describe)

**Interfaces:**
- Consumes: `EngineAdSpend` from Task 1.
- Produces: `loadMetricsInput` now returns `adSpend: EngineAdSpend[]` on its `MetricsInput`, and includes every ad-account currency in the set passed to `ensureRates`.

- [ ] **Step 1: Write the failing tests**

Append these three cases inside the existing `describe('loadMetricsInput and B2B orders', ...)` block in `src/lib/data/load.integration.test.ts`. Its `afterEach` already deletes `[load-test]` shops, and `AdAccount.shop` / `AdSpend.account` both cascade on delete, so the accounts and their spend go with the shop - no new cleanup is needed.

```ts
  it('loads a shop’s ad spend, in the ACCOUNT’s currency and not the shop’s', async () => {
    // A NOK shop running a EUR ad account. Reading the spend as NOK would be a
    // tenfold error in the largest cost line on the dashboard.
    const shop = await db.shop.create({
      data: { name: 'Ad spend [load-test]', currency: 'NOK' },
    })
    const account = await db.adAccount.create({
      data: {
        shopId: shop.id, provider: 'meta', externalId: 'load-test-ads-1',
        name: 'Ads [load-test]', currency: 'EUR',
      },
    })
    await db.adSpend.create({
      data: {
        accountId: account.id, date: new Date('2026-07-01T00:00:00Z'),
        spend: 5000, impressions: 100, clicks: 10,
      },
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(input.adSpend).toEqual([
      { shopId: shop.id, date: new Date('2026-07-01T00:00:00Z'), spend: 5000, currency: 'EUR' },
    ])
  })

  it('does not load ad spend from outside the range', async () => {
    const shop = await db.shop.create({
      data: { name: 'Ad range [load-test]', currency: 'NOK' },
    })
    const account = await db.adAccount.create({
      data: {
        shopId: shop.id, provider: 'google', externalId: 'load-test-ads-2',
        name: 'Ads [load-test]', currency: 'NOK',
      },
    })
    await db.adSpend.createMany({
      data: [
        { accountId: account.id, date: new Date('2026-06-30T00:00:00Z'), spend: 1000, impressions: 1, clicks: 0 },
        { accountId: account.id, date: new Date('2026-07-01T00:00:00Z'), spend: 2000, impressions: 1, clicks: 0 },
        { accountId: account.id, date: new Date('2026-07-02T00:00:00Z'), spend: 4000, impressions: 1, clicks: 0 },
      ],
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(input.adSpend?.map((r) => r.spend)).toEqual([2000])
  })

  it('fetches rates for an ad account’s currency, which no shop need trade in', async () => {
    // A lone NOK shop needs no consolidation, so nothing else would ask for a
    // rate - and its EUR ad spend would then convert on whatever stale rate
    // happened to be lying around.
    const shop = await db.shop.create({
      data: { name: 'Ad FX [load-test]', currency: 'NOK' },
    })
    await db.adAccount.create({
      data: {
        shopId: shop.id, provider: 'meta', externalId: 'load-test-ads-3',
        name: 'Ads [load-test]', currency: 'EUR',
      },
    })

    await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(ensureRates).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ensureRates).mock.calls[0][2]).toEqual(expect.arrayContaining(['NOK', 'EUR']))
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/data/load.integration.test.ts`

Expected: FAIL - `input.adSpend` is `undefined` in the first two, and `ensureRates` is never called in the third (one NOK shop alone puts a single currency in play).

If the whole file errors on connection, run `npm run db:seed` first: these tests need the local seeded database.

- [ ] **Step 3: Load the rows**

In `src/lib/data/load.ts`, add `EngineAdSpend` to the existing type-only import from `../metrics/types`:

```ts
import type { CostBook, EngineAdSpend, EngineExpense, EngineOrder, EngineShop, Recurrence } from '../metrics/types'
```

Insert this block after the `fulfillmentRates` loop and before `const feeRow = ...`:

```ts
  // Ad spend, so the engine can charge marketing to profit. The account carries
  // the shop and the billing currency; the spend row carries only a day and an
  // amount, so the two are joined in memory the way ambassador rates are.
  const adAccounts = await db.adAccount.findMany({
    where: { active: true, shopId: { in: shopIds } },
    select: { id: true, shopId: true, currency: true },
  })
  const accountById = new Map(adAccounts.map((a) => [a.id, a]))
  const spendRows = adAccounts.length
    ? await db.adSpend.findMany({
        // Platforms report a plain UTC day, so the window is a UTC day window -
        // the same one /api/marketing uses, so the two screens see the same rows.
        where: {
          accountId: { in: adAccounts.map((a) => a.id) },
          date: { gte: utcDay(from), lte: utcDay(to) },
        },
        select: { accountId: true, date: true, spend: true },
        orderBy: { date: 'asc' },
      })
    : []
  const adSpend: EngineAdSpend[] = spendRows.map((r) => {
    const account = accountById.get(r.accountId)!
    return { shopId: account.shopId, date: r.date, spend: r.spend, currency: account.currency }
  })
```

Add the ad-account currencies to the `inPlay` set:

```ts
  const inPlay = new Set([
    displayCurrency,
    ...shops.map((s) => s.currency),
    ...orders.map((o) => o.currency),
    ...expenses.map((e) => e.currency),
    // An ad account can bill in a currency no shop trades in, and its spend is
    // now a cost against profit - an unfetched rate is real money mis-stated.
    ...adAccounts.map((a) => a.currency),
    ...(processingFee ? [processingFee.currency] : []),
  ])
```

Add `adSpend` to the returned object, after `expenses`:

```ts
    shops,
    orders,
    expenses,
    adSpend,
    costs,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/data/load.integration.test.ts`
Expected: PASS - the three new cases and every pre-existing one in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/load.ts src/lib/data/load.integration.test.ts
git commit -m "feat: load ad spend alongside the orders it has to be paid out of

The account holds the shop and the billing currency, the spend row holds
the day and the amount; joined in memory, they become the engine's
marketing input. Ad-account currencies join the rate top-up, because an
account can bill in a currency no shop trades in.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: one rate table, so the two screens cannot disagree

**Files:**
- Modify: `src/app/api/marketing/route.ts:43-53` (delete the local rate top-up, use `input.rates`)

**Interfaces:**
- Consumes: the `inPlay` change from Task 3 - `loadMetricsInput` now guarantees rates for every ad-account currency in scope.
- Produces: nothing new.

- [ ] **Step 1: Delete the duplicate rate top-up**

In `src/app/api/marketing/route.ts`, delete this whole block:

```ts
    // An ad account may bill in a currency no shop trades in; top up its rates
    // before converting. Best-effort: convert() falls back to the nearest
    // earlier rate, so a provider outage only makes figures approximate.
    const extra = [...new Set(accounts.map((a) => a.currency))].filter(
      (c) => c !== input.displayCurrency,
    )
    if (extra.length) {
      try {
        await ensureRates(from, to, extra)
      } catch {
        // Rates stay as they were.
      }
    }
    const rates = extra.length ? buildRateTable(await loadRates()) : input.rates
```

and replace it with:

```ts
    // loadMetricsInput already tops up every ad-account currency in scope - it
    // has to, because that spend is now a cost against profit. Reusing its rate
    // table is what stops this page and the dashboard quoting different money
    // for the same spend.
    const rates = input.rates
```

Then delete the three imports that block was the only user of:

```ts
import { buildRateTable } from '@/lib/metrics/fx'
import { ensureRates, loadRates } from '@/lib/fx/rates'
```

- [ ] **Step 2: Verify the route still compiles and its tests pass**

Run: `npx vitest run src/app/api/marketing/route.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no output. A leftover unused import fails `npm run lint` in CI, so if `rates` or an import is now unused, remove it.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors for `src/app/api/marketing/route.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/marketing/route.ts
git commit -m "refactor: one rate table behind marketing spend

The loader now tops up ad-account currencies itself, so the route's own
ensureRates and rate-table build were a second code path to the same
number. Two paths mean the Marketing page and the dashboard can drift on
what the same spend was worth.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: the Compare table - Fulfillment moves up, Marketing and ROAS arrive, Shipping and Net revenue go

**Files:**
- Modify: `src/components/dashboard/CompareTable.tsx`
- Test: `src/components/dashboard/CompareTable.test.tsx`

**Interfaces:**
- Consumes: `Figures.marketing` from Task 1, supplied end to end by Task 3.
- Produces: nothing other tasks depend on. This is the last task.

The column order this produces:

```
Orders · Gross revenue · Discounts · Net sales · Fulfillment · VAT ·
Transaction fees · COGS · Marketing · Op. expenses · ROAS · Commission ·
Net profit · Margin
```

- [ ] **Step 1: Update the fixture and write the failing tests**

In `src/components/dashboard/CompareTable.test.tsx`, add `marketing` to the `row` fixture and lower its profit to match - marketing is a cost now, and a fixture whose profit ignores it would be teaching the reader something false:

```ts
const row: ShopFigures = {
  ...ZERO_FIGURES,
  shopId: 's1',
  shopName: 'Panetti Norway',
  orders: 2,
  grossSales: 100000,
  discounts: 10000,
  netSales: 90000,
  shippingCharged: 5000,
  taxes: 23750, // 25% of net revenue
  netRevenue: 95000,
  grossRevenue: 118750, // net revenue + VAT = what the customer paid
  cogs: 24795, // 26.10% of net revenue
  marketing: 25000, // 250.00 kr of ads -> 118,750 / 25,000 = 4.75x
  netProfit: 45205, // 95000 net revenue - 24795 cogs - 25000 marketing
  netMargin: 45205 / 95000,
}
```

Replace the header list inside the existing first test (`'shows Gross revenue right after Orders - what the customer actually paid'`) and add the two absence checks to it:

```ts
    for (const label of [
      'Orders', 'Gross revenue', 'Discounts', 'Net sales', 'Fulfillment', 'VAT',
      'Transaction fees', 'COGS', 'Marketing', 'Op. expenses', 'ROAS', 'Commission',
      'Net profit', 'Margin',
    ]) {
      expect(screen.getByRole('button', { name: `Sort by ${label}` })).toBeTruthy()
    }

    // Shipping charged is zero in every shop and every period - these shops
    // ship free, and what shipping COSTS is already under Fulfillment. Net
    // revenue is net sales plus that zero, so it printed the same money twice.
    for (const gone of ['Shipping', 'Net revenue']) {
      expect(screen.queryByRole('button', { name: `Sort by ${gone}` })).toBeNull()
      expect(screen.queryByRole('checkbox', { name: gone })).toBeNull()
    }
```

Then append these four new cases to the `describe('CompareTable', ...)` block:

```ts
  it('shows Marketing as a cost, with total spend in the Total row', () => {
    render(<CompareTable result={result} />)

    // The shop row and the identical Total both carry it.
    const spend = formatMoney(25000, 'NOK')
    expect(screen.getAllByText((_t, el) => el?.textContent === spend).length).toBe(2)
  })

  it('shows ROAS as gross revenue over ad spend, blended in the Total', () => {
    render(<CompareTable result={result} />)

    // 118,750 / 25,000 = 4.75x. The Total row is the blended figure by
    // construction: it is all gross revenue over all spend.
    expect(screen.getAllByText('4.75×').length).toBe(2)
  })

  it('dashes ROAS when no ads ran - never 0.00×', () => {
    render(<CompareTable result={result} />)

    const idleRow = screen.getByText('Mazzetti Denmark').closest('tr')!
    expect(idleRow.textContent).toContain('-')
    expect(idleRow.textContent).not.toContain('0.00×')
  })

  it('shows 0.00× when the ads ran and nothing sold - that is a true answer', () => {
    const burned: ShopFigures = {
      ...ZERO_FIGURES,
      shopId: 's3',
      shopName: 'Panetti Germany',
      marketing: 12000,
      netProfit: -12000,
    }
    render(<CompareTable result={{ ...result, byShop: [burned] }} />)

    expect(screen.getByText('0.00×')).toBeTruthy()
  })

  it('ranks by ROAS with the dashes behind, not in front', () => {
    // A shop with the highest profit and no ads at all: if a missing ROAS
    // sorted as 0, or as NaN leaving the order untouched, it would stay on top
    // of a ROAS ranking it does not belong in.
    const rich: ShopFigures = {
      ...ZERO_FIGURES,
      shopId: 's3',
      shopName: 'Mazzetti Norway',
      grossRevenue: 900000,
      netProfit: 500000,
    }
    render(<CompareTable result={{ ...result, byShop: [rich, row, idle] }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sort by ROAS' }))

    const names = screen.getAllByRole('row').slice(1).map((tr) => tr.firstElementChild?.textContent)
    expect(names[0]).toBe('Panetti Norway')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/dashboard/CompareTable.test.tsx`

Expected: FAIL - no `Sort by Marketing` or `Sort by ROAS` button exists, `Sort by Shipping` and `Sort by Net revenue` still do, and `4.75×` is nowhere on the page.

- [ ] **Step 3: Rework the columns and the row type**

In `src/components/dashboard/CompareTable.tsx`:

Widen the import to bring in `Figures`:

```ts
import type { EngineResult, Figures, ShopFigures } from '@/lib/metrics/types'
```

Add the row type and the derivation above `type Column`:

```ts
/** A shop row plus the one figure this table derives rather than receives. */
type Row = ShopFigures & { roas: number | null }

/**
 * Gross revenue per unit of ad spend. Derived here, not in the engine, because
 * it is a ratio of two figures already on the row - and because the footer IS
 * the totals row, which makes its cell the blended ROAS for free: all gross
 * revenue over all spend. No spend is not "0.00x", it is nothing to divide by,
 * so it prints a dash; spend with nothing sold really is 0.00x, and prints.
 */
function withRoas<T extends Figures>(figures: T): T & { roas: number | null } {
  return { ...figures, roas: figures.marketing > 0 ? figures.grossRevenue / figures.marketing : null }
}
```

Change `Column` to key off `Row` and know about the new format:

```ts
type Column = {
  key: keyof Row
  label: string
  hint?: string
  money?: boolean
  percent?: boolean
  roas?: boolean // "4.75×" - and a dash where there is nothing to divide by
  tone?: boolean // colour by sign
  shareOfNetRevenue?: boolean // append "(26.10%)" - this figure as a share of the row's net revenue
}
```

Replace `COLUMNS` entirely:

```ts
const COLUMNS: Column[] = [
  { key: 'orders', label: 'Orders' },
  { key: 'grossRevenue', label: 'Gross revenue', money: true, hint: 'What customers actually paid: net revenue + VAT (Nordic "brutto")' },
  { key: 'discounts', label: 'Discounts', money: true, hint: 'Coupon and code discounts, excl. VAT' },
  { key: 'netSales', label: 'Net sales', money: true, hint: 'After discounts - the commission base, excl. VAT' },
  { key: 'fulfillment', label: 'Fulfillment', money: true, hint: 'What shipping actually cost us: the per-order rate from Settings, or a B2B order’s own shipping cost' },
  { key: 'taxes', label: 'VAT', money: true, hint: 'VAT collected (25% NO/SE/DK, 25.5% FI, 19% DE) - remitted to the tax office, never income or cost' },
  { key: 'transactionFees', label: 'Transaction fees', money: true, hint: 'Payment gateway: % of the charged total + fixed part' },
  { key: 'cogs', label: 'COGS', money: true, shareOfNetRevenue: true, hint: 'Product cost + handling, and its share of net revenue' },
  { key: 'marketing', label: 'Marketing', money: true, hint: 'Meta and Google ad spend, converted at each day’s own rate' },
  { key: 'operationalExpenses', label: 'Op. expenses', money: true },
  { key: 'roas', label: 'ROAS', roas: true, hint: 'Gross revenue per unit of ad spend. The Total row is the blended figure: all gross revenue over all spend.' },
  { key: 'commission', label: 'Commission', money: true },
  { key: 'netProfit', label: 'Net profit', money: true, tone: true },
  { key: 'netMargin', label: 'Margin', percent: true, tone: true },
]
```

Note what is deliberately absent: `shippingCharged` and `netRevenue`. `useVisibleColumns` already drops saved keys that match no column, so a browser holding either of them in `localStorage['compare-columns']` needs no migration - and `marketing` and `roas` are in nobody's saved hidden list, so they arrive ticked.

- [ ] **Step 4: Teach the cell to print a ratio and a dash**

Replace the `Cell` component in the same file:

```ts
function Cell({
  column,
  row,
  currency,
  stripe,
}: {
  column: Column
  row: Row
  currency: string
  stripe: string
}) {
  const value = row[column.key] as number | null

  // A ratio with nothing to divide by is not a number, and printing one would
  // lie. The dash is muted so a column of them reads as absence, not as data.
  if (value === null) {
    return <td className={`num px-4 py-2.5 text-right text-faint ${stripe}`}>-</td>
  }

  // "$3,843.74 (26.10%)" - the share only exists when there is revenue to share.
  const share =
    column.shareOfNetRevenue && row.netRevenue > 0
      ? ` (${((value / row.netRevenue) * 100).toFixed(2)}%)`
      : ''

  const text = column.money
    ? formatMoney(value, currency) + share
    : column.roas
      ? `${value.toFixed(2)}×`
      : column.percent
        ? `${(value * 100).toFixed(1)}%`
        : value.toLocaleString('en-US')

  const tone = !column.tone ? 'text-ink' : value < 0 ? 'text-loss' : 'text-gain'
  const weight = column.key === 'netProfit' ? 'font-semibold' : ''

  return <td className={`num px-4 py-2.5 text-right ${tone} ${weight} ${stripe}`}>{text}</td>
}
```

- [ ] **Step 5: Derive the rows and sort the dashes last**

In the `CompareTable` component, change the sort state and the row construction:

```ts
  const [sortBy, setSortBy] = useState<keyof Row>('netProfit')
```

```ts
  const rows = result.byShop.map(withRoas).sort((a, b) => {
    // A missing ROAS sorts to the bottom of a descending ranking rather than
    // poisoning the comparator with NaN, which would leave the order untouched
    // and make the click look broken.
    const x = a[sortBy] ?? Number.NEGATIVE_INFINITY
    const y = b[sortBy] ?? Number.NEGATIVE_INFINITY
    return desc ? Number(y) - Number(x) : Number(x) - Number(y)
  })
```

(`.map()` already returns a fresh array, so the previous `[...result.byShop]` copy is no longer needed - sorting in place here is safe.)

```ts
  function sort(key: keyof Row) {
```

And the footer's row, replacing the inline object in the `<tfoot>` `Cell`:

```ts
              {columns.map((column, i) => (
                <Cell
                  key={column.key}
                  column={column}
                  row={withRoas({ ...result.total, shopId: 'total', shopName: 'Total' })}
                  currency={currency}
                  stripe={stripeOf(i)}
                />
              ))}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/dashboard/CompareTable.test.tsx`
Expected: PASS - all nine cases in the file.

- [ ] **Step 7: Run the whole suite and the type check**

Run: `npm test`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 8: Verify the dashboard end to end**

The existing `e2e/admin.spec.ts` asserts `getByText('Net revenue')` is visible. Playwright's string matching is case-insensitive substring, so the top strip's `NET REVENUE` tile - which stays, because there is no Net sales tile up there to duplicate it - still satisfies it. Confirm rather than assume:

Run: `npx playwright test e2e/admin.spec.ts`

Expected: PASS. Playwright starts its own dev server (`webServer` in `playwright.config.ts`, `reuseExistingServer: true`), so no server needs starting by hand. If it fails on the `Net revenue` line, change that assertion to `page.getByTestId('stat-net-revenue')` - the tile, named unambiguously - rather than removing it.

- [ ] **Step 9: Commit**

```bash
git add src/components/dashboard/CompareTable.tsx src/components/dashboard/CompareTable.test.tsx
git commit -m "feat: Marketing and ROAS in the Compare table, Shipping and Net revenue out

Shipping charged read zero for every shop in every period - these shops
ship free, and what shipping COSTS was already under Fulfillment, which
now takes its place. Net revenue was net sales plus that zero, so the
table printed the same money twice.

In their place: Marketing, the Meta and Google spend now deducted from
profit, and ROAS beside Op. expenses. The footer is the totals row, so
its ROAS cell is the blended figure without a second calculation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Read the live operational expenses before this ships**

The spec's first risk. Any Meta or Google spend currently entered under Settings → Expenses is counted twice from this commit onward.

Run:

```bash
npx tsx --env-file=.env -e "import { db } from './src/lib/db'; db.operationalExpense.findMany({ select: { label: true, category: true, amount: true, currency: true, shop: { select: { name: true } } } }).then((r) => { console.table(r.map((e) => ({ shop: e.shop.name, label: e.label, category: e.category, amount: e.amount, currency: e.currency }))); return db.\$disconnect() })"
```

Read the `label` and `category` of every row for anything meaning ads - "Meta", "Facebook", "Google", "Ads", "Marketing", "Annonser", "Markedsføring". Report what you find to the user with the shop and the amount. **Do not delete anything.** It is their bookkeeping; removal is their call, and this step exists to give them the list to decide from.

---

## Verification

After Task 5, the whole change is verifiable in one pass:

- `npm test` - the full unit and integration suite.
- `npx tsc --noEmit` - no type errors.
- `npm run lint` - no lint errors.
- `npx playwright test` - the full e2e suite.
- `npm run dev`, then open `/dashboard`: the Compare table reads Orders · Gross revenue · Discounts · Net sales · Fulfillment · VAT · Transaction fees · COGS · Marketing · Op. expenses · ROAS · Commission · Net profit · Margin. Net profit is lower than before by the marketing total. The Total row's ROAS equals total gross revenue ÷ total marketing. Cross-check that marketing total against the AD SPEND tile on `/marketing` for the same period and shop filter - they must be identical to the cent.

Then tell the user, before they open it themselves: profit on the dashboard is now lower, by exactly the marketing total, and that is the correction landing rather than a bug. Give them the two figures - the old profit and the marketing total - so the difference explains itself.

## Out of scope

- A blended ROAS tile in the top strip. The Total row carries the number.
- Marketing or ROAS as lines on the Trend chart. Profit already moves with spend.
- Attributing spend to individual orders or ambassadors.
