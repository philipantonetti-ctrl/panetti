# CPA, CPM and Impressions in the campaign breakdown

2026-08-03

## Why

The breakdown table under Ads by shop shows Spend, ROAS, Purch., Value and CTR.
The client asked for three more: CPA, CPM and Impressions — the set he already
reads in Ads Manager.

All three are arithmetic on numbers the table already has. `BreakdownEntry`
(`src/lib/ads/types.ts`) carries `spend`, `purchases`, `purchaseValue`,
`impressions` and `clicks`, and both drivers already select impressions and
clicks (`meta.ts` `fetchMetaBreakdown`, `google.ts` `fetchGoogleBreakdown`).
Impressions were fetched and then never printed; CTR was the only thing using
them.

So: no API change, no sync change, no migration. One component and its test.

## What changes

`src/app/marketing/BreakdownTable.tsx` only.

### The columns

`Campaign | Spend | ROAS | CPA | Purch. | Value | CPM | CTR | Impr.`

Nine columns, all always visible, in the order the client listed them. The
section already wraps its table in `overflow-x-auto`, so a narrow screen scrolls
rather than crushing the numbers. No metric picker: he named the exact set he
wants, and a picker would be one more thing to discover for no gain.

`COLUMNS` — the `colSpan` behind the "Loading…", "Ad set"/"Ad group" and
per-account error rows — goes from 6 to 9. Missing it leaves those rows short of
the table's real width.

### The three helpers

Beside the existing `roasText`, `ctrText` and `purchasesText`, and formatted
through the same `formatMoney`. Their zero-guards are copied from
`ratios()` in `src/lib/ads/marketing.ts`, deliberately: the Ads-by-shop table
and this table sit on the same screen, and a client must never read two
different definitions of CPA or CPM within one page.

| helper | value | dash when |
| --- | --- | --- |
| `cpaText(spend, purchases, currency)` | `formatMoney(Math.round(spend / purchases), currency)` | `spend === 0` or `purchases === 0` |
| `cpmText(spend, impressions, currency)` | `formatMoney(Math.round((spend / impressions) * 1000), currency)` | `impressions === 0` |
| `impressionsText(impressions)` | `Math.round(impressions).toLocaleString('en-US')` | never |

`Math.round` keeps the result a whole number of minor units, which is the one
thing `src/lib/money.ts` asks of every caller. Impressions never dash: zero
impressions is a true answer about delivery, not a division with nothing to
divide by.

CPA here means spend per attributed purchase — what Ads Manager calls "Cost per
purchase", and what `marketing.ts` calls `costPerPurchase`. It is deliberately
NOT the `cpa` of the Ads-by-shop table, which is spend per paid *store* order:
a store order carries no campaign id, so that figure cannot be computed for one
campaign row and every row would print the same number.

### Every depth, free

Campaign, ad set and ad rows all render through one `renderRow`, so the drill-
down picks the new columns up with no separate change.

## Tests

`src/app/marketing/BreakdownTable.test.tsx`.

Two existing tests need touching, for two different reasons:

- The CTR dash test reads `children[5]`. CPA and CPM sit ahead of CTR now, so
  it becomes `children[7]`. (The ROAS test's `children[2]` is unaffected —
  CPA goes in at index 3, behind it.)
- `lists the campaigns it was given` asserts `getByText('$1,200.00')` for
  spend. The shared fixture has 1,000 impressions, which makes CPM come out to
  exactly the same money as spend, so that query starts matching two cells.
  It becomes a positional read of the spend cell — the coincidence is in the
  fixture, not in the code, and the test should fail on spend being wrong
  rather than on two cells agreeing.

A `cellsOf(name)` helper reads a row's cells as an array of strings, so new
tests assert a value and its column in one line instead of reaching for
`children[n]` — that reach is what made a column insertion break tests that
had nothing to say about it.

New cases:

- CPA is spend divided by purchases, formatted as money.
- CPA dashes when purchases is 0 — never `Infinity`, never `NaN`.
- CPA dashes when spend is 0, matching `ratios()`.
- CPM is spend per thousand impressions, formatted as money.
- CPM dashes when impressions is 0.
- Impressions print with a thousands separator, and 0 prints `0`, not a dash.
- The header reads in the client's order.
- An expanded ad-set row carries the new columns too — the drill-down is the
  half of this table a positional test would otherwise never touch.

## Out of scope

Sorting by the new columns. The table is sorted highest-spend-first by the
route and has never been clickable-sortable; adding it here is a different
feature and a different conversation.
