# ecom-analytics Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a BeProfit-style analytics dashboard for multiple WooCommerce shops that tracks sales, computes true net profit, attributes sales to ambassadors via coupon codes, and lets ambassadors log in to see their own earnings.

**Architecture:** A single Next.js app. All money math lives in one pure, heavily-tested module (`lib/metrics/`) that knows nothing about HTTP or the database — it takes orders, costs, expenses and FX rates in, and returns figures out. Thin API routes and pages call it. Data is stored in each shop's native currency and converted to USD only at read time, using the exchange rate from the order's own date, so history never shifts.

**Tech Stack:** Next.js 15 (App Router) · TypeScript · Prisma + SQLite · Tailwind CSS · Recharts · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-07-14-ecom-analytics-phase1-design.md`

---

## The Money Rules (memorise these — every task depends on them)

**Every revenue figure excludes VAT.** VAT is collected for the state; it was never the business's money.

```
  Gross sales        Σ line-item value before discount        (excl. VAT)
– Discounts          Σ discounts applied                      (excl. VAT)
─────────────────
= NET SALES          ← the reference figure; commission base  (excl. VAT)
+ Shipping charged   what the customer paid for shipping      (excl. VAT)
─────────────────
= NET REVENUE        ← top line used for profit
– COGS               Σ qty × cost-per-item   (cost in effect ON THE ORDER'S DATE)
– Handling           Σ qty × handling-cost   (cost in effect ON THE ORDER'S DATE)
– Operational expenses   each expense's daily share × active days in the range
– Ambassador commission  10% × net sales of each attributed order
─────────────────
= NET PROFIT         Net margin = net profit ÷ net revenue
```

- **Refunded/cancelled orders contribute nothing.** No revenue, no commission.
- **Commission = 10% of net sales** — after discount, excluding shipping, excluding VAT.
- **Missing product costs are 0 and flagged in the UI — never guessed.**

---

## File Structure

Each file has one clear responsibility.

| File | Responsibility |
|------|----------------|
| `prisma/schema.prisma` | The 10 tables |
| `prisma/seed.ts` | Realistic sample data (11 shops, ambassadors, orders) |
| `src/lib/money.ts` | Money as integer minor units; rounding. No floats for money. |
| `src/lib/metrics/types.ts` | The input/output shapes of the engine |
| `src/lib/metrics/costs.ts` | Pick the ProductCost in effect on a date |
| `src/lib/metrics/expenses.ts` | Spread an operational expense across a date range |
| `src/lib/metrics/fx.ts` | Convert an amount using the rate on a given date |
| `src/lib/metrics/ambassadors.ts` | Rank ambassadors by sales (the leaderboard) |
| `src/lib/metrics/engine.ts` | Compose the above into shop totals + grand total |
| `src/lib/metrics/index.ts` | Public exports of the engine |
| `src/lib/db.ts` | The Prisma client singleton |
| `src/lib/dates.ts` | Date-range presets (Today, This month, …) and day iteration |
| `src/lib/woo/client.ts` | Talk to one WooCommerce shop's REST API |
| `src/lib/woo/sync.ts` | Pull orders → upsert products/orders → attribute ambassadors |
| `src/lib/fx/rates.ts` | Fetch + cache daily ECB rates (Frankfurter) |
| `src/lib/auth/*` | Sessions, password hashing, role guards |
| `src/app/**` | Pages and API routes — thin; they call the modules above |

---

## Stage 1 — Foundation

### Task 1: Scaffold the Next.js project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`

- [ ] **Step 1: Create the Next.js app**

Run in `C:\Users\alama\Desktop\Philip Project\ecom-analytics`:

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack --yes
```

If it refuses because the directory is not empty, that is expected (we have `docs/` and `.git/`) — pass `--yes` and let it write alongside. If it still refuses, scaffold into a temp dir and copy `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `src/`, and `public/` across.

- [ ] **Step 2: Install the remaining dependencies**

```bash
npm install @prisma/client recharts bcryptjs jose zod
npm install -D prisma vitest @vitejs/plugin-react vite-tsconfig-paths @testing-library/react @testing-library/jest-dom jsdom @playwright/test tsx @types/bcryptjs
```

- [ ] **Step 3: Configure Vitest**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
  },
})
```

- [ ] **Step 4: Add scripts to `package.json`**

Merge into the `"scripts"` block:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "db:push": "prisma db push",
    "db:seed": "tsx prisma/seed.ts",
    "db:studio": "prisma studio"
  }
}
```

- [ ] **Step 5: Verify the app builds and the test runner works**

```bash
npm run build
npx vitest run --passWithNoTests
```

Expected: build succeeds; Vitest reports no test files (exit 0).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js + TypeScript + Tailwind + Vitest"
```

---

### Task 2: Money helper (integers, never floats)

Money in floats produces `0.1 + 0.2 = 0.30000000000000004`. All money is stored and computed as **integer minor units** (øre, cents). This file is the only place that knows that.

**Files:**
- Create: `src/lib/money.ts`
- Test: `src/lib/money.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/money.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toMinor, toMajor, mulRate, pct, sum, formatMoney } from './money'

describe('money', () => {
  it('converts major units to integer minor units', () => {
    expect(toMinor(10.5)).toBe(1050)
    expect(toMinor('44999.00')).toBe(4499900)
    expect(toMinor(0)).toBe(0)
  })

  it('rounds half away from zero, so 0.005 never silently disappears', () => {
    expect(toMinor(0.005)).toBe(1)
    expect(toMinor(-0.005)).toBe(-1)
  })

  it('converts minor units back to major', () => {
    expect(toMajor(1050)).toBe(10.5)
  })

  it('multiplies by a rate and returns whole minor units', () => {
    expect(mulRate(10000, 0.0937)).toBe(937)
  })

  it('takes a percentage of an amount', () => {
    expect(pct(10000, 0.1)).toBe(1000)
  })

  it('sums a list of amounts', () => {
    expect(sum([100, 250, 3])).toBe(353)
    expect(sum([])).toBe(0)
  })

  it('formats money for display in its currency', () => {
    expect(formatMoney(4499900, 'NOK')).toContain('44')
    expect(formatMoney(125050, 'USD')).toContain('1,250')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/lib/money.test.ts
```

Expected: FAIL — `Failed to resolve import "./money"`.

- [ ] **Step 3: Implement**

Create `src/lib/money.ts`:

```ts
/**
 * All money in this app is an INTEGER number of minor units (øre, cents).
 * Never use a float for money — 0.1 + 0.2 !== 0.3.
 * This file is the only place allowed to know about that convention.
 */

/** Round half away from zero (0.5 -> 1, -0.5 -> -1). */
function roundHalfAway(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n)
}

/** Major units (kr, $) -> integer minor units (øre, cents). */
export function toMinor(amount: number | string): number {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (!Number.isFinite(n)) return 0
  return roundHalfAway(n * 100)
}

/** Integer minor units -> major units, for display only. */
export function toMajor(minor: number): number {
  return minor / 100
}

/** Multiply minor units by a rate (e.g. an FX rate), staying in whole minor units. */
export function mulRate(minor: number, rate: number): number {
  return roundHalfAway(minor * rate)
}

/** Take a percentage (0.1 = 10%) of an amount in minor units. */
export function pct(minor: number, rate: number): number {
  return roundHalfAway(minor * rate)
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/** Format minor units for display, e.g. formatMoney(125050, 'USD') -> "$1,250.50". */
export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toMajor(minor))
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run src/lib/money.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts src/lib/money.test.ts
git commit -m "feat: money helpers using integer minor units"
```

---

### Task 3: Database schema

**Files:**
- Create: `prisma/schema.prisma`, `src/lib/db.ts`, `.env`

- [ ] **Step 1: Write the schema**

Create `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

// All money fields are INTEGER MINOR UNITS (øre/cents) in the SHOP'S OWN currency.
// Conversion to USD happens at read time only — never stored converted.

model Shop {
  id         String   @id @default(cuid())
  name       String
  currency   String   // "NOK" | "SEK" | "DKK" | "EUR" | "USD"
  wooUrl     String?
  wooKey     String?
  wooSecret  String?
  active     Boolean  @default(true)
  lastSyncAt DateTime?
  createdAt  DateTime @default(now())

  orders    Order[]
  products  Product[]
  expenses  OperationalExpense[]
  codes     AmbassadorCode[]
}

model Product {
  id           String   @id @default(cuid())
  shopId       String
  externalId   String   // WooCommerce product id
  sku          String
  name         String
  lastPrice    Int      @default(0) // last seen selling price, minor units

  shop  Shop          @relation(fields: [shopId], references: [id], onDelete: Cascade)
  costs ProductCost[]
  items OrderItem[]

  @@unique([shopId, externalId])
}

// A product's cost is a TIMELINE, not a single number.
// The cost of an order line is the row with the latest effectiveFrom <= order date.
model ProductCost {
  id            String   @id @default(cuid())
  productId     String
  costPerItem   Int      @default(0) // minor units, shop currency
  handlingCost  Int      @default(0) // minor units, shop currency
  effectiveFrom DateTime
  createdAt     DateTime @default(now())

  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@index([productId, effectiveFrom])
}

model Order {
  id              String   @id @default(cuid())
  shopId          String
  externalId      String   // WooCommerce order id
  number          String
  placedAt        DateTime
  status          String   // "completed" | "processing" | "refunded" | "cancelled" | ...
  currency        String   // shop's currency at time of order

  grossSales      Int      // line value BEFORE discount, excl VAT
  discountTotal   Int      // excl VAT
  netSales        Int      // grossSales - discountTotal. THE COMMISSION BASE. Stored for audit.
  shippingCharged Int      // excl VAT
  taxTotal        Int      // VAT — recorded, never counted as revenue
  total           Int      // what the customer actually paid, incl VAT

  couponCode      String?
  ambassadorId    String?  // resolved AT SYNC TIME and frozen — changing codes never rewrites history

  shop       Shop        @relation(fields: [shopId], references: [id], onDelete: Cascade)
  ambassador Ambassador? @relation(fields: [ambassadorId], references: [id], onDelete: SetNull)
  items      OrderItem[]

  @@unique([shopId, externalId])
  @@index([shopId, placedAt])
  @@index([ambassadorId, placedAt])
}

model OrderItem {
  id           String @id @default(cuid())
  orderId      String
  productId    String
  sku          String
  name         String
  quantity     Int
  unitPrice    Int    // minor units, excl VAT
  lineNetTotal Int    // after discount, excl VAT

  order   Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@index([orderId])
}

model OperationalExpense {
  id         String    @id @default(cuid())
  shopId     String
  label      String
  category   String    // "Overhead > Employees", "Fulfillment > Warehouse", ...
  amount     Int       // minor units, in `currency`
  currency   String
  recurrence String    // "ONE_TIME" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
  startDate  DateTime  // first payment
  endDate    DateTime?
  active     Boolean   @default(true)
  createdAt  DateTime  @default(now())

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, startDate])
}

model Ambassador {
  id             String   @id @default(cuid())
  name           String
  email          String   @unique
  commissionRate Float    @default(0.10) // 10%
  active         Boolean  @default(true)
  createdAt      DateTime @default(now())

  codes  AmbassadorCode[]
  orders Order[]
  user   User?
}

model AmbassadorCode {
  id           String  @id @default(cuid())
  ambassadorId String
  shopId       String? // null = valid on all shops
  code         String  @unique // stored UPPERCASE; matching is case-insensitive

  ambassador Ambassador @relation(fields: [ambassadorId], references: [id], onDelete: Cascade)
  shop       Shop?      @relation(fields: [shopId], references: [id], onDelete: Cascade)
}

model User {
  id           String  @id @default(cuid())
  email        String  @unique
  passwordHash String
  role         String  // "ADMIN" | "AMBASSADOR"
  ambassadorId String? @unique

  ambassador Ambassador? @relation(fields: [ambassadorId], references: [id], onDelete: Cascade)
}

model FxRate {
  id    String   @id @default(cuid())
  date  DateTime // the day this rate applies to (UTC midnight)
  base  String   // e.g. "NOK"
  quote String   // e.g. "USD"
  rate  Float    // 1 base = `rate` quote

  @@unique([date, base, quote])
  @@index([base, quote, date])
}
```

- [ ] **Step 2: Create `.env`**

```
DATABASE_URL="file:./dev.db"
AUTH_SECRET="dev-secret-change-me-in-production-0123456789abcdef"
```

- [ ] **Step 3: Create the Prisma client singleton**

Create `src/lib/db.ts`:

```ts
import { PrismaClient } from '@prisma/client'

// Reuse the client across hot reloads in dev, so we don't exhaust connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
```

- [ ] **Step 4: Push the schema and verify it applies**

```bash
npx prisma db push
```

Expected: "Your database is now in sync with your Prisma schema." and the client generates.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma src/lib/db.ts
git commit -m "feat: database schema — shops, orders, costs, expenses, ambassadors, FX"
```

---

### Task 4: Date helpers and range presets

The dashboard's date picker needs presets (Today, This month, …), and the expense engine needs to iterate the days in a range. Both live here.

**Files:**
- Create: `src/lib/dates.ts`
- Test: `src/lib/dates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/dates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { utcDay, daysInRange, eachDay, resolvePreset, daysInMonthOf } from './dates'

describe('dates', () => {
  it('normalises a date to UTC midnight, so a time-of-day never shifts a day', () => {
    expect(utcDay(new Date('2026-07-14T23:59:59Z')).toISOString()).toBe('2026-07-14T00:00:00.000Z')
  })

  it('counts days in a range inclusively — a single day is 1 day, not 0', () => {
    expect(daysInRange(new Date('2026-07-01'), new Date('2026-07-01'))).toBe(1)
    expect(daysInRange(new Date('2026-07-01'), new Date('2026-07-31'))).toBe(31)
  })

  it('iterates every day in a range', () => {
    const days = eachDay(new Date('2026-07-01'), new Date('2026-07-03'))
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it('knows how many days are in the month a date falls in', () => {
    expect(daysInMonthOf(new Date('2026-07-14'))).toBe(31)
    expect(daysInMonthOf(new Date('2026-02-10'))).toBe(28)
    expect(daysInMonthOf(new Date('2024-02-10'))).toBe(29) // leap year
  })

  it('resolves presets relative to a given "today"', () => {
    const today = new Date('2026-07-14T10:00:00Z')

    const t = resolvePreset('today', today)
    expect(t.from.toISOString().slice(0, 10)).toBe('2026-07-14')
    expect(t.to.toISOString().slice(0, 10)).toBe('2026-07-14')

    const y = resolvePreset('yesterday', today)
    expect(y.from.toISOString().slice(0, 10)).toBe('2026-07-13')

    const m = resolvePreset('this_month', today)
    expect(m.from.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(m.to.toISOString().slice(0, 10)).toBe('2026-07-14')

    const l7 = resolvePreset('last_7_days', today)
    expect(l7.from.toISOString().slice(0, 10)).toBe('2026-07-08') // 7 days INCLUDING today
    expect(l7.to.toISOString().slice(0, 10)).toBe('2026-07-14')

    const yr = resolvePreset('this_year', today)
    expect(yr.from.toISOString().slice(0, 10)).toBe('2026-01-01')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/lib/dates.test.ts
```

Expected: FAIL — cannot resolve `./dates`.

- [ ] **Step 3: Implement**

Create `src/lib/dates.ts`:

```ts
/**
 * Everything here works in UTC and treats a "day" as a whole calendar day.
 * Ranges are INCLUSIVE of both ends: 1 Jul -> 1 Jul is one day.
 */

export type DateRange = { from: Date; to: Date }

export type Preset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'this_year'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'

const DAY_MS = 24 * 60 * 60 * 1000

/** Strip the time — the UTC midnight that starts this date's day. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Inclusive day count. */
export function daysInRange(from: Date, to: Date): number {
  const a = utcDay(from).getTime()
  const b = utcDay(to).getTime()
  if (b < a) return 0
  return Math.round((b - a) / DAY_MS) + 1
}

/** Every day in the range, inclusive. */
export function eachDay(from: Date, to: Date): Date[] {
  const out: Date[] = []
  const end = utcDay(to).getTime()
  for (let t = utcDay(from).getTime(); t <= end; t += DAY_MS) out.push(new Date(t))
  return out
}

/** How many days are in the calendar month that `d` falls in (handles leap years). */
export function daysInMonthOf(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

/** How many days are in the calendar year that `d` falls in. */
export function daysInYearOf(d: Date): number {
  const y = d.getUTCFullYear()
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return isLeap ? 366 : 365
}

export function resolvePreset(preset: Preset, now: Date = new Date()): DateRange {
  const today = utcDay(now)
  const shift = (days: number) => new Date(today.getTime() + days * DAY_MS)

  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday':
      return { from: shift(-1), to: shift(-1) }
    case 'this_week': {
      // Week starts Monday.
      const dow = (today.getUTCDay() + 6) % 7
      return { from: shift(-dow), to: today }
    }
    case 'this_month':
      return { from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), to: today }
    case 'this_year':
      return { from: new Date(Date.UTC(today.getUTCFullYear(), 0, 1)), to: today }
    case 'last_7_days':
      return { from: shift(-6), to: today } // inclusive of today = 7 days
    case 'last_30_days':
      return { from: shift(-29), to: today }
    case 'last_90_days':
      return { from: shift(-89), to: today }
  }
}

export const PRESET_LABELS: Record<Preset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  this_month: 'This month',
  this_year: 'This year',
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run src/lib/dates.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dates.ts src/lib/dates.test.ts
git commit -m "feat: UTC date helpers and range presets"
```

---

## Stage 2 — The Metrics Engine

This is where the money is. Pure functions only — no database, no HTTP. Every function takes data in
and returns numbers out, which is what makes it possible to test exhaustively.

### Task 5: Engine types

**Files:**
- Create: `src/lib/metrics/types.ts`

- [ ] **Step 1: Define the shapes**

Create `src/lib/metrics/types.ts`:

```ts
/**
 * The engine's own view of the world. Deliberately NOT the Prisma types —
 * the engine must not care where the data came from.
 * All money is INTEGER MINOR UNITS in the currency named alongside it.
 */

export type Recurrence = 'ONE_TIME' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/** Statuses that contribute nothing: no revenue, no commission. */
export const EXCLUDED_STATUSES = ['refunded', 'cancelled', 'failed', 'trash'] as const

export type CostPoint = {
  costPerItem: number
  handlingCost: number
  effectiveFrom: Date
}

export type EngineOrderItem = {
  productId: string
  quantity: number
  lineNetTotal: number // after discount, excl VAT
}

export type EngineOrder = {
  id: string
  shopId: string
  placedAt: Date
  status: string
  currency: string
  grossSales: number
  discountTotal: number
  netSales: number // THE commission base
  shippingCharged: number
  taxTotal: number
  ambassadorId: string | null
  commissionRate: number // e.g. 0.10; 0 when unattributed
  items: EngineOrderItem[]
}

export type EngineExpense = {
  id: string
  shopId: string
  amount: number
  currency: string
  recurrence: Recurrence
  startDate: Date
  endDate: Date | null
  active: boolean
}

export type EngineShop = {
  id: string
  name: string
  currency: string
}

/** productId -> its full cost history */
export type CostBook = Map<string, CostPoint[]>

/** date (yyyy-mm-dd) -> currency -> rate to 1 unit of the display currency */
export type RateTable = Map<string, Map<string, number>>

/** Every figure below is in the DISPLAY currency, in minor units. */
export type Figures = {
  orders: number
  grossSales: number
  discounts: number
  netSales: number
  shippingCharged: number
  netRevenue: number
  cogs: number // product cost + handling combined
  operationalExpenses: number
  commission: number
  netProfit: number
  netMargin: number // 0.24 = 24%; 0 when there is no revenue
  avgOrderValue: number
  ambassadorSales: number // netSales of attributed orders only
}

export type ShopFigures = Figures & { shopId: string; shopName: string }

export type EngineResult = {
  displayCurrency: string
  byShop: ShopFigures[]
  total: Figures
}

export const ZERO_FIGURES: Figures = {
  orders: 0,
  grossSales: 0,
  discounts: 0,
  netSales: 0,
  shippingCharged: 0,
  netRevenue: 0,
  cogs: 0,
  operationalExpenses: 0,
  commission: 0,
  netProfit: 0,
  netMargin: 0,
  avgOrderValue: 0,
  ambassadorSales: 0,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/metrics/types.ts
git commit -m "feat: metrics engine types"
```

---

### Task 6: Cost lookup — the cost in effect on the order's date

**The rule:** an order from March is costed with March's cost, even if the cost changed in June.

**Files:**
- Create: `src/lib/metrics/costs.ts`
- Test: `src/lib/metrics/costs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/costs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { costOn } from './costs'
import type { CostPoint } from './types'

const history: CostPoint[] = [
  { costPerItem: 10000, handlingCost: 100, effectiveFrom: new Date('2026-01-01') },
  { costPerItem: 12000, handlingCost: 200, effectiveFrom: new Date('2026-06-01') },
  { costPerItem: 15000, handlingCost: 300, effectiveFrom: new Date('2026-09-01') },
]

describe('costOn', () => {
  it('uses the cost in effect on the order date, not the newest one', () => {
    expect(costOn(history, new Date('2026-03-15'))).toEqual({ costPerItem: 10000, handlingCost: 100 })
    expect(costOn(history, new Date('2026-07-15'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
    expect(costOn(history, new Date('2026-10-15'))).toEqual({ costPerItem: 15000, handlingCost: 300 })
  })

  it('applies a cost from its effectiveFrom day, inclusive', () => {
    expect(costOn(history, new Date('2026-06-01'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
  })

  it('returns zero when the order predates every known cost — never guesses', () => {
    expect(costOn(history, new Date('2025-12-31'))).toEqual({ costPerItem: 0, handlingCost: 0 })
  })

  it('returns zero when there is no cost history at all', () => {
    expect(costOn([], new Date('2026-07-15'))).toEqual({ costPerItem: 0, handlingCost: 0 })
  })

  it('does not care what order the history arrives in', () => {
    const shuffled = [history[2], history[0], history[1]]
    expect(costOn(shuffled, new Date('2026-07-15'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
  })

  it('ignores the time of day — an order at 23:59 uses that day cost', () => {
    expect(costOn(history, new Date('2026-06-01T23:59:59Z'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/metrics/costs.test.ts`
Expected: FAIL — cannot resolve `./costs`.

- [ ] **Step 3: Implement**

Create `src/lib/metrics/costs.ts`:

```ts
import { utcDay } from '../dates'
import type { CostPoint } from './types'

export type EffectiveCost = { costPerItem: number; handlingCost: number }

const ZERO: EffectiveCost = { costPerItem: 0, handlingCost: 0 }

/**
 * The cost that was true on `date`: the cost point with the latest
 * effectiveFrom that is on or before that day.
 *
 * If no cost was ever entered for that period the cost is ZERO — we never
 * guess. The UI flags zero-cost products so they get noticed, not hidden.
 */
export function costOn(history: CostPoint[], date: Date): EffectiveCost {
  const day = utcDay(date).getTime()

  let best: CostPoint | null = null
  for (const point of history) {
    const from = utcDay(point.effectiveFrom).getTime()
    if (from > day) continue
    if (!best || from > utcDay(best.effectiveFrom).getTime()) best = point
  }

  if (!best) return ZERO
  return { costPerItem: best.costPerItem, handlingCost: best.handlingCost }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/metrics/costs.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metrics/costs.ts src/lib/metrics/costs.test.ts
git commit -m "feat: cost lookup honours the cost in effect on the order date"
```

---

### Task 7: Expense spreading — "spread daily"

**The rule:** a 14 000 kr monthly expense in a 31-day month is ~451.61 kr/day. Look at 7 days and
~3 161 kr of it lands in that range. This is what makes profit correct for *any* date range.

**Rounding matters here.** Naively rounding each day and summing loses øre: `round(1400000/31) = 45161`,
and `45161 × 31 = 1399991` — 9 øre short of the month. So we accumulate the **exact** daily value as a
float and round only the **running total**. A full month then sums to exactly the month's amount, and
any sub-range still gets its fair share.

**Files:**
- Create: `src/lib/metrics/expenses.ts`
- Test: `src/lib/metrics/expenses.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/expenses.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { expenseInRange } from './expenses'
import type { EngineExpense } from './types'

function make(over: Partial<EngineExpense> = {}): EngineExpense {
  return {
    id: 'e1',
    shopId: 's1',
    amount: 1400000, // 14 000 kr in øre
    currency: 'NOK',
    recurrence: 'MONTHLY',
    startDate: new Date('2026-01-01'),
    endDate: null,
    active: true,
    ...over,
  }
}

describe('expenseInRange', () => {
  it('spreads a monthly expense across the days of the month', () => {
    // July has 31 days -> 1400000/31 = 45161.29 øre/day. 7 days -> round(316129.03) = 316129.
    expect(expenseInRange(make(), new Date('2026-07-01'), new Date('2026-07-07'))).toBe(316129)
  })

  it('charges exactly the full amount when the whole month is selected — no øre lost', () => {
    expect(expenseInRange(make(), new Date('2026-07-01'), new Date('2026-07-31'))).toBe(1400000)
  })

  it('uses each month own length — February is not July', () => {
    expect(expenseInRange(make(), new Date('2026-02-01'), new Date('2026-02-28'))).toBe(1400000)
  })

  it('charges a daily expense once per day', () => {
    const e = make({ recurrence: 'DAILY', amount: 10000 })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-05'))).toBe(50000)
  })

  it('spreads a weekly expense over 7 days', () => {
    const e = make({ recurrence: 'WEEKLY', amount: 70000 })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-07'))).toBe(70000)
  })

  it('spreads a yearly expense over the days of that year', () => {
    // 2026 has 365 days. 36500000/365 = 100000 per day. 10 days -> 1000000.
    const e = make({ recurrence: 'YEARLY', amount: 36500000 })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-10'))).toBe(1000000)
  })

  it('charges a one-time expense only on its start date', () => {
    const e = make({ recurrence: 'ONE_TIME', amount: 500000, startDate: new Date('2026-07-05') })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-31'))).toBe(500000)
    expect(expenseInRange(e, new Date('2026-07-06'), new Date('2026-07-31'))).toBe(0)
    expect(expenseInRange(e, new Date('2026-07-05'), new Date('2026-07-05'))).toBe(500000)
  })

  it('charges nothing before the expense started', () => {
    const e = make({ startDate: new Date('2026-07-15') })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-14'))).toBe(0)
  })

  it('charges only the days from its start when the range straddles the start date', () => {
    // Starts 15 Jul; range 1-31 Jul -> 17 chargeable days (15th..31st).
    const e = make({ startDate: new Date('2026-07-15') })
    const perDay = 1400000 / 31
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-31'))).toBe(Math.round(perDay * 17))
  })

  it('stops charging after the end date', () => {
    const e = make({ endDate: new Date('2026-07-10') })
    const perDay = 1400000 / 31
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-31'))).toBe(Math.round(perDay * 10))
  })

  it('charges nothing for an inactive expense', () => {
    expect(expenseInRange(make({ active: false }), new Date('2026-07-01'), new Date('2026-07-31'))).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/metrics/expenses.test.ts`
Expected: FAIL — cannot resolve `./expenses`.

- [ ] **Step 3: Implement**

Create `src/lib/metrics/expenses.ts`:

```ts
import { eachDay, utcDay, daysInMonthOf, daysInYearOf } from '../dates'
import type { EngineExpense } from './types'

/**
 * How much of `expense` falls inside [from, to]?
 *
 * Recurring expenses are converted to a DAILY amount and charged per active day.
 * A month's daily amount depends on that month's own length, so February and July
 * are each charged correctly — which is why we walk day by day instead of
 * multiplying by an average.
 *
 * A ONE_TIME expense lands entirely on its startDate.
 *
 * Returns minor units in the EXPENSE'S OWN currency. Converting to the display
 * currency is the caller's job (see fx.ts).
 */
export function expenseInRange(expense: EngineExpense, from: Date, to: Date): number {
  if (!expense.active) return 0

  const start = utcDay(expense.startDate).getTime()
  const end = expense.endDate ? utcDay(expense.endDate).getTime() : null

  if (expense.recurrence === 'ONE_TIME') {
    const rangeStart = utcDay(from).getTime()
    const rangeEnd = utcDay(to).getTime()
    return start >= rangeStart && start <= rangeEnd ? expense.amount : 0
  }

  // Accumulate the EXACT daily share and round only the running total, so a full
  // period sums to exactly the period's amount and no øre goes missing.
  let exact = 0
  for (const day of eachDay(from, to)) {
    const t = day.getTime()
    if (t < start) continue // hadn't started yet
    if (end !== null && t > end) continue // already ended
    exact += exactDailyAmount(expense, day)
  }
  return Math.round(exact)
}

/** The expense's exact (unrounded) share of a single day. */
function exactDailyAmount(expense: EngineExpense, day: Date): number {
  switch (expense.recurrence) {
    case 'DAILY':
      return expense.amount
    case 'WEEKLY':
      return expense.amount / 7
    case 'MONTHLY':
      return expense.amount / daysInMonthOf(day)
    case 'YEARLY':
      return expense.amount / daysInYearOf(day)
    case 'ONE_TIME':
      return 0 // handled above
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/metrics/expenses.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metrics/expenses.ts src/lib/metrics/expenses.test.ts
git commit -m "feat: operational expenses spread daily across any date range"
```

---

### Task 8: FX conversion — the rate on the order's own day

**The rule:** last month's numbers must never change because today's rate moved.

**Files:**
- Create: `src/lib/metrics/fx.ts`
- Test: `src/lib/metrics/fx.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/fx.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { convert, buildRateTable } from './fx'

const rates = buildRateTable([
  { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-02'), currency: 'NOK', rate: 0.2 },
  { date: new Date('2026-07-01'), currency: 'SEK', rate: 0.09 },
])

describe('convert', () => {
  it('converts using the rate on that specific day', () => {
    expect(convert(10000, 'NOK', new Date('2026-07-01'), 'USD', rates)).toBe(1000)
    expect(convert(10000, 'NOK', new Date('2026-07-02'), 'USD', rates)).toBe(2000)
  })

  it('is a no-op when the amount is already in the display currency', () => {
    expect(convert(10000, 'USD', new Date('2026-07-01'), 'USD', rates)).toBe(10000)
  })

  it('falls back to the most recent earlier rate when a day is missing', () => {
    // No rate on 5 Jul -> use 2 Jul rate of 0.2
    expect(convert(10000, 'NOK', new Date('2026-07-05'), 'USD', rates)).toBe(2000)
  })

  it('falls back to the earliest known rate when the date predates all rates', () => {
    expect(convert(10000, 'NOK', new Date('2026-06-01'), 'USD', rates)).toBe(1000)
  })

  it('returns the amount unchanged when the currency is entirely unknown', () => {
    // Showing an unconverted number is honest; showing zero would hide real money.
    expect(convert(10000, 'JPY', new Date('2026-07-01'), 'USD', rates)).toBe(10000)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/metrics/fx.test.ts`
Expected: FAIL — cannot resolve `./fx`.

- [ ] **Step 3: Implement**

Create `src/lib/metrics/fx.ts`:

```ts
import { utcDay } from '../dates'
import { mulRate } from '../money'
import type { RateTable } from './types'

export type RateRow = { date: Date; currency: string; rate: number }

const key = (d: Date) => utcDay(d).toISOString().slice(0, 10)

/** Build the lookup used by `convert`. A rate means "1 unit of currency = rate USD". */
export function buildRateTable(rows: RateRow[]): RateTable {
  const table: RateTable = new Map()
  for (const row of rows) {
    const k = key(row.date)
    if (!table.has(k)) table.set(k, new Map())
    table.get(k)!.set(row.currency, row.rate)
  }
  return table
}

/**
 * Convert `amount` (minor units, in `from` currency) into `display` currency using
 * the rate that applied ON `date`.
 *
 * Missing that exact day we walk backwards to the most recent earlier rate; if the
 * date predates every rate we hold, we use the earliest one. An entirely unknown
 * currency is returned unchanged rather than zeroed — an unconverted number is
 * honest, a zero would hide real money.
 */
export function convert(
  amount: number,
  from: string,
  date: Date,
  display: string,
  rates: RateTable,
): number {
  if (from === display) return amount

  const wanted = key(date)
  const days = [...rates.keys()].sort()

  // The most recent day at or before `date` that has a rate for this currency.
  let chosen: number | undefined
  for (const day of days) {
    if (day > wanted) break
    const r = rates.get(day)?.get(from)
    if (r !== undefined) chosen = r
  }

  // Nothing at or before it: fall forward to the earliest rate we know.
  if (chosen === undefined) {
    for (const day of days) {
      const r = rates.get(day)?.get(from)
      if (r !== undefined) {
        chosen = r
        break
      }
    }
  }

  if (chosen === undefined) return amount // unknown currency — never zero it out
  return mulRate(amount, chosen)
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/metrics/fx.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metrics/fx.ts src/lib/metrics/fx.test.ts
git commit -m "feat: FX conversion pinned to the order's own date"
```

---

### Task 9: The engine — compose everything into the final figures

This is the function the whole app calls. It is the single source of truth for every number on
every screen.

**Files:**
- Create: `src/lib/metrics/engine.ts`, `src/lib/metrics/index.ts`
- Test: `src/lib/metrics/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeMetrics } from './engine'
import { buildRateTable } from './fx'
import type { CostBook, EngineExpense, EngineOrder, EngineShop } from './types'

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
    grossSales: 100000, // 1000.00 kr before discount
    discountTotal: 10000, //  100.00 kr discount
    netSales: 90000, //  900.00 kr  <- commission base
    shippingCharged: 5000, //   50.00 kr
    taxTotal: 22500, //  225.00 kr VAT — never revenue
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
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/metrics/engine.test.ts`
Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 3: Implement**

Create `src/lib/metrics/engine.ts`:

```ts
import { utcDay } from '../dates'
import { pct, sum } from '../money'
import { costOn } from './costs'
import { expenseInRange } from './expenses'
import { convert } from './fx'
import {
  EXCLUDED_STATUSES,
  ZERO_FIGURES,
  type CostBook,
  type EngineExpense,
  type EngineOrder,
  type EngineResult,
  type EngineShop,
  type Figures,
  type RateTable,
  type ShopFigures,
} from './types'

export type MetricsInput = {
  shops: EngineShop[]
  orders: EngineOrder[]
  expenses: EngineExpense[]
  costs: CostBook
  rates: RateTable
  displayCurrency: string
  from: Date
  to: Date
}

/** An order that contributes nothing — refunded, cancelled, failed. */
function counts(order: EngineOrder): boolean {
  return !EXCLUDED_STATUSES.includes(order.status.toLowerCase() as never)
}

function inRange(order: EngineOrder, from: Date, to: Date): boolean {
  const t = utcDay(order.placedAt).getTime()
  return t >= utcDay(from).getTime() && t <= utcDay(to).getTime()
}

/**
 * THE function. Every number on every screen comes from here.
 *
 *   net sales    = gross sales - discounts          (excl VAT — VAT is never revenue)
 *   net revenue  = net sales + shipping charged
 *   cogs         = qty x (cost + handling), at the cost in effect ON THE ORDER'S DATE
 *   commission   = rate x net sales, for attributed orders only
 *   net profit   = net revenue - cogs - operational expenses - commission
 *
 * Money arrives in each shop's own currency and is converted to `displayCurrency`
 * using the rate from the order's own date, so history never shifts.
 */
export function computeMetrics(input: MetricsInput): EngineResult {
  const { shops, orders, expenses, costs, rates, displayCurrency, from, to } = input

  const live = orders.filter((o) => counts(o) && inRange(o, from, to))

  const byShop: ShopFigures[] = shops.map((shop) => {
    const shopOrders = live.filter((o) => o.shopId === shop.id)

    // Convert an amount from this order's currency into the display currency,
    // at the rate that applied on the day the order was placed.
    const conv = (amount: number, order: EngineOrder) =>
      convert(amount, order.currency, order.placedAt, displayCurrency, rates)

    const grossSales = sum(shopOrders.map((o) => conv(o.grossSales, o)))
    const discounts = sum(shopOrders.map((o) => conv(o.discountTotal, o)))
    const netSales = sum(shopOrders.map((o) => conv(o.netSales, o)))
    const shippingCharged = sum(shopOrders.map((o) => conv(o.shippingCharged, o)))
    const netRevenue = netSales + shippingCharged

    const cogs = sum(
      shopOrders.map((order) =>
        sum(
          order.items.map((item) => {
            const cost = costOn(costs.get(item.productId) ?? [], order.placedAt)
            const line = item.quantity * (cost.costPerItem + cost.handlingCost)
            return conv(line, order)
          }),
        ),
      ),
    )

    // Commission is a percentage of NET SALES — after discount, before shipping, excl VAT.
    const commission = sum(
      shopOrders.map((o) => (o.ambassadorId ? conv(pct(o.netSales, o.commissionRate), o) : 0)),
    )
    const ambassadorSales = sum(shopOrders.map((o) => (o.ambassadorId ? conv(o.netSales, o) : 0)))

    // Expenses are dated by day, not by order, so they convert at the range's start.
    const operationalExpenses = sum(
      expenses
        .filter((e) => e.shopId === shop.id)
        .map((e) => convert(expenseInRange(e, from, to), e.currency, from, displayCurrency, rates)),
    )

    const netProfit = netRevenue - cogs - operationalExpenses - commission

    return {
      shopId: shop.id,
      shopName: shop.name,
      orders: shopOrders.length,
      grossSales,
      discounts,
      netSales,
      shippingCharged,
      netRevenue,
      cogs,
      operationalExpenses,
      commission,
      netProfit,
      netMargin: netRevenue === 0 ? 0 : netProfit / netRevenue,
      avgOrderValue: shopOrders.length === 0 ? 0 : Math.round(netRevenue / shopOrders.length),
      ambassadorSales,
    }
  })

  return { displayCurrency, byShop, total: totalOf(byShop) }
}

/** Add the shop rows up. Ratios are recomputed from the totals, never averaged. */
function totalOf(rows: ShopFigures[]): Figures {
  if (rows.length === 0) return { ...ZERO_FIGURES }

  const add = (pick: (r: ShopFigures) => number) => sum(rows.map(pick))

  const netRevenue = add((r) => r.netRevenue)
  const netProfit = add((r) => r.netProfit)
  const orders = add((r) => r.orders)

  return {
    orders,
    grossSales: add((r) => r.grossSales),
    discounts: add((r) => r.discounts),
    netSales: add((r) => r.netSales),
    shippingCharged: add((r) => r.shippingCharged),
    netRevenue,
    cogs: add((r) => r.cogs),
    operationalExpenses: add((r) => r.operationalExpenses),
    commission: add((r) => r.commission),
    netProfit,
    netMargin: netRevenue === 0 ? 0 : netProfit / netRevenue,
    avgOrderValue: orders === 0 ? 0 : Math.round(netRevenue / orders),
    ambassadorSales: add((r) => r.ambassadorSales),
  }
}
```

Create `src/lib/metrics/index.ts`:

```ts
export { computeMetrics, type MetricsInput } from './engine'
export { costOn, type EffectiveCost } from './costs'
export { expenseInRange } from './expenses'
export { convert, buildRateTable, type RateRow } from './fx'
export * from './types'
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/metrics/engine.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Run the whole suite — the engine is done**

Run: `npm test`
Expected: PASS — all tests across money, dates, costs, expenses, fx, engine.

- [ ] **Step 6: Commit**

```bash
git add src/lib/metrics/
git commit -m "feat: metrics engine — net profit across shops, costs, expenses, commission, FX"
```

---

### Task 10: Ambassador leaderboard

**Files:**
- Create: `src/lib/metrics/ambassadors.ts`
- Test: `src/lib/metrics/ambassadors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/ambassadors.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { leaderboard } from './ambassadors'
import { buildRateTable } from './fx'
import type { EngineOrder } from './types'

const rates = buildRateTable([{ date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 }])

function order(over: Partial<EngineOrder>): EngineOrder {
  return {
    id: 'o', shopId: 'no', placedAt: new Date('2026-07-01'), status: 'completed', currency: 'NOK',
    grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0,
    ambassadorId: null, commissionRate: 0.1, items: [], ...over,
  }
}

const people = [
  { id: 'a1', name: 'Emma Nilsen' },
  { id: 'a2', name: 'Johan Berg' },
  { id: 'a3', name: 'Sofia Lind' },
]

describe('leaderboard', () => {
  it('ranks ambassadors by their sales, biggest first', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [
        order({ id: '1', ambassadorId: 'a1', netSales: 100000 }),
        order({ id: '2', ambassadorId: 'a2', netSales: 300000 }),
        order({ id: '3', ambassadorId: 'a1', netSales: 100000 }),
      ],
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(rows[0].name).toBe('Johan Berg')   // 3000 kr
    expect(rows[1].name).toBe('Emma Nilsen')  // 2000 kr across 2 orders
    expect(rows[0].rank).toBe(1)
    expect(rows[1].rank).toBe(2)
    expect(rows[1].orders).toBe(2)
  })

  it('converts sales and commission to the display currency', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [order({ ambassadorId: 'a1', netSales: 100000 })], // 1000 kr
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows[0].sales).toBe(10000)      // $100.00
    expect(rows[0].commission).toBe(1000)  // $10.00 = 10%
  })

  it('excludes refunded orders from an ambassador totals', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [
        order({ id: '1', ambassadorId: 'a1', netSales: 100000 }),
        order({ id: '2', ambassadorId: 'a1', netSales: 500000, status: 'refunded' }),
      ],
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows[0].orders).toBe(1)
    expect(rows[0].sales).toBe(10000)
  })

  it('includes an ambassador with no sales, ranked last with zeroes', () => {
    const rows = leaderboard({
      ambassadors: people,
      orders: [order({ ambassadorId: 'a1', netSales: 100000 })],
      rates, displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(rows).toHaveLength(3)
    expect(rows[2].sales).toBe(0)
    expect(rows[2].orders).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/metrics/ambassadors.test.ts`
Expected: FAIL — cannot resolve `./ambassadors`.

- [ ] **Step 3: Implement**

Create `src/lib/metrics/ambassadors.ts`:

```ts
import { utcDay } from '../dates'
import { pct } from '../money'
import { convert } from './fx'
import { EXCLUDED_STATUSES, type EngineOrder, type RateTable } from './types'

export type LeaderboardRow = {
  rank: number
  ambassadorId: string
  name: string
  orders: number
  sales: number // net sales, display currency
  commission: number // display currency
}

export type LeaderboardInput = {
  ambassadors: { id: string; name: string }[]
  orders: EngineOrder[]
  rates: RateTable
  displayCurrency: string
  from: Date
  to: Date
}

/**
 * Who sold the most. Same rules as the engine: refunded orders count for nothing,
 * commission is a percentage of net sales.
 *
 * Ambassadors with no sales in the range are still listed (with zeroes) — an empty
 * row is information; a missing row looks like a bug.
 */
export function leaderboard(input: LeaderboardInput): LeaderboardRow[] {
  const { ambassadors, orders, rates, displayCurrency, from, to } = input

  const start = utcDay(from).getTime()
  const end = utcDay(to).getTime()

  const live = orders.filter((o) => {
    if (!o.ambassadorId) return false
    if (EXCLUDED_STATUSES.includes(o.status.toLowerCase() as never)) return false
    const t = utcDay(o.placedAt).getTime()
    return t >= start && t <= end
  })

  const rows = ambassadors.map((person) => {
    const mine = live.filter((o) => o.ambassadorId === person.id)

    let sales = 0
    let commission = 0
    for (const o of mine) {
      sales += convert(o.netSales, o.currency, o.placedAt, displayCurrency, rates)
      commission += convert(pct(o.netSales, o.commissionRate), o.currency, o.placedAt, displayCurrency, rates)
    }

    return { rank: 0, ambassadorId: person.id, name: person.name, orders: mine.length, sales, commission }
  })

  rows.sort((a, b) => b.sales - a.sales)
  rows.forEach((row, i) => (row.rank = i + 1))
  return rows
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/metrics/ambassadors.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metrics/ambassadors.ts src/lib/metrics/ambassadors.test.ts
git commit -m "feat: ambassador leaderboard"
```

---

## Stage 3 — Data Layer & Seed

The engine is pure and knows nothing about the database. This stage builds the thin layer that
loads rows out of Prisma and hands them to the engine in its own shapes.

### Task 11: FX rates — fetch and cache daily ECB rates

Rates come from Frankfurter (ECB data, free, no API key). We store one row per currency per day and
never re-fetch a day we already have.

**Files:**
- Create: `src/lib/fx/rates.ts`
- Test: `src/lib/fx/rates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/fx/rates.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { parseFrankfurter, missingDays } from './rates'

describe('parseFrankfurter', () => {
  it('turns the API response into rate rows to USD', () => {
    // Frankfurter with base=USD gives "1 USD = X NOK". We need the inverse: 1 NOK = ? USD.
    const rows = parseFrankfurter({
      base: 'USD',
      rates: {
        '2026-07-01': { NOK: 10, SEK: 11.111111 },
        '2026-07-02': { NOK: 8 },
      },
    })

    const nok1 = rows.find((r) => r.currency === 'NOK' && r.date.toISOString().startsWith('2026-07-01'))!
    expect(nok1.rate).toBeCloseTo(0.1, 6) // 1 NOK = 0.10 USD

    const sek1 = rows.find((r) => r.currency === 'SEK')!
    expect(sek1.rate).toBeCloseTo(0.09, 5)

    const nok2 = rows.find((r) => r.currency === 'NOK' && r.date.toISOString().startsWith('2026-07-02'))!
    expect(nok2.rate).toBeCloseTo(0.125, 6)
  })

  it('always includes USD to USD as exactly 1', () => {
    const rows = parseFrankfurter({ base: 'USD', rates: { '2026-07-01': { NOK: 10 } } })
    const usd = rows.find((r) => r.currency === 'USD')!
    expect(usd.rate).toBe(1)
  })

  it('skips a zero rate rather than dividing by zero', () => {
    const rows = parseFrankfurter({ base: 'USD', rates: { '2026-07-01': { NOK: 0 } } })
    expect(rows.find((r) => r.currency === 'NOK')).toBeUndefined()
  })
})

describe('missingDays', () => {
  it('returns the days in the range we do not already hold', () => {
    const have = [new Date('2026-07-01'), new Date('2026-07-03')]
    const gaps = missingDays(new Date('2026-07-01'), new Date('2026-07-04'), have)
    expect(gaps.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-07-02', '2026-07-04'])
  })

  it('returns nothing when we hold every day', () => {
    const have = [new Date('2026-07-01'), new Date('2026-07-02')]
    expect(missingDays(new Date('2026-07-01'), new Date('2026-07-02'), have)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/fx/rates.test.ts`
Expected: FAIL — cannot resolve `./rates`.

- [ ] **Step 3: Implement**

Create `src/lib/fx/rates.ts`:

```ts
import { db } from '../db'
import { eachDay, utcDay } from '../dates'
import type { RateRow } from '../metrics/fx'

const DISPLAY = 'USD'

export type FrankfurterResponse = {
  base: string
  rates: Record<string, Record<string, number>>
}

/**
 * Frankfurter returns "1 USD = X NOK". The engine wants "1 NOK = ? USD",
 * so we invert. A zero rate is skipped rather than dividing by zero.
 */
export function parseFrankfurter(res: FrankfurterResponse): RateRow[] {
  const rows: RateRow[] = []

  for (const [day, perCurrency] of Object.entries(res.rates)) {
    const date = utcDay(new Date(day + 'T00:00:00Z'))

    // The display currency is always worth exactly one of itself.
    rows.push({ date, currency: DISPLAY, rate: 1 })

    for (const [currency, perUsd] of Object.entries(perCurrency)) {
      if (!perUsd) continue // 0 or NaN — skip, never divide by zero
      rows.push({ date, currency, rate: 1 / perUsd })
    }
  }
  return rows
}

/** Which days in [from,to] are not already covered by `have`? */
export function missingDays(from: Date, to: Date, have: Date[]): Date[] {
  const known = new Set(have.map((d) => utcDay(d).toISOString().slice(0, 10)))
  return eachDay(from, to).filter((d) => !known.has(d.toISOString().slice(0, 10)))
}

/**
 * Make sure we hold rates for every day in the range, fetching only the gaps.
 * Called before computing metrics.
 */
export async function ensureRates(from: Date, to: Date, currencies: string[]): Promise<void> {
  const wanted = currencies.filter((c) => c !== DISPLAY)
  if (wanted.length === 0) return

  const existing = await db.fxRate.findMany({
    where: { quote: DISPLAY, date: { gte: utcDay(from), lte: utcDay(to) } },
    select: { date: true },
    distinct: ['date'],
  })

  const gaps = missingDays(from, to, existing.map((r) => r.date))
  if (gaps.length === 0) return

  const start = gaps[0].toISOString().slice(0, 10)
  const end = gaps[gaps.length - 1].toISOString().slice(0, 10)
  const url = `https://api.frankfurter.app/${start}..${end}?from=${DISPLAY}&to=${wanted.join(',')}`

  try {
    const res = await fetch(url)
    if (!res.ok) return // leave the gap; convert() falls back to the nearest earlier rate
    const rows = parseFrankfurter((await res.json()) as FrankfurterResponse)

    await db.$transaction(
      rows.map((r) =>
        db.fxRate.upsert({
          where: { date_base_quote: { date: r.date, base: r.currency, quote: DISPLAY } },
          create: { date: r.date, base: r.currency, quote: DISPLAY, rate: r.rate },
          update: { rate: r.rate },
        }),
      ),
    )
  } catch {
    // Offline or the source is down. Not fatal: convert() falls back to the
    // nearest earlier rate, and the figure is shown as approximate.
  }
}

/** Load every rate we hold, as the engine's RateRow shape. */
export async function loadRates(): Promise<RateRow[]> {
  const rows = await db.fxRate.findMany({ where: { quote: DISPLAY } })
  return rows.map((r) => ({ date: r.date, currency: r.base, rate: r.rate }))
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/fx/rates.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fx/
git commit -m "feat: fetch and cache daily ECB exchange rates"
```

---

### Task 12: The loader — database rows into engine inputs

The only place that translates Prisma rows into the engine's shapes.

**Files:**
- Create: `src/lib/data/load.ts`

- [ ] **Step 1: Implement**

Create `src/lib/data/load.ts`:

```ts
import { db } from '../db'
import { utcDay } from '../dates'
import { buildRateTable } from '../metrics/fx'
import { ensureRates, loadRates } from '../fx/rates'
import type { CostBook, EngineExpense, EngineOrder, EngineShop, Recurrence } from '../metrics/types'
import type { MetricsInput } from '../metrics/engine'

export type LoadArgs = {
  shopIds?: string[] // undefined = every active shop
  from: Date
  to: Date
}

/**
 * Gather everything the engine needs for one query.
 *
 * The display currency is decided here, and it follows one rule:
 *   exactly one shop  -> that shop's own currency
 *   several shops     -> USD, so the totals mean something
 */
export async function loadMetricsInput(args: LoadArgs): Promise<MetricsInput> {
  const { from, to } = args

  const shopRows = await db.shop.findMany({
    where: { active: true, ...(args.shopIds?.length ? { id: { in: args.shopIds } } : {}) },
    orderBy: { name: 'asc' },
  })

  const shops: EngineShop[] = shopRows.map((s) => ({ id: s.id, name: s.name, currency: s.currency }))
  const shopIds = shops.map((s) => s.id)

  const displayCurrency = shops.length === 1 ? shops[0].currency : 'USD'

  const orderRows = await db.order.findMany({
    where: { shopId: { in: shopIds }, placedAt: { gte: utcDay(from), lte: endOfDay(to) } },
    include: { items: true, ambassador: true },
  })

  const orders: EngineOrder[] = orderRows.map((o) => ({
    id: o.id,
    shopId: o.shopId,
    placedAt: o.placedAt,
    status: o.status,
    currency: o.currency,
    grossSales: o.grossSales,
    discountTotal: o.discountTotal,
    netSales: o.netSales,
    shippingCharged: o.shippingCharged,
    taxTotal: o.taxTotal,
    ambassadorId: o.ambassadorId,
    // The rate is read from the ambassador, so a rate change applies to future
    // reports — but the ATTRIBUTION itself was frozen at sync time.
    commissionRate: o.ambassador?.commissionRate ?? 0,
    items: o.items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      lineNetTotal: i.lineNetTotal,
    })),
  }))

  // Cost history for exactly the products these orders touched.
  const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId)))]
  const costRows = await db.productCost.findMany({
    where: { productId: { in: productIds } },
    orderBy: { effectiveFrom: 'asc' },
  })

  const costs: CostBook = new Map()
  for (const c of costRows) {
    const list = costs.get(c.productId) ?? []
    list.push({ costPerItem: c.costPerItem, handlingCost: c.handlingCost, effectiveFrom: c.effectiveFrom })
    costs.set(c.productId, list)
  }

  const expenseRows = await db.operationalExpense.findMany({ where: { shopId: { in: shopIds } } })
  const expenses: EngineExpense[] = expenseRows.map((e) => ({
    id: e.id,
    shopId: e.shopId,
    amount: e.amount,
    currency: e.currency,
    recurrence: e.recurrence as Recurrence,
    startDate: e.startDate,
    endDate: e.endDate,
    active: e.active,
  }))

  // Only fetch FX when we actually need to convert something.
  const currencies = [...new Set([...shops.map((s) => s.currency), ...expenses.map((e) => e.currency)])]
  if (displayCurrency === 'USD' && currencies.some((c) => c !== 'USD')) {
    await ensureRates(from, to, currencies)
  }

  return {
    shops,
    orders,
    expenses,
    costs,
    rates: buildRateTable(await loadRates()),
    displayCurrency,
    from,
    to,
  }
}

/** 23:59:59.999 on `d`, so an order placed in the evening is inside the range. */
function endOfDay(d: Date): Date {
  const day = utcDay(d)
  return new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/data/
git commit -m "feat: load engine inputs from the database"
```

---

### Task 13: Seed — realistic sample data

The app must be usable and demonstrably correct **before** any live WooCommerce credentials exist.

**Files:**
- Create: `prisma/seed.ts`

- [ ] **Step 1: Write the seed**

Create `prisma/seed.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()

// Deterministic pseudo-random, so the seed produces the same data every run.
let s = 42
const rnd = () => {
  s = (s * 1103515245 + 12345) % 2147483648
  return s / 2147483648
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
const between = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo + 1))

const SHOPS = [
  { name: 'Panetti Norway', currency: 'NOK' },
  { name: 'Panetti Sweden', currency: 'SEK' },
  { name: 'Panetti Denmark', currency: 'DKK' },
  { name: 'Panetti Finland', currency: 'EUR' },
  { name: 'Panetti Germany', currency: 'EUR' },
  { name: 'Mazzetti.no', currency: 'NOK' },
  { name: 'Mazzetti.se', currency: 'SEK' },
  { name: 'Mazzetti Denmark', currency: 'DKK' },
  { name: 'Mazzetti Finland', currency: 'EUR' },
  { name: 'Massasjepistoler.no', currency: 'NOK' },
  { name: 'Bellino.no', currency: 'NOK' },
]

const CATALOGUE = [
  { sku: 'MACBL661', name: 'Mazzetti Advanced Comfort - Massasjestol (Svart)', price: 4499900, cost: 1599000, handling: 2400 },
  { sku: 'MACBE661', name: 'Mazzetti Advanced Comfort - Massasjestol (Beige)', price: 4499900, cost: 1599000, handling: 2400 },
  { sku: 'MLCBL510', name: 'Mazzetti Lite Comfort - Massasjestol (Svart)', price: 2999900, cost: 821000, handling: 2400 },
  { sku: 'MLCBE510', name: 'Mazzetti Lite Comfort - Massasjestol (Beige)', price: 2999900, cost: 821000, handling: 2500 },
  { sku: 'MPX-001', name: 'Massasjepistol Pro X', price: 249900, cost: 78000, handling: 1200 },
  { sku: 'MPM-002', name: 'Massasjepistol Mini', price: 129900, cost: 41000, handling: 900 },
]

const AMBASSADORS = [
  'Emma Nilsen', 'Johan Berg', 'Sofia Lind', 'Mats Haugen', 'Ida Solberg',
  'Lukas Dahl', 'Nora Vik', 'Oliver Strand', 'Maja Ruud', 'Elias Moen',
  'Thea Lunde', 'Filip Aas', 'Sara Holm', 'Jonas Ek', 'Live Sand',
  'Kasper Bo', 'Amalie Rye', 'Sander Fjell', 'Julie Nes', 'Tobias Kro',
  'Hanna Sten', 'Adrian Lie', 'Mia Foss', 'Noah Berge',
]

const EXPENSES = [
  { label: '3PL Warehouse', category: 'Fulfillment > Warehouse', amount: 1400000, recurrence: 'MONTHLY' },
  { label: 'Accounting', category: 'Overhead > Subscriptions', amount: 525000, recurrence: 'MONTHLY' },
  { label: 'Employees', category: 'Overhead > Employees', amount: 1750000, recurrence: 'MONTHLY' },
  { label: 'Shopify + tools', category: 'Overhead > Subscriptions', amount: 120000, recurrence: 'MONTHLY' },
  { label: 'Office', category: 'Overhead > Office', amount: 800000, recurrence: 'MONTHLY' },
]

const ORDER_STATUSES = ['completed', 'completed', 'completed', 'completed', 'processing', 'refunded']

async function main() {
  console.log('Clearing existing data...')
  await db.orderItem.deleteMany()
  await db.order.deleteMany()
  await db.productCost.deleteMany()
  await db.product.deleteMany()
  await db.operationalExpense.deleteMany()
  await db.ambassadorCode.deleteMany()
  await db.user.deleteMany()
  await db.ambassador.deleteMany()
  await db.shop.deleteMany()
  await db.fxRate.deleteMany()

  console.log('Creating shops...')
  const shops = []
  for (const s of SHOPS) {
    shops.push(await db.shop.create({ data: { name: s.name, currency: s.currency } }))
  }

  console.log('Creating ambassadors + logins...')
  const passwordHash = await bcrypt.hash('password123', 10)
  const ambassadors = []
  for (const name of AMBASSADORS) {
    const slug = name.split(' ')[0].toLowerCase()
    const a = await db.ambassador.create({
      data: {
        name,
        email: `${slug}@ambassador.test`,
        commissionRate: 0.1,
        codes: { create: { code: `${name.split(' ')[0].toUpperCase()}10` } },
      },
    })
    await db.user.create({
      data: { email: a.email, passwordHash, role: 'AMBASSADOR', ambassadorId: a.id },
    })
    ambassadors.push(a)
  }

  await db.user.create({
    data: { email: 'admin@ecom.test', passwordHash, role: 'ADMIN' },
  })

  console.log('Creating products, costs and expenses per shop...')
  // Carry sku+name alongside the id — two products share a price, so looking one up
  // by price alone would silently attach the wrong SKU to half the order lines.
  type SeedProduct = { id: string; price: number; sku: string; name: string }
  const productsByShop = new Map<string, SeedProduct[]>()

  for (const shop of shops) {
    const list: SeedProduct[] = []

    for (const [i, item] of CATALOGUE.entries()) {
      const product = await db.product.create({
        data: {
          shopId: shop.id,
          externalId: String(1000 + i),
          sku: item.sku,
          name: item.name,
          lastPrice: item.price,
        },
      })

      // A cost timeline: one cost from Jan, a price rise from June.
      // This exercises the effective-date logic with real data.
      await db.productCost.create({
        data: {
          productId: product.id,
          costPerItem: item.cost,
          handlingCost: item.handling,
          effectiveFrom: new Date('2026-01-01'),
        },
      })
      await db.productCost.create({
        data: {
          productId: product.id,
          costPerItem: Math.round(item.cost * 1.08), // 8% cost increase
          handlingCost: item.handling,
          effectiveFrom: new Date('2026-06-01'),
        },
      })

      list.push({ id: product.id, price: item.price, sku: item.sku, name: item.name })
    }
    productsByShop.set(shop.id, list)

    for (const e of EXPENSES) {
      await db.operationalExpense.create({
        data: {
          shopId: shop.id,
          label: e.label,
          category: e.category,
          amount: e.amount,
          currency: shop.currency,
          recurrence: e.recurrence,
          startDate: new Date('2026-01-01'),
          active: true,
        },
      })
    }
  }

  console.log('Creating orders across the last 6 months...')
  const today = new Date('2026-07-14')
  let orderNo = 1000

  for (const shop of shops) {
    const products = productsByShop.get(shop.id)!
    // Busier shops get more orders — the seed should look like the real thing.
    const busy = ['Panetti Norway', 'Mazzetti.no', 'Massasjepistoler.no'].includes(shop.name)
    const count = busy ? between(140, 200) : between(20, 70)

    for (let i = 0; i < count; i++) {
      const daysAgo = between(0, 180)
      const placedAt = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000)

      // ~35% of orders carry an ambassador code.
      const ambassador = rnd() < 0.35 ? pick(ambassadors) : null

      const lines = between(1, 2)
      let gross = 0
      const items: { productId: string; sku: string; name: string; quantity: number; unitPrice: number; lineNetTotal: number }[] = []

      for (let l = 0; l < lines; l++) {
        const p = pick(products)
        const qty = between(1, 2)
        const line = p.price * qty
        gross += line
        items.push({
          productId: p.id,
          sku: p.sku,
          name: p.name,
          quantity: qty,
          unitPrice: p.price,
          lineNetTotal: line,
        })
      }

      // The ambassador's code gives the customer 10% off.
      const discount = ambassador ? Math.round(gross * 0.1) : 0
      const netSales = gross - discount
      // Spread the discount across the lines so line totals still add up to netSales.
      if (discount > 0) {
        let left = discount
        for (const [idx, item] of items.entries()) {
          const share = idx === items.length - 1 ? left : Math.round((item.lineNetTotal / gross) * discount)
          item.lineNetTotal -= share
          left -= share
        }
      }

      const shipping = rnd() < 0.5 ? 0 : between(4900, 9900)
      const tax = Math.round((netSales + shipping) * 0.25) // 25% VAT
      const status = pick(ORDER_STATUSES)

      await db.order.create({
        data: {
          shopId: shop.id,
          externalId: String(orderNo),
          number: `#${orderNo}`,
          placedAt,
          status,
          currency: shop.currency,
          grossSales: gross,
          discountTotal: discount,
          netSales,
          shippingCharged: shipping,
          taxTotal: tax,
          total: netSales + shipping + tax,
          couponCode: ambassador ? `${ambassador.name.split(' ')[0].toUpperCase()}10` : null,
          ambassadorId: ambassador?.id ?? null,
          items: { create: items },
        },
      })
      orderNo++
    }
  }

  console.log('Seeding exchange rates...')
  // Roughly realistic; the live fetcher will fill in and correct these.
  const RATES: Record<string, number> = { NOK: 0.097, SEK: 0.094, DKK: 0.145, EUR: 1.08, USD: 1 }
  for (let d = 0; d <= 200; d++) {
    const date = new Date(Date.UTC(2026, 0, 1) + d * 24 * 60 * 60 * 1000)
    for (const [currency, rate] of Object.entries(RATES)) {
      await db.fxRate.create({
        data: { date, base: currency, quote: 'USD', rate },
      })
    }
  }

  const orders = await db.order.count()
  console.log(`\nDone. ${shops.length} shops, ${ambassadors.length} ambassadors, ${orders} orders.`)
  console.log('Admin login:      admin@ecom.test / password123')
  console.log('Ambassador login: emma@ambassador.test / password123')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
```

- [ ] **Step 2: Run the seed**

```bash
npm run db:push
npm run db:seed
```

Expected output ends with something like:
```
Done. 11 shops, 24 ambassadors, ~900 orders.
Admin login:      admin@ecom.test / password123
Ambassador login: emma@ambassador.test / password123
```

- [ ] **Step 3: Sanity-check the data landed**

```bash
npx prisma studio
```

Open `Order` — confirm orders exist, some with a `couponCode` and `ambassadorId`, some without, and
some with status `refunded`. Close Studio when satisfied.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat: seed realistic sample data — 11 shops, 24 ambassadors, 6 months of orders"
```

---

### Task 14: Prove the engine works against the real seeded database

An integration test: the engine's unit tests use hand-made data, so this one runs it against
actual Prisma rows. It is the first moment the whole stack is proven to hang together.

**Files:**
- Test: `src/lib/data/load.integration.test.ts`

- [ ] **Step 1: Write the test**

Create `src/lib/data/load.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadMetricsInput } from './load'
import { computeMetrics } from '../metrics'
import { db } from '../db'

// These run against the seeded dev.db. Run `npm run db:seed` first.
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
```

- [ ] **Step 2: Run it**

```bash
npm run db:seed
npx vitest run src/lib/data/load.integration.test.ts
```

Expected: PASS — 4 tests. If `cogs` is 0, the cost seeding or the `costOn` lookup is wrong — fix
before moving on. This test is the guard that the whole chain works.

- [ ] **Step 3: Commit**

```bash
git add src/lib/data/load.integration.test.ts
git commit -m "test: engine verified against the seeded database"
```

---

## Stage 4 — Auth & the Security Boundary

An ambassador must **never** be able to see another ambassador's data, or any company cost or profit
figure. That is enforced on the server, in one place, and tested.

### Task 15: Sessions and password hashing

**Files:**
- Create: `src/lib/auth/session.ts`, `src/lib/auth/password.ts`
- Test: `src/lib/auth/session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { signSession, verifySession, type SessionUser } from './session'
import { hashPassword, checkPassword } from './password'

const admin: SessionUser = { userId: 'u1', email: 'a@b.c', role: 'ADMIN', ambassadorId: null }

describe('session', () => {
  it('round-trips a signed session', async () => {
    const token = await signSession(admin)
    const back = await verifySession(token)
    expect(back).toEqual(admin)
  })

  it('rejects a tampered token', async () => {
    const token = await signSession(admin)
    // Flip the role in the payload — the signature must no longer verify.
    const tampered = token.slice(0, -4) + 'aaaa'
    expect(await verifySession(tampered)).toBeNull()
  })

  it('rejects nonsense', async () => {
    expect(await verifySession('not-a-token')).toBeNull()
    expect(await verifySession('')).toBeNull()
  })
})

describe('password', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse')
    expect(hash).not.toBe('correct horse') // never stored in the clear
    expect(await checkPassword('correct horse', hash)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse')
    expect(await checkPassword('wrong horse', hash)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/auth/session.test.ts`
Expected: FAIL — cannot resolve `./session`.

- [ ] **Step 3: Implement**

Create `src/lib/auth/password.ts`:

```ts
import bcrypt from 'bcryptjs'

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}

export function checkPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}
```

Create `src/lib/auth/session.ts`:

```ts
import { SignJWT, jwtVerify } from 'jose'

export type Role = 'ADMIN' | 'AMBASSADOR'

export type SessionUser = {
  userId: string
  email: string
  role: Role
  ambassadorId: string | null
}

export const SESSION_COOKIE = 'ecom_session'

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET
  if (!value) throw new Error('AUTH_SECRET is not set')
  return new TextEncoder().encode(value)
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

/** Returns the user, or null if the token is missing, expired, or tampered with. */
export async function verifySession(token: string): Promise<SessionUser | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret())
    return {
      userId: payload.userId as string,
      email: payload.email as string,
      role: payload.role as Role,
      ambassadorId: (payload.ambassadorId as string | null) ?? null,
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/auth/session.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/
git commit -m "feat: signed sessions and password hashing"
```

---

### Task 16: The guard — one place that decides who may see what

**Files:**
- Create: `src/lib/auth/guard.ts`
- Test: `src/lib/auth/guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { canViewAmbassador, assertAdmin, AuthError } from './guard'
import type { SessionUser } from './session'

const admin: SessionUser = { userId: 'u1', email: 'admin@x.c', role: 'ADMIN', ambassadorId: null }
const emma: SessionUser = { userId: 'u2', email: 'emma@x.c', role: 'AMBASSADOR', ambassadorId: 'a1' }
const johan: SessionUser = { userId: 'u3', email: 'johan@x.c', role: 'AMBASSADOR', ambassadorId: 'a2' }

describe('canViewAmbassador', () => {
  it('lets an admin view anyone', () => {
    expect(canViewAmbassador(admin, 'a1')).toBe(true)
    expect(canViewAmbassador(admin, 'a2')).toBe(true)
  })

  it('lets an ambassador view themselves', () => {
    expect(canViewAmbassador(emma, 'a1')).toBe(true)
  })

  it('STOPS an ambassador viewing another ambassador', () => {
    expect(canViewAmbassador(emma, 'a2')).toBe(false)
    expect(canViewAmbassador(johan, 'a1')).toBe(false)
  })

  it('stops a logged-out visitor viewing anyone', () => {
    expect(canViewAmbassador(null, 'a1')).toBe(false)
  })
})

describe('assertAdmin', () => {
  it('passes for an admin', () => {
    expect(() => assertAdmin(admin)).not.toThrow()
  })

  it('throws for an ambassador — costs and profit are not theirs to see', () => {
    expect(() => assertAdmin(emma)).toThrow(AuthError)
  })

  it('throws for a logged-out visitor', () => {
    expect(() => assertAdmin(null)).toThrow(AuthError)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/auth/guard.test.ts`
Expected: FAIL — cannot resolve `./guard`.

- [ ] **Step 3: Implement**

Create `src/lib/auth/guard.ts`:

```ts
import type { SessionUser } from './session'

export class AuthError extends Error {
  constructor(message = 'Not allowed') {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * The rule, in one function:
 *   an admin may view any ambassador;
 *   an ambassador may view ONLY themselves;
 *   nobody else may view anyone.
 */
export function canViewAmbassador(user: SessionUser | null, ambassadorId: string): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return true
  return user.ambassadorId === ambassadorId
}

/** Company-wide figures — costs, profit, every shop — are admin-only. */
export function assertAdmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user || user.role !== 'ADMIN') throw new AuthError('Admins only')
}

export function assertAmbassadorAccess(user: SessionUser | null, ambassadorId: string): void {
  if (!canViewAmbassador(user, ambassadorId)) throw new AuthError('Not your data')
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/auth/guard.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/guard.ts src/lib/auth/guard.test.ts
git commit -m "feat: access guard — an ambassador can only ever see their own data"
```

---

### Task 17: Reading the session in the app, and the login page

**Files:**
- Create: `src/lib/auth/current-user.ts`, `src/app/login/page.tsx`, `src/app/api/auth/login/route.ts`, `src/app/api/auth/logout/route.ts`, `src/middleware.ts`

- [ ] **Step 1: Read the session from the cookie**

Create `src/lib/auth/current-user.ts`:

```ts
import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySession, type SessionUser } from './session'

/** The logged-in user, or null. The single way any page or route learns who is asking. */
export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySession(token)
}
```

- [ ] **Step 2: The login route**

Create `src/app/api/auth/login/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { checkPassword } from '@/lib/auth/password'
import { SESSION_COOKIE, signSession } from '@/lib/auth/session'

const Body = z.object({ email: z.string().email(), password: z.string().min(1) })

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter an email and password' }, { status: 400 })
  }

  const user = await db.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } })

  // Same message whether the email is unknown or the password is wrong —
  // never reveal which accounts exist.
  const bad = NextResponse.json({ error: 'Wrong email or password' }, { status: 401 })
  if (!user) return bad
  if (!(await checkPassword(parsed.data.password, user.passwordHash))) return bad

  const token = await signSession({
    userId: user.id,
    email: user.email,
    role: user.role as 'ADMIN' | 'AMBASSADOR',
    ambassadorId: user.ambassadorId,
  })

  const res = NextResponse.json({
    ok: true,
    redirectTo: user.role === 'ADMIN' ? '/dashboard' : '/portal',
  })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, // JavaScript in the browser can never read it
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
  return res
}
```

Create `src/app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth/session'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 })
  return res
}
```

- [ ] **Step 3: The login page**

Create `src/app/login/page.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error ?? 'Could not sign in')
      setBusy(false)
      return
    }
    router.push(data.redirectTo)
    router.refresh()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-bold text-slate-900">ecom-analytics</h1>
        <p className="mt-1 text-sm text-slate-500">Sign in to continue</p>

        {/* htmlFor + id matter: they are what makes the label actually LABEL the input,
            for screen readers and for the end-to-end tests that find fields by label. */}
        <label htmlFor="email" className="mt-6 block text-xs font-medium uppercase tracking-wide text-slate-500">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500"
        />

        <label htmlFor="password" className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500"
        />

        {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-violet-700 py-2.5 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 4: Middleware — send logged-out visitors to the login page**

Create `src/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

/**
 * A coarse gate: no session -> go to /login.
 * It does NOT decide what a logged-in user may see — that is the guard's job,
 * enforced in the routes themselves, where it cannot be bypassed.
 */
export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const user = token ? await verifySession(token) : null

  if (!user) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // An ambassador has no business on an admin page.
  if (user.role === 'AMBASSADOR' && !req.nextUrl.pathname.startsWith('/portal')) {
    const url = req.nextUrl.clone()
    url.pathname = '/portal'
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/ambassadors/:path*', '/settings/:path*', '/portal/:path*'],
}
```

- [ ] **Step 5: Verify login works in a real browser**

```bash
npm run dev
```

Visit `http://localhost:3000/dashboard` → you must be redirected to `/login`.
Sign in as `admin@ecom.test` / `password123` → you land on `/dashboard` (a 404 for now — that is
next). Sign in as `emma@ambassador.test` / `password123` → you land on `/portal`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/current-user.ts src/app/login src/app/api/auth src/middleware.ts
git commit -m "feat: login, logout, session cookie, and route gating"
```

---

## Stage 5 — The Dashboard

### Task 18: The metrics API

**Files:**
- Create: `src/app/api/metrics/route.ts`, `src/lib/api/range.ts`
- Test: `src/app/api/metrics/route.test.ts`

- [ ] **Step 1: Parse the query into a date range**

Create `src/lib/api/range.ts`:

```ts
import { resolvePreset, utcDay, type DateRange, type Preset } from '../dates'

const PRESETS: Preset[] = [
  'today', 'yesterday', 'this_week', 'this_month', 'this_year',
  'last_7_days', 'last_30_days', 'last_90_days',
]

/**
 * Turn `?preset=this_month` or `?from=2026-07-01&to=2026-07-14` into a range.
 * Anything unrecognised falls back to this month, so a bad URL never crashes a page.
 */
export function rangeFromQuery(params: URLSearchParams, now: Date = new Date()): DateRange {
  const from = params.get('from')
  const to = params.get('to')

  if (from && to) {
    const f = new Date(from)
    const t = new Date(to)
    if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime())) {
      // Tolerate a backwards range rather than returning nothing.
      return f <= t ? { from: utcDay(f), to: utcDay(t) } : { from: utcDay(t), to: utcDay(f) }
    }
  }

  const preset = params.get('preset') as Preset | null
  if (preset && PRESETS.includes(preset)) return resolvePreset(preset, now)

  return resolvePreset('this_month', now)
}

export function shopIdsFromQuery(params: URLSearchParams): string[] | undefined {
  const raw = params.get('shops')
  if (!raw) return undefined // undefined = every active shop
  const ids = raw.split(',').filter(Boolean)
  return ids.length ? ids : undefined
}
```

- [ ] **Step 2: Write the failing test**

Create `src/app/api/metrics/route.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'

const now = new Date('2026-07-14T12:00:00Z')
const q = (s: string) => new URLSearchParams(s)

describe('rangeFromQuery', () => {
  it('reads an explicit from/to', () => {
    const r = rangeFromQuery(q('from=2026-07-01&to=2026-07-10'), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-07-10')
  })

  it('reads a preset', () => {
    const r = rangeFromQuery(q('preset=today'), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-14')
  })

  it('swaps a backwards range instead of returning nothing', () => {
    const r = rangeFromQuery(q('from=2026-07-10&to=2026-07-01'), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-07-10')
  })

  it('falls back to this month when the query is nonsense', () => {
    const r = rangeFromQuery(q('preset=banana'), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-01')
  })

  it('falls back to this month when there is no query at all', () => {
    const r = rangeFromQuery(q(''), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-01')
  })
})

describe('shopIdsFromQuery', () => {
  it('splits a comma-separated list', () => {
    expect(shopIdsFromQuery(q('shops=a,b,c'))).toEqual(['a', 'b', 'c'])
  })

  it('returns undefined (= all shops) when absent or empty', () => {
    expect(shopIdsFromQuery(q(''))).toBeUndefined()
    expect(shopIdsFromQuery(q('shops='))).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run it and watch it fail, then pass**

Run: `npx vitest run src/app/api/metrics/route.test.ts`
Expected: FAIL first (module missing), then PASS — 7 tests — once `src/lib/api/range.ts` exists.

- [ ] **Step 4: The route**

Create `src/app/api/metrics/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { computeMetrics } from '@/lib/metrics'
import { leaderboard } from '@/lib/metrics/ambassadors'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { db } from '@/lib/db'

export async function GET(req: Request) {
  try {
    // Company-wide figures are admin-only. This is the security boundary.
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { from, to } = rangeFromQuery(params)
    const shopIds = shopIdsFromQuery(params)

    const input = await loadMetricsInput({ shopIds, from, to })
    const metrics = computeMetrics(input)

    const people = await db.ambassador.findMany({
      where: { active: true },
      select: { id: true, name: true },
    })

    const top = leaderboard({
      ambassadors: people,
      orders: input.orders,
      rates: input.rates,
      displayCurrency: input.displayCurrency,
      from,
      to,
    })

    return NextResponse.json({
      metrics,
      leaderboard: top.filter((r) => r.orders > 0).slice(0, 10),
      range: { from: from.toISOString(), to: to.toISOString() },
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load metrics' }, { status: 500 })
  }
}
```

Create `src/app/api/shops/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const shops = await db.shop.findMany({
      where: { active: true },
      select: { id: true, name: true, currency: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ shops })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load shops' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Verify by hand**

With `npm run dev` running and signed in as admin, visit:
`http://localhost:3000/api/metrics?preset=this_month`

Expected: JSON with `metrics.total.netRevenue`, `metrics.byShop` (11 entries), and a `leaderboard`.
Then sign out and hit it again → `403`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/metrics src/app/api/shops src/lib/api
git commit -m "feat: metrics API, admin-only"
```

---

### Task 19: Shared UI pieces

**Files:**
- Create: `src/components/Money.tsx`, `src/components/KpiCard.tsx`, `src/components/TopBar.tsx`

- [ ] **Step 1: Money formatting for the browser**

Create `src/components/Money.tsx`:

```tsx
import { formatMoney } from '@/lib/money'

export function Money({ minor, currency, className = '' }: { minor: number; currency: string; className?: string }) {
  const negative = minor < 0
  return (
    <span className={`${negative ? 'text-red-600' : ''} ${className}`}>{formatMoney(minor, currency)}</span>
  )
}

export function Percent({ value, className = '' }: { value: number; className?: string }) {
  const negative = value < 0
  return (
    <span className={`${negative ? 'text-red-600' : ''} ${className}`}>
      {(value * 100).toFixed(1)}%
    </span>
  )
}
```

- [ ] **Step 2: KPI card**

Create `src/components/KpiCard.tsx`:

```tsx
export function KpiCard({
  label,
  value,
  tone = 'plain',
}: {
  label: string
  value: React.ReactNode
  tone?: 'plain' | 'good' | 'accent'
}) {
  const colour =
    tone === 'good' ? 'text-emerald-600' : tone === 'accent' ? 'text-violet-700' : 'text-slate-900'

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${colour}`}>{value}</div>
    </div>
  )
}
```

- [ ] **Step 3: Top bar**

Create `src/components/TopBar.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'

export function TopBar({ email, children }: { email: string; children?: React.ReactNode }) {
  const router = useRouter()

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="flex items-center justify-between bg-[#2e1a47] px-4 py-2.5 text-white">
      <div className="font-bold tracking-tight">📊 ecom-analytics</div>
      <div className="flex items-center gap-2 text-xs">
        {children}
        <span className="text-white/60">{email}</span>
        <button onClick={signOut} className="rounded-md bg-white/10 px-2.5 py-1.5 hover:bg-white/20">
          Sign out
        </button>
      </div>
    </header>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/
git commit -m "feat: shared UI — money, percent, KPI card, top bar"
```

---

### Task 20: The date-range picker and shop selector

**Files:**
- Create: `src/components/DateRangePicker.tsx`, `src/components/ShopSelector.tsx`

- [ ] **Step 1: Date range picker**

Create `src/components/DateRangePicker.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { PRESET_LABELS, type Preset } from '@/lib/dates'

const PRESETS = Object.keys(PRESET_LABELS) as Preset[]

export function DateRangePicker({
  preset,
  from,
  to,
  onChange,
}: {
  preset: Preset | 'custom'
  from: string
  to: string
  onChange: (next: { preset: Preset | 'custom'; from?: string; to?: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const label = preset === 'custom' ? `${from} → ${to}` : PRESET_LABELS[preset]

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-md bg-white/10 px-2.5 py-1.5 hover:bg-white/20"
      >
        📅 {label} ▾
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[320px] rounded-xl border border-slate-200 bg-white p-3 text-slate-800 shadow-lg">
          <div className="grid grid-cols-2 gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  onChange({ preset: p })
                  setOpen(false)
                }}
                className={`rounded-md px-2 py-1.5 text-left text-xs hover:bg-violet-50 ${
                  preset === p ? 'bg-violet-100 font-semibold text-violet-800' : ''
                }`}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>

          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Custom range</div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="date"
                defaultValue={from}
                onChange={(e) => onChange({ preset: 'custom', from: e.target.value, to })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              />
              <span className="text-slate-400">→</span>
              <input
                type="date"
                defaultValue={to}
                onChange={(e) => onChange({ preset: 'custom', from, to: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Shop selector**

Create `src/components/ShopSelector.tsx`:

```tsx
'use client'

import { useState } from 'react'

export type Shop = { id: string; name: string; currency: string }

export function ShopSelector({
  shops,
  selected,
  onChange,
}: {
  shops: Shop[]
  selected: string[] // empty = all
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const all = selected.length === 0
  const label = all ? `All shops (${shops.length})` : `${selected.length} shop${selected.length > 1 ? 's' : ''}`

  /**
   * An empty list means "all shops".
   *
   * Careful: when everything is selected, un-ticking one shop must leave the other
   * ten — NOT collapse to that one. Isolating a single shop is a different action,
   * which is what the "Only" button is for.
   */
  function toggle(id: string) {
    const base = all ? shops.map((s) => s.id) : selected
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    onChange(next.length === shops.length ? [] : next)
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="rounded-md bg-white/10 px-2.5 py-1.5 hover:bg-white/20">
        🏬 {label} ▾
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 max-h-[360px] w-[300px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 text-slate-800 shadow-lg">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Shops</span>
            <button onClick={() => onChange([])} className="text-[11px] font-semibold text-violet-700 hover:underline">
              Select all
            </button>
          </div>

          {shops.map((shop) => {
            const on = all || selected.includes(shop.id)
            const onlyMe = selected.length === 1 && selected[0] === shop.id
            return (
              <div key={shop.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(shop.id)}
                  aria-label={shop.name}
                  className="accent-violet-700"
                />
                <span className="flex-1">{shop.name}</span>
                <span className="text-slate-400">{shop.currency}</span>
                {/* Isolate this one shop — the fastest way to read it in its own currency. */}
                <button
                  onClick={() => onChange([shop.id])}
                  aria-label={`Only ${shop.name}`}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    onlyMe ? 'bg-violet-100 text-violet-700' : 'text-slate-400 hover:bg-violet-50 hover:text-violet-700'
                  }`}
                >
                  Only
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/DateRangePicker.tsx src/components/ShopSelector.tsx
git commit -m "feat: date-range picker and multi-shop selector"
```

---

### Task 21: The dashboard page

**Files:**
- Create: `src/app/dashboard/page.tsx`, `src/app/dashboard/DashboardClient.tsx`, `src/components/CompareTable.tsx`, `src/components/Leaderboard.tsx`

- [ ] **Step 1: The compare table**

Create `src/components/CompareTable.tsx`:

```tsx
import { Money, Percent } from './Money'
import type { EngineResult } from '@/lib/metrics/types'

export function CompareTable({ result }: { result: EngineResult }) {
  const c = result.displayCurrency

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="bg-slate-50 text-right text-slate-500">
            <th className="px-3 py-2.5 text-left font-medium">Shop</th>
            <th className="px-3 py-2.5 font-medium">Orders</th>
            <th className="px-3 py-2.5 font-medium">Net revenue</th>
            <th className="px-3 py-2.5 font-medium" title="Product cost + handling">COGS</th>
            <th className="px-3 py-2.5 font-medium">Op. Ex.</th>
            <th className="px-3 py-2.5 font-medium">Commission</th>
            <th className="px-3 py-2.5 font-medium">Net profit</th>
            <th className="px-3 py-2.5 font-medium">Margin</th>
          </tr>
        </thead>
        <tbody className="text-right text-slate-700">
          {result.byShop.map((row) => (
            <tr key={row.shopId} className="border-t border-slate-100">
              <td className="px-3 py-2 text-left font-medium text-slate-900">{row.shopName}</td>
              <td className="px-3 py-2">{row.orders}</td>
              <td className="px-3 py-2"><Money minor={row.netRevenue} currency={c} /></td>
              <td className="px-3 py-2"><Money minor={row.cogs} currency={c} /></td>
              <td className="px-3 py-2"><Money minor={row.operationalExpenses} currency={c} /></td>
              <td className="px-3 py-2"><Money minor={row.commission} currency={c} /></td>
              <td className="px-3 py-2 font-semibold text-emerald-600"><Money minor={row.netProfit} currency={c} /></td>
              <td className="px-3 py-2"><Percent value={row.netMargin} /></td>
            </tr>
          ))}

          <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
            <td className="px-3 py-2.5 text-left">Total</td>
            <td className="px-3 py-2.5">{result.total.orders}</td>
            <td className="px-3 py-2.5"><Money minor={result.total.netRevenue} currency={c} /></td>
            <td className="px-3 py-2.5"><Money minor={result.total.cogs} currency={c} /></td>
            <td className="px-3 py-2.5"><Money minor={result.total.operationalExpenses} currency={c} /></td>
            <td className="px-3 py-2.5"><Money minor={result.total.commission} currency={c} /></td>
            <td className="px-3 py-2.5 text-emerald-600"><Money minor={result.total.netProfit} currency={c} /></td>
            <td className="px-3 py-2.5"><Percent value={result.total.netMargin} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: The leaderboard**

Create `src/components/Leaderboard.tsx`:

```tsx
import { Money } from './Money'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'

export function Leaderboard({ rows, currency }: { rows: LeaderboardRow[]; currency: string }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
        No ambassador sales in this period.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-slate-50 text-right text-slate-500">
            <th className="px-3 py-2.5 text-left font-medium">#</th>
            <th className="px-3 py-2.5 text-left font-medium">Ambassador</th>
            <th className="px-3 py-2.5 font-medium">Orders</th>
            <th className="px-3 py-2.5 font-medium">Sales</th>
            <th className="px-3 py-2.5 font-medium">Commission</th>
          </tr>
        </thead>
        <tbody className="text-right text-slate-700">
          {rows.map((row) => (
            <tr key={row.ambassadorId} className="border-t border-slate-100">
              <td className="px-3 py-2 text-left">{row.rank}</td>
              <td className="px-3 py-2 text-left font-medium text-slate-900">{row.name}</td>
              <td className="px-3 py-2">{row.orders}</td>
              <td className="px-3 py-2"><Money minor={row.sales} currency={currency} /></td>
              <td className="px-3 py-2 font-semibold text-violet-700"><Money minor={row.commission} currency={currency} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 3: The page**

Create `src/app/dashboard/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { DashboardClient } from './DashboardClient'

export default async function DashboardPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  return <DashboardClient email={user.email} shops={shops} />
}
```

Create `src/app/dashboard/DashboardClient.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { KpiCard } from '@/components/KpiCard'
import { Money, Percent } from '@/components/Money'
import { CompareTable } from '@/components/CompareTable'
import { Leaderboard } from '@/components/Leaderboard'
import { DateRangePicker } from '@/components/DateRangePicker'
import { ShopSelector, type Shop } from '@/components/ShopSelector'
import type { EngineResult } from '@/lib/metrics/types'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'
import type { Preset } from '@/lib/dates'

type Payload = { metrics: EngineResult; leaderboard: LeaderboardRow[] }

export function DashboardClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([]) // empty = all
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    if (selected.length) params.set('shops', selected.join(','))

    setLoading(true)
    fetch(`/api/metrics?${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load')
        return res.json()
      })
      .then((json: Payload) => {
        setData(json)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [preset, from, to, selected])

  const currency = data?.metrics.displayCurrency ?? 'USD'
  const t = data?.metrics.total

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email}>
        <ShopSelector shops={shops} selected={selected} onChange={setSelected} />
        <DateRangePicker
          preset={preset}
          from={from}
          to={to}
          onChange={(next) => {
            setPreset(next.preset)
            if (next.from !== undefined) setFrom(next.from)
            if (next.to !== undefined) setTo(next.to)
          }}
        />
      </TopBar>

      <main className="mx-auto max-w-7xl p-5">
        {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {loading && !data ? (
          <div className="py-20 text-center text-sm text-slate-400">Loading…</div>
        ) : t ? (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <KpiCard label="Net revenue" value={<Money minor={t.netRevenue} currency={currency} />} />
              <KpiCard label="Orders" value={t.orders} />
              <KpiCard label="Avg order value" value={<Money minor={t.avgOrderValue} currency={currency} />} />
              <KpiCard label="Net profit" value={<Money minor={t.netProfit} currency={currency} />} tone="good" />
              <KpiCard label="Net margin" value={<Percent value={t.netMargin} />} tone="good" />
              <KpiCard label="Ambassador sales" value={<Money minor={t.ambassadorSales} currency={currency} />} tone="accent" />
            </div>

            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Compare shops</h2>
            <div className="mb-6">
              <CompareTable result={data!.metrics} />
            </div>

            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">🏆 Top ambassadors</h2>
            <Leaderboard rows={data!.leaderboard} currency={currency} />

            {currency === 'USD' && shops.length > 1 && (
              <p className="mt-4 text-[11px] text-slate-400">
                Shops use different currencies, so figures are consolidated to USD at each order&apos;s own exchange rate.
              </p>
            )}
          </>
        ) : null}
      </main>
    </div>
  )
}
```

- [ ] **Step 4: See it in a real browser**

```bash
npm run dev
```

Sign in as `admin@ecom.test` / `password123`. You must see: six KPI cards with real figures, the
compare table with 11 shops and a Total row, and the ambassador leaderboard. Change the date range
to "Today" — the numbers must change. Select one shop — the currency must switch from USD to that
shop's own currency.

**If the numbers look wrong, stop and fix the engine — do not paper over it in the UI.**

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard src/components/CompareTable.tsx src/components/Leaderboard.tsx
git commit -m "feat: the dashboard — KPI cards, compare table, leaderboard"
```

---

## Stage 6 — Cost & Expense Admin

These screens are where the profit numbers actually come from. Without them the dashboard shows
revenue with no cost, which is worse than useless — it looks like profit.

### Task 22: Product costs — API

**Files:**
- Create: `src/app/api/products/route.ts`, `src/app/api/products/[id]/cost/route.ts`

- [ ] **Step 1: List products with their current cost**

Create `src/app/api/products/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { costOn } from '@/lib/metrics/costs'

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    if (!shopId) return NextResponse.json({ error: 'shopId is required' }, { status: 400 })

    const shop = await db.shop.findUnique({ where: { id: shopId } })
    if (!shop) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    const products = await db.product.findMany({
      where: { shopId },
      include: { costs: { orderBy: { effectiveFrom: 'desc' } } },
      orderBy: { name: 'asc' },
    })

    const today = new Date()

    return NextResponse.json({
      currency: shop.currency,
      products: products.map((p) => {
        const current = costOn(p.costs, today)
        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          sellingPrice: p.lastPrice,
          costPerItem: current.costPerItem,
          handlingCost: current.handlingCost,
          // The flag the UI uses to highlight a product whose cost was never entered.
          missingCost: current.costPerItem === 0,
          history: p.costs.map((c) => ({
            costPerItem: c.costPerItem,
            handlingCost: c.handlingCost,
            effectiveFrom: c.effectiveFrom.toISOString(),
          })),
        }
      }),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load products' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Save a new cost, effective from a date**

Create `src/app/api/products/[id]/cost/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { utcDay } from '@/lib/dates'

const Body = z.object({
  costPerItem: z.number().min(0),
  handlingCost: z.number().min(0),
  effectiveFrom: z.string(), // yyyy-mm-dd
})

/**
 * Saving a cost APPENDS a new point on the product's cost timeline — it never
 * overwrites history. Orders before `effectiveFrom` keep the cost they had.
 *
 * Saving twice for the same day updates that day's point rather than stacking
 * duplicates on it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())

    const { id } = await params
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid cost' }, { status: 400 })

    const product = await db.product.findUnique({ where: { id } })
    if (!product) return NextResponse.json({ error: 'No such product' }, { status: 404 })

    const day = utcDay(new Date(parsed.data.effectiveFrom))
    if (Number.isNaN(day.getTime())) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    }

    const costPerItem = toMinor(parsed.data.costPerItem)
    const handlingCost = toMinor(parsed.data.handlingCost)

    const existing = await db.productCost.findFirst({
      where: { productId: id, effectiveFrom: day },
    })

    if (existing) {
      await db.productCost.update({
        where: { id: existing.id },
        data: { costPerItem, handlingCost },
      })
    } else {
      await db.productCost.create({
        data: { productId: id, costPerItem, handlingCost, effectiveFrom: day },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save the cost' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/products
git commit -m "feat: product costs API with effective-from dating"
```

---

### Task 23: Product costs — the screen

**Files:**
- Create: `src/app/settings/costs/page.tsx`, `src/app/settings/costs/CostsClient.tsx`

- [ ] **Step 1: The page**

Create `src/app/settings/costs/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { CostsClient } from './CostsClient'

export default async function CostsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  return <CostsClient email={user.email} shops={shops} />
}
```

- [ ] **Step 2: The client**

Create `src/app/settings/costs/CostsClient.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { formatMoney, toMajor } from '@/lib/money'
import type { Shop } from '@/components/ShopSelector'

type Product = {
  id: string
  sku: string
  name: string
  sellingPrice: number
  costPerItem: number
  handlingCost: number
  missingCost: boolean
}

export function CostsClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [currency, setCurrency] = useState('NOK')
  const [products, setProducts] = useState<Product[]>([])
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)

  function load() {
    if (!shopId) return
    setLoading(true)
    fetch(`/api/products?shopId=${shopId}`)
      .then((r) => r.json())
      .then((d) => {
        setProducts(d.products ?? [])
        setCurrency(d.currency ?? 'NOK')
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [shopId])

  const shown = onlyMissing ? products.filter((p) => p.missingCost) : products
  const missing = products.filter((p) => p.missingCost).length

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email} />

      <main className="mx-auto max-w-6xl p-5">
        <h1 className="text-lg font-bold text-slate-900">Product costs</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every product ever sold appears here. Fill in the cost and it will be used for profit from the
          date you choose.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <select
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.currency})
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} className="accent-violet-700" />
            Only missing costs
          </label>

          {missing > 0 && (
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
              ⚠️ {missing} product{missing > 1 ? 's' : ''} without a cost
            </span>
          )}
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-right text-slate-500">
                <th className="px-3 py-2.5 text-left font-medium">Product</th>
                <th className="px-3 py-2.5 font-medium">Selling price</th>
                <th className="px-3 py-2.5 font-medium">Cost per item</th>
                <th className="px-3 py-2.5 font-medium">Handling</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="text-right text-slate-700">
              {loading ? (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-400">Loading…</td></tr>
              ) : shown.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-400">No products.</td></tr>
              ) : (
                shown.map((p) => (
                  <tr key={p.id} className={`border-t border-slate-100 ${p.missingCost ? 'bg-amber-50/60' : ''}`}>
                    <td className="px-3 py-2.5 text-left">
                      <div className="font-medium text-slate-900">{p.name}</div>
                      <div className="text-[11px] text-slate-400">SKU {p.sku}</div>
                    </td>
                    <td className="px-3 py-2.5">{formatMoney(p.sellingPrice, currency)}</td>
                    <td className={`px-3 py-2.5 ${p.missingCost ? 'font-semibold text-amber-700' : ''}`}>
                      {formatMoney(p.costPerItem, currency)}
                    </td>
                    <td className="px-3 py-2.5">{formatMoney(p.handlingCost, currency)}</td>
                    <td className="px-3 py-2.5">
                      <button onClick={() => setEditing(p)} className="font-semibold text-violet-700 hover:underline">
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {editing && (
        <CostModal
          product={editing}
          currency={currency}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function CostModal({
  product,
  currency,
  onClose,
  onSaved,
}: {
  product: Product
  currency: string
  onClose: () => void
  onSaved: () => void
}) {
  const [cost, setCost] = useState(String(toMajor(product.costPerItem)))
  const [handling, setHandling] = useState(String(toMajor(product.handlingCost)))
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    await fetch(`/api/products/${product.id}/cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        costPerItem: parseFloat(cost) || 0,
        handlingCost: parseFloat(handling) || 0,
        effectiveFrom,
      }),
    })
    setBusy(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-bold text-slate-900">Update cost</h2>
        <p className="mt-0.5 text-xs text-slate-500">{product.name}</p>

        <label className="mt-4 block text-xs font-medium text-slate-600">Cost per item ({currency})</label>
        <input
          type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />

        <label className="mt-3 block text-xs font-medium text-slate-600">Handling cost ({currency})</label>
        <input
          type="number" step="0.01" value={handling} onChange={(e) => setHandling(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />

        <label className="mt-3 block text-xs font-medium text-slate-600">Apply this cost from</label>
        <input
          type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          Orders <strong>before</strong> this date keep the previous cost.<br />
          Orders <strong>from</strong> this date onward use the new one.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-slate-600 hover:text-slate-900">Cancel</button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify in the browser**

With `npm run dev`, sign in as admin and visit `/settings/costs`. Pick a shop, edit a cost, set
"apply from" to today, save. Then go to `/dashboard` and check that **this month's** COGS changed but
an **earlier month's** did not. That is the effective-date rule working end to end.

- [ ] **Step 4: Commit**

```bash
git add src/app/settings/costs
git commit -m "feat: product costs screen with effective-from dating"
```

---

### Task 24: Operational expenses — API and screen

**Files:**
- Create: `src/app/api/expenses/route.ts`, `src/app/api/expenses/[id]/route.ts`, `src/app/settings/expenses/page.tsx`, `src/app/settings/expenses/ExpensesClient.tsx`

- [ ] **Step 1: The API**

Create `src/app/api/expenses/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { utcDay } from '@/lib/dates'

export const CATEGORIES = [
  'Overhead > Office',
  'Overhead > Employees',
  'Overhead > Subscriptions',
  'Overhead > Equipment',
  'Marketing > Digital Marketing',
  'Marketing > Design',
  'Marketing > Website Expenses',
  'Marketing > Content',
  'Operations > COGS',
  'Operations > Product Samples',
  'Operations > Importing Fees',
  'Fulfillment > Fulfillment',
  'Fulfillment > Warehouse',
  'Fulfillment > Handling',
  'Transaction fees',
  'Other',
] as const

const Body = z.object({
  shopId: z.string().min(1),
  label: z.string().min(1),
  category: z.string().min(1),
  amount: z.number().min(0),
  currency: z.string().length(3),
  recurrence: z.enum(['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  startDate: z.string(),
  endDate: z.string().nullable().optional(),
  active: z.boolean().default(true),
})

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    if (!shopId) return NextResponse.json({ error: 'shopId is required' }, { status: 400 })

    const expenses = await db.operationalExpense.findMany({
      where: { shopId },
      orderBy: { label: 'asc' },
    })

    return NextResponse.json({ expenses, categories: CATEGORIES })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load expenses' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid expense' }, { status: 400 })
    const d = parsed.data

    const expense = await db.operationalExpense.create({
      data: {
        shopId: d.shopId,
        label: d.label,
        category: d.category,
        amount: toMinor(d.amount),
        currency: d.currency.toUpperCase(),
        recurrence: d.recurrence,
        startDate: utcDay(new Date(d.startDate)),
        endDate: d.endDate ? utcDay(new Date(d.endDate)) : null,
        active: d.active,
      },
    })

    return NextResponse.json({ expense })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save the expense' }, { status: 500 })
  }
}
```

Create `src/app/api/expenses/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    await db.operationalExpense.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not delete the expense' }, { status: 500 })
  }
}
```

- [ ] **Step 2: The screen**

Create `src/app/settings/expenses/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { ExpensesClient } from './ExpensesClient'

export default async function ExpensesPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  return <ExpensesClient email={user.email} shops={shops} />
}
```

Create `src/app/settings/expenses/ExpensesClient.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { formatMoney } from '@/lib/money'
import type { Shop } from '@/components/ShopSelector'

type Expense = {
  id: string
  label: string
  category: string
  amount: number
  currency: string
  recurrence: string
  startDate: string
  active: boolean
}

const RECURRENCES = ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const RECURRENCE_LABEL: Record<string, string> = {
  ONE_TIME: 'One time', DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly',
}

export function ExpensesClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)

  function load() {
    if (!shopId) return
    setLoading(true)
    fetch(`/api/expenses?shopId=${shopId}`)
      .then((r) => r.json())
      .then((d) => {
        setExpenses(d.expenses ?? [])
        setCategories(d.categories ?? [])
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [shopId])

  const shop = shops.find((s) => s.id === shopId)

  async function remove(id: string) {
    await fetch(`/api/expenses/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email} />

      <main className="mx-auto max-w-5xl p-5">
        <h1 className="text-lg font-bold text-slate-900">Operational expenses</h1>
        <p className="mt-1 text-sm text-slate-500">
          Recurring costs are spread across the days of the period you are viewing, so profit is right for
          any date range.
        </p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <select
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {shops.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
            ))}
          </select>

          <button
            onClick={() => setAdding(true)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            + Add expense
          </button>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-left text-slate-500">
                <th className="px-3 py-2.5 font-medium">Expense</th>
                <th className="px-3 py-2.5 font-medium">Category</th>
                <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th className="px-3 py-2.5 font-medium">Recurrence</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="text-slate-700">
              {loading ? (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-400">Loading…</td></tr>
              ) : expenses.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-400">No expenses yet.</td></tr>
              ) : (
                expenses.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="px-3 py-2.5 font-medium text-slate-900">{e.label}</td>
                    <td className="px-3 py-2.5 text-slate-500">{e.category}</td>
                    <td className="px-3 py-2.5 text-right">{formatMoney(e.amount, e.currency)}</td>
                    <td className="px-3 py-2.5 text-slate-500">
                      {RECURRENCE_LABEL[e.recurrence] ?? e.recurrence}
                      {e.recurrence !== 'ONE_TIME' && <span className="text-slate-400"> (spread daily)</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        e.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {e.active ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button onClick={() => remove(e.id)} className="text-slate-400 hover:text-red-600">Delete</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {adding && shop && (
        <ExpenseModal
          shop={shop}
          categories={categories}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load() }}
        />
      )}
    </div>
  )
}

function ExpenseModal({
  shop, categories, onClose, onSaved,
}: {
  shop: Shop
  categories: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [label, setLabel] = useState('')
  const [category, setCategory] = useState(categories[0] ?? 'Other')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(shop.currency)
  const [recurrence, setRecurrence] = useState('MONTHLY')
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: shop.id,
        label,
        category,
        amount: parseFloat(amount) || 0,
        currency,
        recurrence,
        startDate,
        active: true,
      }),
    })
    setBusy(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="border-b border-slate-100 pb-3 text-base font-bold text-slate-900">Add operational expense</h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600">Recurrence</label>
            <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {RECURRENCES.map((r) => <option key={r} value={r}>{RECURRENCE_LABEL[r]}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600">Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-slate-600">Label</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="E.g. subscriptions, payroll"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-slate-600">Amount</label>
            <div className="mt-1 flex">
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}
                className="rounded-l-lg border border-r-0 border-slate-300 bg-slate-50 px-2 py-2 text-sm">
                {['NOK', 'SEK', 'DKK', 'EUR', 'USD'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="Enter amount"
                className="w-full rounded-r-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-slate-600">First payment</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button onClick={onClose} className="px-3 py-2 text-xs text-slate-600 hover:text-slate-900">Cancel</button>
          <button onClick={save} disabled={busy || !label}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
            {busy ? 'Saving…' : 'Save and close'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify in the browser**

Visit `/settings/expenses`, add a MONTHLY expense of 31 000 for a shop, then open `/dashboard` with
that shop selected and the range set to a **single day**. Its Op. Ex. must be ~1 000 — the daily
share. That is "spread daily" working end to end.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/expenses src/app/settings/expenses
git commit -m "feat: operational expenses — API and screen"
```

---

## Stage 7 — The Ambassador Portal

### Task 25: The portal API — and the security test that matters most

**Files:**
- Create: `src/app/api/portal/route.ts`
- Test: `src/app/api/portal/security.test.ts`

- [ ] **Step 1: Write the security test FIRST**

Create `src/app/api/portal/security.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { assertAmbassadorAccess, canViewAmbassador, AuthError } from '@/lib/auth/guard'
import type { SessionUser } from '@/lib/auth/session'

/**
 * The single most important rule in the system:
 * an ambassador can NEVER see another ambassador's money.
 * If this test ever fails, the product is broken and must not ship.
 */
const emma: SessionUser = { userId: 'u2', email: 'emma@x.c', role: 'AMBASSADOR', ambassadorId: 'emma-id' }
const johan: SessionUser = { userId: 'u3', email: 'johan@x.c', role: 'AMBASSADOR', ambassadorId: 'johan-id' }
const admin: SessionUser = { userId: 'u1', email: 'a@x.c', role: 'ADMIN', ambassadorId: null }

describe('ambassador data isolation', () => {
  it('lets Emma see Emma', () => {
    expect(() => assertAmbassadorAccess(emma, 'emma-id')).not.toThrow()
  })

  it('STOPS Emma seeing Johan', () => {
    expect(() => assertAmbassadorAccess(emma, 'johan-id')).toThrow(AuthError)
  })

  it('STOPS Johan seeing Emma', () => {
    expect(() => assertAmbassadorAccess(johan, 'emma-id')).toThrow(AuthError)
  })

  it('STOPS a logged-out visitor seeing anyone', () => {
    expect(() => assertAmbassadorAccess(null, 'emma-id')).toThrow(AuthError)
  })

  it('lets an admin see anyone', () => {
    expect(canViewAmbassador(admin, 'emma-id')).toBe(true)
    expect(canViewAmbassador(admin, 'johan-id')).toBe(true)
  })

  it('an ambassador with no linked ambassador record can see nobody', () => {
    const orphan: SessionUser = { userId: 'u9', email: 'x@x.c', role: 'AMBASSADOR', ambassadorId: null }
    expect(canViewAmbassador(orphan, 'emma-id')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/app/api/portal/security.test.ts`
Expected: PASS — 6 tests (the guard already exists from Task 16).

- [ ] **Step 3: The portal route**

Create `src/app/api/portal/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery } from '@/lib/api/range'
import { utcDay } from '@/lib/dates'
import { pct } from '@/lib/money'
import { buildRateTable, convert } from '@/lib/metrics/fx'
import { loadRates, ensureRates } from '@/lib/fx/rates'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'

const DISPLAY = 'USD'

/**
 * An ambassador's own figures — and ONLY their own.
 *
 * The ambassador id is taken from the SESSION, never from the query string.
 * There is therefore no id for a caller to tamper with.
 */
export async function GET(req: Request) {
  try {
    const user = await currentUser()
    if (!user) throw new AuthError('Sign in first')
    if (user.role !== 'AMBASSADOR' || !user.ambassadorId) {
      throw new AuthError('This page is for ambassadors')
    }

    const { from, to } = rangeFromQuery(new URL(req.url).searchParams)

    const me = await db.ambassador.findUniqueOrThrow({
      where: { id: user.ambassadorId },
      include: { codes: true },
    })

    const orders = await db.order.findMany({
      where: {
        ambassadorId: me.id, // <- from the session. Not from the request.
        placedAt: { gte: utcDay(from), lte: new Date(utcDay(to).getTime() + 86_400_000 - 1) },
        status: { notIn: [...EXCLUDED_STATUSES] },
      },
      include: { shop: { select: { name: true, currency: true } } },
      orderBy: { placedAt: 'desc' },
    })

    await ensureRates(from, to, [...new Set(orders.map((o) => o.currency))])
    const rates = buildRateTable(await loadRates())

    let sales = 0
    let commission = 0
    const recent = orders.slice(0, 10).map((o) => {
      const orderSales = convert(o.netSales, o.currency, o.placedAt, DISPLAY, rates)
      const orderCommission = convert(pct(o.netSales, me.commissionRate), o.currency, o.placedAt, DISPLAY, rates)
      return {
        id: o.id,
        date: o.placedAt.toISOString(),
        shop: o.shop.name,
        sales: orderSales,
        commission: orderCommission,
      }
    })

    for (const o of orders) {
      sales += convert(o.netSales, o.currency, o.placedAt, DISPLAY, rates)
      commission += convert(pct(o.netSales, me.commissionRate), o.currency, o.placedAt, DISPLAY, rates)
    }

    // Rank: where do I stand among all ambassadors this period?
    const everyone = await db.order.groupBy({
      by: ['ambassadorId'],
      where: {
        ambassadorId: { not: null },
        placedAt: { gte: utcDay(from), lte: new Date(utcDay(to).getTime() + 86_400_000 - 1) },
        status: { notIn: [...EXCLUDED_STATUSES] },
      },
      _sum: { netSales: true },
    })

    // Note: ranking compares raw netSales across currencies. Good enough for a rank,
    // and it never exposes another ambassador's figures — only a position.
    const better = everyone.filter((row) => (row._sum.netSales ?? 0) > (everyone.find((r) => r.ambassadorId === me.id)?._sum.netSales ?? 0)).length
    const totalAmbassadors = await db.ambassador.count({ where: { active: true } })

    return NextResponse.json({
      name: me.name,
      codes: me.codes.map((c) => c.code),
      commissionRate: me.commissionRate,
      currency: DISPLAY,
      sales,
      commission,
      orders: orders.length,
      rank: orders.length > 0 ? better + 1 : null,
      totalAmbassadors,
      recent,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load your figures' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/portal
git commit -m "feat: ambassador portal API — session-scoped, never id-from-query"
```

---

### Task 26: The portal screen

**Files:**
- Create: `src/app/portal/page.tsx`, `src/app/portal/PortalClient.tsx`

- [ ] **Step 1: The page**

Create `src/app/portal/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { PortalClient } from './PortalClient'

export default async function PortalPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role === 'ADMIN') redirect('/dashboard')

  return <PortalClient email={user.email} />
}
```

- [ ] **Step 2: The client**

Create `src/app/portal/PortalClient.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { KpiCard } from '@/components/KpiCard'
import { Money } from '@/components/Money'
import { DateRangePicker } from '@/components/DateRangePicker'
import { formatMoney } from '@/lib/money'
import type { Preset } from '@/lib/dates'

type Portal = {
  name: string
  codes: string[]
  commissionRate: number
  currency: string
  sales: number
  commission: number
  orders: number
  rank: number | null
  totalAmbassadors: number
  recent: { id: string; date: string; shop: string; sales: number; commission: number }[]
}

export function PortalClient({ email }: { email: string }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Portal | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }

    setLoading(true)
    fetch(`/api/portal?${params}`)
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [preset, from, to])

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email}>
        <DateRangePicker
          preset={preset}
          from={from}
          to={to}
          onChange={(next) => {
            setPreset(next.preset)
            if (next.from !== undefined) setFrom(next.from)
            if (next.to !== undefined) setTo(next.to)
          }}
        />
      </TopBar>

      <main className="mx-auto max-w-4xl p-5">
        {loading && !data ? (
          <div className="py-20 text-center text-sm text-slate-400">Loading…</div>
        ) : data ? (
          <>
            <h1 className="text-lg font-bold text-slate-900">Hi {data.name.split(' ')[0]} 👋</h1>
            <p className="mt-1 text-sm text-slate-500">
              Here is how your code{' '}
              <strong className="text-violet-700">{data.codes.join(', ') || '—'}</strong> is performing.
            </p>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label="Your sales" value={<Money minor={data.sales} currency={data.currency} />} />
              <KpiCard label="Orders" value={data.orders} />
              <KpiCard
                label="Your commission"
                value={<Money minor={data.commission} currency={data.currency} />}
                tone="good"
              />
              <KpiCard
                label="Your rank"
                value={
                  data.rank ? (
                    <span>#{data.rank} <span className="text-xs font-medium text-slate-400">of {data.totalAmbassadors}</span></span>
                  ) : '—'
                }
                tone="accent"
              />
            </div>

            <h2 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Recent orders with your code
            </h2>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 text-right text-slate-500">
                    <th className="px-3 py-2.5 text-left font-medium">Date</th>
                    <th className="px-3 py-2.5 text-left font-medium">Shop</th>
                    <th className="px-3 py-2.5 font-medium">Sale</th>
                    <th className="px-3 py-2.5 font-medium">Your commission</th>
                  </tr>
                </thead>
                <tbody className="text-right text-slate-700">
                  {data.recent.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-10 text-center text-slate-400">
                        No orders with your code in this period yet.
                      </td>
                    </tr>
                  ) : (
                    data.recent.map((o) => (
                      <tr key={o.id} className="border-t border-slate-100">
                        <td className="px-3 py-2.5 text-left">{new Date(o.date).toLocaleDateString()}</td>
                        <td className="px-3 py-2.5 text-left">{o.shop}</td>
                        <td className="px-3 py-2.5">{formatMoney(o.sales, data.currency)}</td>
                        <td className="px-3 py-2.5 font-semibold text-emerald-600">
                          {formatMoney(o.commission, data.currency)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-[11px] text-slate-400">
              You earn {(data.commissionRate * 100).toFixed(0)}% of the net sale value of every order that uses
              your code. Figures are shown in USD.
            </p>
          </>
        ) : null}
      </main>
    </div>
  )
}
```

- [ ] **Step 3: Verify in the browser**

Sign in as `emma@ambassador.test` / `password123`. You must see Emma's own sales, commission and
rank. Now try to visit `/dashboard` directly — you must be **redirected back to `/portal`**. Try
`/api/metrics` — it must return **403**.

- [ ] **Step 4: Commit**

```bash
git add src/app/portal
git commit -m "feat: ambassador portal screen"
```

---

## Stage 8 — WooCommerce Sync

Everything so far runs on seeded data. This stage connects real shops. The same code path serves
both, so nothing about the dashboard changes when the data becomes real.

### Task 27: Mapping a WooCommerce order onto our own shape

The trickiest part of the whole integration, so it gets tested on its own, with a real WooCommerce
payload shape.

**Files:**
- Create: `src/lib/woo/map.ts`
- Test: `src/lib/woo/map.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/woo/map.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapOrder, type WooOrder } from './map'

// A realistic WooCommerce order. Woo gives strings, and line `total` is
// ALREADY after discount and EXCLUDING tax — which is exactly our net sales.
const woo: WooOrder = {
  id: 501,
  number: '501',
  status: 'completed',
  currency: 'NOK',
  date_created_gmt: '2026-07-10T09:30:00',
  discount_total: '100.00',
  discount_tax: '25.00',
  shipping_total: '50.00',
  shipping_tax: '12.50',
  total_tax: '237.50',
  total: '1237.50',
  coupon_lines: [{ code: 'emma10' }],
  line_items: [
    { id: 1, product_id: 9001, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 2, subtotal: '1000.00', total: '900.00' },
  ],
}

describe('mapOrder', () => {
  it('reads net sales as the line total AFTER discount and EXCLUDING VAT', () => {
    const o = mapOrder(woo)
    expect(o.grossSales).toBe(100000) // subtotal 1000.00 before discount
    expect(o.discountTotal).toBe(10000) //  discount  100.00
    expect(o.netSales).toBe(90000) //  net       900.00  <- commission base
  })

  it('never lets VAT into revenue', () => {
    const o = mapOrder(woo)
    expect(o.taxTotal).toBe(23750) // recorded...
    expect(o.netSales).toBe(90000) // ...but not in net sales
    expect(o.shippingCharged).toBe(5000) // shipping ex-VAT, not 62.50
  })

  it('picks up the coupon code, uppercased so matching is reliable', () => {
    expect(mapOrder(woo).couponCode).toBe('EMMA10')
  })

  it('has no coupon when none was used', () => {
    expect(mapOrder({ ...woo, coupon_lines: [] }).couponCode).toBeNull()
  })

  it('takes the FIRST coupon when several were used', () => {
    const o = mapOrder({ ...woo, coupon_lines: [{ code: 'sofia10' }, { code: 'emma10' }] })
    expect(o.couponCode).toBe('SOFIA10')
  })

  it('maps the line items', () => {
    const o = mapOrder(woo)
    expect(o.items).toHaveLength(1)
    expect(o.items[0].quantity).toBe(2)
    expect(o.items[0].lineNetTotal).toBe(90000) // after discount, ex VAT
    expect(o.items[0].externalProductId).toBe('9001')
  })

  it('carries the status through so refunds can be excluded downstream', () => {
    expect(mapOrder({ ...woo, status: 'refunded' }).status).toBe('refunded')
  })

  it('survives a missing or malformed number without crashing', () => {
    const o = mapOrder({ ...woo, discount_total: '', shipping_total: undefined as unknown as string })
    expect(o.discountTotal).toBe(0)
    expect(o.shippingCharged).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/woo/map.test.ts`
Expected: FAIL — cannot resolve `./map`.

- [ ] **Step 3: Implement**

Create `src/lib/woo/map.ts`:

```ts
import { toMinor } from '../money'

export type WooLineItem = {
  id: number
  product_id: number
  sku: string
  name: string
  quantity: number
  subtotal: string // BEFORE discount, excl tax
  total: string // AFTER discount, excl tax  <- this is net
}

export type WooOrder = {
  id: number
  number: string
  status: string
  currency: string
  date_created_gmt: string
  discount_total: string
  discount_tax: string
  shipping_total: string
  shipping_tax: string
  total_tax: string
  total: string
  coupon_lines: { code: string }[]
  line_items: WooLineItem[]
}

export type MappedOrder = {
  externalId: string
  number: string
  status: string
  currency: string
  placedAt: Date
  grossSales: number
  discountTotal: number
  netSales: number
  shippingCharged: number
  taxTotal: number
  total: number
  couponCode: string | null
  items: {
    externalProductId: string
    sku: string
    name: string
    quantity: number
    unitPrice: number
    lineNetTotal: number
  }[]
}

/** WooCommerce hands us strings, and sometimes nothing at all. */
const num = (v: string | undefined | null): number => toMinor(v ? parseFloat(v) || 0 : 0)

/**
 * Turn a WooCommerce order into our own shape.
 *
 * The critical detail: in WooCommerce, a line item's `subtotal` is the value
 * BEFORE discount and `total` is the value AFTER discount — and BOTH exclude
 * tax. So `total` is exactly our net sales, which is exactly the commission base.
 *
 * VAT (`total_tax`) is recorded for reference and never enters revenue.
 */
export function mapOrder(woo: WooOrder): MappedOrder {
  const grossSales = woo.line_items.reduce((sum, li) => sum + num(li.subtotal), 0)
  const netSales = woo.line_items.reduce((sum, li) => sum + num(li.total), 0)

  // Prefer the discount implied by the lines; fall back to Woo's own figure.
  const discountTotal = grossSales - netSales || num(woo.discount_total)

  return {
    externalId: String(woo.id),
    number: woo.number,
    status: woo.status,
    currency: woo.currency,
    placedAt: new Date(woo.date_created_gmt + 'Z'),
    grossSales,
    discountTotal,
    netSales,
    shippingCharged: num(woo.shipping_total), // ex VAT — shipping_tax stays out
    taxTotal: num(woo.total_tax),
    total: num(woo.total),
    couponCode: woo.coupon_lines?.[0]?.code?.toUpperCase() ?? null,
    items: woo.line_items.map((li) => ({
      externalProductId: String(li.product_id),
      sku: li.sku || String(li.product_id),
      name: li.name,
      quantity: li.quantity,
      unitPrice: li.quantity ? Math.round(num(li.subtotal) / li.quantity) : 0,
      lineNetTotal: num(li.total),
    })),
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/woo/map.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/woo/map.ts src/lib/woo/map.test.ts
git commit -m "feat: map WooCommerce orders — net sales excludes VAT"
```

---

### Task 28: The sync

**Files:**
- Create: `src/lib/woo/client.ts`, `src/lib/woo/sync.ts`, `src/app/api/sync/route.ts`

- [ ] **Step 1: The client**

Create `src/lib/woo/client.ts`:

```ts
import type { WooOrder } from './map'

export type WooCredentials = {
  url: string // https://shop.example.com
  key: string
  secret: string
}

/**
 * Fetch orders changed since `since`, one page at a time.
 * WooCommerce caps `per_page` at 100.
 */
export async function fetchOrders(creds: WooCredentials, since: Date | null): Promise<WooOrder[]> {
  const all: WooOrder[] = []
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      orderby: 'date',
      order: 'asc',
    })
    if (since) params.set('modified_after', since.toISOString().slice(0, 19))

    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
    })

    if (!res.ok) {
      throw new Error(`WooCommerce responded ${res.status}: ${await res.text()}`)
    }

    const batch = (await res.json()) as WooOrder[]
    all.push(...batch)
    if (batch.length < 100) break // last page
  }

  return all
}
```

- [ ] **Step 2: The sync**

Create `src/lib/woo/sync.ts`:

```ts
import { db } from '../db'
import { fetchOrders } from './client'
import { mapOrder } from './map'

export type SyncResult = {
  shopId: string
  shopName: string
  ok: boolean
  ordersSynced: number
  error?: string
}

/**
 * Pull a shop's orders and store them.
 *
 * - Only orders changed since the last successful sync are requested.
 * - Products are discovered from the orders themselves — anything ever sold appears
 *   in Product Costs automatically, with no cost until someone enters one.
 * - Ambassador attribution is resolved HERE and frozen on the order, so renaming or
 *   reassigning a code later can never rewrite past commissions.
 * - On failure, lastSyncAt is left untouched, so the next run picks up the same
 *   window again and nothing is silently skipped.
 */
export async function syncShop(shopId: string): Promise<SyncResult> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } })
  const base = { shopId: shop.id, shopName: shop.name }

  if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
    return { ...base, ok: false, ordersSynced: 0, error: 'No WooCommerce credentials for this shop' }
  }

  try {
    const orders = await fetchOrders(
      { url: shop.wooUrl, key: shop.wooKey, secret: shop.wooSecret },
      shop.lastSyncAt,
    )

    // Load the code -> ambassador map once, rather than per order.
    const codes = await db.ambassadorCode.findMany()
    const byCode = new Map(codes.map((c) => [c.code.toUpperCase(), c]))

    let synced = 0

    for (const raw of orders) {
      const o = mapOrder(raw)

      // Attribute — a code scoped to another shop does not count here.
      let ambassadorId: string | null = null
      if (o.couponCode) {
        const match = byCode.get(o.couponCode)
        if (match && (!match.shopId || match.shopId === shop.id)) {
          ambassadorId = match.ambassadorId
        }
      }

      // Make sure every product on the order exists.
      const productIds = new Map<string, string>()
      for (const item of o.items) {
        const product = await db.product.upsert({
          where: { shopId_externalId: { shopId: shop.id, externalId: item.externalProductId } },
          create: {
            shopId: shop.id,
            externalId: item.externalProductId,
            sku: item.sku,
            name: item.name,
            lastPrice: item.unitPrice,
          },
          update: { name: item.name, sku: item.sku, lastPrice: item.unitPrice },
        })
        productIds.set(item.externalProductId, product.id)
      }

      const data = {
        shopId: shop.id,
        externalId: o.externalId,
        number: o.number,
        placedAt: o.placedAt,
        status: o.status,
        currency: o.currency,
        grossSales: o.grossSales,
        discountTotal: o.discountTotal,
        netSales: o.netSales,
        shippingCharged: o.shippingCharged,
        taxTotal: o.taxTotal,
        total: o.total,
        couponCode: o.couponCode,
        ambassadorId,
      }

      const order = await db.order.upsert({
        where: { shopId_externalId: { shopId: shop.id, externalId: o.externalId } },
        create: data,
        update: data,
      })

      // Rewrite the lines rather than trying to diff them — simpler and always correct.
      await db.orderItem.deleteMany({ where: { orderId: order.id } })
      await db.orderItem.createMany({
        data: o.items.map((item) => ({
          orderId: order.id,
          productId: productIds.get(item.externalProductId)!,
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineNetTotal: item.lineNetTotal,
        })),
      })

      synced++
    }

    // Only now — after everything landed — do we move the watermark forward.
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: new Date() } })

    return { ...base, ok: true, ordersSynced: synced }
  } catch (e) {
    // lastSyncAt is deliberately NOT updated, so the next run retries this window.
    return {
      ...base,
      ok: false,
      ordersSynced: 0,
      error: e instanceof Error ? e.message : 'Sync failed',
    }
  }
}

export async function syncAllShops(): Promise<SyncResult[]> {
  const shops = await db.shop.findMany({ where: { active: true, wooUrl: { not: null } } })
  const results: SyncResult[] = []
  for (const shop of shops) results.push(await syncShop(shop.id))
  return results
}
```

- [ ] **Step 3: The route**

Create `src/app/api/sync/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { syncAllShops, syncShop } from '@/lib/woo/sync'

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    const results = shopId ? [await syncShop(shopId)] : await syncAllShops()

    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Verify the sync is safe to run twice**

Add to `src/lib/woo/map.test.ts` — a test proving the upsert key is stable, which is what makes a
re-run harmless:

```ts
  it('produces a stable external id, so syncing twice updates rather than duplicates', () => {
    const a = mapOrder(woo)
    const b = mapOrder({ ...woo, status: 'processing' }) // same order, changed status
    expect(a.externalId).toBe(b.externalId)
  })
```

Run: `npx vitest run src/lib/woo/map.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/woo src/app/api/sync
git commit -m "feat: WooCommerce sync — orders, products, ambassador attribution"
```

---

### Task 29: The shops settings screen

**Files:**
- Create: `src/app/settings/shops/page.tsx`, `src/app/settings/shops/ShopsClient.tsx`, `src/app/api/shops/[id]/route.ts`

- [ ] **Step 1: The update route**

Create `src/app/api/shops/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const Body = z.object({
  wooUrl: z.string().url().or(z.literal('')),
  wooKey: z.string(),
  wooSecret: z.string(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    await db.shop.update({
      where: { id },
      data: {
        wooUrl: parsed.data.wooUrl || null,
        wooKey: parsed.data.wooKey || null,
        wooSecret: parsed.data.wooSecret || null,
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save' }, { status: 500 })
  }
}
```

- [ ] **Step 2: The screen**

Create `src/app/settings/shops/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { ShopsClient } from './ShopsClient'

export default async function ShopsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({ orderBy: { name: 'asc' } })

  return (
    <ShopsClient
      email={user.email}
      shops={shops.map((s) => ({
        id: s.id,
        name: s.name,
        currency: s.currency,
        wooUrl: s.wooUrl ?? '',
        connected: Boolean(s.wooUrl && s.wooKey && s.wooSecret),
        lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
      }))}
    />
  )
}
```

Create `src/app/settings/shops/ShopsClient.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { TopBar } from '@/components/TopBar'

type Row = {
  id: string
  name: string
  currency: string
  wooUrl: string
  connected: boolean
  lastSyncAt: string | null
}

export function ShopsClient({ email, shops }: { email: string; shops: Row[] }) {
  const router = useRouter()
  const [editing, setEditing] = useState<Row | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')

  async function syncAll() {
    setSyncing(true)
    setMessage('')
    const res = await fetch('/api/sync', { method: 'POST' })
    const data = await res.json()

    const results: { shopName: string; ok: boolean; ordersSynced: number; error?: string }[] = data.results ?? []
    const good = results.filter((r) => r.ok)
    const bad = results.filter((r) => !r.ok)

    setMessage(
      `Synced ${good.reduce((n, r) => n + r.ordersSynced, 0)} orders from ${good.length} shop(s).` +
        (bad.length ? ` Failed: ${bad.map((r) => `${r.shopName} (${r.error})`).join(', ')}` : ''),
    )
    setSyncing(false)
    router.refresh()
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email} />

      <main className="mx-auto max-w-4xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-900">Shops</h1>
            <p className="mt-1 text-sm text-slate-500">
              Connect each WooCommerce store. Until a store is connected it shows seeded sample data.
            </p>
          </div>
          <button
            onClick={syncAll}
            disabled={syncing}
            className="rounded-lg bg-violet-700 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-60"
          >
            {syncing ? 'Syncing…' : '⟳ Sync all'}
          </button>
        </div>

        {message && (
          <div className="mt-4 rounded-lg bg-slate-100 px-4 py-3 text-xs text-slate-700">{message}</div>
        )}

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-left text-slate-500">
                <th className="px-3 py-2.5 font-medium">Shop</th>
                <th className="px-3 py-2.5 font-medium">Currency</th>
                <th className="px-3 py-2.5 font-medium">Connection</th>
                <th className="px-3 py-2.5 font-medium">Last sync</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="text-slate-700">
              {shops.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="px-3 py-2.5 font-medium text-slate-900">{s.name}</td>
                  <td className="px-3 py-2.5">{s.currency}</td>
                  <td className="px-3 py-2.5">
                    {s.connected ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        Connected
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                        Sample data
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-slate-500">
                    {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button onClick={() => setEditing(s)} className="font-semibold text-violet-700 hover:underline">
                      {s.connected ? 'Edit' : 'Connect'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      {editing && (
        <ConnectModal
          shop={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function ConnectModal({ shop, onClose, onSaved }: { shop: Row; onClose: () => void; onSaved: () => void }) {
  const [wooUrl, setWooUrl] = useState(shop.wooUrl)
  const [wooKey, setWooKey] = useState('')
  const [wooSecret, setWooSecret] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    await fetch(`/api/shops/${shop.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wooUrl, wooKey, wooSecret }),
    })
    setBusy(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-bold text-slate-900">Connect {shop.name}</h2>
        <p className="mt-1 text-xs text-slate-500">
          In WordPress: WooCommerce → Settings → Advanced → REST API → Add key (Read access).
        </p>

        <label className="mt-4 block text-xs font-medium text-slate-600">Store URL</label>
        <input value={wooUrl} onChange={(e) => setWooUrl(e.target.value)} placeholder="https://mazzetti.no"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <label className="mt-3 block text-xs font-medium text-slate-600">Consumer key</label>
        <input value={wooKey} onChange={(e) => setWooKey(e.target.value)} placeholder="ck_…"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <label className="mt-3 block text-xs font-medium text-slate-600">Consumer secret</label>
        <input type="password" value={wooSecret} onChange={(e) => setWooSecret(e.target.value)} placeholder="cs_…"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-slate-600">Cancel</button>
          <button onClick={save} disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/settings/shops src/app/api/shops
git commit -m "feat: shops settings — connect WooCommerce and sync"
```

---

### Task 30: Navigation between the screens

**Files:**
- Modify: `src/components/TopBar.tsx`
- Create: `src/app/page.tsx` (replace the Next.js placeholder)

- [ ] **Step 1: Add nav links to the top bar**

In `src/components/TopBar.tsx`, add navigation between the `📊 ecom-analytics` logo and the right-hand
controls. Replace the opening `<div className="font-bold tracking-tight">📊 ecom-analytics</div>` with:

```tsx
      <div className="flex items-center gap-5">
        <div className="font-bold tracking-tight">📊 ecom-analytics</div>
        {!hideNav && (
          <nav className="flex items-center gap-3 text-xs text-white/70">
            <a href="/dashboard" className="hover:text-white">Dashboard</a>
            <a href="/settings/costs" className="hover:text-white">Product costs</a>
            <a href="/settings/expenses" className="hover:text-white">Expenses</a>
            <a href="/settings/shops" className="hover:text-white">Shops</a>
          </nav>
        )}
      </div>
```

and extend the props so the ambassador portal can hide the admin nav:

```tsx
export function TopBar({
  email,
  children,
  hideNav = false,
}: {
  email: string
  children?: React.ReactNode
  hideNav?: boolean
}) {
```

In `src/app/portal/PortalClient.tsx`, pass `hideNav`:

```tsx
      <TopBar email={email} hideNav>
```

- [ ] **Step 2: The root page sends people where they belong**

Replace `src/app/page.tsx` entirely:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'

export default async function Home() {
  const user = await currentUser()
  if (!user) redirect('/login')
  redirect(user.role === 'ADMIN' ? '/dashboard' : '/portal')
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/TopBar.tsx src/app/page.tsx src/app/portal/PortalClient.tsx
git commit -m "feat: navigation and role-aware landing"
```

---

## Stage 9 — End to End, and All Green

### Task 31: End-to-end tests

**Files:**
- Create: `playwright.config.ts`, `e2e/admin.spec.ts`, `e2e/ambassador.spec.ts`

- [ ] **Step 1: Playwright config**

Create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
```

- [ ] **Step 2: The admin journey**

Create `e2e/admin.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('admin sees the dashboard with real figures', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await expect(page).toHaveURL(/\/dashboard/)
  await expect(page.getByText('Net revenue')).toBeVisible()
  await expect(page.getByText('Compare shops')).toBeVisible()

  // The total row must show actual money, not a dash or a zero.
  const total = page.getByRole('row', { name: /Total/ })
  await expect(total).toBeVisible()
  await expect(total).toContainText('$')
})

test('changing the date range changes the numbers', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await expect(page.getByText('Compare shops')).toBeVisible()

  const before = await page.getByRole('row', { name: /Total/ }).innerText()

  await page.getByRole('button', { name: /📅/ }).click()
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  await expect(async () => {
    const after = await page.getByRole('row', { name: /Total/ }).innerText()
    expect(after).not.toBe(before)
  }).toPass({ timeout: 10_000 })
})

test('isolating a single shop switches to that shop own currency', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await expect(page.getByText('Compare shops')).toBeVisible()

  // Across all 11 shops the figures are consolidated into USD.
  await expect(page.getByRole('row', { name: /Total/ })).toContainText('$')

  // Isolate one Norwegian shop with its "Only" button.
  await page.getByRole('button', { name: /🏬/ }).click()
  await page.getByRole('button', { name: 'Only Mazzetti.no' }).click()

  // One NOK shop -> figures are in NOK, not USD.
  await expect(page.getByRole('row', { name: /Total/ })).toContainText('NOK', { timeout: 10_000 })
  await expect(page.getByRole('row', { name: /Total/ })).not.toContainText('$')
})

test('the leaderboard names the top ambassador', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await expect(page.getByText('Top ambassadors')).toBeVisible()
  await expect(page.getByRole('cell', { name: '1', exact: true }).first()).toBeVisible()
})
```

- [ ] **Step 3: The ambassador journey — including the security boundary**

Create `e2e/ambassador.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('an ambassador sees their own figures', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  await expect(page).toHaveURL(/\/portal/)
  await expect(page.getByText('Your sales')).toBeVisible()
  await expect(page.getByText('Your commission')).toBeVisible()
  await expect(page.getByText('EMMA10')).toBeVisible()
})

test('an ambassador CANNOT reach the admin dashboard', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/portal/) // bounced back
  await expect(page.getByText('Compare shops')).toHaveCount(0)
})

test('an ambassador CANNOT read the admin metrics API', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  const res = await page.request.get('/api/metrics?preset=this_month')
  expect(res.status()).toBe(403)
})

test('an ambassador never sees company costs or profit', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')
  await expect(page.getByText('Your sales')).toBeVisible()

  const body = await page.locator('body').innerText()
  expect(body).not.toContain('COGS')
  expect(body).not.toContain('Net profit')
  expect(body).not.toContain('Op. Ex.')
})

test('a signed-out visitor is sent to the login page', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)
})
```

- [ ] **Step 4: Run them**

```bash
npx playwright install chromium
npm run db:seed
npm run test:e2e
```

Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e/
git commit -m "test: end-to-end — admin journey and ambassador security boundary"
```

---

### Task 32: All green

- [ ] **Step 1: Reset to a known state and run everything**

```bash
npm run db:push
npm run db:seed
npm test
npm run test:e2e
npm run build
npx tsc --noEmit
```

**Every one of these must pass.** Expected:
- `npm test` — all unit + integration tests green (money, dates, costs, expenses, fx, engine,
  ambassadors, auth, guard, range, woo/map, security, load.integration)
- `npm run test:e2e` — 9 Playwright tests green
- `npm run build` — compiles with no errors
- `npx tsc --noEmit` — no type errors

- [ ] **Step 2: Drive the real app one last time**

```bash
npm run dev
```

Walk through it as a person, not a test:
1. Sign in as `admin@ecom.test` / `password123`.
2. The dashboard shows six KPI cards, 11 shops in the compare table, a Total row, and a leaderboard.
3. Switch the range to "Today", then "This year" — the numbers move.
4. Select one shop — the currency changes from USD to that shop's own.
5. `/settings/costs` — edit a cost, apply it from today, save. The dashboard's COGS for this month
   changes; an earlier month's does not.
6. `/settings/expenses` — add a MONTHLY expense; a single-day view charges roughly 1/30th of it.
7. Sign out. Sign in as `emma@ambassador.test` / `password123`.
8. The portal shows Emma's own sales, commission, and rank — and no company costs.
9. Try `/dashboard` — you are bounced back to `/portal`.

- [ ] **Step 3: Write the README**

Create `README.md`:

```markdown
# ecom-analytics

Analytics for our WooCommerce shops: sales, true net profit, and ambassador tracking.

## Running it

```bash
npm install
npm run db:push     # create the database
npm run db:seed     # fill it with sample data
npm run dev         # http://localhost:3000
```

Sign in with:
- Admin: `admin@ecom.test` / `password123`
- Ambassador: `emma@ambassador.test` / `password123`

## How the money is calculated

Every revenue figure **excludes VAT** — VAT was never our money.

```
  Gross sales        line value before discount     (excl VAT)
- Discounts
= NET SALES          <- ambassadors earn 10% of this
+ Shipping charged                                  (excl VAT)
= NET REVENUE
- COGS               qty x (cost + handling), at the cost in effect ON THE ORDER'S DATE
- Operational expenses   spread across the days of the period you are viewing
- Ambassador commission
= NET PROFIT
```

Refunded and cancelled orders count for nothing — no revenue, no commission.

## Where things live

- `src/lib/metrics/` — all the money maths. Pure functions, heavily tested. **Start here.**
- `src/lib/woo/` — talking to WooCommerce.
- `src/lib/auth/` — logins and the rule that an ambassador only ever sees their own data.
- `src/app/` — the pages and API routes. Thin: they just call the above.

## Connecting a real shop

Settings → Shops → Connect. You need the store URL and a WooCommerce REST API key
(WordPress → WooCommerce → Settings → Advanced → REST API → Add key, Read access).
Then press "Sync all". Until a shop is connected it shows seeded sample data.

## Tests

```bash
npm test          # unit + integration
npm run test:e2e  # browser tests
```
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README — how to run it and how the money is calculated"
```

- [ ] **Step 5: Final verification**

Run the full suite one more time and confirm it is green:

```bash
npm test && npm run test:e2e && npm run build
```

**Do not claim the work is done until this command sequence passes and you have seen the output.**

---

## What is NOT in Phase 1

Deliberately out of scope, each with a clean place to attach later:

- Meta / Google Ads, ROAS, CTR (Phase 2) — ad spend becomes another cost feeding the same engine
- Bounce rate, customer acquisition, LTV (Phase 3)
- Shipping provider, delivery times, delayed orders (Phase 4) — shipping cost becomes another cost line
- Customer service performance (Phase 5)
- Payment processing fees, returns forecasting, Google Sheets sync, CSV import
