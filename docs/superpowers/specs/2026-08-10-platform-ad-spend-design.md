# Ad spend by platform, and proving the total is right

**Date:** 2026-08-10
**Status:** approved, ready for planning

## The complaint

The client asked for two things in one message:

> can we please also have this thing you see on the bottom? That also shows how
> much is spent on the different platforms? Because now it seems like the
> ad-spend is not showing fully in our dashboard, it shows too little spend

The reference is a BeProfit screenshot for Jul-11-2026 ~ Aug-9-2026 showing
Facebook 443 199 NOK, Google 196 137 NOK, Total 639 337 NOK, and a per-platform
table with Amount Spent, Impressions, Clicks and CPC.

Two separate claims live in that message and they need separate answers:

1. **There is no per-platform view.** True, and cheap to fix — the numbers are
   already computed.
2. **The total is too low.** Unproven. Note the wording: "it *seems* like". No
   one has yet compared our figure against BeProfit's over the same range in the
   same currency, so this design does not assume the total is wrong. It makes
   the total *checkable*, and fixes the one mechanism that can genuinely lose
   spend.

## What the investigation found

Five ways spend can read low, from reading the code:

| # | Finding | Location | Real defect? |
|---|---------|----------|--------------|
| 1 | With more than one store selected every figure is USD; BeProfit shows NOK. 639 337 NOK is roughly $58–60k, so ours looks ~11x smaller | `src/lib/data/load.ts:37` | No, but it is almost certainly what "too little" means |
| 2 | Marketing opens on `this_month`, not BeProfit's rolling 30 days | `src/app/marketing/MarketingClient.tsx:128` | No — different window, different number |
| 3 | A sync that stops for more than 35 days leaves a permanent hole | `src/lib/ads/sync.ts:48-52` | **Yes** |
| 4 | An ad account on an inactive shop contributes zero everywhere, silently | `src/lib/data/load.ts:30` | Out of scope; noted below |
| 5 | `metaSpend` / `googleSpend` are already computed but hidden by default and absent from the summary card | `src/components/marketing/MarketingTable.tsx:52-63` | No — this is the feature request |

Finding 3 is the only one that destroys data, and it is worth stating precisely.
`syncWindow` reads `lastSyncAt` as a boolean and never as a date:

```js
const back = lastSyncAt ? RESTATE_DAYS : BACKFILL_DAYS
return { from: new Date(to.getTime() - back * DAY_MS), to }
```

An account whose token expires for 60 days keeps its old `lastSyncAt` while it
errors — correct so far. On reconnection it fetches only the last 35 days, then
writes `lastSyncAt = now`. Days 36 through 60 are never fetched by anything,
ever. The hole is sealed and silent.

The existing test cannot catch it, because it only ever passes a `lastSyncAt`
one day old:

```js
const later = syncWindow(new Date('2026-07-28T00:00:00Z'), now)  // now = 2026-07-29
expect((later.to.getTime() - later.from.getTime()) / DAY_MS).toBe(35)
```

## Design

### 1. Platform aggregation lives in `buildMarketing`

The loop at `marketing.ts:155` already reads `account.provider` to split
`metaSpend` from `googleSpend`. Platform buckets accumulate in that same pass —
no new queries, no new endpoint.

Two alternatives were rejected:

- **A separate `/api/marketing/platforms` route.** A second query path drifts
  from the first. This codebase already warns against exactly that in four
  places (`attribution.ts:52-60`, `meta.ts:59-65`, `marketing/route.ts:30-35`,
  `attribution.ts:119-127`). The platform card disagreeing with the headline
  card is the precise failure it would produce.
- **Computing client-side from `byShop`.** `byShop` carries no per-platform
  impressions or clicks, so CPC per platform cannot be derived from it.

Keeping it in one pure function makes the invariant hold by construction:

```
sum(byPlatform[].spend) === total.spend === sum(byShop[].spend)
```

which is a test rather than a hope.

New shape on `MarketingResult`:

```ts
export type MarketingPlatformRow = {
  provider: string          // 'meta' | 'google', or whatever the account says
  label: string             // 'Meta' | 'Google', title-cased fallback otherwise
  spend: number             // display currency minor units
  impressions: number
  clicks: number
  conversions: number
  conversionValue: number   // display currency minor units
  cpc: number | null
  cpm: number | null
  ctr: number | null
  platformRoas: number | null
  costPerPurchase: number | null
  share: number             // 0..1 of total spend, for the bar; 0 when total is 0
}
```

`byPlatform` is sorted by spend descending, so the biggest spender leads — the
same order BeProfit uses.

**Bug fixed in passing:** today's `provider === 'meta' ? meta : google` files an
unknown provider under Google. Buckets key on the provider string itself, so a
third platform can never be quietly absorbed into Google's number.

### 2. Display currency becomes a setting

```prisma
model Setting {
  displayCurrency String @default("USD")
}
```

The rule, which stays honest about what conversion is happening:

- **One store selected** — that store's own currency, exactly as today. No
  conversion, so the figure matches Ads Manager to the øre.
- **Several stores** — the setting. The current hardcoded `'USD'` becomes the
  default value rather than a fixed rule.

`load.ts:37` is the only line of logic that changes. FX needs no work:
`load.ts:174` already seeds `inPlay` with `displayCurrency` before calling
`ensureRates`, so rates for the chosen currency are fetched automatically, and
`crossConvert` (`metrics/fx.ts:103`) already handles an arbitrary target.

`loadMetricsInput` reads the setting itself rather than taking it as an
argument. Its four callers already pass `timezone` from `getSetting()`, so a
second field would work — but a caller that forgot would render a page quoting a
different currency from the one beside it, which is the drift this codebase
guards against everywhere else. `getSetting()` already falls back to defaults on
any DB failure, so it cannot break a build-time prerender.

**Products is not affected.** `load-products.ts` refuses mixed currencies
outright (`MixedCurrencyError`, `load-products.ts:61`) and only ever reports one
store's own currency, so there is nothing for a display setting to choose. The
setting governs the Dashboard and Marketing, which are the pages that
consolidate.

The Settings field says plainly: *Used when several stores are combined. A
single store always shows its own currency.*

This is what lets the client compare like-for-like with BeProfit. It is a
default-preserving change: nothing moves until someone picks a new value.

### 3. The four surfaces

**Ad Spend card** (`MarketingPlatformCard`) — one row per platform with a share
bar and the combined total beneath, mirroring the screenshot's left card.

**Platform table** (`PlatformTable`) — one row per platform: spend, impressions,
clicks, CPC, purchases, P. ROAS. BeProfit's `v.expenses` column is deliberately
omitted: it reads 0 NOK for both rows in the reference screenshot and we have no
equivalent concept.

**Chart split by platform** — a `By platform` toggle on `MarketingChart`. Off:
today's spend against gross revenue. On: a Meta line and a Google line. Requires
`metaSpend` and `googleSpend` on each `MarketingSeriesPoint`, accumulated in the
same `byDay` pass.

**Spend check panel** (`SpendCheck`) — per connected account, over the chosen
range:

| Column | Why it is there |
|--------|-----------------|
| Account, platform | Which thing is being described |
| **Native total** | Unconverted, in the account's own currency. The number that can be held against Ads Manager or BeProfit directly |
| Converted total | The same money in display currency, so the sum is traceable to the headline |
| Days with data | `n / m`, and the first and last day that carry a row |
| Last sync | How stale the row is |
| Status | `lastError`, or inactive, or ok |

Native total is the point of the panel. If the native totals agree with BeProfit
and the headline still looks small, the answer is currency — demonstrated rather
than argued.

**"Days with data" is information, not an alarm.** A platform returns no row for
a day on which nothing was delivered, so a paused campaign and a failed sync
look identical from the row count alone. The panel must not claim to tell them
apart. It reports the count, and the first and last day carrying data, and lets
a human judge.

The banner therefore fires only on signals that are unambiguous:

- an account has a `lastError`, or
- an account's `lastSyncAt` is more than 24 hours old (the cron runs every 15
  minutes and each account is due every 6, so a day of silence is a fault), or
- an account is `active: false` while still holding spend in the range.

Collapsed by default, following the existing unassigned-campaigns notice pattern
at `MarketingClient.tsx:220`.

Served by extending `/api/marketing` rather than adding a route, so the panel
and the headline are computed from one load of one range and cannot disagree.
No extra query is needed: `accountSpendRows` already returns spend unconverted
in the account's own currency, which is exactly the native total. Only the
account `select` widens, by `createdAt`, `lastSyncAt`, `lastError`, `active` and
`name`.

### 4. The sync gap fix

```js
export function syncWindow(lastSyncAt, now) {
  const to = utcDay(now)
  if (!lastSyncAt) return { from: new Date(to.getTime() - BACKFILL_DAYS * DAY_MS), to }
  const daysSince = Math.ceil((to.getTime() - utcDay(lastSyncAt).getTime()) / DAY_MS)
  const back = Math.min(BACKFILL_DAYS, Math.max(RESTATE_DAYS, daysSince + RESTATE_DAYS))
  return { from: new Date(to.getTime() - back * DAY_MS), to }
}
```

Behaviour at the edges:

| `lastSyncAt` | `back` | Effect |
|---|---|---|
| null | 365 | First sync backfills a year, unchanged |
| yesterday | 36 | One day wider than today's 35; harmless, upserts overwrite in place |
| 60 days ago | 95 | Covers the hole |
| 2 years ago | 365 | Capped at the backfill limit |
| in the future (clock skew) | 35 | Floors at the restate window |

Cost is bounded: Meta account-level rows for 95 days sit inside one 500-row
page, and campaign fetches are already chunked at `CHUNK_DAYS = 90`.

## Testing

Behavioural, per the repo's existing style. Every test below must be able to
fail — the sync-window test is written first and observed failing against the
current implementation.

1. `syncWindow` with a 60-day-old `lastSyncAt` reaches back far enough to cover
   the gap. **Fails before the fix.**
2. `syncWindow` edge table: null, yesterday, two years, future date.
3. Platform totals equal shop totals equal the headline total, with two accounts
   in different currencies.
4. The same invariant with one split-by-campaign account in the mix, so campaign
   rows are proven to reach the platform buckets.
5. An unknown provider string gets its own bucket and does not inflate Google.
6. `share` is 0 rather than `NaN` when total spend is 0.
7. Spend check reports `24 / 30` when six days in the range have no row, and
   does **not** raise the banner for it on its own.
8. The banner does fire for a `lastError`, and for a `lastSyncAt` older than
   24 hours.
9. Spend check native total is unconverted — a NOK account reports NOK, not
   display currency.
10. Display currency: several shops honour the setting; one shop still reports
    its own currency and ignores it.
11. Component tests: card renders both platforms with bars; table renders CPC as
    a dash when clicks are 0; chart toggle swaps series; panel stays collapsed
    until expanded and the banner appears only on a problem.

## Out of scope

Recorded rather than fixed, so they are not lost:

- **Finding 4** — an ad account whose shop is `active: false` contributes zero
  spend everywhere with no notice. The spend check panel will surface it as a
  symptom (the account is absent from the list), but the underlying silence is
  a separate fix.
- BeProfit's `v.expenses` column has no equivalent in this system.
- Whether every one of the client's ad accounts is actually connected. The
  spend check panel is what makes that answerable; connecting missing accounts
  is an operational step, not a code change.
