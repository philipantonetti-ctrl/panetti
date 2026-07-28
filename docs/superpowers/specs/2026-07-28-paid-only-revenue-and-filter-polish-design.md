# Paid-only revenue, Deselect all, one "gross" only

Date: 2026-07-28

## Why

Three client requests, verbatim:

1. "The system includes orders that has status 'Pending', these orders should
   not be included in the revenue until they are 'paid'."
2. "Here there is only a Select all button, but I would want it to change to
   Deselect all when all are selected, so I easily can deselect all."
3. "I don't understand the difference between Gross sales, Gross revenue?
   Why are both there?"

## 1. Revenue counts only paid orders

WooCommerce's own meaning of the statuses: `pending` = order placed, payment
not received; `on-hold` = stock reserved, payment awaited (bank transfer and
the like). Money exists in neither. `processing` and `completed` mean payment
received. The client's rule — no revenue until paid — therefore excludes both
unpaid statuses, not just `pending`.

`src/lib/metrics/types.ts` splits the one status list into three:

- `VOIDED_STATUSES` = refunded, cancelled, failed, trash — dead ends that
  earn nothing, ever.
- `UNPAID_STATUSES` = pending, on-hold — earn nothing YET; the webhook flips
  them to `processing` the moment Woo records payment, and from that second
  they count.
- `EXCLUDED_STATUSES` = both lists — everything the money engine ignores.

Because the engine, the daily trend, the ambassador leaderboard and the
portal all already filter on `EXCLUDED_STATUSES`, widening that list carries
the rule everywhere at once: revenue, profit, orders count, commission,
charts, portal earnings. No pending order can earn an ambassador commission
and then unearn it — commission simply starts at payment.

The Orders list is the one place that differs: a pending order is a LIVE
order and must stay visible. The list's hide-by-default filter narrows to
`VOIDED_STATUSES` only, while the per-order figures (COGS, fee, commission,
profit, margin) go `null` for the whole excluded set — a pending row shows
its amber "Pending" badge and dashes, and the dashes turn into money the
moment payment lands.

## 2. Select all ⇄ Deselect all

`ShopFilter` semantics today: `selected = []` means "all shops". The header
button always says "Select all". New behavior:

- When every shop is effectively selected (`selected` empty), the button
  reads **Deselect all** and clicking it selects nothing.
- "Nothing" is representable: the component emits `[NO_SHOPS]`, a sentinel id
  (`'none'`) no real shop can carry (real ids are cuids). Checkboxes all
  clear, the trigger label reads "No shops", the button flips back to
  **Select all** (which restores `[]` = all).
- The sentinel rides the existing `shops=` query param unchanged; it matches
  no rows, so Orders shows "Total 0 found" and the dashboard shows zeros —
  the honest picture of "no shops selected" — until the user ticks the shops
  they actually want. Ticking a shop from the none state selects just it.
- No API changes at all.

## 3. One "gross", not two

"Gross sales" (before discounts, excl. VAT — the Shopify sense) and "Gross
revenue" (what customers actually paid, incl. VAT) reading side by side is a
genuine source of confusion, and gross sales is derivable from the columns
that stay (net sales + discounts). The **Gross sales column is removed** from
the Compare table and its picker. The engine keeps computing the figure (it
is tested and cheap); only the UI stops showing it. Stale hidden-column
localStorage entries for it are dropped by the existing unknown-key filter.

Remaining column story, left to right: Orders, Gross revenue (paid, incl.
VAT), Discounts, Net sales, Shipping, VAT, Net revenue, then costs down to
Net profit and Margin.

## Testing

- engine: a pending and an on-hold order contribute zero revenue, zero
  orders-count, zero commission; the same order as `processing` counts fully.
- ambassadors: a pending order earns no leaderboard sales.
- orders API: pending → figures `null`; pending is NOT hidden when
  `includeVoided` is false; refunded still is.
- ShopFilter (new test file): button label flips both ways; Deselect all
  emits the sentinel; the none state unchecks every box and labels the
  trigger "No shops"; ticking a shop from none selects exactly that shop.
- CompareTable: Gross sales gone from table and picker; Gross revenue still
  right after Orders.
