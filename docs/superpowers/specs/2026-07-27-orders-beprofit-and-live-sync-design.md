# Orders page (BeProfit-style) + live webhook sync — design

Date: 2026-07-27
Requested by the client, with a BeProfit screenshot as the reference:

> "I would also like to add this order section btw, so I can filter out order day
> for day or from time to time. Also when pressing order, it will show what
> product/s the customer purchased and you can also see the status of the order etc"
>
> "We will use webhooks for new orders, refunds, cancellations, and updates. It
> will always update as soon as one of these happens in any of the websites,
> correct? Most important is that it doesn't affect our WooCommerce webshop
> speed at all."

## Part A — Orders page brought up to the reference

The Orders page shipped in `1fdfb1a` already filters by day/range and expands to
show products. What the reference has that ours lacks:

1. **Two status badges per order** — payment state and fulfillment state
   (BeProfit shows "Voided"+"Unfulfilled", "Paid"+"Fulfilled"). Ours shows the
   raw Woo status once. We derive both from the one Woo status, using precise
   words (Refunded / Cancelled / Failed, not a generic "Voided" — more useful):
   - payment: refunded→Refunded, cancelled→Cancelled, failed→Failed,
     trash→Voided (red); pending→Pending, on-hold→On hold (amber);
     checkout-draft→Draft (muted); processing|completed→Paid (green).
   - fulfillment: completed→Fulfilled (green); anything else→Unfulfilled (amber),
     matching the reference where even voided orders read Unfulfilled.
2. **The page shows every order, including refunded/cancelled.** The metrics
   screens rightly exclude them; an order BROWSER must show them or "see the
   status" is impossible. Default flips to include-all, with a status filter
   dropdown (All / Completed / Processing / Pending / On hold / Refunded /
   Cancelled / Failed).
3. **Customer column.** Requires storing it: `Order.customerName`,
   `Order.customerEmail` (nullable). Mapped from Woo's `billing` object. `''`
   means "checked, Woo has none"; `null` means "synced before this feature" —
   the distinction is what lets the backfill terminate.
4. **Per-order money columns** matching the reference: Items, Paid (incl VAT),
   Shipping, Tax, Fulfillment, Fee, COGS, Commission, **Profit**, **Margin**
   (BeProfit's "Con. Profit"/"Con. Margin" = contribution profit). Formulas
   mirror the engine exactly, in the order's own currency:
   - fulfillment = shop's rate in force on the order's date (`fulfillmentOn`,
     exported from the engine)
   - fee = round(total × percent/100) + fixed part cross-converted from the
     fee's currency at the order's date (no `ensureRates` call here — the cron
     tops rates up; `crossConvert` falls back to nearest earlier rate)
   - cogs = Σ qty × (costPerItem + handlingCost) at the order's date (`costOn`)
   - commission = pct(netSales, ambassador's current rate) for attributed orders
   - profit = netSales + shippingCharged − cogs − fulfillment − fee − commission
   - margin = profit / (netSales + shippingCharged)
   - Voided orders (EXCLUDED_STATUSES) get `null` for every figure → shown as
     "—". They contribute nothing, and pretending otherwise (as BeProfit does)
     misleads.
5. **Search + "Total N found"**, like the reference toolbar. Server-side `q`
   across order number, customer name/email, coupon code and product names.
6. **Expanded row becomes a proper sub-table**: thumbnail, SKU, product name,
   unit price, qty, line total (reference shows SKU | Product Name | … | Items).
   Plus the existing shipping/coupon facts, now joined by net sales & discount.
7. **Sync now button** on the toolbar — POST /api/sync, then refetch. Answers
   "can it also be synced when I want it to?" with a literal button.
8. Date column shows date + time on two lines, as in the reference.

`GET /api/orders` gains `q` and `status` params; each order gains
`customerName`, `customerEmail`, `discountTotal`, and nullable figures
(`cogs`, `fulfillment`, `fee`, `commission`, `profit`, `margin`); each product
line gains `imageUrl`, `unitPrice`, `lineNetTotal`.

## Part B — live sync: webhooks + reconciliation + on-demand

Three layers, so "always up to date" holds without ever touching storefront speed:

1. **Webhooks (instant).** `POST /api/webhooks/woo/[shopId]`:
   - Verifies `x-wc-webhook-signature` — base64 HMAC-SHA256 of the RAW body
     with a per-shop secret stored encrypted (`Shop.wooWebhookSecret`), compared
     timing-safely. Invalid → 401. Unknown/inactive shop → 404.
   - Woo's activation ping (`webhook_id=N`, unsigned) → 200 without touching
     data, so webhook activation never fails.
   - Topics `order.created` / `order.updated` / `order.restored` carry the full
     order JSON → same mapping + upsert path as the sync (shared
     `storeOrder()`), so refunds, cancellations and edits land the second Woo
     fires. `order.deleted` (trash) → status set to `trash` by externalId, which
     the metrics already exclude.
   - Never moves `lastSyncAt` — that watermark belongs to the reconciliation
     sync alone.
2. **Self-registration.** After each COMPLETED sync, best-effort
   `ensureWebhooks()`: lists the store's webhooks via the same REST credentials,
   creates the four topics pointing at `APP_URL /api/webhooks/woo/<shopId>`
   (generating + storing the secret on first run), reactivates any Woo disabled.
   Self-heals if someone deletes them. Skipped silently when no public app URL
   is configured (local dev). One extra GET per shop per sync.
3. **Reconciliation cron every 15 minutes** (was hourly) — `vercel.json`
   schedule `*/15 * * * *`. With webhooks doing the instant work this is purely
   a safety net for missed deliveries.

**Why the webshop stays fast:** WooCommerce delivers webhooks asynchronously via
its background queue (Action Scheduler), after the customer's request has
finished — checkout never waits on us. Our registration and sync calls hit the
WP REST API server-to-server, not the storefront. Nothing runs on shop pages.

### Sync reliability fixes (found in the audit, required for "always updates")

1. **Watermark = fetch start, not completion.** `lastSyncAt` was set to
   `new Date()` AFTER the store loop — orders modified during the sync run fell
   in a permanent blind spot. Now the timestamp is taken before `fetchOrders`.
2. **5-minute overlap on incremental windows.** `modified_after` is sent
   truncated to whole seconds, and the shop server's clock may drift from ours.
   Fetching from `lastSyncAt − 5 min` costs nothing (upserts are idempotent) and
   removes both failure modes.
3. **Per-order atomicity.** The order upsert + item rewrite now run in one
   `db.$transaction`, so a mid-run crash can't leave an order visible with no
   lines. (A whole-run transaction would be wrong: 5,000 upserts in one
   transaction on serverless Postgres is its own outage.)
4. **Woo error bodies truncated** to 300 chars before entering our error
   messages — a WordPress HTML error page doesn't belong in a toast.

### Customer backfill (historical orders)

Incremental sync only touches CHANGED orders, so history would show a blank
Customer column forever. After each completed sync, best-effort: take up to 500
of the shop's orders where `customerName IS NULL` (newest first), fetch them
from Woo by id (`include=` batches of 100), update ONLY the customer fields —
attribution, items and totals untouched. Orders Woo no longer has, and orders
with no billing data, get `''` so they leave the NULL set: the process strictly
converges and then costs zero.

## Schema changes (all additive, safe on the live DB)

```prisma
model Shop  { wooWebhookSecret String? }   // encrypted like wooKey/wooSecret
model Order { customerName String?; customerEmail String? }
```

Seed gains deterministic customer names/emails so dev and e2e look real.

## Testing

- `map.test.ts`: billing → customerName/customerEmail (missing billing → '').
- `sync.test.ts`: incremental window overlaps 5 min; watermark = fetch start;
  customer backfill fills only customer fields and converges.
- `webhooks route test`: valid signature upserts an order (create + update +
  refund status change); bad signature 401; ping 200 no-write; order.deleted →
  trash; unknown shop 404.
- `orders route test`: search, status filter, includeVoided default off but
  status param wins, figures math (fulfillment/fee/cogs/commission/profit),
  voided figures null, customer fields present.
- `OrdersClient.test`: two badges, customer cell, figure columns, expanded
  sub-table with unit price/line total, search box present.
- e2e `orders.spec.ts`: existing two tests stay; add single-day pick renders,
  search narrows to one order, badges visible.

## Client-facing sync answer (for Philip to relay)

- Webhooks make it LIVE: new orders, refunds, cancellations and edits appear
  seconds after they happen, on every connected store.
- The 15-minute scheduled sync is a safety net (Philip already told the client
  15 min — this makes that true), and "Sync now" is on the Orders page for
  sync-on-demand. A plain refresh always shows the newest already-synced data.
- Webshop speed is untouched: Woo sends webhooks in the background after the
  customer's page has already loaded; we never run code on the storefront.
