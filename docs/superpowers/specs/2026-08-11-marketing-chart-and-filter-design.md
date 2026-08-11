# Marketing trend: ROAS and POAS, granularity, a platform filter and refresh

**Date:** 2026-08-11
**Status:** approved, ready for planning

## The complaint

The client looked at the Marketing page again after the platform ad spend work
landed and said, of his BeProfit screenshot:

> i believe there are lack there is not there that is already on biprofit

So this is a gap-closing pass against the same reference screenshot, not a new
feature. Reading the two side by side for the same page:

| BeProfit has | We have | In this design |
|---|---|---|
| ROAS and POAS dashed lines on the trend, right-hand axis | Meta and Google lines, one axis | **Yes** |
| Daily / Weekly / Monthly toggle | daily only | **Yes** |
| Ad Platform filter scoping the page | switcher drives only the campaign drill-down | **Yes** |
| Refresh Marketing Data on the page | lives in Settings | **Yes** |
| Export button | none | No — see Out of scope |
| Email & SMS tab | none | No — a separate channel, its own project |
| Marketing Simulator | none | No |
| `v.expenses` column | none | No — declined in the 2026-08-10 design and still declined |

## What already landed, so it is not re-litigated

The 2026-08-10 platform ad spend work shipped the platform card, the platform
table, the by-platform chart toggle, the Spend check panel with unconverted
native totals, operator-chosen display currency, and the `syncWindow` fix for
the sealed-hole bug.

**The "too little spend" half of the original complaint is not assumed to be
live.** At the time of writing the page reads 373 333 NOK for Aug 1–11, which
is 11 days at roughly 33 900/day. The BeProfit reference was 639 337 NOK over
30 days, roughly 21 300/day. Per day ours now runs *higher* than his reference.
If it still reads low on a matched range, the answer is in the Spend check
panel's native totals — that panel exists precisely so this is demonstrated
rather than argued, and nothing in this design would change the total anyway.

Everything below is presentation work on numbers that are already correct.

## Design

### 1. `netProfit` reaches the series

POAS needs per-day profit. `dailySeries` already computes it on `SeriesPoint`
(`metrics/trend.ts`); it is simply not carried across into the marketing series
at `marketing.ts:291`.

```ts
export type MarketingSeriesPoint = {
  date: string
  spend: number
  grossRevenue: number
  netProfit: number   // new — whole-store, already net of ad spend
  metaSpend: number
  googleSpend: number
}
```

`netProfit` is `netRevenue − cogs − fulfillment − fees − marketing − opex −
commission` (`engine.ts:245`), so ad spend is deducted before this number
exists. That fixes the definition of POAS below; it is not a free choice.

### 2. The platform filter is a server concern

Filtering by platform changes spend on every row, and every ratio derived from
spend must be recomputed. Doing that on the client means a second copy of
`ratios()`, which is the drift this codebase warns against in four separate
places and which would show up as the platform card disagreeing with the
headline tile.

So `/api/marketing` takes a `platform` parameter and filters the account list
before `accountSpendRows` runs. The scoped list feeds `accountSpendRows`,
`unassignedCampaignCount` and the Spend check panel alike, so every surface on
the page is describing the same set of accounts.

An unrecognised value is a **400**, validated against the providers actually
present on the connected accounts. A typo must not render as a legitimate zero
— that is the same failure mode `searchStream`'s `PARSE_FAILED` sentinel exists
to prevent (`google.ts:146`).

**Two ratios cannot survive the filter.** `roas` and `cpa` divide whole-store
revenue and whole-store orders by spend. Give them Meta-only spend against
whole-store revenue and they do not narrow, they inflate: a store ROAS of 5.5x
becomes 7.5x for no reason but a dropdown. `ratios()` therefore takes a
`wholeStore` flag, false whenever a platform filter is active:

```ts
roas: wholeStore && row.spend > 0 ? row.grossRevenue / row.spend : null,
cpa:  wholeStore && row.spend > 0 && row.orders > 0
        ? Math.round(row.spend / row.orders)
        : null,
```

This produces a dash through the mechanism `ratios()` already uses for every
other ratio with no honest denominator (`marketing.ts:120-124`), on `byShop`
rows and on `total` alike. The cell carries a tooltip saying whole-store revenue
cannot be divided by one platform's spend.

`grossRevenue` and `orders` themselves stay visible. They are still true; they
are just not divisible by this spend.

**Which surfaces the filter reaches.** All of them, because they are all built
from the one scoped result: the four KPI tiles (`MarketingStats`), the ad spend
card, the platform table, the shop table and the Spend check panel. A filter
that narrowed only some of them would put two different scopes on one screen
with nothing saying which was which.

**The control** is a `PlatformFilter` beside `ShopFilter` and `DateFilter` in
the page header. Its options are built from `byPlatform` in the response, so
only platforms that actually have a connected account appear, and the client
cannot offer a value the server would reject. It defaults to All platforms and
is session state, not persisted — the same treatment `ShopFilter` already gets.

### 3. Granularity is a client concern

Bucketing sums six numbers and divides. It contradicts no server number, because
no server number reports a weekly ROAS. Keeping it in `MarketingChart` makes the
toggle instant and adds no API surface.

```
bucket.spend        = Σ day.spend
bucket.grossRevenue = Σ day.grossRevenue
bucket.netProfit    = Σ day.netProfit
bucket.metaSpend    = Σ day.metaSpend
bucket.googleSpend  = Σ day.googleSpend

roas = bucket.grossRevenue / bucket.spend   // null when spend is 0
poas = bucket.netProfit    / bucket.spend   // null when spend is 0
```

**Sum then divide, never average the daily ratios.** A week in which one day
spent 200 and another spent 20 000 would otherwise weight the two equally and
report a ratio that happened on no day and to no money. This is the single most
likely defect in the whole change, and it gets a test written first and observed
failing.

Weeks are ISO (Monday start), months are calendar. A bucket is labelled by its
start date, with the full span in the tooltip. Buckets at the range edges are
usually partial and are kept as such — dropping them would remove real spend
from a chart whose whole purpose is showing where the money went.

Default is Daily, matching BeProfit. The control is a segmented control in the
chart header, mirroring the existing `PlatformSwitcher` pattern rather than
inventing a second idiom.

### 4. ROAS and POAS on the trend

Both plot on a **right-hand axis** — they are multiples, not money, and sharing
the money axis would flatten them into the baseline. Dashed, to read as derived
rather than measured, matching the reference screenshot.

They draw in both chart modes, which gives four series either way:

- combined: gross revenue, ad spend, ROAS, POAS
- by platform: Meta, Google, ROAS, POAS

**POAS is `netProfit / spend`** — profit after ad spend, over ad spend. This is
BeProfit's own definition, which matters because the client cross-checks against
BeProfit. Breakeven is 0: at POAS 0 the ads earned back exactly what they cost.

**Both lines are omitted when a platform filter is active**, with the legend
saying why. They divide whole-store figures by spend, so they fail on a single
platform for exactly the reason `roas` and `cpa` do. Hiding them is the same
honesty as the dash; drawing them would be a lie with a legend.

### 5. The refresh button

`POST /api/ads/sync` already exists, already forces past the six-hour throttle,
and `AdAccountsClient.tsx:121` already has the handler pattern: a `syncing`
state, `useToast` on both paths, the button disabled and relabelled while it
runs. Mirror it. On success a local nonce in `MarketingClient`'s fetch effect
deps pulls the fresh numbers.

It sits in the page header beside the filters. The route carries
`maxDuration = 60` because several accounts re-fetching can take real seconds,
so the disabled-and-relabelled state is load-bearing rather than decoration:
without it the button reads as broken for most of a minute.

The Marketing page redirects non-admins (`marketing/page.tsx`) and the sync route
is `assertAdmin`, so there is no role work to do.

## Testing

Behavioural, in the repo's existing style. Every test must be able to fail.

1. `netProfit` reaches `MarketingSeriesPoint` from `dailySeries`.
2. A platform filter narrows spend, impressions and clicks to that provider, and
   the platform row still equals the headline total.
3. A platform filter nulls `roas` and `cpa` on `byShop` rows and on `total`,
   while `grossRevenue` and `orders` stay intact.
4. With no filter, `roas` and `cpa` still compute — catches the `wholeStore`
   flag defaulting the wrong way, which would silently blank the ratios for
   every unfiltered user.
5. An unknown `platform` value returns 400 rather than an empty result.
6. ISO weeks start Monday; monthly buckets split on the calendar boundary.
7. **Weekly ROAS is summed-then-divided, not the mean of the daily ratios.**
   Written first, observed failing against a naive implementation.
8. A zero-spend bucket yields null for ROAS and POAS, never `Infinity` or `NaN`.
9. Partial buckets at the range edges are included, not dropped.
10. The chart omits the ROAS and POAS lines when a platform filter is active.
11. Refresh: disabled while syncing, toasts on failure, refetches on success.

## Out of scope

Recorded rather than fixed, so they are not lost:

- **Export.** Genuinely useful given how often this client cross-checks against
  BeProfit, and deliberately deferred to keep this pass to one shape of change.
  Worth its own small project.
- **Email & SMS tab.** A separate marketing channel needing its own integration.
  Nothing in this design blocks it.
- **Marketing Simulator.** Speculative; no stated requirement behind it.
- **`v.expenses`.** Still declined, for the reason the 2026-08-10 design gave:
  it reads 0 NOK for both rows in the client's own screenshot and we have no
  equivalent concept to populate it with.
- **An ad account on an inactive shop contributes zero everywhere.** Carried
  forward unchanged from the 2026-08-10 design's Finding 4. The Spend check
  panel surfaces it as a symptom; the underlying silence is a separate fix.
