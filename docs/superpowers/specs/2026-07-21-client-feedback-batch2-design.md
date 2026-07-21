# Client feedback batch 2 — design

**Date:** 2026-07-21 · **Status:** Approved (4 scope questions answered by owner)

Philip's first full review produced 8 items. Decisions locked: catalog-price fetch for
VAT display; fulfillment = default rate only; Dintero fee global with EUR fixed part
converted per order; ONE global settings page (not per shop).

## 1. Selling price incl. VAT (Product costs)

Sync additionally fetches each shop's product catalog (`/wp-json/wc/v3/products`,
pages of 100) and stores the catalog `price` — which these stores list incl. VAT —
into a new nullable `Product.catalogPrice Int?` (minor units). It only UPDATES
products we already know from orders; "every product ever sold" semantics stay.
Product costs page shows `catalogPrice ?? lastPrice`; subtitle says prices include VAT.
Costs entered stay ex-VAT; profit math unchanged by this item.

## 2+8. One global Settings → General page

New singleton table `Setting`:
`timezone` (default "Europe/Oslo"), `defaultPreset` (default "this_month"),
`dateFormat` (options: Jul-21-2026 · 21-Jul-2026 · 07/21/2026 · 21/07/2026 · 2026/07/21),
`currencyFormat` (options: `1 000,00 €` · `1 000,00 EUR` · `€1,000.00`).
Settings page gets a General tile: those four dropdowns (timezone list from
`Intl.supportedValuesOf('timeZone')`). Currency itself stays per shop.

**Timezone is load-bearing:** day boundaries, presets and the trend series bucket in
the SETTING's zone (today: hardcoded UTC — orders placed 00:00–02:00 Oslo time land
on the previous day). Implementation: `zonedDay(date, tz)` via `Intl.DateTimeFormat`
(no new deps); presets resolve from "today in tz"; custom from/to interpreted as
tz-days. FX lookup stays keyed by the order's UTC date (daily ECB rates; documented
tolerance). DST-boundary tests required. Default preset comes from the setting.
Date/currency formats apply on dashboard surfaces via a settings context; `formatMoney`
gains a style parameter defaulting to current behavior.

## 3. Date range picker

`DateFilter` becomes one popover: preset list (existing 8 + Last week, Last month,
Last year, Last 12 months — BeProfit's quarters dropped) + dual-month calendar +
Apply. Range semantics: first click = from; second click = to; clicking a day before
the current from RESTARTS the range at that day. Hand-rolled calendar, no new deps.
Used by dashboard and portal.

## 4+5. Fulfillment default rate (per shop, timeline)

New table `FulfillmentRate { shopId, perOrder Int (minor, shop currency),
effectiveFrom, createdAt }` — a timeline like ProductCost: the rate charged to an
order is the newest row with `effectiveFrom <= placedAt`. No rules engine (weight /
quantity / carrier tiers deliberately NOT built). Settings → Fulfillment: per shop,
current rate + history + "New rate" (amount + from date). Engine: new figure
`fulfillment` = Σ rate-at-order-date over live orders. **Net profit now subtracts it.**
Shops with no rates contribute 0.

## 6. Zebra + column

CompareTable tbody: even rows get the light panel tint (hover intact, sticky
first-cell background follows via bg-inherit). New "Fulfillment" money column after
COGS; "Transaction fees" column after Net revenue (item 7).

## 7. Processing fee (Dintero Checkout, global)

New table `ProcessingFee { percent Float, fixedMinor Int, currency "EUR", active }`
— one row, edited via Settings → Processing fees (single Dintero card: % + fixed €).
Engine: per live order `fee = round(total × percent/100) + convert(fixedMinor,
EUR → order currency at the order's own date)` — `total` is the charged amount incl.
VAT, because that is what the gateway takes its cut of. Needs a cross-currency
`convertBetween` in the fx module (via the USD rate table). New figure
`transactionFees`; **Net profit subtracts it**; applies to all history (flat rate
assumption, same as BeProfit).

**New profit formula:**
`netProfit = netRevenue − cogs − fulfillment − transactionFees − operationalExpenses − commission`
(taxes still informational only).

## Phasing (each: branch → TDD → green → deploy)

- **P1** zebra + range picker (no schema)
- **P2** schema additions in ONE additive `prisma db push` (Setting, FulfillmentRate,
  ProcessingFee, Product.catalogPrice) — prod push with inline URL, additive-only,
  after local green; live data untouched
- **P3** catalog price sync + display
- **P4** fulfillment settings + engine + column
- **P5** processing fee settings + engine + column
- **P6** timezone/formats/default-range (deepest engine change, DST tests)

## Out of scope

Fulfillment rules engine; other payment gateways; per-shop timezones/formats;
quarter presets; Handling/Duties toggles (default rate covers the need).
