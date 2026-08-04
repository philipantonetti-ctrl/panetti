# Marketing as a cost, ROAS on the dashboard

2026-08-04

## Why

The Compare table has a Shipping column that reads `$0.00` for every shop, in
every period. It is not broken: shipping *charged to the customer* really is
zero everywhere, because these shops ship free. The shipping that costs money
is already counted under Fulfillment, where a B2B order carries its own
`fulfillmentCost` and a webshop order gets the shop's per-order rate. So the
column occupies a screen-width of a table that already scrolls sideways, and
tells the reader nothing.

Net revenue has the same problem for a different reason. `netRevenue =
netSales + shippingCharged`, and with shipping at zero the two columns print
identical figures side by side. The reader sees the same money twice and has to
work out which one to trust.

Meanwhile the largest cost in the business is not in the profit table at all.
Meta and Google spend lives on the Marketing page, so the dashboard's Net
profit is overstated by every krone spent on ads.

Three changes, one screen: drop the two dead columns, put Marketing in the
table as a real cost, and give each shop a ROAS.

## What changes on screen

`src/components/dashboard/CompareTable.tsx`.

```
before:  Orders · Gross revenue · Discounts · Net sales · Shipping · VAT ·
         Net revenue · Transaction fees · COGS · Fulfillment · Op. expenses ·
         Commission · Net profit · Margin

after:   Orders · Gross revenue · Discounts · Net sales · Fulfillment · VAT ·
         Transaction fees · COGS · Marketing · Op. expenses · ROAS ·
         Commission · Net profit · Margin
```

- `shippingCharged` and `netRevenue` are removed from `COLUMNS`.
- `fulfillment` moves up into Shipping's old slot, after Net sales.
- `marketing` goes in at Fulfillment's old slot, after COGS: Meta and Google
  spend combined for that shop, total spend in the Total row.
- `roas` goes in to the right of Op. expenses.

Net profit and Margin will both fall, on every row and in the Total, because
marketing is now deducted. That is the point of the change, not a regression.

### ROAS

That row's gross revenue divided by that row's marketing spend, printed
`7.76×` — two decimals and a multiplication sign, matching `MarketingTable`'s
`roas` cell so the two screens read the same. The Total row is therefore the
blended ROAS with no separate calculation: total gross revenue over total
spend, which is exactly what the footer already sums to.

A row with no ad spend prints `—`, never `0.00×`. This follows the rule
`ratios()` in `src/lib/ads/marketing.ts` already sets: a ratio with a zero
denominator is not a number, and printing one would lie. Zero gross revenue
against real spend is a different case — `0.00×` is the true answer there, and
it prints.

### The metric picker

`STORAGE_KEY = 'compare-columns'` stores the HIDDEN keys and its reader already
drops keys it does not recognise, so a browser holding `shippingCharged` or
`netRevenue` in its saved list needs no migration: those entries are discarded
on read. `marketing` and `roas` are absent from every saved list, so they
arrive ticked, which is what a new column should do.

### Everything else on the dashboard

Unchanged. In particular the top strip keeps its NET REVENUE tile: there is no
Net sales tile up there, so nothing is shown twice, and `stat-net-revenue` is
the figure `e2e/b2b.spec.ts` asserts on.

The COGS column keeps its share-of-net-revenue percentage. Net revenue is still
computed and still the basis of profit and margin; only its column goes.

## Where the Marketing number comes from

Marketing has to enter through the engine, not be merged onto the rows in the
browser. `dailySeries` runs the same engine per day for the Trend chart, and
`/api/metrics` runs it a second time over `previousRange` for the "vs previous
month" arrows. A figure stitched on in the client would be missing from both,
so the chart's profit line and the delta arrows would quietly disagree with the
table they sit above.

### The engine

`src/lib/metrics/types.ts`:

```ts
/** One day of one ad account's spend, in the ACCOUNT's billing currency. */
export type EngineAdSpend = {
  shopId: string
  date: Date       // UTC midnight, as the platforms report it
  spend: number    // minor units
  currency: string
}
```

`Figures` gains `marketing: number`, and `ZERO_FIGURES` gains `marketing: 0`.

`MetricsInput` (`src/lib/metrics/engine.ts`) gains `adSpend?: EngineAdSpend[]`.
Optional, so every existing caller and every existing test keeps compiling and
keeps its current numbers: no rows means marketing is 0 means net profit is
what it was.

`computeMetrics` sums a shop's rows that fall inside `[from, to]`, converting
each at **its own day's rate** through the existing `convert()` — the same rule
orders already follow, so a rate move never rewrites last month.

Net profit becomes:

```
netRevenue − cogs − fulfillment − transactionFees − marketing
           − operationalExpenses − commission
```

`netMargin` keeps net revenue as its denominator and simply falls with profit.
`totalOf` adds `marketing` like any other money field.

Two details that matter:

- **Range filtering lives in the engine**, not in the caller, so `dailySeries`
  works untouched: it passes `{ ...input, orders: <that day's> }` with
  `from = to = day`, and the engine picks out that day's spend by itself.
  Membership is by UTC day (`utcDay(from) <= row.date <= utcDay(to)`), matching
  how `/api/marketing` already queries the table.
- **Group by shop once.** Build a `Map<shopId, EngineAdSpend[]>` at the top of
  `computeMetrics`, before the `shops.map`, and filter only by date inside it.
  A year of `dailySeries` calls the engine 365 times over the same rows; the
  naive nested filter is shops × rows × days.

### ROAS is not an engine field

It is a ratio of two numbers already on the row, so `CompareTable` derives it:

```ts
type Row = ShopFigures & { roas: number | null }
const withRoas = (f) => ({ ...f, roas: f.marketing > 0 ? f.grossRevenue / f.marketing : null })
```

`Column.key` widens from `keyof ShopFigures` to `keyof Row`, `Column` gains a
`roas?: boolean` flag beside its existing `money` and `percent` ones, `Cell`
renders `null` as `—`, and sorting nulls last uses
`a[sortBy] ?? Number.NEGATIVE_INFINITY`, the same guard `MarketingTable`
already uses. Putting `roas: number | null` into `Figures` instead would force
every consumer of that type to handle a null, to no benefit — and rounding it
to `0` to keep it a `number` would print the lie the dash exists to prevent.

### The loader

`src/lib/data/load.ts` fetches the rows: active `AdAccount`s for the shops in
scope, then their `AdSpend` for `utcDay(from) .. utcDay(to)`, selecting only
`accountId`, `date` and `spend`. Each row is joined to its account's `shopId`
and `currency` in memory, the way `rateByAmbassador` is already done.

Ad-account currencies join the `inPlay` set that drives `ensureRates`. An
account can bill in a currency no shop trades in, and without this its spend
would convert on whatever stale rate happened to be lying around.

### One rate table

Once the loader guarantees rates for ad currencies, the `extra` / `ensureRates`
/ `buildRateTable` block in `src/app/api/marketing/route.ts` is dead: it can
use `input.rates`. That is ten lines removed, and more importantly it removes
the second code path — the Marketing page and the Dashboard must never be able
to quote different spend for the same period.

The marketing route keeps its own `adSpend` query. `buildMarketing` needs the
full `SpendRow` (impressions, clicks, conversions, video) that the engine has
no use for, and loading all of that on every dashboard request to serve one
column would be the wrong trade.

## Risks

1. **Double counting.** Any Meta or Google spend currently entered under
   Settings → Expenses will be counted twice from the moment this ships. The
   seeded expenses are 3PL, accounting, employees, tools and office — none of
   them ads — but the live `OperationalExpense` labels must be read before
   deploy. Anything that looks like ad spend is reported to the client, and
   removed only on their say-so: it is their bookkeeping, not ours.
2. **Ad spend has no timezone.** The platforms report a plain UTC day; orders
   bucket in their shop's zone. At a range boundary a day of spend can land one
   side of the line and a day of orders the other. `/api/marketing` has always
   worked this way, so this introduces no new discrepancy — but it does put it
   next to a profit figure for the first time.
3. **The client will see profit drop.** Worth saying out loud when it ships,
   with the marketing total that explains the difference, so it reads as a
   correction rather than a bug.

## Tests

`src/lib/metrics/engine.test.ts`

- Ad spend converts at its own day's rate, not the range's.
- Net profit falls by exactly the converted spend.
- A shop with no ad account gets `marketing: 0`, not a missing field.
- Rows outside `[from, to]` are excluded.
- Rows for another shop do not leak across.
- `totalOf` sums marketing across shops.

`src/lib/metrics/trend.test.ts`

- A day's profit point includes that day's spend, and only that day's.

`src/components/dashboard/CompareTable.test.tsx`

- The header list is the new fourteen, in order. (The existing assertion is
  updated, not added to.)
- Marketing renders as money in both a shop row and the Total.
- ROAS renders `7.76×` from gross revenue over marketing.
- ROAS renders `—` when marketing is 0.
- ROAS renders `0.00×` when there is spend but no revenue.
- Sorting by ROAS puts the dashes last.

`src/lib/data/load.integration.test.ts`

- Spend lands on the shop that owns the ad account.
- Spend outside the range is not loaded.

Every existing net-profit assertion across the suite passes unchanged, because
`adSpend` is optional and absent means zero.

## Out of scope

- A blended ROAS tile in the top strip. The Total row carries the number; a
  tile is a second place to keep correct.
- Marketing or ROAS in the Trend chart as their own lines. Profit already moves
  with spend now, which is the question the chart answers.
- Attributing spend to individual orders or ambassadors. Platform attribution
  lives on the Marketing page and stays there.
