# Product analytics — design

**Date:** 2026-08-05
**Status:** approved, ready for an implementation plan

## The ask

A page showing how each product performed, per store, over a date range. Several
stores can be viewed together, but only when adding their money together is
honest. Modelled on BeProfit's Products Analytics screen, which the client uses
and compares us to.

## What already exists

Nothing new has to be synced. Every figure below is already in the database:

| Figure | Source |
| --- | --- |
| Orders | count of DISTINCT orders containing the product, not line count — an order listing it twice counts once |
| Quantity | `sum(OrderItem.quantity)` |
| Gross sales | `OrderItem.unitPrice x quantity` |
| Net sales | `OrderItem.lineNetTotal` (after discount, excl VAT) |
| COGS | `ProductCost` timeline, read through `costOn()` |
| Profit, margin | derived |

BeProfit's `Vendor` and `Type` columns have no equivalent — the Woo sync does not
store them — and are out of scope.

## Decisions

### Rows merge on SKU

One row per product across the selected stores, expandable into per-store rows.
The same physical product exists as a separate `Product` per shop
(`@@unique([shopId, externalId])`) with a translated name, so a per-store-only
table cannot answer "how is the Pizzetta Pro doing". Confirmed with the client
that SKUs are identical across stores.

**Exception:** where `Product.sku === Product.externalId`, the row does not merge.
That equality is exactly `map.ts:101`'s no-SKU fallback (`li.sku || String(li.product_id)`),
and Woo product ids are per-store sequential — merging on them would fold two
different stores' product #42 into one row.

### Multi-store view is gated on currency, not country

`Shop` records `currency` and has no country column. The rule that protects the
arithmetic is currency: Finland and Germany are different countries but both EUR,
and adding EUR to EUR is correct. This is also the rule BeProfit states.

A selection spanning more than one currency is refused, not silently converted.

### Display currency is the group's own currency

`load.ts:36` forces USD whenever more than one shop is selected. This page departs
from that deliberately: the same-currency rule makes a native total correct, so the
client reads EUR as EUR rather than a converted figure he has to trust.

FX is still wired in for one case. A B2B order can be invoiced in a currency the
shop does not use (`load.ts:105`, `costCurrency`), so the engine's two-converter
split is kept — order currency for revenue, shop currency for costs. `convert()`
short-circuits when they match (`fx.ts:92`), so the ordinary case costs nothing.

### Profit is exact, never apportioned

Product profit = net sales − COGS. Shipping, gateway fees, fulfillment and
ambassador commission sit on the *order*, not the product, and splitting them by
share of line value would turn every figure into an estimate. BeProfit's
"Contribution Profit" does exactly that; we are not copying it.

Ad spend is explicitly excluded. It is per campaign, not per product, and pushing
it down to products would be a guess dressed as a number.

Note: `Figures` gained a `marketing` field in `037c96b` (ad spend, per shop per
day, in `EngineAdSpend`). That is a SHOP-level figure and stays one. There is no
column on this page that consumes it, and none should be added — a product has no
share of a campaign that can be established from data we hold.

## Architecture

### `src/lib/metrics/products.ts` (new)

```ts
export function productFigures(input: ProductInput): ProductResult
```

Pure, no database access, mirroring `computeMetrics`. Returns merged rows, each
carrying its per-store children, plus a total row.

The total row is a **sum**, with margin recomputed from the summed figures —
never an average of the row margins. This matches `totalOf()` (`engine.ts:267`)
and is why BeProfit's "Weighted Average" footer is not copied: averaging a 74%
margin on a 474 EUR product against a 69% margin on a 15.000 EUR one produces a
number that describes nothing.

Three rules are inherited from the engine rather than reimplemented:

1. **Refunds reverse.** `entriesIn()` (`engine.ts:87`) is currently private. It is
   exported and shared. A refunded order counts +1 on its placed day and −1 on its
   voided day, on this page and on the Dashboard, permanently in step. A private
   copy would drift, and four recent commits exist precisely because this rule is
   easy to get wrong.
2. **Costs are dated.** `costOn(history, order.placedAt)` — a cost edited today
   never rewrites last month's margin.
3. **`orders` counts DISTINCT orders among sale entries only** (`sign === 1`),
   matching commit `b2e9385`. A reversal is not an un-placed order, and an order
   listing the same product on two lines is still one order.

### `src/lib/data/load-products.ts` (new)

`loadMetricsInput` selects only `productId, quantity, lineNetTotal` from order
items (`load.ts:94`). This page also needs `sku`, `name`, `unitPrice` and the
product's `imageUrl` and `externalId`. A sibling loader is added rather than
widening that select, because every Dashboard request would otherwise carry three
unused columns across thousands of rows.

The loader resolves the display currency from the selected shops and throws when
they disagree.

### `src/app/api/products/analytics/route.ts` (new)

Admin-only, `Cache-Control: private, no-store`, the same boundary as
`api/metrics/route.ts`. Reuses `rangeFromQuery` and `shopIdsFromQuery`.
Returns 400 with the available currency groups when the selection is mixed —
a hand-typed `?shops=` must not slip past a client-side check.

### `src/app/products/` (new page)

`page.tsx` (server, auth + shop list) and `ProductsClient.tsx`, following
`marketing/page.tsx` and `MarketingClient.tsx` exactly. Header carries the existing
`ShopFilter` and `DateFilter`; no new filter components.

Nav entry "Products" in the Analytics section of `AppShell.tsx:48`, under
Marketing. Distinct from `/settings/costs` ("Product costs"), which is where costs
are entered; this is where they pay off.

### `src/app/products/ProductsTable.tsx` (new)

Merged rows sorted by profit descending, click to expand per-store children —
the drill-down pattern from `marketing/BreakdownTable.tsx`. Thumbnail from
`Product.imageUrl`, already stored by the sync (`sync.ts:105`). Client-side sort
and search over the fetched rows.

No pagination. Merging on SKU should keep this under a hundred rows; if real data
proves otherwise, pagination is a small follow-up.

## Uncosted products must be visible

`costOn()` returns zero when no cost was ever entered (`costs.ts:25`), so an
uncosted product reports a 100% margin — a lie that looks like a triumph. Every
such row is marked, and the header carries a count linking to `/settings/costs`:

> 7 of 41 products have no cost entered — their margins read as 100%. Add costs →

## Errors and empty states

| Condition | Behaviour |
| --- | --- |
| Selection spans several currencies | No request. Panel naming the currencies, with one-click fixes per group. API also returns 400. |
| No shops selected (`NO_SHOPS`) | Empty state, no request. |
| No sales in range | "No products sold in this period." |
| API failure | The inline error strip used by the Marketing page. |
| Zero net sales on a row | Margin renders `—`, matching the `ratios()` convention. |

## Testing

Written first, RED confirmed before GREEN.

`products.test.ts`:

- a refunded order removes its products on the voided day, not the placed day
- a cost change does not rewrite an earlier period's margin
- the same SKU in two shops merges, and the per-store children sum to the parent
- products where `sku === externalId` never merge
- a EUR B2B order on a NOK shop converts at its own day's rate
- `orders` counts sales, not reversals
- zero net sales yields no margin rather than `NaN` or `Infinity`

`route.test.ts`: mixed-currency selection returns 400; non-admin returns 403.

`ProductsTable.test.tsx`: header order; expansion reveals per-store rows; uncosted
rows are marked; the uncosted count is accurate.

`engine.test.ts`: unchanged and still passing, proving the `entriesIn()` export
changed no behaviour.

## Out of scope

- Vendor and Type columns (not synced)
- Contribution profit / allocated order costs
- Ad spend attributed to products
- A manual "these are the same product" mapping across stores (unnecessary while
  SKUs match; its own spec if that ever changes)
- Cross-currency product totals
