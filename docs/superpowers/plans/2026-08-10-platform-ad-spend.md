# Platform Ad Spend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show ad spend broken down by platform on the Marketing page, let the workspace choose its display currency, and make the ad spend total independently checkable against Ads Manager.

**Architecture:** Platform totals accumulate inside the loop `buildMarketing` already runs, so they cannot disagree with the headline. The spend check panel reuses the same already-fetched rows, reporting each account's UNCONVERTED native total. Display currency becomes a `Setting` column read by `loadMetricsInput`. One genuine data-loss bug in `syncWindow` is fixed first, on its own.

**Tech Stack:** Next.js 16 (App Router), React 19, Prisma 6.19.3 / PostgreSQL, Vitest 4.1.10, Tailwind v4, Recharts, Zod.

## Global Constraints

- **Money is INTEGER MINOR UNITS everywhere.** Conversion happens at read time only. Never store converted money.
- **Test command:** `npx vitest run <path>` from the worktree root. Full suite: `npx vitest run`.
- **DOM tests must start with `// @vitest-environment jsdom` as the literal first line.** The repo default env is `node`.
- **Every DOM test file must `import '@testing-library/jest-dom/vitest'`.** There is no global setup file, so without that line `toBeInTheDocument`, `toHaveStyle` and `toHaveTextContent` fail with `Invalid Chai property`. Verified by probe on 2026-08-10.
- **Use `fireEvent` from `@testing-library/react`.** `@testing-library/user-event` is NOT installed — do not import it.
- **Recharts needs no size mocking for these tests.** Verified by probe: the legend, heading and toggle render outside the `ResponsiveContainer`, so they are queryable under jsdom without stubbing `clientWidth`. Do not assert on SVG paths — those genuinely do not render at zero size.
- **Never `git add -A`.** It sweeps `next-env.d.ts`. Always `git add <explicit paths>`.
- **Never run `git stash`, `git checkout -- .`, `git reset`, or `git restore`.** They silently destroy work in this repo.
- **Never edit files with PowerShell `Get-Content`/`Set-Content`.** PS 5.1 mojibakes UTF-8. Use the Edit/Write tools.
- **Local Postgres only.** Tests run against `%LOCALAPPDATA%\panetti-pg`. Never point tests at the live Neon database. Never run `npm run db:seed` — it wipes all data.
- **Schema changes:** run `npx prisma db push` then `npx prisma generate` after editing `prisma/schema.prisma`.
- DB-backed tests scope their rows with a per-file marker string (see `sync.test.ts`'s `MARKER = '[ads-test]'`) so parallel files never collide.
- A ratio with a zero denominator renders as `—`, never as `0`.

---

## File Structure

**Modified:**
- `src/lib/ads/sync.ts` — `syncWindow` gap fix (Task 1)
- `prisma/schema.prisma` — `Setting.displayCurrency` (Task 2)
- `src/lib/settings.ts` — default + allowed list (Task 2)
- `src/app/api/settings/route.ts` — validation (Task 2)
- `src/app/settings/general/GeneralClient.tsx`, `page.tsx` — the picker (Task 2)
- `src/lib/data/load.ts` — read the setting (Task 2)
- `src/lib/ads/marketing.ts` — `byPlatform` + per-platform series (Task 3)
- `src/app/api/marketing/route.ts` — widen account select, return `spendCheck` (Task 4)
- `src/components/marketing/MarketingChart.tsx` — by-platform toggle (Task 7)
- `src/app/marketing/MarketingClient.tsx` — mount the new pieces (Task 8)

**Created:**
- `src/lib/ads/spend-check.ts` + test — pure per-account reconciliation (Task 4)
- `src/components/marketing/PlatformCard.tsx` + test (Task 5)
- `src/components/marketing/PlatformTable.tsx` + test (Task 6)
- `src/components/marketing/SpendCheck.tsx` + test (Task 8)

---

## Task 1: Close the sync gap

A sync that stops for more than 35 days currently leaves a permanent hole. `syncWindow` reads `lastSyncAt` as a boolean and never as a date, so a recovering account fetches 35 days and then stamps `lastSyncAt = now`, sealing the gap. Nothing ever backfills it.

**Files:**
- Modify: `src/lib/ads/sync.ts:48-52`
- Test: `src/lib/ads/sync.test.ts:43-53`

**Interfaces:**
- Consumes: nothing
- Produces: `syncWindow(lastSyncAt: Date | null, now: Date): { from: Date; to: Date }` — signature unchanged

- [ ] **Step 1: Write the failing test**

Add to `src/lib/ads/sync.test.ts`, inside the existing `describe('syncWindow', ...)` block:

```ts
  it('reaches back to the last successful sync, not a fixed 35 days', () => {
    // A token expired on 11 June and nobody noticed until 10 August. The
    // account kept its old lastSyncAt while it errored, which is correct.
    // What is not correct is fetching only 35 days on recovery and then
    // stamping lastSyncAt = now: days 36-60 are then never fetched by
    // anything, ever, and the hole is sealed silently.
    const now = new Date('2026-08-10T10:00:00Z')
    const stale = syncWindow(new Date('2026-06-11T00:00:00Z'), now)

    // 60 days of gap plus the 35-day restate window.
    expect((stale.to.getTime() - stale.from.getTime()) / DAY_MS).toBe(95)

    // The point of the number: the day after the last sync is inside the window.
    expect(stale.from.getTime()).toBeLessThan(new Date('2026-06-12T00:00:00Z').getTime())
  })

  it('caps a very stale account at the backfill limit rather than asking for ten years', () => {
    const now = new Date('2026-08-10T10:00:00Z')
    const ancient = syncWindow(new Date('2024-01-01T00:00:00Z'), now)
    expect((ancient.to.getTime() - ancient.from.getTime()) / DAY_MS).toBe(365)
  })

  it('floors at the restate window when lastSyncAt is in the future', () => {
    // Clock skew between the app server and the database must not produce a
    // negative window that fetches nothing.
    const now = new Date('2026-08-10T10:00:00Z')
    const skewed = syncWindow(new Date('2026-08-20T00:00:00Z'), now)
    expect((skewed.to.getTime() - skewed.from.getTime()) / DAY_MS).toBe(35)
  })
```

- [ ] **Step 2: Run the tests and watch the first one fail**

Run: `npx vitest run src/lib/ads/sync.test.ts -t "reaches back to the last successful sync"`

Expected: FAIL — `expected 35 to be 95`. If it passes, stop: the test is not exercising the bug and something is wrong with the setup.

- [ ] **Step 3: Fix `syncWindow`**

Replace `src/lib/ads/sync.ts:48-52` with:

```ts
export function syncWindow(lastSyncAt: Date | null, now: Date): { from: Date; to: Date } {
  const to = utcDay(now)
  if (!lastSyncAt) return { from: new Date(to.getTime() - BACKFILL_DAYS * DAY_MS), to }

  // lastSyncAt is a DATE, not a yes/no. An account that stopped syncing for 60
  // days needs those 60 days re-fetched as well as the restate window, because
  // nothing else will ever go back for them: the next successful sync writes
  // lastSyncAt = now and the hole becomes permanent and invisible.
  const daysSince = Math.ceil((to.getTime() - utcDay(lastSyncAt).getTime()) / DAY_MS)
  const back = Math.min(BACKFILL_DAYS, Math.max(RESTATE_DAYS, daysSince + RESTATE_DAYS))
  return { from: new Date(to.getTime() - back * DAY_MS), to }
}
```

- [ ] **Step 4: Run the whole sync test file**

Run: `npx vitest run src/lib/ads/sync.test.ts`

Expected: PASS, all tests including the pre-existing `backfills a year on first sync, 35 days after that`. Note that test asserts `36` is not expected — check it. It passes `lastSyncAt` one day before `now`, so `daysSince` is 1 and `back` is 36, and the existing assertion `.toBe(35)` will now FAIL.

Update that pre-existing assertion to `36` and extend its comment:

```ts
  it('backfills a year on first sync, and covers the restate window after that', () => {
    const now = new Date('2026-07-29T10:00:00Z')
    const first = syncWindow(null, now)
    expect(first.to).toEqual(new Date('2026-07-29T00:00:00Z'))
    expect((first.to.getTime() - first.from.getTime()) / DAY_MS).toBe(365)

    // Synced yesterday: one day of gap plus the 35-day restate window. The
    // extra day costs nothing — every write is an upsert keyed on (account, date).
    const later = syncWindow(new Date('2026-07-28T00:00:00Z'), now)
    expect((later.to.getTime() - later.from.getTime()) / DAY_MS).toBe(36)
  })
```

- [ ] **Step 5: Run the file again**

Run: `npx vitest run src/lib/ads/sync.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ads/sync.ts src/lib/ads/sync.test.ts
git commit -m "fix(ads): re-fetch the whole gap since the last successful sync"
```

---

## Task 2: Display currency setting

**Files:**
- Modify: `prisma/schema.prisma` (`model Setting`)
- Modify: `src/lib/settings.ts`
- Modify: `src/app/api/settings/route.ts:19-31`
- Modify: `src/app/settings/general/GeneralClient.tsx`
- Modify: `src/app/settings/general/page.tsx`
- Modify: `src/lib/data/load.ts:37`
- Test: `src/lib/data/load.test.ts` (create the describe block if the file has none for currency)

**Interfaces:**
- Consumes: `getSetting()` from `src/lib/settings.ts`
- Produces: `DISPLAY_CURRENCIES: string[]`, and `Setting.displayCurrency: string` on the object `getSetting()` returns

- [ ] **Step 1: Add the schema column**

In `prisma/schema.prisma`, add to `model Setting`:

```prisma
  displayCurrency String @default("USD") // used only when several shops are combined
```

- [ ] **Step 2: Apply the schema and regenerate**

Run: `npx prisma db push`
Then: `npx prisma generate`

Expected: `Your database is now in sync with your Prisma schema.` Adding a column with a default is not destructive and must not prompt for `--accept-data-loss`.

- [ ] **Step 3: Add the default and the allowed list**

In `src/lib/settings.ts`, add `displayCurrency: 'USD'` to `SETTING_DEFAULTS`, and add this export beside `CURRENCY_FORMATS`:

```ts
/**
 * What the workspace may consolidate into. Restricted to what the rate
 * provider (Frankfurter, see fx/rates.ts) actually quotes — an unquoted
 * currency would leave crossConvert with no rate and silently return the
 * amount unconverted, which reads as a real number and is not one.
 */
export const DISPLAY_CURRENCIES = ['USD', 'NOK', 'DKK', 'SEK', 'EUR', 'GBP']
```

- [ ] **Step 4: Validate it on the way in**

In `src/app/api/settings/route.ts`, import `DISPLAY_CURRENCIES` from `@/lib/settings` and add to the `Body` schema:

```ts
  displayCurrency: z
    .string()
    .refine((c) => DISPLAY_CURRENCIES.includes(c), 'Pick a display currency'),
```

- [ ] **Step 5: Write the failing loader test**

Create or extend `src/lib/data/load.test.ts`. Follow the DB-backed pattern in `src/lib/ads/sync.test.ts`: a `MARKER` string, a `wipe()` in `beforeEach`, real rows.

```ts
import { beforeEach, afterAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { loadMetricsInput } from './load'

const MARKER = '[load-currency-test]'

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}

beforeEach(wipe)
afterAll(wipe)

async function setDisplayCurrency(displayCurrency: string) {
  await db.setting.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', displayCurrency },
    update: { displayCurrency },
  })
}

const RANGE = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T00:00:00Z') }

describe('display currency', () => {
  it('consolidates several shops into the configured currency', async () => {
    await db.shop.create({ data: { name: `${MARKER} one`, currency: 'NOK' } })
    await db.shop.create({ data: { name: `${MARKER} two`, currency: 'DKK' } })
    await setDisplayCurrency('NOK')

    const shopIds = (
      await db.shop.findMany({ where: { name: { contains: MARKER } }, select: { id: true } })
    ).map((s) => s.id)

    const input = await loadMetricsInput({ shopIds, ...RANGE })
    expect(input.displayCurrency).toBe('NOK')
  })

  it('still reports a single shop in its OWN currency, ignoring the setting', async () => {
    // One shop needs no consolidation, so converting it would introduce FX
    // error where there was none and stop the figure matching Ads Manager.
    const shop = await db.shop.create({ data: { name: `${MARKER} solo`, currency: 'DKK' } })
    await setDisplayCurrency('NOK')

    const input = await loadMetricsInput({ shopIds: [shop.id], ...RANGE })
    expect(input.displayCurrency).toBe('DKK')
  })
})
```

- [ ] **Step 6: Run it and watch the first test fail**

Run: `npx vitest run src/lib/data/load.test.ts`

Expected: the first test FAILS with `expected 'USD' to be 'NOK'`. The second already passes — that is the behaviour being protected, not added.

- [ ] **Step 7: Read the setting in the loader**

In `src/lib/data/load.ts`, import `getSetting` from `../settings`, then replace line 37:

```ts
  // Several shops have to cross into one currency to be summable. WHICH one is
  // a workspace choice, read here rather than passed in: all four callers
  // already fetch the setting for `timezone`, and one that forgot to pass a
  // second field would render a page quoting a different currency from the one
  // beside it. One shop needs no crossing, so it keeps its own currency and the
  // figure still matches the platform exactly.
  const setting = await getSetting()
  const displayCurrency = shops.length === 1 ? shops[0].currency : setting.displayCurrency
```

Update the docblock at `load.ts:20-25` so it stops claiming USD:

```
 * The display currency is decided here, and it follows one rule:
 *   exactly one shop  -> that shop's own currency
 *   several shops     -> the workspace's displayCurrency setting (default USD)
```

- [ ] **Step 8: Run the loader tests**

Run: `npx vitest run src/lib/data/load.test.ts`

Expected: PASS, both tests.

- [ ] **Step 9: Add the picker to Settings**

In `src/app/settings/general/GeneralClient.tsx`:

Add `displayCurrency: string` to the `Values` type. Import `DISPLAY_CURRENCIES` from `@/lib/settings`. Add this block after the Currency format select:

```tsx
          <label className="mt-4 block text-[12px] font-medium text-ink">Display currency</label>
          <select
            aria-label="Display currency"
            value={values.displayCurrency}
            onChange={set('displayCurrency')}
            className={`mt-1 ${INPUT}`}
          >
            {DISPLAY_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted">
            Used when several stores are combined. A single store always shows its own currency.
          </p>
```

In `src/app/settings/general/page.tsx`, add `displayCurrency: setting.displayCurrency` to the `initial` object.

- [ ] **Step 10: Write the settings component test**

Add to `src/app/settings/general/GeneralClient.test.tsx` (the file exists; match its imports and its existing `initial` fixture, adding `displayCurrency: 'USD'` to it):

```tsx
  it('sends the chosen display currency', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<GeneralClient email="a@b.c" initial={initial} />)
    fireEvent.change(screen.getByLabelText('Display currency'), { target: { value: 'NOK' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.displayCurrency).toBe('NOK')
  })
```

- [ ] **Step 11: Run the settings tests**

Run: `npx vitest run src/app/settings/general/GeneralClient.test.tsx`

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add prisma/schema.prisma src/lib/settings.ts src/app/api/settings/route.ts src/app/settings/general/GeneralClient.tsx src/app/settings/general/GeneralClient.test.tsx src/app/settings/general/page.tsx src/lib/data/load.ts src/lib/data/load.test.ts
git commit -m "feat(settings): choose the currency several stores consolidate into"
```

---

## Task 3: Platform aggregation in buildMarketing

**Files:**
- Modify: `src/lib/ads/marketing.ts` (types at 11-72, loop at 155-181, totals at 197-220)
- Test: `src/lib/ads/marketing.test.ts`

**Interfaces:**
- Consumes: `SpendRow`, `MarketingAccount` (unchanged shapes)
- Produces:
  - `MarketingPlatformRow` — exported type, fields listed in Step 3
  - `MarketingResult.byPlatform: MarketingPlatformRow[]`
  - `MarketingSeriesPoint` gains `metaSpend: number` and `googleSpend: number`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/ads/marketing.test.ts`. The file already defines `rates`, `engine`, `accounts`, `TO` and `spendRow` — reuse them.

```ts
describe('byPlatform', () => {
  const built = () =>
    buildMarketing({
      accounts,
      spend: [
        spendRow({ accountId: 'acc-meta', date: new Date('2026-07-01T00:00:00Z'), spend: 100_00, impressions: 1000, clicks: 50 }),
        spendRow({ accountId: 'acc-google', date: new Date('2026-07-01T00:00:00Z'), spend: 50_00, impressions: 400, clicks: 20 }),
      ],
      engine,
      series: [],
      rates,
      to: TO,
    })

  it('splits spend by platform and the parts add up to the whole', () => {
    // The invariant that matters: the platform card and the headline card are
    // reading the same money. If these can ever disagree, one of the two
    // screens is lying and there is no way to tell which.
    const result = built()
    const platformTotal = result.byPlatform.reduce((n, p) => n + p.spend, 0)

    expect(platformTotal).toBe(result.total.spend)
    expect(platformTotal).toBe(result.byShop.reduce((n, r) => n + r.spend, 0))
  })

  it('converts each platform at its own account currency', () => {
    // NOK at 0.1 and EUR at 1.0 on 1 July: 100.00 NOK -> 10.00 USD,
    // 50.00 EUR -> 50.00 USD. A single blended rate would get both wrong.
    const result = built()
    const meta = result.byPlatform.find((p) => p.provider === 'meta')!
    const google = result.byPlatform.find((p) => p.provider === 'google')!

    expect(meta.spend).toBe(10_00)
    expect(google.spend).toBe(50_00)
  })

  it('sorts the biggest spender first', () => {
    expect(built().byPlatform.map((p) => p.provider)).toEqual(['google', 'meta'])
  })

  it('gives an unknown provider its own row instead of folding it into Google', () => {
    // The old code was `provider === 'meta' ? meta : google`, so a third
    // platform would have silently inflated Google's number forever.
    const result = buildMarketing({
      accounts: [...accounts, { id: 'acc-tiktok', shopId: 'shop-a', provider: 'tiktok', currency: 'EUR', dailyBudget: null }],
      spend: [spendRow({ accountId: 'acc-tiktok', date: new Date('2026-07-01T00:00:00Z'), spend: 25_00 })],
      engine,
      series: [],
      rates,
      to: TO,
    })

    expect(result.byPlatform.find((p) => p.provider === 'google')).toBeUndefined()
    expect(result.byPlatform.find((p) => p.provider === 'tiktok')?.spend).toBe(25_00)
  })

  it('reports share as 0 rather than NaN when nothing was spent', () => {
    const result = buildMarketing({
      accounts,
      spend: [spendRow({ accountId: 'acc-meta', date: new Date('2026-07-01T00:00:00Z'), spend: 0 })],
      engine,
      series: [],
      rates,
      to: TO,
    })
    expect(result.byPlatform[0].share).toBe(0)
  })

  it('labels a split account row by platform too', () => {
    // A split-by-campaign row carries its own shopId. It is still Meta money
    // and must reach the Meta bucket, or the accounts this feature exists for
    // would show zero on the platform card.
    const result = buildMarketing({
      accounts,
      spend: [
        spendRow({ accountId: 'acc-meta', shopId: 'shop-b', date: new Date('2026-07-01T00:00:00Z'), spend: 100_00 }),
      ],
      engine,
      series: [],
      rates,
      to: TO,
    })
    expect(result.byPlatform.find((p) => p.provider === 'meta')?.spend).toBe(10_00)
  })
})

describe('per-platform series', () => {
  it('carries each platform down the daily series', () => {
    const result = buildMarketing({
      accounts,
      spend: [
        spendRow({ accountId: 'acc-meta', date: new Date('2026-07-01T00:00:00Z'), spend: 100_00 }),
        spendRow({ accountId: 'acc-google', date: new Date('2026-07-01T00:00:00Z'), spend: 50_00 }),
      ],
      engine,
      series: [{ date: '2026-07-01', grossRevenue: 500_00 } as never],
      rates,
      to: TO,
    })

    const day = result.series[0]
    expect(day.metaSpend).toBe(10_00)
    expect(day.googleSpend).toBe(50_00)
    expect(day.metaSpend + day.googleSpend).toBe(day.spend)
  })
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/ads/marketing.test.ts`

Expected: FAIL — `result.byPlatform is undefined`.

- [ ] **Step 3: Add the types**

In `src/lib/ads/marketing.ts`, add after `MarketingShopRow`:

```ts
/**
 * One platform's totals across every shop in scope.
 *
 * Accumulated in the same pass as the shop rows, from the same converted
 * amounts, so `sum(byPlatform.spend) === total.spend` holds by construction
 * rather than by agreement between two functions.
 */
export type MarketingPlatformRow = {
  provider: string // 'meta' | 'google', or whatever an account reports
  label: string // 'Meta' | 'Google', title-cased fallback for anything else
  spend: number // display currency minor units
  impressions: number
  clicks: number
  conversions: number
  conversionValue: number // display currency minor units
  share: number // 0..1 of total spend; 0 when nothing was spent
  cpc: number | null
  cpm: number | null
  ctr: number | null
  platformRoas: number | null
  costPerPurchase: number | null
}
```

Change `MarketingSeriesPoint` to:

```ts
export type MarketingSeriesPoint = {
  date: string
  spend: number
  grossRevenue: number
  metaSpend: number
  googleSpend: number
}
```

Add `byPlatform: MarketingPlatformRow[]` to `MarketingResult`.

- [ ] **Step 4: Accumulate platforms in the existing loop**

In `buildMarketing`, add above the `for (const row of args.spend)` loop:

```ts
  const PLATFORM_LABELS: Record<string, string> = { meta: 'Meta', google: 'Google' }
  type PlatformAcc = {
    spend: number
    impressions: number
    clicks: number
    conversions: number
    conversionValue: number
  }
  const byPlatform = new Map<string, PlatformAcc>()
  const platformByDay = new Map<string, { meta: number; google: number }>()
```

Inside the loop, after `byShop.set(shopId, acc)`, add:

```ts
    // Keyed on the provider string itself. The previous shape was
    // `provider === 'meta' ? meta : google`, which quietly filed any third
    // platform under Google and would have overstated it forever.
    const platform = byPlatform.get(account.provider) ?? {
      spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0,
    }
    platform.spend += minor
    platform.impressions += row.impressions
    platform.clicks += row.clicks
    platform.conversions += row.conversions
    platform.conversionValue += valueMinor
    byPlatform.set(account.provider, platform)
```

Replace the `byDay` write at the end of the loop with:

```ts
    const day = row.date.toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + minor)
    const split = platformByDay.get(day) ?? { meta: 0, google: 0 }
    if (account.provider === 'meta') split.meta += minor
    else if (account.provider === 'google') split.google += minor
    platformByDay.set(day, split)
```

Note the `else if`: the chart plots two named lines, so a third platform contributes to `spend` but to neither line. That is honest — it is counted in the total and in `byPlatform`, just not drawn as a line that does not exist.

- [ ] **Step 5: Build the platform rows and extend the series**

Before the `return`, add:

```ts
  const platformSpend = [...byPlatform.values()].reduce((n, p) => n + p.spend, 0)
  const platformRows: MarketingPlatformRow[] = [...byPlatform.entries()]
    .map(([provider, p]) => ({
      provider,
      label: PLATFORM_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1),
      ...p,
      // Zero spend has no shares to divide, and NaN would render as a broken bar.
      share: platformSpend > 0 ? p.spend / platformSpend : 0,
      cpc: p.spend > 0 && p.clicks > 0 ? Math.round(p.spend / p.clicks) : null,
      cpm: p.impressions > 0 ? Math.round((p.spend / p.impressions) * 1000) : null,
      ctr: p.impressions > 0 ? p.clicks / p.impressions : null,
      platformRoas: p.spend > 0 ? p.conversionValue / p.spend : null,
      costPerPurchase:
        p.spend > 0 && p.conversions > 0 ? Math.round(p.spend / p.conversions) : null,
    }))
    .sort((a, b) => b.spend - a.spend)
```

Change the `series` mapping to:

```ts
  const series = args.series.map((p) => ({
    date: p.date,
    spend: byDay.get(p.date) ?? 0,
    grossRevenue: p.grossRevenue,
    metaSpend: platformByDay.get(p.date)?.meta ?? 0,
    googleSpend: platformByDay.get(p.date)?.google ?? 0,
  }))
```

And the return to `{ displayCurrency: display, byShop: rows, byPlatform: platformRows, total, series }`.

- [ ] **Step 6: Run the marketing tests**

Run: `npx vitest run src/lib/ads/marketing.test.ts`

Expected: PASS, including every pre-existing test.

- [ ] **Step 7: Prove the invariant test can fail**

Temporarily change `platform.spend += minor` to `platform.spend += Math.round(minor * 0.9)`. Run the file again. The `parts add up to the whole` test MUST fail. Revert the change and re-run to confirm green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ads/marketing.ts src/lib/ads/marketing.test.ts
git commit -m "feat(marketing): total ad spend by platform, in the pass that already ran"
```

---

## Task 4: Spend check data

Per-account reconciliation from rows already fetched. The native total is UNCONVERTED, in the account's own currency — the number that can be held against Ads Manager directly.

**Files:**
- Create: `src/lib/ads/spend-check.ts`
- Create: `src/lib/ads/spend-check.test.ts`
- Modify: `src/app/api/marketing/route.ts:37-59`

**Interfaces:**
- Consumes: `SpendRow` from `./marketing`, `RateTable` from `../metrics/types`, `crossConvert` from `../metrics/fx`
- Produces:
  - `SpendCheckAccount` — exported type, fields in Step 3
  - `SpendCheckResult = { accounts: SpendCheckAccount[]; needsAttention: boolean }`
  - `buildSpendCheck(args): SpendCheckResult`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ads/spend-check.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildSpendCheck } from './spend-check'
import { buildRateTable } from '../metrics/fx'

const rates = buildRateTable([
  { date: new Date('2026-07-01T00:00:00Z'), currency: 'NOK', rate: 0.1 },
])

const FROM = new Date('2026-07-01T00:00:00Z')
const TO = new Date('2026-07-10T00:00:00Z') // 10 days inclusive
const NOW = new Date('2026-07-10T12:00:00Z')

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acc-1',
  name: 'Panetti NO',
  provider: 'meta',
  currency: 'NOK',
  shopId: 'shop-a',
  active: true,
  lastSyncAt: new Date('2026-07-10T06:00:00Z'),
  lastError: null as string | null,
  ...over,
})

const row = (day: number, spend: number) => ({
  accountId: 'acc-1',
  date: new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00Z`),
  spend,
  impressions: 0,
  clicks: 0,
  linkClicks: 0,
  conversions: 0,
  conversionValue: 0,
  videoViews3s: 0,
  thruplays: 0,
})

const build = (accounts: ReturnType<typeof account>[], spend: ReturnType<typeof row>[]) =>
  buildSpendCheck({ accounts, spend, rates, from: FROM, to: TO, displayCurrency: 'USD', now: NOW })

describe('buildSpendCheck', () => {
  it('reports the native total UNCONVERTED, in the account currency', () => {
    // The whole point of the panel. This is the figure a human holds against
    // Ads Manager. Converting it would make it unverifiable.
    const result = build([account()], [row(1, 1000_00), row(2, 500_00)])
    expect(result.accounts[0].nativeTotal).toBe(1500_00)
    expect(result.accounts[0].currency).toBe('NOK')
  })

  it('reports the converted total alongside it', () => {
    const result = build([account()], [row(1, 1000_00)])
    expect(result.accounts[0].convertedTotal).toBe(100_00) // NOK 0.1 -> USD
  })

  it('counts days with data against the length of the range', () => {
    const result = build([account()], [row(1, 100), row(2, 100), row(5, 100)])
    expect(result.accounts[0].daysWithData).toBe(3)
    expect(result.accounts[0].daysInRange).toBe(10)
  })

  it('does NOT raise attention for missing days on their own', () => {
    // A platform returns no row for a day it delivered nothing, so a paused
    // campaign and a broken sync are indistinguishable from the count alone.
    // Crying wolf every time a campaign pauses would make the banner useless.
    const result = build([account()], [row(1, 100)])
    expect(result.accounts[0].daysWithData).toBe(1)
    expect(result.needsAttention).toBe(false)
  })

  it('raises attention for a stored sync error', () => {
    const result = build([account({ lastError: 'Facebook login expired.' })], [row(1, 100)])
    expect(result.needsAttention).toBe(true)
    expect(result.accounts[0].status).toBe('error')
  })

  it('raises attention when a sync has not run for over a day', () => {
    // The cron runs every 15 minutes and each account is due every 6 hours,
    // so a full day of silence is a fault, not a quiet period.
    const stale = account({ lastSyncAt: new Date('2026-07-08T06:00:00Z') })
    const result = build([stale], [row(1, 100)])
    expect(result.needsAttention).toBe(true)
    expect(result.accounts[0].status).toBe('stale')
  })

  it('raises attention for an inactive account that still holds spend in the range', () => {
    const result = build([account({ active: false })], [row(1, 100)])
    expect(result.needsAttention).toBe(true)
    expect(result.accounts[0].status).toBe('inactive')
  })

  it('is quiet for a healthy account', () => {
    const result = build([account()], [row(1, 100)])
    expect(result.accounts[0].status).toBe('ok')
    expect(result.needsAttention).toBe(false)
  })

  it('reports the first and last day carrying data', () => {
    const result = build([account()], [row(3, 100), row(7, 100)])
    expect(result.accounts[0].firstDay).toBe('2026-07-03')
    expect(result.accounts[0].lastDay).toBe('2026-07-07')
  })

  it('lists an account with no rows at all, rather than omitting it', () => {
    // An account that vanishes from the list is exactly the failure the panel
    // exists to make visible.
    const result = build([account()], [])
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].nativeTotal).toBe(0)
    expect(result.accounts[0].firstDay).toBeNull()
  })

  it('sorts the biggest spender first', () => {
    const result = buildSpendCheck({
      accounts: [account(), account({ id: 'acc-2', name: 'Small', currency: 'NOK' })],
      spend: [row(1, 100_00), { ...row(1, 900_00), accountId: 'acc-2' }],
      rates,
      from: FROM,
      to: TO,
      displayCurrency: 'USD',
      now: NOW,
    })
    expect(result.accounts.map((a) => a.name)).toEqual(['Small', 'Panetti NO'])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/ads/spend-check.test.ts`

Expected: FAIL — cannot resolve `./spend-check`.

- [ ] **Step 3: Write the module**

Create `src/lib/ads/spend-check.ts`:

```ts
import { crossConvert } from '../metrics/fx'
import type { RateTable } from '../metrics/types'
import type { SpendRow } from './marketing'

/**
 * Why the ad spend total is what it is.
 *
 * A headline figure gives no way to ask which accounts it came from, so when
 * it disagrees with Ads Manager or BeProfit there is nothing to read and the
 * argument is settled by screenshots. The column that settles it is
 * `nativeTotal`: the account's own money, in its own currency, unconverted. It
 * can be compared directly against the platform.
 *
 * `daysWithData` is deliberately NOT an alarm. A platform returns no row for a
 * day on which nothing was delivered, so a paused campaign and a failed sync
 * look identical from a row count. The panel reports the count and lets a human
 * judge; `needsAttention` fires only on signals that cannot be misread.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** The cron runs every 15 minutes and each account is due every 6 hours. */
const STALE_HOURS = 24

export type SpendCheckAccount = {
  id: string
  name: string
  provider: string
  currency: string
  /** The account's own money, UNCONVERTED. The number to hold against the platform. */
  nativeTotal: number
  /** The same money in display currency, so it traces to the headline. */
  convertedTotal: number
  daysWithData: number
  daysInRange: number
  firstDay: string | null // 'YYYY-MM-DD'
  lastDay: string | null
  lastSyncAt: Date | null
  lastError: string | null
  status: 'ok' | 'error' | 'stale' | 'inactive'
}

export type SpendCheckResult = {
  accounts: SpendCheckAccount[]
  /** True when at least one account is in a state a person should look at. */
  needsAttention: boolean
}

export type SpendCheckAccountInput = {
  id: string
  name: string
  provider: string
  currency: string
  active: boolean
  lastSyncAt: Date | null
  lastError: string | null
}

export function buildSpendCheck(args: {
  accounts: SpendCheckAccountInput[]
  spend: SpendRow[]
  rates: RateTable
  from: Date
  to: Date
  displayCurrency: string
  now: Date
}): SpendCheckResult {
  const daysInRange =
    Math.round((utcMidnight(args.to) - utcMidnight(args.from)) / DAY_MS) + 1

  const accounts = args.accounts.map((account) => {
    const rows = args.spend.filter((r) => r.accountId === account.id)

    let nativeTotal = 0
    let convertedTotal = 0
    const days = new Set<string>()
    for (const r of rows) {
      nativeTotal += r.spend
      convertedTotal += crossConvert(
        r.spend,
        account.currency,
        args.displayCurrency,
        r.date,
        args.rates,
      )
      days.add(r.date.toISOString().slice(0, 10))
    }

    const sorted = [...days].sort()
    const hoursSinceSync = account.lastSyncAt
      ? (args.now.getTime() - account.lastSyncAt.getTime()) / 3_600_000
      : Infinity

    // Order matters: a stored error is the most specific thing we know, and an
    // errored account is also stale, so reporting "stale" would hide the reason.
    const status: SpendCheckAccount['status'] = account.lastError
      ? 'error'
      : !account.active
        ? 'inactive'
        : hoursSinceSync > STALE_HOURS
          ? 'stale'
          : 'ok'

    return {
      id: account.id,
      name: account.name,
      provider: account.provider,
      currency: account.currency,
      nativeTotal,
      convertedTotal,
      daysWithData: days.size,
      daysInRange,
      firstDay: sorted[0] ?? null,
      lastDay: sorted[sorted.length - 1] ?? null,
      lastSyncAt: account.lastSyncAt,
      lastError: account.lastError,
      status,
    }
  })

  accounts.sort((a, b) => b.convertedTotal - a.convertedTotal)

  return { accounts, needsAttention: accounts.some((a) => a.status !== 'ok') }
}

/** Midnight UTC as a number, so day arithmetic ignores the time of day. */
function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/ads/spend-check.test.ts`

Expected: PASS, all 11 tests.

- [ ] **Step 5: Wire it into the marketing route**

In `src/app/api/marketing/route.ts`:

Import `buildSpendCheck` from `@/lib/ads/spend-check`.

Widen the account select at line 39-41 to:

```ts
        select: {
          id: true, shopId: true, provider: true, currency: true, dailyBudget: true,
          name: true, active: true, lastSyncAt: true, lastError: true,
        },
```

After the `buildMarketing` call, add:

```ts
    // Built from the SAME rows buildMarketing just consumed, so the panel and
    // the headline cannot describe different money.
    const now = new Date()
    const spendCheck = buildSpendCheck({
      accounts,
      spend,
      rates,
      from,
      to,
      displayCurrency: result.displayCurrency,
      now,
    })
```

Add `spendCheck` to the JSON response object.

- [ ] **Step 6: Run the whole ads and api suites**

Run: `npx vitest run src/lib/ads src/app/api`

Expected: PASS. `buildMarketing` still receives the account objects; the extra selected fields are additive and structurally compatible with `MarketingAccount`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ads/spend-check.ts src/lib/ads/spend-check.test.ts src/app/api/marketing/route.ts
git commit -m "feat(marketing): per-account spend check with unconverted native totals"
```

---

## Task 5: Platform card

**Files:**
- Create: `src/components/marketing/PlatformCard.tsx`
- Create: `src/components/marketing/PlatformCard.test.tsx`

**Interfaces:**
- Consumes: `MarketingPlatformRow` from `@/lib/ads/marketing`, `formatMoney` from `@/lib/money`
- Produces: `<PlatformCard rows={MarketingPlatformRow[]} total={number} currency={string} />`

- [ ] **Step 1: Write the failing test**

Create `src/components/marketing/PlatformCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PlatformCard } from './PlatformCard'
import type { MarketingPlatformRow } from '@/lib/ads/marketing'

const row = (over: Partial<MarketingPlatformRow>): MarketingPlatformRow => ({
  provider: 'meta',
  label: 'Meta',
  spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  conversionValue: 0,
  share: 0,
  cpc: null,
  cpm: null,
  ctr: null,
  platformRoas: null,
  costPerPurchase: null,
  ...over,
})

describe('PlatformCard', () => {
  it('lists each platform with its spend and the combined total', () => {
    render(
      <PlatformCard
        rows={[row({ provider: 'meta', label: 'Meta', spend: 443_199_00, share: 0.69 }), row({ provider: 'google', label: 'Google', spend: 196_137_00, share: 0.31 })]}
        total={639_336_00}
        currency="NOK"
      />,
    )

    expect(screen.getByText('Meta')).toBeInTheDocument()
    expect(screen.getByText('Google')).toBeInTheDocument()
    expect(screen.getByText(/639/)).toBeInTheDocument()
  })

  it('sizes each bar by its share', () => {
    render(<PlatformCard rows={[row({ spend: 100, share: 0.25 })]} total={400} currency="NOK" />)
    expect(screen.getByTestId('share-meta')).toHaveStyle({ width: '25%' })
  })

  it('says so plainly when nothing was spent', () => {
    render(<PlatformCard rows={[]} total={0} currency="NOK" />)
    expect(screen.getByText(/no ad spend/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/marketing/PlatformCard.test.tsx`

Expected: FAIL — cannot resolve `./PlatformCard`.

- [ ] **Step 3: Write the component**

Create `src/components/marketing/PlatformCard.tsx`:

```tsx
'use client'

import { formatMoney } from '@/lib/money'
import type { MarketingPlatformRow } from '@/lib/ads/marketing'

/**
 * Where the ad money went, by platform. The bar is the share of total spend —
 * a reading aid, never the number itself, which is always printed beside it.
 */

const BAR: Record<string, string> = {
  meta: 'var(--color-series-revenue)',
  google: 'var(--color-series-profit)',
}

export function PlatformCard({
  rows,
  total,
  currency,
}: {
  rows: MarketingPlatformRow[]
  total: number
  currency: string
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <h2 className="text-[13px] font-semibold text-ink">Ad spend</h2>

      {rows.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted">No ad spend in this period.</p>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            {rows.map((r) => (
              <div key={r.provider}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-ink">{r.label}</span>
                  <span className="num text-[13px] font-semibold text-ink">
                    {formatMoney(r.spend, currency)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel">
                  <div
                    data-testid={`share-${r.provider}`}
                    className="h-full rounded-full"
                    style={{ width: `${r.share * 100}%`, background: BAR[r.provider] ?? 'var(--color-decor)' }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <p className="text-[11px] font-semibold tracking-wide text-faint">TOTAL AD SPEND</p>
            <p className="num mt-1 text-[22px] font-semibold text-ink">
              {formatMoney(total, currency)}
            </p>
          </div>
        </>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/components/marketing/PlatformCard.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/marketing/PlatformCard.tsx src/components/marketing/PlatformCard.test.tsx
git commit -m "feat(marketing): ad spend card split by platform"
```

---

## Task 6: Platform table

**Files:**
- Create: `src/components/marketing/PlatformTable.tsx`
- Create: `src/components/marketing/PlatformTable.test.tsx`

**Interfaces:**
- Consumes: `MarketingPlatformRow` from `@/lib/ads/marketing`
- Produces: `<PlatformTable rows={MarketingPlatformRow[]} currency={string} />`

- [ ] **Step 1: Write the failing test**

Create `src/components/marketing/PlatformTable.test.tsx`. Reuse the same `row` helper shape as Task 5 (repeat it in this file — the two tests are independent).

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PlatformTable } from './PlatformTable'
import type { MarketingPlatformRow } from '@/lib/ads/marketing'

const row = (over: Partial<MarketingPlatformRow>): MarketingPlatformRow => ({
  provider: 'meta',
  label: 'Meta',
  spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  conversionValue: 0,
  share: 0,
  cpc: null,
  cpm: null,
  ctr: null,
  platformRoas: null,
  costPerPurchase: null,
  ...over,
})

describe('PlatformTable', () => {
  it('shows spend, impressions, clicks and CPC per platform', () => {
    render(
      <PlatformTable
        rows={[row({ spend: 443_199_00, impressions: 5_560_745, clicks: 55_721, cpc: 7_95 })]}
        currency="NOK"
      />,
    )
    // 'en-US' grouping, matching MarketingTable's own count cells: 5,560,745.
    // Verified against the repo convention at MarketingTable.tsx:110 — do not
    // switch to a space-grouped locale, the two tables sit on the same page.
    const cells = within(screen.getByRole('row', { name: /Meta/ })).getAllByRole('cell')
    expect(cells.map((c) => c.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('5,560,745')]),
    )
  })

  it('renders a dash where a ratio has no denominator', () => {
    // A platform with no clicks has no cost per click. Printing 0 would claim
    // clicks were free.
    render(<PlatformTable rows={[row({ spend: 100_00, clicks: 0, cpc: null })]} currency="NOK" />)
    expect(screen.getByTestId('cpc-meta')).toHaveTextContent('—')
  })

  it('renders nothing at all when there are no platforms', () => {
    const { container } = render(<PlatformTable rows={[]} currency="NOK" />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/marketing/PlatformTable.test.tsx`

Expected: FAIL — cannot resolve `./PlatformTable`.

- [ ] **Step 3: Write the component**

Create `src/components/marketing/PlatformTable.tsx`:

```tsx
'use client'

import { formatMoney } from '@/lib/money'
import type { MarketingPlatformRow } from '@/lib/ads/marketing'

/**
 * One row per platform. Deliberately no "v.expenses" column: the reference
 * BeProfit screenshot shows it as 0 for every row and this system has no
 * equivalent concept, so it would be a column of zeroes claiming to mean
 * something.
 */

/** Same grouping as MarketingTable's count cells; the two sit on one page. */
const count = (n: number) => Math.round(n).toLocaleString('en-US')

export function PlatformTable({
  rows,
  currency,
}: {
  rows: MarketingPlatformRow[]
  currency: string
}) {
  if (rows.length === 0) return null

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-faint">
              <th scope="col" className="px-5 py-3 text-left">PLATFORM</th>
              <th scope="col" className="px-5 py-3 text-right">AMOUNT SPENT</th>
              <th scope="col" className="px-5 py-3 text-right">IMPRESSIONS</th>
              <th scope="col" className="px-5 py-3 text-right">CLICKS</th>
              <th scope="col" className="px-5 py-3 text-right">CPC</th>
              <th scope="col" className="px-5 py-3 text-right">PURCHASES</th>
              <th scope="col" className="px-5 py-3 text-right">P. ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.provider} className="border-b border-line last:border-0">
                <td className="px-5 py-3 text-ink">{r.label}</td>
                <td className="num px-5 py-3 text-right font-semibold text-ink">
                  {formatMoney(r.spend, currency)}
                </td>
                <td className="num px-5 py-3 text-right text-muted">{count(r.impressions)}</td>
                <td className="num px-5 py-3 text-right text-muted">{count(r.clicks)}</td>
                <td data-testid={`cpc-${r.provider}`} className="num px-5 py-3 text-right text-muted">
                  {r.cpc === null ? '—' : formatMoney(r.cpc, currency)}
                </td>
                <td className="num px-5 py-3 text-right text-muted">{count(r.conversions)}</td>
                <td className="num px-5 py-3 text-right text-muted">
                  {r.platformRoas === null ? '—' : `${r.platformRoas.toFixed(2)}×`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/components/marketing/PlatformTable.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/marketing/PlatformTable.tsx src/components/marketing/PlatformTable.test.tsx
git commit -m "feat(marketing): per-platform spend table"
```

---

## Task 7: Chart split by platform

**Files:**
- Modify: `src/components/marketing/MarketingChart.tsx`
- Test: `src/components/marketing/MarketingChart.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `MarketingSeriesPoint` (now carrying `metaSpend`, `googleSpend`) from Task 3
- Produces: `<MarketingChart series currency />` — unchanged props, new internal toggle

- [ ] **Step 1: Write the failing test**

Create or extend `src/components/marketing/MarketingChart.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MarketingChart } from './MarketingChart'

// No container-size mocking needed: the heading, legend and toggle live
// OUTSIDE the ResponsiveContainer, so they render under jsdom at zero size.
// Verified by probe. Do not add assertions on SVG paths — those really do
// need a measured container and would fail.

const series = [
  { date: '2026-07-01', spend: 150_00, grossRevenue: 500_00, metaSpend: 100_00, googleSpend: 50_00 },
  { date: '2026-07-02', spend: 200_00, grossRevenue: 700_00, metaSpend: 120_00, googleSpend: 80_00 },
]

describe('MarketingChart', () => {
  it('plots spend against revenue by default', () => {
    render(<MarketingChart series={series} currency="NOK" />)
    expect(screen.getByText('Gross revenue')).toBeInTheDocument()
    expect(screen.queryByText('Google')).not.toBeInTheDocument()
  })

  it('swaps to one line per platform when By platform is pressed', () => {
    render(<MarketingChart series={series} currency="NOK" />)
    fireEvent.click(screen.getByRole('button', { name: /by platform/i }))

    expect(screen.getByText('Meta')).toBeInTheDocument()
    expect(screen.getByText('Google')).toBeInTheDocument()
    expect(screen.queryByText('Gross revenue')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/marketing/MarketingChart.test.tsx`

Expected: FAIL — no button named "By platform".

- [ ] **Step 3: Add the toggle**

In `src/components/marketing/MarketingChart.tsx`:

Add `import { useState } from 'react'` and two colour constants beside the existing ones:

```tsx
const META = 'var(--color-series-revenue)'
const GOOGLE = 'var(--color-series-profit)'
```

Inside `MarketingChart`, above the `hasSpend` check:

```tsx
  const [byPlatform, setByPlatform] = useState(false)
```

Replace the header block's legend `div` so the heading, legend and a toggle button sit together:

```tsx
        <h2 className="text-[13px] font-semibold text-ink">
          {byPlatform ? 'Ad spend by platform over time' : 'Ad spend & gross revenue over time'}
        </h2>

        <div className="flex items-center gap-4 text-[12px]">
          {(byPlatform
            ? [
                { label: 'Meta', color: META },
                { label: 'Google', color: GOOGLE },
              ]
            : [
                { label: 'Gross revenue', color: REVENUE },
                { label: 'Ad spend', color: SPEND },
              ]
          ).map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-muted">
              <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}

          <button
            type="button"
            aria-pressed={byPlatform}
            onClick={() => setByPlatform((v) => !v)}
            className="rounded-[var(--radius-control)] border border-line px-2.5 py-1 text-[12px] font-semibold text-muted hover:bg-panel hover:text-ink"
          >
            By platform
          </button>
        </div>
```

Replace the two `<Line>` elements with a conditional pair:

```tsx
            {byPlatform ? (
              <>
                <Line type="linear" dataKey="metaSpend" name="Meta" stroke={META} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }} isAnimationActive={false} />
                <Line type="linear" dataKey="googleSpend" name="Google" stroke={GOOGLE} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }} isAnimationActive={false} />
              </>
            ) : (
              <>
                {/* the two existing Line elements, unchanged */}
              </>
            )}
```

Keep the existing `grossRevenue` and `spend` lines verbatim inside the `else` branch, including their comments.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/components/marketing/MarketingChart.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/marketing/MarketingChart.tsx src/components/marketing/MarketingChart.test.tsx
git commit -m "feat(marketing): plot ad spend one line per platform"
```

---

## Task 8: Spend check panel and page wiring

**Files:**
- Create: `src/components/marketing/SpendCheck.tsx`
- Create: `src/components/marketing/SpendCheck.test.tsx`
- Modify: `src/app/marketing/MarketingClient.tsx` (Payload type at 16-33, body at 236-256)
- Modify: `src/app/marketing/MarketingClient.test.tsx` (fixture gains `byPlatform`, `spendCheck`, series fields)

**Interfaces:**
- Consumes: `SpendCheckResult` from `@/lib/ads/spend-check`, `MarketingPlatformRow` from `@/lib/ads/marketing`, `PlatformCard` (Task 5), `PlatformTable` (Task 6)
- Produces: `<SpendCheck data={SpendCheckResult} currency={string} />`

- [ ] **Step 1: Write the failing test**

Create `src/components/marketing/SpendCheck.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SpendCheck } from './SpendCheck'
import type { SpendCheckAccount, SpendCheckResult } from '@/lib/ads/spend-check'

const account = (over: Partial<SpendCheckAccount> = {}): SpendCheckAccount => ({
  id: 'acc-1',
  name: 'Panetti NO',
  provider: 'meta',
  currency: 'NOK',
  nativeTotal: 443_199_00,
  convertedTotal: 40_623_00,
  daysWithData: 30,
  daysInRange: 30,
  firstDay: '2026-07-11',
  lastDay: '2026-08-09',
  lastSyncAt: new Date('2026-08-10T06:00:00Z'),
  lastError: null,
  status: 'ok',
  ...over,
})

const data = (over: Partial<SpendCheckResult> = {}): SpendCheckResult => ({
  accounts: [account()],
  needsAttention: false,
  ...over,
})

describe('SpendCheck', () => {
  it('stays collapsed until asked', () => {
    render(<SpendCheck data={data()} currency="USD" />)
    expect(screen.queryByText('Panetti NO')).not.toBeInTheDocument()
  })

  it('shows the UNCONVERTED native total when expanded', () => {
    // The number a person holds against Ads Manager. If this were converted
    // the panel could not settle anything.
    render(<SpendCheck data={data()} currency="USD" />)
    fireEvent.click(screen.getByRole('button', { name: /spend check/i }))
    expect(screen.getByTestId('native-acc-1')).toHaveTextContent('443')
  })

  it('says nothing alarming when every account is healthy', () => {
    render(<SpendCheck data={data()} currency="USD" />)
    expect(screen.queryByTestId('spend-check-banner')).not.toBeInTheDocument()
  })

  it('raises a banner when an account needs attention', () => {
    render(
      <SpendCheck
        data={data({ accounts: [account({ status: 'error', lastError: 'Login expired' })], needsAttention: true })}
        currency="USD"
      />,
    )
    expect(screen.getByTestId('spend-check-banner')).toBeInTheDocument()
  })

  it('renders nothing when there are no accounts', () => {
    const { container } = render(<SpendCheck data={data({ accounts: [] })} currency="USD" />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/marketing/SpendCheck.test.tsx`

Expected: FAIL — cannot resolve `./SpendCheck`.

- [ ] **Step 3: Write the component**

Create `src/components/marketing/SpendCheck.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/money'
import type { SpendCheckAccount, SpendCheckResult } from '@/lib/ads/spend-check'

/**
 * Where the ad spend total came from, account by account.
 *
 * "Native total" is the column that does the work: the account's own money in
 * its own currency, unconverted, so it can be read straight across to Ads
 * Manager. Everything else on this page is consolidated, and a consolidated
 * figure cannot be checked against anything.
 */

const STATUS_TEXT: Record<SpendCheckAccount['status'], string> = {
  ok: 'ok',
  error: 'sync failed',
  stale: 'not synced today',
  inactive: 'switched off',
}

function ago(date: Date | null): string {
  if (!date) return 'never'
  const hours = Math.round((Date.now() - date.getTime()) / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function SpendCheck({ data, currency }: { data: SpendCheckResult; currency: string }) {
  const [open, setOpen] = useState(false)
  if (data.accounts.length === 0) return null

  const troubled = data.accounts.filter((a) => a.status !== 'ok')

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface">
      {data.needsAttention && (
        <p
          data-testid="spend-check-banner"
          className="border-b border-line px-5 py-3 text-[13px] text-loss"
        >
          {troubled.length === 1
            ? `${troubled[0].name} is not reporting normally (${STATUS_TEXT[troubled[0].status]}), so spend for it may be incomplete.`
            : `${troubled.length} ad accounts are not reporting normally, so spend may be incomplete.`}
        </p>
      )}

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-3 text-left"
      >
        <span className="text-[13px] font-semibold text-ink">Spend check</span>
        <span className="text-[12px] text-muted">
          {data.accounts.length} {data.accounts.length === 1 ? 'account' : 'accounts'} · {open ? 'hide' : 'show'}
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-faint">
                <th scope="col" className="px-5 py-3 text-left">ACCOUNT</th>
                <th scope="col" className="px-5 py-3 text-right" title="The account's own currency, unconverted — compare this against Ads Manager">
                  NATIVE TOTAL
                </th>
                <th scope="col" className="px-5 py-3 text-right">IN {currency}</th>
                <th scope="col" className="px-5 py-3 text-right" title="Days in the range carrying data. A platform reports no row for a day it delivered nothing, so a lower number is not automatically a fault.">
                  DAYS WITH DATA
                </th>
                <th scope="col" className="px-5 py-3 text-right">LAST SYNC</th>
                <th scope="col" className="px-5 py-3 text-left">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-3 text-ink">
                    {a.name}
                    <span className="ml-2 text-[11px] text-faint">{a.provider}</span>
                  </td>
                  <td data-testid={`native-${a.id}`} className="num px-5 py-3 text-right font-semibold text-ink">
                    {formatMoney(a.nativeTotal, a.currency)}
                  </td>
                  <td className="num px-5 py-3 text-right text-muted">
                    {formatMoney(a.convertedTotal, currency)}
                  </td>
                  <td className="num px-5 py-3 text-right text-muted">
                    {a.daysWithData} / {a.daysInRange}
                  </td>
                  <td className="num px-5 py-3 text-right text-muted">{ago(a.lastSyncAt)}</td>
                  <td className={`px-5 py-3 ${a.status === 'ok' ? 'text-muted' : 'text-loss'}`}>
                    {a.lastError ?? STATUS_TEXT[a.status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/components/marketing/SpendCheck.test.tsx`

Expected: PASS.

- [ ] **Step 5: Wire everything into the page**

In `src/app/marketing/MarketingClient.tsx`:

Import `PlatformCard`, `PlatformTable`, `SpendCheck`, and the types `MarketingPlatformRow` and `SpendCheckResult`.

Add to the `Payload` type:

```ts
  byPlatform: MarketingPlatformRow[]
  spendCheck: SpendCheckResult
```

In the rendered body, insert after `<MarketingStats … />`:

```tsx
                <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
                  <PlatformCard rows={data.byPlatform} total={data.total.spend} currency={currency} />
                  <MarketingChart series={data.series} currency={currency} />
                </div>

                <PlatformTable rows={data.byPlatform} currency={currency} />
```

and remove the standalone `<MarketingChart … />` line that previously sat there.

Insert `<SpendCheck data={data.spendCheck} currency={currency} />` as the last child of the results `div`, after the breakdown block.

**Note on dates:** `spendCheck.accounts[].lastSyncAt` arrives from JSON as a string, not a `Date`. Revive it where the payload is parsed:

```ts
      .then((json: Payload) => {
        // JSON has no Date type; SpendCheck does date arithmetic on this.
        json.spendCheck.accounts = json.spendCheck.accounts.map((a) => ({
          ...a,
          lastSyncAt: a.lastSyncAt ? new Date(a.lastSyncAt) : null,
        }))
        setData(json)
        setError('')
      })
```

- [ ] **Step 6: Update the page test fixture**

In `src/app/marketing/MarketingClient.test.tsx`, add `byPlatform: []` and `spendCheck: { accounts: [], needsAttention: false }` to the mocked payload, and add `metaSpend: 0, googleSpend: 0` to any series point fixtures.

Add one test:

```tsx
  it('shows the platform card once data arrives', async () => {
    // …render with a payload whose byPlatform has one Meta row at 100_00…
    expect(await screen.findByText('Meta')).toBeInTheDocument()
  })
```

- [ ] **Step 7: Run the marketing page tests**

Run: `npx vitest run src/app/marketing src/components/marketing`

Expected: PASS.

- [ ] **Step 8: Full gates**

Run each and record the output:

```bash
npx vitest run
npx tsc --noEmit
npx eslint
```

Expected: all tests pass; `tsc` clean; `eslint` at the pre-existing 8-error baseline and no more. If eslint reports more than 8, fix the new ones.

- [ ] **Step 9: Commit**

```bash
git add src/components/marketing/SpendCheck.tsx src/components/marketing/SpendCheck.test.tsx src/app/marketing/MarketingClient.tsx src/app/marketing/MarketingClient.test.tsx
git commit -m "feat(marketing): spend check panel and platform sections on the page"
```

---

## Self-Review Notes

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Platform aggregation in `buildMarketing`, invariant by construction | 3 |
| Unknown provider gets its own bucket | 3 |
| `MarketingPlatformRow` shape | 3 |
| Display currency setting, multi-shop only | 2 |
| `loadMetricsInput` reads the setting itself | 2 |
| Ad Spend card | 5 |
| Platform table, no `v.expenses` | 6 |
| Chart split by platform | 7 |
| Spend check panel with native totals | 4 (data), 8 (UI) |
| "Days with data" is not an alarm | 4 |
| Banner only on error / stale / inactive | 4, 8 |
| Sync gap fix | 1 |
| All 11 listed test cases | 1, 2, 3, 4, 5, 6, 7, 8 |

**Known consequence, called out for the implementer:** Task 1 Step 4 changes a pre-existing assertion from 35 to 36. That is a deliberate behaviour change (one extra day re-fetched on every sync), not a test being bent to fit — every write is an upsert keyed on `(accountId, date)`, so re-fetching a day costs one overwritten row.

**Out of scope, recorded in the spec:** an ad account on an inactive shop still contributes zero silently. The spend check panel surfaces it as an absence rather than a message. Left for a separate change.
