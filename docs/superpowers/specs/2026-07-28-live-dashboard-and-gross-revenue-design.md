# Live dashboard for everyone, Gross revenue column, COGS share

Date: 2026-07-28

## Why

The client (logged in as admin, same account) reported seeing an "old dashboard"
while the developer saw fresh data. He also asked for two Compare-shops changes:

> "Can we please add a Gross revenue after the Orders section? Is it also
> possible to have a (%) after total amount under COGS section, to see how many
> % of the Net revenue? So for example for Panetti Norway under COGS it would
> say $3,843.74 (26.10%)"

(26.10% = 3,843.74 / 14,726.58 — confirmed against his screenshot, so the
percentage base is net revenue.)

## Root cause of the "old dashboard" (investigated, with evidence)

The server is NOT stale. Webhooks and the 15-minute cron keep the database
current, and the live API answers with `Cache-Control: public, max-age=0,
must-revalidate` (verified with curl against panetti.vercel.app), which forbids
serving cached copies without revalidation. There is no service worker.

The staleness is in the browser tab: `DashboardClient` and `OrdersClient` fetch
their data once on mount and again only when a filter changes. A tab left open
overnight shows the world as of when it loaded — forever. The developer reloads
constantly and sees fresh data; the client parks the tab and sees old data.
Both experiences are "correct" per the current code; the code just never
refreshes on its own.

(A long-lived tab also runs the UI bundle it was loaded with, so it misses
newly deployed columns until a reload or navigation. The data fix below also
softens this: the numbers in an old tab stay current even before a reload.)

## Fix 1: open tabs keep themselves current

New hook `useLiveTick(everyMs = 60_000)` in `src/lib/use-live-tick.ts`:

- returns a counter that bumps when the window regains focus, when the tab
  becomes visible again, and every `everyMs` while the tab stays visible;
- never bumps while `document.hidden` (a background tab does no work);
- coalesces bursts (focus + visibilitychange fire together) with a 1 s guard.

Wiring:

- `DashboardClient`: add the tick to the metrics-fetch effect deps. The effect
  gains an `AbortController` so a superseded response can never overwrite a
  newer one. Tick refreshes are silent — `loading` is only set by the filter
  handlers, so nothing dims or flickers.
- `OrdersClient`: add the tick to the orders-fetch effect deps. A tick-driven
  run (detected by comparing the tick against a ref of the last seen value)
  differs from a filter run in two ways: it requests `limit =
  max(PAGE, current row count)` capped at the API's 200 so "Load more" pages
  survive the refresh, and it does NOT close the expanded order row. Filter
  runs keep today's behavior exactly. Same `AbortController` treatment.
- `/api/metrics` and `/api/orders` responses gain
  `Cache-Control: private, no-store`: admin-only financial JSON has no
  business being `public`, and no intermediary may ever replay it.

60 seconds is the poll cadence: webhooks land in the database within seconds,
so an open tab is at most a minute behind, and instantly fresh on focus. Two
or three open admin tabs cost a handful of light queries per minute — nothing
Neon notices.

## Fix 2: Gross revenue after Orders

The engine already computes the number the client wants: net revenue + VAT =
what customers actually paid (Nordic "brutto"). It is called `salesInclVat`
and hides mid-table. Rename the metric to `grossRevenue` across engine, types
and tests, and move the column to sit directly after Orders with the label
"Gross revenue" (hint unchanged: 'What customers actually paid: net revenue +
VAT (Nordic "brutto")').

Renaming the key (not just the label) matters: the column picker stores hidden
keys in localStorage, and the client's browser currently hides `salesInclVat`.
Unknown keys are dropped on load, so `grossRevenue` starts visible for
everyone — which is exactly what "add" means here. No other definition fits
better: gross sales before discounts already exists as its own column, and a
Scandinavian owner saying "gross" means brutto, VAT included.

## Fix 3: COGS shows its share of net revenue

In `CompareTable`, the COGS cells (shop rows and the Total row alike) render
`$3,843.74 (26.10%)` — the row's `cogs / netRevenue`, two decimals. When net
revenue is zero or negative the parenthesis is omitted; a shop with no sales
shows plain `$0.00`.

## Testing

- `sales-incl-vat.test.ts` → `gross-revenue.test.ts`, asserting `grossRevenue`.
- `CompareTable.test.tsx`: Gross revenue header sits right after Orders; COGS
  cells carry the share; zero-revenue rows carry none; Total row shares too.
- New `use-live-tick.test.ts`: interval bumps while visible, focus bumps,
  hidden tab never bumps, bursts coalesce.
- `OrdersClient.test.tsx` / new `DashboardClient.test.tsx`: a window focus
  event triggers a second fetch without entering the loading state; the open
  row stays open on a tick refresh.
- Route tests assert the `Cache-Control: private, no-store` header.
