# Sales by week / month for the operations role — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operations manager a 12-row weekly or monthly sales table on his Dashboard, and an "Exclude 0-amount orders" filter there and on the Orders list, without any cost figure reaching him.

**Architecture:** A pure module builds calendar buckets and computes each one with the owner's own `computeMetrics`, keeping only orders, net revenue and average order. A new operations-guarded route loads orders once and returns an allowlisted shape. The operations Dashboard gets a small client island that renders it; the Orders route and page gain one filter.

**Tech Stack:** Next.js 16 app router, TypeScript, Prisma on Postgres, Vitest + Testing Library (jsdom), Tailwind classes.

**Spec:** `docs/superpowers/specs/2026-09-28-ops-sales-by-period-design.md`

## Global Constraints

- The operations role must never receive cost of goods, fulfilment, transaction fees, commission, marketing, affiliate cost, operational expenses, profit or margin. Raw JSON sent to him must not contain the keys `"cogs"`, `"commission"`, `"margin"`, `"profit"`, `"fulfillment"`.
- "Sales" means the engine's `netRevenue` (net sales + shipping charged, excl. VAT). "Avg order" means the engine's `avgOrderValue`. "Orders" means the engine's `orders`.
- A 0-amount order is one with `total === 0` (what the customer paid, incl. VAT).
- 12 periods are shown. Weeks run Monday to Sunday. Months are calendar months. The current period is marked "so far" and compared with the **whole** previous period.
- "Exclude 0-amount orders" is off by default everywhere.
- UI copy contains no em dashes (client rule). Use plain hyphens in date ranges: `22-28 Sep`, `29 Dec - 4 Jan`.
- Money in the table is shown with `formatMoneyWhole(minor, currency)` from `src/lib/money.ts`.
- DB-backed tests need the local Postgres: run `%LOCALAPPDATA%\panetti-pg\start-pg.cmd` if `pg_isready -h 127.0.0.1 -p 5432` says no response. Run DB tests with `--testTimeout=20000`.
- Never run `git stash`, `git checkout -- <file>`, `git restore`, `git reset` or `git clean`. Commit on `feat/ops-sales-by-period` only; run `git branch --show-current` before each commit.
- End every commit message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After any file is written by a script, check it is not all NUL bytes (`python -c "import io;b=io.open('PATH','rb').read();print(len(b),b.count(b'\x00'))"`); the project lives under OneDrive and a killed process has left NUL-filled files before.

## Review Focus

1. **A shop in another timezone at a week edge.** A Finnish (`Europe/Helsinki`) order placed Monday 00:30 local time is Sunday evening in Oslo; it must count in the Monday week, because an order belongs to its own shop's day. Test added to Task 1.
2. **The 1st of a month.** The current month bucket is one day long, marked so far, and compared with the whole previous month. Test added to Task 1.
3. **A week that crosses New Year.** Its label reads `29 Dec - 4 Jan` and its bounds are 2025-12-29..2026-01-04. Test added to Task 1.
4. **February in a leap year.** A month bucket for February 2028 must end on the 29th. Test added to Task 1.
5. **No sales at all** (a new shop, or everything excluded). Rows show 0, `vsPrevious` is null, and the table says "no prior data", never `NaN%` or `Infinity%`. Tests added to Task 1 and Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/dates.ts` (modify) | Gains `Granularity` and `bucketStart`, moved from the marketing module |
| `src/lib/ads/series-buckets.ts` (modify) | Re-exports them from `dates.ts`; nothing else changes |
| `src/lib/metrics/periods.ts` (create) | `periodBuckets`, `periodLabel`, `salesByPeriod`: pure, no database |
| `src/lib/metrics/periods.test.ts` (create) | Unit tests for the three, including agreement with `computeMetrics` |
| `src/app/api/sales/periods/route.ts` (create) | The operations-guarded route |
| `src/app/api/sales/periods/route.integration.test.ts` (create) | Route behaviour against the local database |
| `src/app/api/operations-access.integration.test.ts` (modify) | The new route joins HIS_DOORS |
| `src/app/api/operations-no-profit.integration.test.ts` (modify) | Both-ways and raw-JSON checks for the new route |
| `src/app/api/orders/route.ts` (modify) | `excludeZero=1` filter |
| `src/app/api/orders/route.test.ts` (modify) | Test for the filter |
| `src/app/orders/OrdersClient.tsx` (modify) | The checkbox |
| `src/app/orders/OrdersClient.test.tsx` (modify) | Test for the checkbox |
| `src/app/dashboard/SalesByPeriod.tsx` (create) | The client island |
| `src/app/dashboard/SalesByPeriod.test.tsx` (create) | Component tests |
| `src/app/dashboard/OperationsDashboard.tsx` (modify) | Loads shops, renders the island |

---

### Task 1: Period buckets and the sales table's numbers

**Files:**
- Modify: `src/lib/dates.ts` (append after `daysInYearOf`)
- Modify: `src/lib/ads/series-buckets.ts:12-31`
- Create: `src/lib/metrics/periods.ts`
- Test: `src/lib/metrics/periods.test.ts`

**Interfaces:**
- Consumes: `computeMetrics(input: MetricsInput): EngineResult` from `src/lib/metrics/engine.ts`; `deltaPct(current, previous): number | null` from `src/lib/metrics/trend.ts`; `MetricsInput` type from `src/lib/metrics/engine.ts`.
- Produces:
  - `export type Grain = 'week' | 'month'`
  - `export type PeriodBucket = { from: Date; to: Date; countedTo: Date; soFar: boolean }`
  - `export function periodBuckets(grain: Grain, today: Date, count: number): PeriodBucket[]` (returns `count + 1`, newest first)
  - `export type PeriodRow = { from: string; to: string; soFar: boolean; orders: number; sales: number; avgOrder: number; vsPrevious: number | null }` (`from`/`to` are `yyyy-mm-dd`)
  - `export function salesByPeriod(input: MetricsInput, buckets: PeriodBucket[], opts: { excludeZero: boolean }): PeriodRow[]` (returns `buckets.length - 1` rows)
  - `export function periodLabel(from: string, to: string, grain: Grain): string`
  - `export const PERIODS = 12`
  - From `src/lib/dates.ts`: `export type Granularity = 'day' | 'week' | 'month'` and `export function bucketStart(date: string, granularity: Granularity): string`

- [ ] **Step 1: Move `bucketStart` into `dates.ts`**

Append to `src/lib/dates.ts`:

```ts
export type Granularity = 'day' | 'week' | 'month'

/**
 * The first day of the week or month `date` falls in, as `yyyy-mm-dd`.
 * Weeks start on Monday; months on the 1st. `date` is a calendar day that has
 * already been placed in its zone, so plain UTC arithmetic on it is right.
 */
export function bucketStart(date: string, granularity: Granularity): string {
  if (granularity === 'day') return date
  if (granularity === 'month') return date.slice(0, 8) + '01'

  const d = new Date(date + 'T00:00:00Z')
  const back = (d.getUTCDay() + 6) % 7 // Sunday is 0 in JS; Monday is 0 here
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}
```

In `src/lib/ads/series-buckets.ts`, delete the local `export type Granularity = ...` line and the whole local `bucketStart` function (its doc comment `/** ISO weeks start on Monday; months on the 1st. */` included), and add directly under the existing `import type { MarketingSeriesPoint } from './marketing'` line:

```ts
import { bucketStart, type Granularity } from '../dates'

// Moved to lib/dates so the operations sales table can use it without
// importing a marketing type. Re-exported so nothing that imports it here breaks.
export { bucketStart, type Granularity }
```

- [ ] **Step 2: Prove the move changed nothing**

Run: `npx vitest run src/lib/ads/series-buckets.test.ts src/components/marketing`
Expected: PASS, same count as before the move.

- [ ] **Step 3: Write the failing tests for the pure module**

Create `src/lib/metrics/periods.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { periodBuckets, periodLabel, salesByPeriod, PERIODS } from './periods'
import { computeMetrics } from './engine'
import { buildRateTable } from './fx'
import type { CostBook, EngineOrder, EngineShop } from './types'
import type { MetricsInput } from './engine'

const d = (s: string) => new Date(`${s}T00:00:00Z`)
const ymd = (x: Date) => x.toISOString().slice(0, 10)

describe('periodBuckets', () => {
  it('gives count + 1 Monday-to-Sunday weeks, newest first, the current one so far', () => {
    // 2026-09-28 is a Monday.
    const b = periodBuckets('week', d('2026-09-30'), 3)
    expect(b).toHaveLength(4)
    expect(b.map((x) => [ymd(x.from), ymd(x.to), ymd(x.countedTo), x.soFar])).toEqual([
      ['2026-09-28', '2026-10-04', '2026-09-30', true],
      ['2026-09-21', '2026-09-27', '2026-09-27', false],
      ['2026-09-14', '2026-09-20', '2026-09-20', false],
      ['2026-09-07', '2026-09-13', '2026-09-13', false],
    ])
  })

  it('gives calendar months, the current one counted to today', () => {
    const b = periodBuckets('month', d('2026-09-15'), 2)
    expect(b.map((x) => [ymd(x.from), ymd(x.to), ymd(x.countedTo), x.soFar])).toEqual([
      ['2026-09-01', '2026-09-30', '2026-09-15', true],
      ['2026-08-01', '2026-08-31', '2026-08-31', false],
      ['2026-07-01', '2026-07-31', '2026-07-31', false],
    ])
  })

  // Review Focus 2
  it('on the 1st, the current month is one day long and the previous is whole', () => {
    const [now, before] = periodBuckets('month', d('2026-10-01'), 1)
    expect([ymd(now.from), ymd(now.countedTo), now.soFar]).toEqual(['2026-10-01', '2026-10-01', true])
    expect([ymd(before.from), ymd(before.to)]).toEqual(['2026-09-01', '2026-09-30'])
  })

  // Review Focus 3
  it('keeps a week that crosses New Year whole', () => {
    const [week] = periodBuckets('week', d('2026-01-01'), 1)
    expect([ymd(week.from), ymd(week.to)]).toEqual(['2025-12-29', '2026-01-04'])
  })

  // Review Focus 4
  it('ends February on the 29th in a leap year', () => {
    const b = periodBuckets('month', d('2028-03-10'), 1)
    expect([ymd(b[1].from), ymd(b[1].to)]).toEqual(['2028-02-01', '2028-02-29'])
  })

  it('shows twelve periods by default', () => {
    expect(PERIODS).toBe(12)
  })
})

describe('periodLabel', () => {
  it('writes a week inside one month, across two months, and a month', () => {
    expect(periodLabel('2026-09-22', '2026-09-28', 'week')).toBe('22-28 Sep')
    expect(periodLabel('2025-12-29', '2026-01-04', 'week')).toBe('29 Dec - 4 Jan')
    expect(periodLabel('2026-09-01', '2026-09-30', 'month')).toBe('September 2026')
  })
})

describe('salesByPeriod', () => {
  const shops: EngineShop[] = [
    { id: 'no', name: 'Norway', currency: 'USD' },
    { id: 'fi', name: 'Finland', currency: 'USD' },
  ]
  const rates = buildRateTable([{ date: d('2026-01-01'), currency: 'USD', rate: 1 }])
  const costs: CostBook = new Map([
    ['p1', [{ costPerItem: 1000, handlingCost: 0, effectiveFrom: d('2026-01-01') }]],
  ])

  function order(id: string, placedAt: string, over: Partial<EngineOrder> = {}): EngineOrder {
    return {
      id, shopId: 'no', placedAt: new Date(placedAt), status: 'completed', currency: 'USD', costCurrency: 'USD',
      grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 2000, taxTotal: 3000, total: 15000,
      ambassadorId: null, commissionRate: 0,
      items: [{ productId: 'p1', sku: 'PANPIZPRO', quantity: 1, lineNetTotal: 10000 }],
      ...over,
    }
  }

  function input(orders: EngineOrder[]): MetricsInput {
    return {
      shops, orders, expenses: [], costs, rates, displayCurrency: 'USD',
      from: d('2026-09-01'), to: d('2026-09-30'),
      timezone: 'Europe/Oslo',
      shopTimezones: new Map([['fi', 'Europe/Helsinki']]),
    }
  }

  // Today is Wednesday 30 Sep 2026: current week 28 Sep - 4 Oct, then 21-27, then 14-20.
  const buckets = periodBuckets('week', d('2026-09-30'), 2)

  it('counts each week, newest first, and compares with the whole week before', () => {
    const rows = salesByPeriod(
      input([
        order('a', '2026-09-29T10:00:00Z'),
        order('b', '2026-09-22T10:00:00Z'),
        order('c', '2026-09-23T10:00:00Z'),
        order('d', '2026-09-15T10:00:00Z'),
      ]),
      buckets,
      { excludeZero: false },
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      from: '2026-09-28', to: '2026-10-04', soFar: true,
      orders: 1, sales: 12000, avgOrder: 12000, vsPrevious: -0.5,
    })
    expect(rows[1]).toEqual({
      from: '2026-09-21', to: '2026-09-27', soFar: false,
      orders: 2, sales: 24000, avgOrder: 12000, vsPrevious: 1,
    })
  })

  it('never counts a voided or unpaid order', () => {
    const rows = salesByPeriod(
      input([
        order('a', '2026-09-29T10:00:00Z'),
        order('r', '2026-09-29T11:00:00Z', { status: 'refunded' }),
        order('p', '2026-09-29T12:00:00Z', { status: 'pending' }),
      ]),
      buckets,
      { excludeZero: false },
    )
    expect(rows[0].orders).toBe(1)
  })

  it('leaves 0-amount orders out of every row and every comparison base, only when asked', () => {
    const free = { grossSales: 10000, discountTotal: 10000, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0 }
    const orders = [
      order('a', '2026-09-29T10:00:00Z'),
      order('z1', '2026-09-29T11:00:00Z', free),
      order('b', '2026-09-22T10:00:00Z'),
      order('z2', '2026-09-22T11:00:00Z', free),
    ]
    const kept = salesByPeriod(input(orders), buckets, { excludeZero: false })
    expect(kept.map((r) => r.orders)).toEqual([2, 2])
    expect(kept[0].avgOrder).toBe(6000)

    const dropped = salesByPeriod(input(orders), buckets, { excludeZero: true })
    expect(dropped.map((r) => r.orders)).toEqual([1, 1])
    expect(dropped[0].avgOrder).toBe(12000)
    expect(dropped[0].vsPrevious).toBe(0)
  })

  // Review Focus 1
  it('puts an order in its own shop\'s week, not the workspace\'s', () => {
    // Monday 28 Sep 00:30 in Helsinki is Sunday 27 Sep 23:30 in Oslo.
    const rows = salesByPeriod(
      input([order('f', '2026-09-27T21:30:00Z', { shopId: 'fi' })]),
      buckets,
      { excludeZero: false },
    )
    expect(rows[0].orders).toBe(1)
    expect(rows[1].orders).toBe(0)
  })

  // Review Focus 5
  it('reports no change, not a number, when there was nothing before', () => {
    const rows = salesByPeriod(input([order('a', '2026-09-29T10:00:00Z')]), buckets, { excludeZero: false })
    expect(rows[1]).toMatchObject({ orders: 0, sales: 0, avgOrder: 0, vsPrevious: null })
    expect(rows[0].vsPrevious).toBeNull()
  })

  it('agrees with the owner\'s dashboard for the same dates, to the unit', () => {
    const orders = [
      order('a', '2026-09-22T10:00:00Z'),
      order('b', '2026-09-24T18:00:00Z', { shopId: 'fi', netSales: 33333, shippingCharged: 1111 }),
      order('c', '2026-09-27T21:30:00Z'),
    ]
    const [, week] = salesByPeriod(input(orders), buckets, { excludeZero: false })
    const owner = computeMetrics({ ...input(orders), from: d('2026-09-21'), to: d('2026-09-27') }).total
    expect([week.orders, week.sales, week.avgOrder]).toEqual([owner.orders, owner.netRevenue, owner.avgOrderValue])
  })
})
```

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run src/lib/metrics/periods.test.ts`
Expected: FAIL, `Failed to resolve import "./periods"`.

- [ ] **Step 5: Write the module**

Create `src/lib/metrics/periods.ts`:

```ts
import { bucketStart } from '../dates'
import { computeMetrics, type MetricsInput } from './engine'
import { deltaPct } from './trend'

/**
 * Sales by week or by month, for the operations manager's Dashboard.
 *
 * Every row is the owner's own `computeMetrics` over that week or month, and
 * only three of its numbers are read: orders, net revenue and the average
 * order. The status rules, the rule that an order belongs to the day it was
 * placed in its own shop's timezone, and the rate of the order's own day are
 * therefore the owner's dashboard's, not a copy of them - so a week here and
 * the same dates on the owner's dashboard cannot disagree.
 *
 * Nothing that is a cost leaves this file: the row type has no field for one.
 */

export type Grain = 'week' | 'month'

/** How many periods the table shows. */
export const PERIODS = 12

/**
 * One week or month. `from`..`to` is the whole calendar period, which is what
 * the label names; `countedTo` is the last day counted, which is today for the
 * period we are in and `to` for every other.
 */
export type PeriodBucket = { from: Date; to: Date; countedTo: Date; soFar: boolean }

export type PeriodRow = {
  from: string
  to: string
  soFar: boolean
  orders: number
  sales: number
  avgOrder: number
  vsPrevious: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const day = (s: string) => new Date(`${s}T00:00:00Z`)

/**
 * The period `today` falls in, and the `count` before it, newest first.
 *
 * One more than is shown: the oldest is only there so the oldest shown row has
 * a period to be compared with. `today` is the workspace's calendar day as a
 * UTC midnight, as `todayInZone` gives it.
 */
export function periodBuckets(grain: Grain, today: Date, count: number): PeriodBucket[] {
  const out: PeriodBucket[] = []
  let start = day(bucketStart(ymd(today), grain))

  for (let i = 0; i <= count; i++) {
    const end =
      grain === 'week'
        ? new Date(start.getTime() + 6 * DAY_MS)
        : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
    const soFar = i === 0
    out.push({ from: start, to: end, countedTo: soFar ? today : end, soFar })

    start =
      grain === 'week'
        ? new Date(start.getTime() - 7 * DAY_MS)
        : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1))
  }
  return out
}

/**
 * One row per shown bucket, each compared with the WHOLE bucket before it.
 *
 * `excludeZero` drops orders whose customer paid nothing (`total === 0`) from
 * the input once, before any bucket is computed, so every row and every
 * comparison base leave them out alike.
 */
export function salesByPeriod(
  input: MetricsInput,
  buckets: PeriodBucket[],
  opts: { excludeZero: boolean },
): PeriodRow[] {
  const orders = opts.excludeZero ? input.orders.filter((o) => o.total !== 0) : input.orders
  const totals = buckets.map(
    (b) => computeMetrics({ ...input, orders, from: b.from, to: b.countedTo }).total,
  )

  return buckets.slice(0, -1).map((b, i) => ({
    from: ymd(b.from),
    to: ymd(b.to),
    soFar: b.soFar,
    orders: totals[i].orders,
    sales: totals[i].netRevenue,
    avgOrder: totals[i].avgOrderValue,
    vsPrevious: deltaPct(totals[i].netRevenue, totals[i + 1].netRevenue),
  }))
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "22-28 Sep", "29 Dec - 4 Jan", or "September 2026". Hyphens, never dashes. */
export function periodLabel(from: string, to: string, grain: Grain): string {
  const f = day(from)
  const t = day(to)
  if (grain === 'month') return `${MONTH_LONG[f.getUTCMonth()]} ${f.getUTCFullYear()}`
  if (f.getUTCMonth() === t.getUTCMonth()) {
    return `${f.getUTCDate()}-${t.getUTCDate()} ${MONTH_SHORT[t.getUTCMonth()]}`
  }
  return `${f.getUTCDate()} ${MONTH_SHORT[f.getUTCMonth()]} - ${t.getUTCDate()} ${MONTH_SHORT[t.getUTCMonth()]}`
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/lib/metrics/periods.test.ts src/lib/ads/series-buckets.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output.

```bash
git branch --show-current   # must print feat/ops-sales-by-period
git add src/lib/dates.ts src/lib/ads/series-buckets.ts src/lib/metrics/periods.ts src/lib/metrics/periods.test.ts
git commit -m "feat(metrics): sales by week or month, counted by the owner's own engine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The operations-guarded route

**Files:**
- Create: `src/app/api/sales/periods/route.ts`
- Test: `src/app/api/sales/periods/route.integration.test.ts`
- Modify: `src/app/api/operations-access.integration.test.ts` (imports near line 52, HIS_DOORS near line 102)
- Modify: `src/app/api/operations-no-profit.integration.test.ts` (import near line 32, new `describe` after the Orders tab block)

**Interfaces:**
- Consumes: `periodBuckets`, `salesByPeriod`, `PERIODS`, `Grain` from `src/lib/metrics/periods.ts` (Task 1); `loadMetricsInput(args: { shopIds?: string[]; from: Date; to: Date; timezone?: string })` from `src/lib/data/load.ts`; `shopIdsFromQuery` from `src/lib/api/range.ts`; `todayInZone(tz, now)` from `src/lib/tz.ts`; `getSetting()` from `src/lib/settings.ts`; `assertOperations`, `AuthError` from `src/lib/auth/guard.ts`; `currentUser` from `src/lib/auth/current-user.ts`.
- Produces: `GET /api/sales/periods?grain=week|month&shops=<id,id>&excludeZero=1` answering
  `{ grain: 'week' | 'month', currency: string, excludeZero: boolean, rows: { from: string; to: string; soFar: boolean; orders: number; sales: number; avgOrder: number; vsPrevious: number | null }[] }`
  with `Cache-Control: private, no-store`; 403 `{ error }` for any role that is not ADMIN or OPERATIONS.

- [ ] **Step 1: Write the failing route test**

Create `src/app/api/sales/periods/route.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role } from '@/lib/auth/session'

const state = vi.hoisted(() => ({ role: 'OPERATIONS' as Role }))
vi.mock('@/lib/auth/current-user', () => ({
  currentUser: async () => ({ userId: 'u1', email: 'ops@ecom.test', role: state.role, ambassadorId: null }),
}))

const { db } = await import('@/lib/db')
const { GET } = await import('./route')

const MARK = 'sales-periods-test'
let shopId = ''

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.order.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
}
afterAll(cleanup)

// Placed yesterday and eight days ago, so one lands in this week or last and
// the other a week further back, whatever day the suite runs on.
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

async function order(externalId: string, placedAt: Date, total: number) {
  await db.order.create({
    data: {
      shopId, externalId, number: externalId, placedAt, status: 'completed', currency: 'NOK',
      grossSales: 400000, discountTotal: total === 0 ? 400000 : 0,
      netSales: total === 0 ? 0 : 400000, shippingCharged: 0, taxTotal: total === 0 ? 0 : 100000, total,
    },
  })
}

beforeEach(async () => {
  await cleanup()
  state.role = 'OPERATIONS'
  shopId = (await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK', active: true } })).id
  await order('p-1', daysAgo(1), 500000)
  await order('z-1', daysAgo(1), 0)
})

const get = (qs: string) => GET(new Request(`http://localhost/api/sales/periods?${qs}`))

describe('GET /api/sales/periods', () => {
  it('gives the operations manager twelve weeks in his shop currency, never cached', async () => {
    const res = await get(`grain=week&shops=${shopId}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await res.json()
    expect(body.grain).toBe('week')
    expect(body.currency).toBe('NOK')
    expect(body.excludeZero).toBe(false)
    expect(body.rows).toHaveLength(12)
    expect(body.rows[0].soFar).toBe(true)
    const counted = body.rows.reduce((n: number, r: { orders: number }) => n + r.orders, 0)
    expect(counted).toBe(2)
  })

  it('leaves out the 0-amount order when asked', async () => {
    const body = await (await get(`grain=week&shops=${shopId}&excludeZero=1`)).json()
    expect(body.excludeZero).toBe(true)
    const counted = body.rows.reduce((n: number, r: { orders: number }) => n + r.orders, 0)
    expect(counted).toBe(1)
  })

  it('gives twelve calendar months on grain=month and falls back to weeks on nonsense', async () => {
    const months = await (await get(`grain=month&shops=${shopId}`)).json()
    expect(months.grain).toBe('month')
    expect(months.rows).toHaveLength(12)
    expect(months.rows[0].from.endsWith('-01')).toBe(true)

    const junk = await (await get(`grain=fortnight&shops=${shopId}`)).json()
    expect(junk.grain).toBe('week')
  })

  it('sends each row with exactly the allowed fields', async () => {
    const body = await (await get(`grain=week&shops=${shopId}`)).json()
    expect(Object.keys(body).sort()).toEqual(['currency', 'excludeZero', 'grain', 'rows'])
    expect(Object.keys(body.rows[0]).sort()).toEqual(
      ['avgOrder', 'from', 'orders', 'sales', 'soFar', 'to', 'vsPrevious'],
    )
  })

  it('refuses marketing and ambassadors', async () => {
    for (const role of ['MARKETING', 'AMBASSADOR'] as const) {
      state.role = role
      expect((await get(`grain=week&shops=${shopId}`)).status).toBe(403)
    }
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/app/api/sales/periods/route.integration.test.ts --testTimeout=20000`
Expected: FAIL, `Failed to resolve import "./route"`.

- [ ] **Step 3: Write the route**

Create `src/app/api/sales/periods/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { shopIdsFromQuery } from '@/lib/api/range'
import { loadMetricsInput } from '@/lib/data/load'
import { periodBuckets, PERIODS, salesByPeriod, type Grain } from '@/lib/metrics/periods'
import { getSetting } from '@/lib/settings'
import { todayInZone } from '@/lib/tz'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Sales by week or month, for the operations manager's Dashboard.
 *
 * Open to operations as well as the owner, which is why every field below is
 * named one by one: the engine this reads computes profit, margin and every
 * cost, and not one of them may reach his browser. Nothing is spread.
 */
export async function GET(req: Request) {
  try {
    assertOperations(await currentUser())

    const params = new URL(req.url).searchParams
    const grain: Grain = params.get('grain') === 'month' ? 'month' : 'week'
    const excludeZero = params.get('excludeZero') === '1'
    const shopIds = shopIdsFromQuery(params)

    const { timezone } = await getSetting()
    const today = todayInZone(timezone, new Date())
    const buckets = periodBuckets(grain, today, PERIODS)
    const oldest = buckets[buckets.length - 1]

    // One load for the whole span; every bucket is computed from it in memory.
    const input = await loadMetricsInput({ shopIds, from: oldest.from, to: today, timezone })
    const rows = salesByPeriod(input, buckets, { excludeZero })

    return NextResponse.json(
      {
        grain,
        currency: input.displayCurrency,
        excludeZero,
        rows: rows.map((r) => ({
          from: r.from,
          to: r.to,
          soFar: r.soFar,
          orders: r.orders,
          sales: r.sales,
          avgOrder: r.avgOrder,
          vsPrevious: r.vsPrevious,
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load sales' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/app/api/sales/periods/route.integration.test.ts --testTimeout=20000`
Expected: PASS.

- [ ] **Step 5: Add the route to the operations access test**

In `src/app/api/operations-access.integration.test.ts`, after the line `const b2bOrder = await import('./b2b/orders/[id]/route')` add:

```ts
const salesPeriods = await import('./sales/periods/route')
```

and add this entry as the last element of `HIS_DOORS` (after the `'DELETE /api/b2b/orders/[id]'` entry):

```ts
  ['GET /api/sales/periods', () => salesPeriods.GET(url('/api/sales/periods?grain=week'))],
```

- [ ] **Step 6: Add the both-ways and raw-JSON checks**

In `src/app/api/operations-no-profit.integration.test.ts`, after `const b2bCustomer = await import('./b2b/customers/[id]/route')` add:

```ts
const salesPeriods = await import('./sales/periods/route')
```

and after the closing `})` of `describe('the Orders tab', ...)` add:

```ts
describe('the Dashboard sales table', () => {
  const call = (shopId: string) => () =>
    salesPeriods.GET(new Request(`http://localhost/api/sales/periods?grain=month&shops=${shopId}`))

  it('gives him and the admin the same sales, and neither a cost', async () => {
    type Body = { rows: { orders: number; sales: number }[] }
    const { admin, ops } = await bothWays<Body>(call(fixture.shopId))
    // Twelve months either way, and identical: he gets the owner's sales, not a cut-down copy.
    expect(ops.rows).toHaveLength(12)
    expect(ops.rows).toEqual(admin.rows)
  })

  it('leaves no cost, fee, commission or margin anywhere in the JSON he receives', async () => {
    state.role = 'OPERATIONS'
    const raw = await (await call(fixture.shopId)()).text()
    for (const word of ['cogs', 'commission', 'margin', 'profit', 'fulfillment']) {
      expect(raw.toLowerCase(), `"${word}" reached him`).not.toContain(`"${word}"`)
    }
  })
})
```

- [ ] **Step 7: Run all three files**

Run: `npx vitest run src/app/api/sales src/app/api/operations-access.integration.test.ts src/app/api/operations-no-profit.integration.test.ts --testTimeout=20000`
Expected: PASS, including `opens GET /api/sales/periods` and `still refuses MARKETING on every operations route`.

- [ ] **Step 8: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output.

```bash
git branch --show-current   # must print feat/ops-sales-by-period
git add src/app/api/sales src/app/api/operations-access.integration.test.ts src/app/api/operations-no-profit.integration.test.ts
git commit -m "feat(api): sales by period for operations, every field named, no cost reachable

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Orders list filter, server side

**Files:**
- Modify: `src/app/api/orders/route.ts:62-65` (params) and `:103-133` (`where`)
- Test: `src/app/api/orders/route.test.ts` (new `it` after `'filters to one source or the other'`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/orders?...&excludeZero=1` drops orders with `total = 0` from both `total` and `orders`.

- [ ] **Step 1: Write the failing test**

In `src/app/api/orders/route.test.ts`, add inside the same `describe` as `'filters to one source or the other'`, directly after that test:

```ts
  it('leaves out orders the customer paid nothing for, from the list and the count alike', async () => {
    await asAdmin()
    await db.order.create({
      data: {
        shopId: shopA, externalId: 'A-free', number: 'A-free', placedAt: new Date('2026-03-15T12:00:00Z'),
        status: 'completed', currency: 'DKK',
        grossSales: 10000, discountTotal: 10000, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })
    const base = `from=2026-03-01&to=2026-03-31&shops=${shopA}`

    const all = await (await get(base)).json()
    expect(all.total).toBe(3)
    expect(all.orders.map((o: { number: string }) => o.number)).toContain('A-free')

    const paid = await (await get(`${base}&excludeZero=1`)).json()
    expect(paid.total).toBe(2)
    expect(paid.orders.map((o: { number: string }) => o.number)).not.toContain('A-free')
  })
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/app/api/orders/route.test.ts -t "paid nothing" --testTimeout=20000`
Expected: FAIL, `expected 3 to be 2`.

- [ ] **Step 3: Implement**

In `src/app/api/orders/route.ts`, after the line `const source = params.get('source') ?? ''` add:

```ts
    // Replacements, giveaways and test orders go out at 0. They are real
    // parcels, so the list shows them by default; this hides them on request.
    const excludeZero = params.get('excludeZero') === '1'
```

and inside the `where` object, directly after the `...(source === 'b2b' ... : {}),` entry, add:

```ts
      ...(excludeZero ? { total: { not: 0 } } : {}),
```

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run src/app/api/orders/route.test.ts --testTimeout=20000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/ops-sales-by-period
git add src/app/api/orders/route.ts src/app/api/orders/route.test.ts
git commit -m "feat(orders): excludeZero leaves out orders the customer paid nothing for

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Orders list checkbox

**Files:**
- Modify: `src/app/orders/OrdersClient.tsx` (state near line 249, `buildParams` at 282-300, effect deps at 340, toolbar at 419-464)
- Test: `src/app/orders/OrdersClient.test.tsx`

**Interfaces:**
- Consumes: `excludeZero=1` on `GET /api/orders` (Task 3).
- Produces: a checkbox labelled `Exclude 0-amount orders`.

- [ ] **Step 1: Write the failing test**

Append to `src/app/orders/OrdersClient.test.tsx`:

```ts
describe('the 0-amount filter', () => {
  it('is off by default and, once ticked, reaches the server', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        return new Response(JSON.stringify({ total: 0, orders: [] }), { status: 200 })
      }),
    )
    render(<OrdersClient email="ops@test.local" shops={[{ id: 's1', name: 'Panetti Norway', currency: 'NOK' }]} showProfit={false} role="OPERATIONS" />)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))

    const box = screen.getByLabelText('Exclude 0-amount orders') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(calls[0]).not.toContain('excludeZero')

    fireEvent.click(box)
    await waitFor(() => expect(calls.some((u) => u.includes('excludeZero=1'))).toBe(true))
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/app/orders/OrdersClient.test.tsx -t "0-amount"`
Expected: FAIL, `Unable to find a label with the text of: Exclude 0-amount orders`.

- [ ] **Step 3: Implement**

In `src/app/orders/OrdersClient.tsx`:

After `const [source, setSource] = useState(initial.source)` add:

```ts
  // Replacements, giveaways and test orders go out at 0. Shown by default,
  // because each is a real parcel; hidden on request.
  const [excludeZero, setExcludeZero] = useState(false)
```

In `buildParams`, directly after `if (source) p.set('source', source)` add:

```ts
    if (excludeZero) p.set('excludeZero', '1')
```

In the effect's dependency array `[preset, from, to, selected, status, source, query, refresh, tick]`, add `excludeZero` after `source`:

```ts
  }, [preset, from, to, selected, status, source, excludeZero, query, refresh, tick])
```

In the toolbar, directly after the closing `</select>` of the `aria-label="Source"` select, add:

```tsx
                <label className="flex items-center gap-1.5 text-[12px] text-ink">
                  <input
                    type="checkbox"
                    checked={excludeZero}
                    onChange={(e) => {
                      setLoading(true)
                      setExcludeZero(e.target.checked)
                    }}
                  />
                  Exclude 0-amount orders
                </label>
```

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run src/app/orders/OrdersClient.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npx eslint src/app/orders/OrdersClient.tsx && npx tsc --noEmit`
Expected: no output.

```bash
git branch --show-current   # must print feat/ops-sales-by-period
git add src/app/orders/OrdersClient.tsx src/app/orders/OrdersClient.test.tsx
git commit -m "feat(orders): an Exclude 0-amount orders checkbox beside Status and Source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Dashboard table

**Files:**
- Create: `src/app/dashboard/SalesByPeriod.tsx`
- Test: `src/app/dashboard/SalesByPeriod.test.tsx`
- Modify: `src/app/dashboard/OperationsDashboard.tsx` (load shops in the function body, render under the card grid)

**Interfaces:**
- Consumes: `GET /api/sales/periods` (Task 2) and its response shape; `periodLabel`, `Grain` from `src/lib/metrics/periods.ts` (Task 1); `ShopFilter` from `src/components/filters/ShopFilter.tsx` (`{ shops: Shop[]; selected: string[]; onChange(ids: string[]): void }`); `formatMoneyWhole` from `src/lib/money.ts`.
- Produces: `export function SalesByPeriod({ shops }: { shops: { id: string; name: string; currency: string }[] })`.

- [ ] **Step 1: Write the failing component tests**

Create `src/app/dashboard/SalesByPeriod.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SalesByPeriod } from './SalesByPeriod'

afterEach(() => vi.unstubAllGlobals())

const shops = [{ id: 's1', name: 'Panetti Norway', currency: 'NOK' }]

function answer(over: Record<string, unknown> = {}) {
  return {
    grain: 'week',
    currency: 'USD',
    excludeZero: false,
    rows: [
      { from: '2026-09-28', to: '2026-10-04', soFar: true, orders: 98, sales: 3310000, avgOrder: 33776, vsPrevious: -0.27 },
      { from: '2026-09-21', to: '2026-09-27', soFar: false, orders: 134, sales: 4548000, avgOrder: 33940, vsPrevious: 0.06 },
      { from: '2026-09-14', to: '2026-09-20', soFar: false, orders: 0, sales: 0, avgOrder: 0, vsPrevious: null },
    ],
    ...over,
  }
}

function stub(body = answer()) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
  return calls
}

describe('SalesByPeriod', () => {
  it('shows weeks newest first, the current one so far, and the change on each', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(screen.getByText('28 Sep - 4 Oct (so far)')).toBeTruthy())
    expect(screen.getByText('21-27 Sep')).toBeTruthy()
    expect(screen.getByText('134')).toBeTruthy()
    expect(screen.getByText('-27%')).toBeTruthy()
    expect(screen.getByText('+6%')).toBeTruthy()
  })

  // Review Focus 5
  it('says there is nothing to compare with instead of printing a broken number', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(screen.getByText('no prior data')).toBeTruthy())
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull()
  })

  it('asks for months when Month is chosen', async () => {
    const calls = stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).toContain('grain=week')
    fireEvent.click(screen.getByRole('tab', { name: 'Month' }))
    await waitFor(() => expect(calls.some((u) => u.includes('grain=month'))).toBe(true))
  })

  it('leaves 0-amount orders in by default, and says so when they are left out', async () => {
    const calls = stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).not.toContain('excludeZero')
    expect(screen.queryByText('0-amount orders are left out.')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify(answer({ excludeZero: true })), { status: 200 })
    }))
    fireEvent.click(screen.getByLabelText('Exclude 0-amount orders'))
    await waitFor(() => expect(calls.some((u) => u.includes('excludeZero=1'))).toBe(true))
    await waitFor(() => expect(screen.getByText('0-amount orders are left out.')).toBeTruthy())
  })

  it('never shows a cost column', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(screen.getByText('21-27 Sep')).toBeTruthy())
    expect(screen.queryByText(/profit|margin|cost/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/app/dashboard/SalesByPeriod.test.tsx`
Expected: FAIL, `Failed to resolve import "./SalesByPeriod"`.

- [ ] **Step 3: Write the component**

Create `src/app/dashboard/SalesByPeriod.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { ShopFilter } from '@/components/filters/ShopFilter'
import { periodLabel, type Grain } from '@/lib/metrics/periods'
import { formatMoneyWhole } from '@/lib/money'

type Shop = { id: string; name: string; currency: string }

type Row = {
  from: string
  to: string
  soFar: boolean
  orders: number
  sales: number
  avgOrder: number
  vsPrevious: number | null
}

type Answer = { grain: Grain; currency: string; excludeZero: boolean; rows: Row[] }

const GRAINS: { id: Grain; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

/** "+6%", "-27%", "0%", or the words when there was nothing before. */
function change(v: number | null): string {
  if (v === null) return 'no prior data'
  const pct = Math.round(v * 100)
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

/**
 * The operations manager's sales by week or month.
 *
 * Twelve rows, newest first. The current period counts only up to today, says
 * "so far", and is compared with the whole period before it - which is why it
 * usually reads lower early in a week. Sales is net revenue excl. VAT, the
 * same figure as the owner's dashboard. There is no cost here, and the route
 * sends none.
 */
export function SalesByPeriod({ shops }: { shops: Shop[] }) {
  const [grain, setGrain] = useState<Grain>('week')
  const [selected, setSelected] = useState<string[]>([])
  const [excludeZero, setExcludeZero] = useState(false)
  const [data, setData] = useState<Answer | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const ctrl = new AbortController()
    const p = new URLSearchParams({ grain })
    if (selected.length) p.set('shops', selected.join(','))
    if (excludeZero) p.set('excludeZero', '1')
    fetch(`/api/sales/periods?${p}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load sales')
        setData((await res.json()) as Answer)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctrl.abort()
  }, [grain, selected, excludeZero])

  return (
    <section className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Sales by week / month</h2>
          <p className="text-[12px] text-muted">
            Net revenue excl. VAT, as on the owner&apos;s dashboard. The current period is so far, compared with the whole period before.
          </p>
          {data?.excludeZero && <p className="text-[12px] font-semibold text-ink">0-amount orders are left out.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Period"
            className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1"
          >
            {GRAINS.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={grain === g.id}
                onClick={() => setGrain(g.id)}
                className={`rounded-[var(--radius-control)] px-2.5 py-1 text-[12px] font-semibold transition-colors duration-150 ${
                  grain === g.id ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-panel hover:text-ink'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <ShopFilter shops={shops} selected={selected} onChange={setSelected} />
          <label className="flex items-center gap-1.5 text-[12px] text-ink">
            <input type="checkbox" checked={excludeZero} onChange={(e) => setExcludeZero(e.target.checked)} />
            Exclude 0-amount orders
          </label>
        </div>
      </div>

      {error ? (
        <p className="px-4 py-3 text-[12px] text-loss">{error}</p>
      ) : !data ? (
        <div className="skeleton m-4 h-[160px]" />
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-4 py-2 font-semibold">Period</th>
              <th className="px-4 py-2 text-right font-semibold">Orders</th>
              <th className="px-4 py-2 text-right font-semibold">Sales ({data.currency})</th>
              <th className="px-4 py-2 text-right font-semibold">Avg order</th>
              <th className="px-4 py-2 text-right font-semibold">vs previous</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.from} className="border-t border-line">
                <td className="px-4 py-2 text-ink">
                  {`${periodLabel(r.from, r.to, data.grain)}${r.soFar ? ' (so far)' : ''}`}
                </td>
                <td className="num px-4 py-2 text-right">{r.orders}</td>
                <td className="num px-4 py-2 text-right">{formatMoneyWhole(r.sales, data.currency)}</td>
                <td className="num px-4 py-2 text-right">{formatMoneyWhole(r.avgOrder, data.currency)}</td>
                <td className="num px-4 py-2 text-right text-muted">{change(r.vsPrevious)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run the component tests**

Run: `npx vitest run src/app/dashboard/SalesByPeriod.test.tsx`
Expected: PASS.

- [ ] **Step 5: Put it on his Dashboard**

In `src/app/dashboard/OperationsDashboard.tsx`:

Add to the imports, after `import { TodayCard } from './TodayCard'`:

```ts
import { SalesByPeriod } from './SalesByPeriod'
```

At the start of the `OperationsDashboard` function body, directly after `const now = new Date()`, add:

```ts
  // The shops his sales table can narrow to: every active one, like the Orders tab.
  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })
```

In the JSX, directly after the closing `</div>` of the `grid gap-4 md:grid-cols-2 xl:grid-cols-3` card grid and before `</PageBody>`, add:

```tsx
        <SalesByPeriod shops={shops} />
```

- [ ] **Step 6: Run the dashboard tests, lint, typecheck**

Run: `npx vitest run src/app/dashboard && npx eslint src/app/dashboard && npx tsc --noEmit`
Expected: PASS, then no lint or type output.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must print feat/ops-sales-by-period
git add src/app/dashboard/SalesByPeriod.tsx src/app/dashboard/SalesByPeriod.test.tsx src/app/dashboard/OperationsDashboard.tsx
git commit -m "feat(dashboard): Sales by week / month on the operations Dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Whole-suite gate, ship, and prove it on live data

**Files:** none changed unless a check fails.

- [ ] **Step 1: Full suite**

Run: `npx vitest run --testTimeout=20000`
Expected: every file passes except `src/lib/inbox/ingest.integration.test.ts`, which fails on `main` too. Any other failure: re-run that file alone before treating it as real (full-suite contention is known).

- [ ] **Step 2: Push, open the PR, merge once Vercel is green, wait for production `success`**

```bash
git push -u origin feat/ops-sales-by-period
gh pr create --base main --head feat/ops-sales-by-period --title "Sales by week / month for operations, and an Exclude 0-amount filter"
gh pr checks <number>
gh pr merge <number> --merge --delete-branch=false
gh api repos/philipantonetti-ctrl/panetti/deployments --jq '.[0] | "\(.id) \(.sha[0:7]) \(.environment)"'
gh api repos/philipantonetti-ctrl/panetti/deployments/<id>/statuses --jq '.[0].state'
```

The PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: Agreement on production**

Signed in as admin on https://panetti.vercel.app (the admin door is `/admin`), fetch `/api/sales/periods?grain=week` and `/api/metrics?from=<a full week's Monday>&to=<its Sunday>`. The week's row `orders` and `sales` must equal the metrics `metrics.total.orders` and `metrics.total.netRevenue`.

- [ ] **Step 4: The 0-amount count on production**

Compare `/api/orders?preset=last_90_days&includeVoided=true` against the same with `&excludeZero=1`: the difference in `total` must equal the SQL count
`select count(*) from "Order" where total = 0 and "placedAt" > now() - interval '90 days'` run the same minute (read-only).

- [ ] **Step 5: Load time**

Time `/api/sales/periods?grain=month` on production. Report the number. Optimise only if it is over 3 seconds.
