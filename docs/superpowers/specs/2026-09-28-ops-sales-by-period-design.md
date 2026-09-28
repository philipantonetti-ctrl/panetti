# Sales by week / month for the operations role — design

Date: 2026-09-28
Requested by: the operations manager, relayed by Marvin
Status: approved in conversation, awaiting written-spec review

## The request

> In the dashboard or orders tab, is there a way to generate analytics with
> weekly comparison? Or by month or both? And also the option to exclude the
> "0" amount orders?

## Decisions already made

| Question | Decision |
|---|---|
| Shape | A **period table**: rows of weeks or months side by side |
| Where | **Both**: the table on the operations Dashboard, and an exclude-0 filter on the Orders list |
| Approach | Engine-backed, one load, grouped in memory (approach A) |
| "Sales" | **Net revenue excl. VAT**: goods + shipping − discounts. Identical to the owner's "NET REVENUE" |
| Current, partial period | Marked **so far**, compared with the **whole** previous period |
| Who sees it | The operations Dashboard. The owner's dashboard is unchanged |

## What exists today (measured 2026-09-28)

- The operations `/dashboard` (`src/app/dashboard/OperationsDashboard.tsx`)
  shows five to-do cards and **no sales figures** and no date control.
- The Orders tab (`src/app/orders/OrdersClient.tsx`) shows one aggregate,
  "Total N found", and no sums or comparisons.
- Comparisons exist only on the owner's dashboard, via `/api/metrics`, which
  is `assertAdmin` and profit-first. Its "vs N days before" is by length, not
  by calendar week or month.
- Week and month bucketing exists only for the Marketing chart:
  `bucketStart` in `src/lib/ads/series-buckets.ts`, Monday weeks, months from
  the 1st.
- **0-amount orders:** among counted orders (not voided, not unpaid) placed in
  the last 90 days, **287 have `total = 0`**, about 8% of orders. Every one of
  them also has `netSales = 0`; there is no order where the goods were free but
  shipping or VAT was paid. They are real parcels: mostly whole Pizzetta Pro
  ovens and spare parts. Of all 311 zero orders in the window (any status),
  253 carry no coupon (replacements), 44 an ambassador code
  (`PANETTIAMBASSADOR.NO/.SE/.DE/.DK`) and 14 `TESTORDERCOUPON100%OFF`.

## What the operations manager sees

### Dashboard: "Sales by week / month"

A new section under the five to-do cards.

Controls:

- **Week | Month** switch. 12 rows either way: the last 12 weeks (Monday to
  Sunday) or the last 12 calendar months, newest first.
- **Shop picker.** All shops, shown in the workspace display currency (USD
  today, `Setting.displayCurrency`), or one shop, shown in its own currency.
  The same rule as the owner's dashboard (`load.ts` display currency).
- **Exclude 0-amount orders** checkbox. Off by default. When on, the section
  heading says so, and every row **and every comparison base** leaves them out.

Columns: **Period · Orders · Sales · Avg order · vs previous**

- *Period*: the whole calendar period, "22–28 Sep" or "September 2026",
  even for the current one, which additionally reads **so far** and counts
  only up to today.
- *Orders*: the count the owner's dashboard would show for those dates.
- *Sales*: net revenue excl. VAT, whole units in the display currency.
- *Avg order*: Sales ÷ Orders, recomputed per row, never averaged.
- *vs previous*: the change in Sales against the whole previous period, as a
  percentage. A previous period of 0 shows "no prior data", as the owner's
  dashboard does.

Never shown, never sent: cost of goods, fulfilment, fees, commission,
marketing, affiliate cost, expenses, profit, margin.

### Orders tab: one filter

An **Exclude 0-amount orders** checkbox next to Status and Source. It filters
on the server, so the list, "Total N found" and "Load more" all follow it.

## How it works

### `src/lib/metrics/periods.ts` (new, pure)

- `periodBuckets(grain, today, count)` returns `count + 1` buckets, newest
  first, each `{ from, to, soFar }`. The extra, oldest bucket exists only so
  the oldest shown row has a "vs previous". `soFar` is true for the bucket
  that contains `today`, whose `to` is `today`.
- `salesByPeriod(input, buckets, { excludeZero })` returns one row per shown
  bucket: `{ from, to, soFar, orders, sales, avgOrder, vsPrevious }`.
  - Orders are counted with the engine's own `entriesIn`
    (`src/lib/metrics/engine.ts:118`): the same excluded statuses, and an order
    belongs to the day it was placed **in its shop's timezone**.
  - Money is converted per order with `crossConvert`
    (`src/lib/metrics/fx.ts:127`) at that order's own day rate, then summed.
    Per-order conversion is additive, so a bucket's sum equals
    `computeMetrics` for the same dates.
  - `excludeZero` drops orders with `total === 0` before anything is counted,
    for every bucket alike.
- Monday weeks come from `bucketStart`, moved from
  `src/lib/ads/series-buckets.ts` to a neutral module (it currently imports a
  marketing type) and re-exported from its old home so the Marketing chart is
  untouched.

### `GET /api/sales/periods` (new)

- Query: `grain=week|month`, `shops=` (as every other route), `excludeZero=1`.
- Guard: `assertOperations` (`src/lib/auth/guard.ts:52`), so ADMIN and
  OPERATIONS. `Cache-Control: private, no-store`.
- Loads once with `loadMetricsInput` (`src/lib/data/load.ts:30`) over the full
  span of all buckets, then calls `salesByPeriod`.
- Response is built field by field from an **allowlist**:
  `{ grain, currency, excludeZero, rows: [{ from, to, soFar, orders, sales, avgOrder, vsPrevious }] }`.
  No engine object is spread into it, so no cost field can reach it.

### `GET /api/orders` (changed)

- `excludeZero=1` adds `total: { not: 0 }` to the one `where` that feeds both
  the count and the rows (`src/app/api/orders/route.ts:103-141`).

### UI

- `OperationsDashboard.tsx` stays a server component. The table is a client
  island, `src/app/dashboard/SalesByPeriod.tsx`, fetching `/api/sales/periods`.
- `OrdersClient.tsx`: a checkbox in the toolbar, sent from `buildParams`,
  included in the effect's dependencies.

## Testing (red first, watched fail)

1. **Buckets:** Monday weeks across a month edge and a year edge; calendar
   months; the current bucket is `soFar` and ends today; a Sunday 23:30
   Europe/Oslo order lands in its shop's week, not the UTC one; voided and
   unpaid orders never count.
2. **Exclude zero:** removes zero orders from every row and from the
   comparison base, and only when asked.
3. **Agreement with the owner's dashboard:** on one fixture, a week's row
   equals `computeMetrics` for the same dates in orders, net revenue and
   average order value.
4. **vs previous:** against the whole previous period; a zero base gives
   `null`.
5. **Route access:** `/api/sales/periods` added to HIS_DOORS in
   `src/app/api/operations-access.integration.test.ts`.
6. **No cost leak:** the raw JSON for both roles contains none of `cogs`,
   `commission`, `margin`, `profit`, `fulfillment`, added to
   `src/app/api/operations-no-profit.integration.test.ts`.
7. **Orders filter:** `excludeZero=1` drops zero orders from both `total` and
   `orders`.
8. **Components:** the switch changes the grain, the checkbox sends the
   parameter, the current row says "so far".
9. **Live, after deploy:** one week's row against the owner's dashboard for
   the same dates; the 0-amount count against SQL; the load time of a 12-month
   request measured on production data.

## Known effects, stated so nobody is surprised

- **Early in a week or month the current row shows a large drop.** It is "so
  far" against a whole period, by decision.
- **With the checkbox on, order counts go down about 8% and the average order
  goes up.** Philip cross-checks orders against BeProfit, which counts them;
  the checkbox is off by default and the heading says when it is on.
- The owner's dashboard's "vs N days before" compares by length, not by
  calendar. Its percentage for "This month" will differ from this table's.
  Both are right; they answer different questions.

## Out of scope

- The owner's dashboard is not changed.
- No chart, no CSV export, no custom number of periods.
- Ad spend and other costs are not shown to operations, in any form.
