# Marketing trend gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining gaps between our Marketing page and the client's BeProfit reference: ROAS and POAS on the trend, a Daily/Weekly/Monthly toggle, a page-level Ad Platform filter, and a Refresh button.

**Architecture:** The platform filter is a server concern because it changes spend on every row and every ratio derived from it - `buildMarketing` takes a `platform` argument, filters accounts itself, and derives from that same argument whether the whole-store ratios (`roas`, `cpa`) may be computed at all. Granularity is a client concern because bucketing sums numbers and divides, contradicting no server figure; it lives in a pure helper consumed by `MarketingChart`. The refresh button reuses the existing `POST /api/ads/sync` route and the existing handler pattern from `AdAccountsClient`.

**Tech Stack:** Next.js App Router, TypeScript, Prisma, Recharts, Vitest + Testing Library (jsdom), Tailwind with CSS custom properties.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-marketing-chart-and-filter-design.md`
- Money is **minor units** (integers) everywhere. Ratios are floats or `null`.
- **A ratio with no honest denominator is `null`, never `0`, `Infinity` or `NaN`.** It renders as `-`.
- **POAS is `netProfit / spend`** - profit after ad spend, over ad spend. Breakeven is 0.
- Weekly buckets are **ISO weeks, Monday start**. Monthly buckets are calendar months.
- **Bucket ratios are summed-then-divided, never the mean of daily ratios.**
- Run a single test file with `npx vitest run <path>`, and one test with `-t '<name>'`. Full suite is `npm run test`. Lint is `npm run lint`.
- Component tests need `// @vitest-environment jsdom` as line 1.
- Do not assert on Recharts SVG paths - they need a measured container and will fail under jsdom. Assert on headings, legends and controls, which render outside `ResponsiveContainer`.
- Never run `git stash`, `git checkout --`, `git reset --hard`, or `git restore`. If a working tree looks wrong, stop and report.

---

### Task 1: Carry net profit down the marketing series

POAS needs per-day profit. `dailySeries` already computes `netProfit` on each `SeriesPoint`; it is simply not copied across into `MarketingSeriesPoint`.

**Files:**
- Modify: `src/lib/ads/marketing.ts` (type at ~line 88, series map at ~line 291)
- Test: `src/lib/ads/marketing.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MarketingSeriesPoint` gains `netProfit: number`. Tasks 4 and 5 rely on it.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/ads/marketing.test.ts`, inside the existing `describe('per-platform series', ...)` block:

```ts
  it('carries whole-store net profit down the daily series, for POAS', () => {
    const result = buildMarketing({
      accounts,
      spend,
      engine,
      series: [{ date: '2026-07-01', grossRevenue: 500_00, netRevenue: 300_00, netProfit: 120_00 }],
      rates,
      to: TO,
    })

    expect(result.series[0].netProfit).toBe(120_00)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ads/marketing.test.ts -t 'net profit'`
Expected: FAIL - `expected undefined to be 12000`

- [ ] **Step 3: Write minimal implementation**

In `src/lib/ads/marketing.ts`, add the field to the type:

```ts
export type MarketingSeriesPoint = {
  date: string
  spend: number
  grossRevenue: number
  /** Whole-store, already net of ad spend (engine.ts). POAS divides by spend. */
  netProfit: number
  metaSpend: number
  googleSpend: number
}
```

And one line in the series map at the bottom of `buildMarketing`:

```ts
  const series = args.series.map((p) => ({
    date: p.date,
    spend: byDay.get(p.date) ?? 0,
    grossRevenue: p.grossRevenue,
    netProfit: p.netProfit,
    metaSpend: platformByDay.get(p.date)?.meta ?? 0,
    googleSpend: platformByDay.get(p.date)?.google ?? 0,
  }))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ads/marketing.test.ts`
Expected: PASS, all tests in the file. TypeScript will now flag any other place constructing a `MarketingSeriesPoint` - fix those by adding `netProfit` (test fixtures get `netProfit: 0`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/marketing.ts src/lib/ads/marketing.test.ts
git commit -m "feat(marketing): carry net profit onto the series, so POAS can be drawn"
```

---

### Task 2: Platform filter, and the two ratios that cannot survive it

`roas` and `cpa` divide whole-store revenue and orders by spend. Narrow spend to one platform and they do not narrow - they inflate. This task adds the filter and dashes those two out whenever it is active.

**Files:**
- Modify: `src/lib/ads/marketing.ts` (`ratios` at ~line 120, `buildMarketing` signature and body)
- Test: `src/lib/ads/marketing.test.ts`

**Interfaces:**
- Consumes: `MarketingSeriesPoint.netProfit` from Task 1.
- Produces: `buildMarketing` accepts `platform?: string | null`. Task 3 passes it.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `src/lib/ads/marketing.test.ts`:

```ts
describe('platform filter', () => {
  it('narrows spend and its ad-side metrics to one provider', () => {
    const all = buildMarketing({ accounts, spend, engine, series, rates, to: TO })
    const meta = buildMarketing({ accounts, spend, engine, series, rates, to: TO, platform: 'meta' })

    expect(meta.total.spend).toBeLessThan(all.total.spend)
    expect(meta.total.spend).toBe(all.total.metaSpend)
    expect(meta.total.googleSpend).toBe(0)
    expect(meta.byPlatform.map((p) => p.provider)).toEqual(['meta'])
  })

  it('dashes the whole-store ratios, because they would inflate not narrow', () => {
    const meta = buildMarketing({ accounts, spend, engine, series, rates, to: TO, platform: 'meta' })
    const shopA = meta.byShop.find((r) => r.shopId === 'shop-a')!

    expect(shopA.roas).toBeNull()
    expect(shopA.cpa).toBeNull()
    expect(meta.total.roas).toBeNull()
    expect(meta.total.cpa).toBeNull()

    // The store facts themselves are still true and stay on screen.
    expect(shopA.grossRevenue).toBe(500_00)
    expect(shopA.orders).toBe(10)
    // Platform-attributed ratios divide platform value by platform spend, so
    // they remain honest under the filter.
    expect(shopA.platformRoas).not.toBeNull()
  })

  it('still computes the whole-store ratios when no filter is active', () => {
    const all = buildMarketing({ accounts, spend, engine, series, rates, to: TO })
    const shopA = all.byShop.find((r) => r.shopId === 'shop-a')!

    expect(shopA.roas).not.toBeNull()
    expect(shopA.cpa).not.toBeNull()
    expect(all.total.roas).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ads/marketing.test.ts -t 'platform filter'`
Expected: FAIL - the first two fail because `platform` is ignored, so `meta.total.spend` equals the unfiltered total and `roas` is a number.

- [ ] **Step 3: Write the implementation**

In `src/lib/ads/marketing.ts`, give `ratios` the flag. Only two lines change inside it:

```ts
/**
 * A ratio with a zero denominator is not a number, and printing one would lie.
 *
 * `wholeStore` is false when a platform filter is active. `roas` and `cpa`
 * divide WHOLE-STORE revenue and orders by spend, so narrowing spend to one
 * platform does not narrow them - it inflates them. A 5.5x store ROAS would
 * read 7.5x for no reason but a dropdown. They dash instead.
 */
const ratios = (row: Ratioless, wholeStore = true): MarketingShopRow => ({
  ...row,
  roas: wholeStore && row.spend > 0 ? row.grossRevenue / row.spend : null,
  platformRoas: row.spend > 0 ? row.conversionValue / row.spend : null,
  cpa:
    wholeStore && row.spend > 0 && row.orders > 0 ? Math.round(row.spend / row.orders) : null,
  costPerPurchase:
    row.spend > 0 && row.conversions > 0 ? Math.round(row.spend / row.conversions) : null,
  avgPurchaseValue: row.conversions > 0 ? Math.round(row.conversionValue / row.conversions) : null,
  cpm: row.impressions > 0 ? Math.round((row.spend / row.impressions) * 1000) : null,
  cpc: row.spend > 0 && row.clicks > 0 ? Math.round(row.spend / row.clicks) : null,
  costPerLinkClick:
    row.spend > 0 && row.linkClicks > 0 ? Math.round(row.spend / row.linkClicks) : null,
  ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
  linkCtr: row.impressions > 0 ? row.linkClicks / row.impressions : null,
  holdRate: row.videoViews3s > 0 ? row.thruplays / row.videoViews3s : null,
})
```

Then the signature and the top of `buildMarketing`:

```ts
export function buildMarketing(args: {
  accounts: MarketingAccount[]
  spend: SpendRow[]
  engine: EngineResult
  series: SeriesPoint[]
  rates: RateTable
  /** Range end: a current setting like the budget converts at the current rate. */
  to: Date
  /** Only this provider's accounts count. Whole-store ratios dash out. */
  platform?: string | null
}): MarketingResult {
  const display = args.engine.displayCurrency

  // Filtered HERE rather than trusting the caller to have done it, because
  // `wholeStore` is derived from the same argument. A caller that filtered the
  // accounts but forgot the flag would publish inflated store ROAS; this way
  // the data and the flag cannot disagree.
  const accounts = args.platform
    ? args.accounts.filter((a) => a.provider === args.platform)
    : args.accounts
  const wholeStore = !args.platform

  const accountById = new Map(accounts.map((a) => [a.id, a]))
```

Change the budget loop to read the filtered list - it is the only other use of `args.accounts`:

```ts
  for (const account of accounts) {
```

Finally pass the flag at the two `ratios` call sites. In the `rows` map:

```ts
    return ratios(
      {
        shopId: shop.shopId,
        shopName: shop.shopName,
        dailyBudget: budgetByShop.get(shop.shopId) ?? null,
        ...acc,
        orders: shop.orders,
        grossRevenue: shop.grossRevenue,
      },
      wholeStore,
    )
```

And on `total`, as the second argument after the object literal:

```ts
  const total = ratios(
    {
      shopId: '',
      shopName: 'Total',
      // ...unchanged...
      orders: args.engine.total.orders,
      grossRevenue: args.engine.total.grossRevenue,
    },
    wholeStore,
  )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ads/marketing.test.ts`
Expected: PASS, including the pre-existing tests - the default `wholeStore = true` keeps every unfiltered caller unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/marketing.ts src/lib/ads/marketing.test.ts
git commit -m "feat(marketing): filter by platform, dashing the ratios it would inflate"
```

---

### Task 3: The platform parameter on /api/marketing

**Files:**
- Modify: `src/app/api/marketing/route.ts`
- Test: `src/app/api/marketing/route.test.ts`

**Interfaces:**
- Consumes: `buildMarketing({ ..., platform })` from Task 2.
- Produces: `GET /api/marketing?platform=meta`. 400 `{ error: 'Unknown ad platform' }` for an unrecognised value. Task 6's `PlatformFilter` sends it.

- [ ] **Step 1: Write the failing tests**

Open `src/app/api/marketing/route.test.ts` and follow the mocking style already established at the top of that file. Add:

```ts
  it('narrows every surface to one platform', async () => {
    const res = await GET(new Request('http://x/api/marketing?platform=meta'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.byPlatform.map((p: { provider: string }) => p.provider)).toEqual(['meta'])
    // The spend check panel describes the same accounts the totals do, or the
    // panel would "prove" a total that is not on screen.
    expect(
      body.spendCheck.accounts.every((a: { provider: string }) => a.provider === 'meta'),
    ).toBe(true)
  })

  it('refuses an unknown platform rather than answering with a plausible zero', async () => {
    const res = await GET(new Request('http://x/api/marketing?platform=tiktok'))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Unknown ad platform')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/marketing/route.test.ts -t 'platform'`
Expected: FAIL - the first returns both platforms, the second returns 200 with an empty result.

- [ ] **Step 3: Write the implementation**

In `src/app/api/marketing/route.ts`, read the parameter alongside the others:

```ts
    const shopIds = shopIdsFromQuery(params)
    const platform = params.get('platform')
```

After `accounts` is fetched (the `Promise.all` at ~line 43), validate and scope:

```ts
    // Validated against the providers actually connected. A typo must not read
    // as a legitimate zero - the same reason google.ts refuses to treat an
    // unparseable response as an empty one.
    if (platform && !accounts.some((a) => a.provider === platform)) {
      return NextResponse.json(
        { error: 'Unknown ad platform' },
        { status: 400, headers: NO_STORE },
      )
    }
    // One scoped list feeds every surface - totals, chart, tables and the
    // Spend Check panel - so the page cannot show two scopes at once.
    const scopedAccounts = platform
      ? accounts.filter((a) => a.provider === platform)
      : accounts
```

Then replace every later use of `accounts` with `scopedAccounts`, and pass `platform` to `buildMarketing`:

```ts
    const spend = await accountSpendRows(scopedAccounts.map((a) => a.id), scopeIds, from, to)

    const unassignedCampaigns = await unassignedCampaignCount(scopedAccounts.map((a) => a.id))

    const engine = computeMetrics(input)
    const result = buildMarketing({
      accounts: scopedAccounts,
      spend,
      engine,
      series: dailySeries(input),
      rates,
      to,
      platform,
    })
```

The inactive-accounts query for the panel is scoped the same way, or the panel
would list Google accounts on a Meta-filtered page:

```ts
    const inactiveAccounts = await db.adAccount.findMany({
      where: {
        active: false,
        shopId: { in: scopeIds },
        ...(platform ? { provider: platform } : {}),
      },
      select: {
        id: true, shopId: true, provider: true, currency: true, dailyBudget: true,
        name: true, active: true, lastSyncAt: true, lastError: true,
      },
    })
```

and the `buildSpendCheck` call takes the scoped list:

```ts
    const spendCheck = buildSpendCheck({
      accounts: [...scopedAccounts, ...inactiveWithSpend],
      spend: [...spend, ...inactiveSpend],
      rates,
      from,
      to,
      displayCurrency: result.displayCurrency,
      now,
    })
```

Leave `connectedCount` reading all active accounts: it answers "has this
workspace connected anything at all", which a filter must not change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/marketing/route.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/marketing/route.ts src/app/api/marketing/route.test.ts
git commit -m "feat(marketing): scope the whole response to one ad platform"
```

---

### Task 4: The bucketing helper

A pure function, in its own file, so the arithmetic can be tested without a chart. This is where the plan's most likely defect lives, so its test is written first and observed failing.

**Files:**
- Create: `src/lib/ads/series-buckets.ts`
- Test: `src/lib/ads/series-buckets.test.ts`

**Interfaces:**
- Consumes: `MarketingSeriesPoint` (with `netProfit`) from Task 1.
- Produces: `type Granularity = 'day' | 'week' | 'month'`, `bucketStart(date: string, g: Granularity): string`, `bucketSeries(series: MarketingSeriesPoint[], g: Granularity): SeriesBucket[]`. Task 5 consumes all three.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ads/series-buckets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bucketSeries, bucketStart } from './series-buckets'
import type { MarketingSeriesPoint } from './marketing'

const point = (over: Partial<MarketingSeriesPoint> & { date: string }): MarketingSeriesPoint => ({
  spend: 0,
  grossRevenue: 0,
  netProfit: 0,
  metaSpend: 0,
  googleSpend: 0,
  ...over,
})

describe('bucketStart', () => {
  it('leaves a day alone', () => {
    expect(bucketStart('2026-07-01', 'day')).toBe('2026-07-01')
  })

  it('snaps a week back to its Monday', () => {
    // 2026-07-01 is a Wednesday; 2026-07-05 the Sunday that closes that week.
    expect(bucketStart('2026-07-01', 'week')).toBe('2026-06-29')
    expect(bucketStart('2026-07-05', 'week')).toBe('2026-06-29')
    // 2026-07-06 is the next Monday and starts a new bucket.
    expect(bucketStart('2026-07-06', 'week')).toBe('2026-07-06')
  })

  it('snaps a month back to the first', () => {
    expect(bucketStart('2026-07-19', 'month')).toBe('2026-07-01')
  })
})

describe('bucketSeries', () => {
  it('sums the money in a week', () => {
    const out = bucketSeries(
      [
        point({ date: '2026-06-29', spend: 100_00, grossRevenue: 400_00, metaSpend: 100_00 }),
        point({ date: '2026-07-01', spend: 200_00, grossRevenue: 900_00, metaSpend: 150_00, googleSpend: 50_00 }),
      ],
      'week',
    )

    expect(out).toHaveLength(1)
    expect(out[0].date).toBe('2026-06-29')
    expect(out[0].spend).toBe(300_00)
    expect(out[0].grossRevenue).toBe(1300_00)
    expect(out[0].metaSpend).toBe(250_00)
    expect(out[0].endDate).toBe('2026-07-01')
  })

  it('divides the summed bucket, never averaging the daily ratios', () => {
    // Day one: 200 spend, 2000 revenue -> 10x. Day two: 20 000 spend, 40 000
    // revenue -> 2x. The mean of the ratios is 6x and describes no money that
    // was ever spent. Summed and divided: 42 000 / 20 200 = 2.079x.
    const out = bucketSeries(
      [
        point({ date: '2026-06-29', spend: 200_00, grossRevenue: 2_000_00, netProfit: 1_000_00 }),
        point({ date: '2026-06-30', spend: 20_000_00, grossRevenue: 40_000_00, netProfit: 4_000_00 }),
      ],
      'week',
    )

    expect(out[0].roas).toBeCloseTo(2.0792, 3)
    expect(out[0].roas).not.toBeCloseTo(6, 1)
    expect(out[0].poas).toBeCloseTo(0.2475, 3)
  })

  it('reports null rather than Infinity for a bucket that spent nothing', () => {
    const out = bucketSeries([point({ date: '2026-06-29', grossRevenue: 500_00 })], 'week')

    expect(out[0].roas).toBeNull()
    expect(out[0].poas).toBeNull()
  })

  it('splits on the calendar month boundary', () => {
    const out = bucketSeries(
      [
        point({ date: '2026-07-31', spend: 100_00 }),
        point({ date: '2026-08-01', spend: 200_00 }),
      ],
      'month',
    )

    expect(out.map((b) => b.date)).toEqual(['2026-07-01', '2026-08-01'])
    expect(out[1].spend).toBe(200_00)
  })

  it('keeps a partial bucket at the edge of the range', () => {
    // A range starting mid-week must not drop the days before its first Monday.
    const out = bucketSeries(
      [
        point({ date: '2026-07-03', spend: 100_00 }),
        point({ date: '2026-07-06', spend: 200_00 }),
      ],
      'week',
    )

    expect(out).toHaveLength(2)
    expect(out[0].spend).toBe(100_00)
  })

  it('returns days untouched and in order at day granularity', () => {
    const out = bucketSeries(
      [point({ date: '2026-07-02', spend: 50_00 }), point({ date: '2026-07-01', spend: 10_00 })],
      'day',
    )

    expect(out.map((b) => b.date)).toEqual(['2026-07-01', '2026-07-02'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ads/series-buckets.test.ts`
Expected: FAIL - `Cannot find module './series-buckets'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/ads/series-buckets.ts`:

```ts
import type { MarketingSeriesPoint } from './marketing'

/**
 * Rolling the daily series up into weeks or months, for the chart's
 * granularity toggle.
 *
 * This lives on the client side of the wire on purpose: it contradicts no
 * server figure, because no server figure reports a weekly ROAS. The totals in
 * the header remain the period totals whatever this does.
 */

export type Granularity = 'day' | 'week' | 'month'

export type SeriesBucket = MarketingSeriesPoint & {
  /** Inclusive last day this bucket actually carries, for the tooltip. */
  endDate: string
  roas: number | null
  poas: number | null
}

/** ISO weeks start on Monday; months on the 1st. */
export function bucketStart(date: string, granularity: Granularity): string {
  if (granularity === 'day') return date
  if (granularity === 'month') return date.slice(0, 8) + '01'

  const d = new Date(date + 'T00:00:00Z')
  const back = (d.getUTCDay() + 6) % 7 // Sunday is 0 in JS; Monday is 0 here
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

export function bucketSeries(
  series: MarketingSeriesPoint[],
  granularity: Granularity,
): SeriesBucket[] {
  const buckets = new Map<string, SeriesBucket>()

  for (const p of series) {
    const key = bucketStart(p.date, granularity)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.spend += p.spend
      bucket.grossRevenue += p.grossRevenue
      bucket.netProfit += p.netProfit
      bucket.metaSpend += p.metaSpend
      bucket.googleSpend += p.googleSpend
      if (p.date > bucket.endDate) bucket.endDate = p.date
    } else {
      // A bucket at either edge of the range is usually partial. It is kept as
      // it is: dropping it would take real spend off a chart whose whole job is
      // showing where the money went.
      buckets.set(key, { ...p, date: key, endDate: p.date, roas: null, poas: null })
    }
  }

  // Ratios come from the SUMMED bucket, never from averaging the days. A week
  // in which one day spent 200 and another 20 000 would otherwise weight the
  // two equally and report a ratio that happened on no day and to no money.
  return [...buckets.values()]
    .map((b) => ({
      ...b,
      roas: b.spend > 0 ? b.grossRevenue / b.spend : null,
      poas: b.spend > 0 ? b.netProfit / b.spend : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ads/series-buckets.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/series-buckets.ts src/lib/ads/series-buckets.test.ts
git commit -m "feat(marketing): roll the daily series into ISO weeks and months"
```

---

### Task 5: ROAS, POAS and the granularity toggle on the chart

**Files:**
- Modify: `src/components/marketing/MarketingChart.tsx`
- Modify: `src/app/globals.css` (chart series tokens, ~line 39-41)
- Test: `src/components/marketing/MarketingChart.test.tsx`

**Interfaces:**
- Consumes: `bucketSeries`, `type Granularity` from Task 4; `MarketingSeriesPoint.netProfit` from Task 1.
- Produces: `<MarketingChart series currency platformFiltered? />`. Task 6 passes `platformFiltered`.

- [ ] **Step 1: Write the failing tests**

Replace the fixture in `src/components/marketing/MarketingChart.test.tsx` (it now needs `netProfit`) and add the new cases:

```ts
const series = [
  { date: '2026-07-01', spend: 150_00, grossRevenue: 500_00, netProfit: 90_00, metaSpend: 100_00, googleSpend: 50_00 },
  { date: '2026-07-02', spend: 200_00, grossRevenue: 700_00, netProfit: 120_00, metaSpend: 120_00, googleSpend: 80_00 },
]
```

Then append inside the existing `describe('MarketingChart', ...)`:

```ts
  it('draws ROAS and POAS alongside the money', () => {
    render(<MarketingChart series={series} currency="NOK" />)

    expect(screen.getByText('ROAS')).toBeInTheDocument()
    expect(screen.getByText('POAS')).toBeInTheDocument()
  })

  it('drops ROAS and POAS when one platform is selected, and says why', () => {
    render(<MarketingChart series={series} currency="NOK" platformFiltered />)

    expect(screen.queryByText('ROAS')).not.toBeInTheDocument()
    expect(screen.queryByText('POAS')).not.toBeInTheDocument()
    expect(screen.getByText(/whole-store/i)).toBeInTheDocument()
  })

  it('offers day, week and month, starting on day', () => {
    render(<MarketingChart series={series} currency="NOK" />)

    expect(screen.getByRole('tab', { name: 'Day' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'Week' }))
    expect(screen.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'true')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/marketing/MarketingChart.test.tsx`
Expected: FAIL - no `ROAS` text, no `tab` roles.

- [ ] **Step 3: Write the implementation**

In `src/components/marketing/MarketingChart.tsx`, add imports and two colours:

```ts
import { useMemo, useState } from 'react'
import { bucketSeries, type Granularity } from '@/lib/ads/series-buckets'
```

The two ratio series need tokens. `globals.css` already groups the chart palette
under a `/* Chart series */` comment at ~line 39; add to that group, keeping the
hex convention its two neighbours use:

```css
  /* Chart series - validated for colour-blindness (see DESIGN.md) */
  --color-series-revenue: #2563a8;
  --color-series-profit: #1f7a55;
  --color-series-roas: #7c3aed;
  --color-series-poas: #1f2937;
```

DESIGN.md's rule is that "colour never carries meaning alone". These two lines
also carry distinct dash patterns and their own legend entries, so the rule
holds without relying on hue.

```ts
const ROAS = 'var(--color-series-roas)'
const POAS = 'var(--color-series-poas)'
```

Add the granularity control, mirroring the existing `PlatformSwitcher` idiom:

```tsx
const GRAINS: { id: Granularity; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

function GrainSwitcher({
  grain,
  onChange,
}: {
  grain: Granularity
  onChange: (next: Granularity) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Granularity"
      className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1"
    >
      {GRAINS.map((g) => (
        <button
          key={g.id}
          type="button"
          role="tab"
          aria-selected={grain === g.id}
          onClick={() => onChange(g.id)}
          className={`rounded-[var(--radius-control)] px-2.5 py-1 text-[12px] font-semibold transition-colors duration-150 ${
            grain === g.id ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-panel hover:text-ink'
          }`}
        >
          {g.label}
        </button>
      ))}
    </div>
  )
}
```

Widen the component's props and bucket the data:

```tsx
export function MarketingChart({
  series,
  currency,
  platformFiltered = false,
}: {
  series: MarketingSeriesPoint[]
  currency: string
  /** One platform is selected, so whole-store ratios have no honest denominator. */
  platformFiltered?: boolean
}) {
  const [byPlatform, setByPlatform] = useState(false)
  const [grain, setGrain] = useState<Granularity>('day')
  const data = useMemo(() => bucketSeries(series, grain), [series, grain])
  const hasSpend = series.some((p) => p.spend !== 0)
```

Add `GrainSwitcher` beside the existing `By platform` button, and extend the
legend so `ROAS` and `POAS` appear when they are drawn:

```tsx
          {!platformFiltered &&
            [
              { label: 'ROAS', color: ROAS },
              { label: 'POAS', color: POAS },
            ].map((s) => (
              <span key={s.label} className="flex items-center gap-1.5 text-muted">
                <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}

          <GrainSwitcher grain={grain} onChange={setGrain} />
```

Point the chart at `data`, add the right-hand axis, and give the money lines an
explicit `yAxisId` - Recharts requires every line to name its axis once a second
one exists:

```tsx
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
```

```tsx
            <YAxis
              yAxisId="money"
              tickFormatter={(v: number) => tickMoney(v, currency)}
              tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            {!platformFiltered && (
              <YAxis
                yAxisId="ratio"
                orientation="right"
                tickFormatter={(v: number) => `${v.toFixed(1)}×`}
                tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
                axisLine={false}
                tickLine={false}
                width={48}
              />
            )}
```

Add `yAxisId="money"` to each of the four existing `<Line>` elements, then the
two new ones after them:

```tsx
            {!platformFiltered && (
              <>
                <Line
                  yAxisId="ratio"
                  type="linear"
                  dataKey="roas"
                  name="ROAS"
                  stroke={ROAS}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={false}
                  // A bucket that spent nothing has no ratio; joining across the
                  // gap would draw a number that was never true.
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="ratio"
                  type="linear"
                  dataKey="poas"
                  name="POAS"
                  stroke={POAS}
                  strokeWidth={2}
                  strokeDasharray="2 3"
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </>
            )}
```

Under the chart, the sentence that explains the absence:

```tsx
      {platformFiltered && (
        <p className="mt-3 text-[12px] text-muted">
          ROAS and POAS divide whole-store revenue and profit by ad spend, so they are not
          shown for a single platform.
        </p>
      )}
```

The tooltip formats money with `formatMoney`, which would print `2.08` as
currency. Make it print ratios as multiples instead:

```tsx
      {payload.map((row) => (
        <p key={row.name} className="mt-1 flex items-center gap-2 text-[12px]">
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: row.color }} />
          <span className="text-muted">{row.name}</span>
          <span className="num ml-auto font-semibold text-ink">
            {row.name === 'ROAS' || row.name === 'POAS'
              ? `${row.value.toFixed(2)}×`
              : formatMoney(row.value, currency)}
          </span>
        </p>
      ))}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/marketing/MarketingChart.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/marketing/MarketingChart.tsx src/components/marketing/MarketingChart.test.tsx
git commit -m "feat(marketing): ROAS and POAS on the trend, with a day/week/month toggle"
```

---

### Task 6: The Ad Platform filter control

**Files:**
- Create: `src/components/filters/PlatformFilter.tsx`
- Create: `src/components/filters/PlatformFilter.test.tsx`
- Modify: `src/app/marketing/MarketingClient.tsx`
- Test: `src/app/marketing/MarketingClient.test.tsx`

**Interfaces:**
- Consumes: `platform` query parameter from Task 3; `platformFiltered` prop from Task 5.
- Produces: `<PlatformFilter options={{ provider, label }[]} selected={string | null} onChange={(next: string | null) => void} />`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/filters/PlatformFilter.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PlatformFilter } from './PlatformFilter'

const options = [
  { provider: 'meta', label: 'Meta' },
  { provider: 'google', label: 'Google' },
]

describe('PlatformFilter', () => {
  it('starts on all platforms', () => {
    render(<PlatformFilter options={options} selected={null} onChange={() => {}} />)
    expect(screen.getByRole('combobox')).toHaveValue('')
  })

  it('reports the chosen provider, and null for all', () => {
    const onChange = vi.fn()
    render(<PlatformFilter options={options} selected={null} onChange={onChange} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'meta' } })
    expect(onChange).toHaveBeenCalledWith('meta')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('renders nothing when there is only one platform to choose from', () => {
    // A dropdown with one real option is a control that cannot do anything.
    const { container } = render(
      <PlatformFilter options={[options[0]]} selected={null} onChange={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/filters/PlatformFilter.test.tsx`
Expected: FAIL - `Cannot find module './PlatformFilter'`

- [ ] **Step 3: Write the implementation**

Create `src/components/filters/PlatformFilter.tsx`:

```tsx
'use client'

/**
 * Which ad platform the page describes.
 *
 * Options come from the response's own `byPlatform`, so only platforms that
 * actually have a connected account are offered and the client can never send
 * a value the server would reject with a 400.
 */
export function PlatformFilter({
  options,
  selected,
  onChange,
}: {
  options: { provider: string; label: string }[]
  selected: string | null
  onChange: (next: string | null) => void
}) {
  // One platform is not a choice, it is a label. Nothing to render.
  if (options.length < 2) return null

  return (
    <select
      aria-label="Ad platform"
      value={selected ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:border-faint"
    >
      <option value="">All platforms</option>
      {options.map((o) => (
        <option key={o.provider} value={o.provider}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/filters/PlatformFilter.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into MarketingClient**

In `src/app/marketing/MarketingClient.tsx`, import it and add state:

```ts
import { PlatformFilter } from '@/components/filters/PlatformFilter'
```

```ts
  const [platform, setPlatform] = useState<string | null>(null)
```

Send it, and add it to the effect's dependencies - omitting it there is the bug
that makes a filter appear to do nothing:

```ts
    if (selected.length) params.set('shops', selected.join(','))
    if (platform) params.set('platform', platform)
```

```ts
  }, [preset, from, to, selected, platform, tick, hasAccounts])
```

The options cannot come straight from `data.byPlatform`: once a filter is on,
the server narrows `byPlatform` to the selected platform, so the dropdown would
be left holding only the option already chosen and the user could never get back
to All platforms. Remember the last unfiltered list instead:

```ts
  // byPlatform narrows to the selection once a filter is active, which would
  // strand the dropdown on the one option already chosen. The full list is
  // remembered from the last unfiltered response.
  const [allPlatforms, setAllPlatforms] = useState<{ provider: string; label: string }[]>([])
  useEffect(() => {
    if (!platform && data) {
      setAllPlatforms(data.byPlatform.map((p) => ({ provider: p.provider, label: p.label })))
    }
  }, [platform, data])
```

Then render it beside the other filters in `PageHeader`, above `ShopFilter`:

```tsx
            <PlatformFilter
              options={allPlatforms}
              selected={platform}
              onChange={(next) => {
                setLoading(true)
                setPlatform(next)
              }}
            />
```

Finally tell the chart:

```tsx
                  <MarketingChart
                    series={data.series}
                    currency={currency}
                    platformFiltered={platform !== null}
                  />
```

- [ ] **Step 6: Add the page-level test**

In `src/app/marketing/MarketingClient.test.tsx`. This file stubs fetch per test
with `vi.stubGlobal('fetch', fetchMock)` and flushes with
`await act(async () => {})` - there is no shared `fetchMock`, and no
`waitFor`. Reuse the `withPlatform` payload fixture already defined in the file
(it carries two entries in `byPlatform`, which is what makes the dropdown
render at all):

```tsx
  it('asks the server for one platform when one is chosen', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(withPlatform), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    fireEvent.change(screen.getByRole('combobox', { name: /ad platform/i }), {
      target: { value: 'meta' },
    })
    await act(async () => {})

    const calls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls.some((u) => u.includes('platform=meta'))).toBe(true)
  })
```

If `withPlatform` holds only one platform, give this test its own payload with
two - a one-option `PlatformFilter` renders nothing by design, so the
`combobox` query would fail for the wrong reason.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/app/marketing/ src/components/filters/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/filters/PlatformFilter.tsx src/components/filters/PlatformFilter.test.tsx src/app/marketing/MarketingClient.tsx src/app/marketing/MarketingClient.test.tsx
git commit -m "feat(marketing): an ad platform filter that scopes the whole page"
```

---

### Task 7: The Refresh button

**Files:**
- Modify: `src/app/marketing/MarketingClient.tsx`
- Test: `src/app/marketing/MarketingClient.test.tsx`
- Reference (read, do not modify): `src/app/settings/ad-accounts/AdAccountsClient.tsx:118-140`

**Interfaces:**
- Consumes: `POST /api/ads/sync` (exists, admin-only, forces past the six-hour throttle).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

In `src/app/marketing/MarketingClient.test.tsx`:

Same stubbing style as Task 6 - per-test `vi.stubGlobal`, flushed with
`await act(async () => {})`:

```tsx
  it('syncs, then reloads the numbers the sync just wrote', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await act(async () => {})

    const calls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls).toContain('/api/ads/sync')
    // The sync only changes the DATABASE; the tab still holds the old numbers
    // until it asks again. More calls than the sync alone proves the refetch.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before + 1)
  })
```

Use whichever payload fixture the file already defines for a healthy response
(`payload` here stands for that fixture - check its real name before writing).
The disabled state is asserted separately, because the click resolves inside
the same `act` flush and the button is enabled again by the time it returns:

```tsx
  it('cannot be pressed twice while it is running', async () => {
    let release: (v: Response) => void = () => {}
    const fetchMock = vi.fn((url: string) =>
      String(url) === '/api/ads/sync'
        ? new Promise<Response>((resolve) => {
            release = resolve
          })
        : Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    const button = screen.getByRole('button', { name: /refresh/i })
    fireEvent.click(button)
    await act(async () => {})

    expect(button).toBeDisabled()

    await act(async () => {
      release(new Response('{}', { status: 200 }))
    })
    expect(button).not.toBeDisabled()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/marketing/MarketingClient.test.tsx -t 'syncs'`
Expected: FAIL - `Unable to find an accessible element with the role "button" and name /refresh/i`.

- [ ] **Step 3: Write the implementation**

In `src/app/marketing/MarketingClient.tsx`, import the toast hook and add state:

```ts
import { useToast } from '@/components/toast/useToast'
```

```ts
  const [syncing, setSyncing] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const toast = useToast()
```

Add `refreshNonce` to the fetch effect's dependency array:

```ts
  }, [preset, from, to, selected, platform, tick, refreshNonce, hasAccounts])
```

The handler, mirroring `AdAccountsClient`:

```ts
  async function refresh() {
    setSyncing(true)
    try {
      const res = await fetch('/api/ads/sync', { method: 'POST' })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Sync failed')
        return
      }
      // The sync wrote to the database; this pulls it into the tab.
      setLoading(true)
      setRefreshNonce((n) => n + 1)
      toast.success('Ad spend refreshed')
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSyncing(false)
    }
  }
```

The button, in `PageHeader` beside the filters:

```tsx
            <button
              type="button"
              onClick={refresh}
              disabled={syncing}
              className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:border-faint disabled:opacity-50"
            >
              {syncing ? 'Refreshing…' : 'Refresh ad data'}
            </button>
```

The route carries `maxDuration = 60`, so several accounts re-fetching can hold
this for most of a minute. The disabled-and-relabelled state is what stops the
button reading as broken while that happens.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/marketing/MarketingClient.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the linter**

Run: `npm run test`
Expected: PASS, no failures.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/marketing/MarketingClient.tsx src/app/marketing/MarketingClient.test.tsx
git commit -m "feat(marketing): refresh ad data without leaving the page"
```

---

## Self-review notes

**Spec coverage:** section 1 → Task 1. Section 2 (platform filter, `wholeStore`,
400 validation, every surface, the control) → Tasks 2, 3, 6. Section 3
(granularity, sum-then-divide, ISO weeks, partial edges, Daily default) →
Tasks 4, 5. Section 4 (right axis, dashed, both modes, POAS definition, omitted
under a filter) → Task 5. Section 5 (refresh) → Task 7. Spec tests 1-11 map to
Tasks 1, 2, 2, 2, 3, 4, 4, 4, 4, 5, 7 respectively.

**Verified against the codebase while writing, not assumed:**
- `MarketingClient.test.tsx` stubs fetch per test with `vi.stubGlobal` and
  flushes with `await act(async () => {})`. There is no shared `fetchMock` and
  no `waitFor` in that file; Tasks 6 and 7 follow its real style.
- `--color-series-roas` and `--color-series-poas` do **not** exist. Task 5 adds
  both to the `/* Chart series */` group in `globals.css`.
- `useToast` is at `@/components/toast/useToast`.
- ISO week arithmetic in Task 4's fixtures was checked: 2026-07-01 is a
  Wednesday, so its week starts Monday 2026-06-29, and 2026-07-06 opens the
  next bucket.

**Out of scope, per the spec:** Export, Email & SMS, Marketing Simulator,
`v.expenses`, and the inactive-shop silence.
