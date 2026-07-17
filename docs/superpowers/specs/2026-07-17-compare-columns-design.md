# Compare-shops columns — design

**Date:** 2026-07-17
**Status:** Approved (option "real numbers only" chosen over expense-splitting and a column picker)

## Why

The client compares this system against BeProfit's *Compare Shops* view, which shows 13
metrics per shop: Net Sales, Transaction Fees, Order Count, COGS, Marketing, Fulfillment,
Taxes, Operational Expenses, ROAS, Con. Profit, Con. Margin, Net Profit, Net Margin.

Our Compare shops table shows 7: Orders, Net revenue, COGS, Op. expenses, Commission,
Net profit, Margin.

The gap is smaller than it looks. The metrics engine already computes gross sales,
discounts, net sales and shipping on every request — the table simply never displays
them. VAT (`taxTotal`) is stored on every order and loaded into the engine
(`src/lib/data/load.ts` line 49) but never summed. Only the columns that need data we
do not have (ad spend, gateway fees) are genuinely out of reach today.

## What the client will see

The Compare shops table gains five columns, in this order:

| Shop | Orders | Gross sales | Discounts | Net sales | Shipping | Net revenue | COGS | Op. expenses | Commission | Net profit | Margin | Taxes |
|------|--------|-------------|-----------|-----------|----------|-------------|------|--------------|------------|------------|--------|-------|

New columns carry hover hints:

- **Gross sales** — "Before discounts, excl. VAT"
- **Discounts** — "Coupon and code discounts, excl. VAT"
- **Net sales** — "After discounts — the commission base"
- **Shipping** — "Shipping charged to customers, excl. VAT"
- **Taxes** — "VAT collected — passed on to the tax office, not income or cost"

Sorting and the Total row are driven by the same `COLUMNS` array, so both work on the
new columns with no extra code. The table container already scrolls horizontally.

## The Taxes decision (deliberate, do not "fix")

**Taxes is information, not a cost. Net profit does not change.**

Our books keep VAT out of revenue from the first byte: `mapOrder` reads WooCommerce's
ex-VAT line values, and the engine's formula is

    net profit = net revenue − COGS − operational expenses − commission

VAT is money the client passes on to Skatteetaten — never income, never an expense.
The column exists so he can see it captured (BeProfit shows the same number), and it
sits **last**, after Margin, so it never reads as a step in the profit cascade.

## Changes

1. `src/lib/metrics/types.ts` — add `taxes: number` to `Figures` and `ZERO_FIGURES`.
2. `src/lib/metrics/engine.ts` — per shop: `taxes = Σ conv(o.taxTotal, o)` over live
   orders (same conversion-at-order-date rule as every other figure); add `taxes` to
   `totalOf`.
3. `src/components/dashboard/CompareTable.tsx` — extend `COLUMNS` to the 12 data
   columns above, with hints.

No schema change, no migration, no API change (the route already returns the full
`Figures` object), no loader change (`taxTotal` already selected).

## Testing

- Engine: `taxes` is summed per shop, converted at each order's own date, refunded /
  cancelled / failed orders contribute nothing, and the Total row equals the sum of
  the shop rows.
- Existing suite (252 tests / 31 files), `tsc`, and `next build` stay green.

## Out of scope (arrives with the ads phase)

- **Marketing** and **ROAS** — need Meta/Google ad-account integrations.
- **Transaction fees** — WooCommerce's orders API does not carry gateway fees.
- **Con. Profit / Con. Margin** — defined using marketing + fees, so they come together.
- Splitting Marketing/Fulfillment/fees out of Op. expenses by category (option B).
- A BeProfit-style "Select metrics" column picker (option C).
