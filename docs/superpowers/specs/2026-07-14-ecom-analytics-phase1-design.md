# ecom-analytics — Phase 1 Design

**Date:** 2026-07-14
**Status:** Approved for implementation
**Scope:** Phase 1 — sales tracking, profit engine, and ambassador tracking

---

## 1. Purpose

An in-house analytics platform for a group of regional WooCommerce webshops. It replaces the
reporting the business currently gets from BeProfit and adds something BeProfit does not do:
**ambassadors log in and see their own sales and earnings.**

Phase 1 delivers a working dashboard covering sales, profit, and ambassadors. Later phases add ad
platforms, web analytics, shipping, and customer service. The Phase 1 data model is designed so
those phases plug in without rework.

### Guiding constraint

The owner asked explicitly that this project stay **simple and easy to understand later**. Every
decision below favours a conventional, well-documented approach over a clever one. Where BeProfit's
own UX was more complicated than it needed to be, we simplified it (see §6.2).

---

## 2. Roadmap context

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | **Sales + profit engine + ambassador tracking & portal** | **This spec** |
| 2 | Meta Ads + Google Ads (CTR, ROAS, spend, 3-sec video views) | Later |
| 3 | Web analytics (bounce rate, customer acquisition, LTV) | Later |
| 4 | Shipping / fulfillment (delivery times, delayed orders) | Later |
| 5 | Customer service performance | Later |

---

## 3. Definitions (the money rules)

These definitions are the heart of the system. **Every revenue figure excludes VAT** — VAT is
collected on behalf of the state and was never the business's money.

```
  Gross sales        Σ line-item value before discount        (excl. VAT)
– Discounts          Σ discounts applied                      (excl. VAT)
─────────────────
= NET SALES          ← the reference figure; commission base  (excl. VAT)
+ Shipping charged   what the customer paid for shipping      (excl. VAT)
─────────────────
= NET REVENUE        ← top line used for profit
– COGS               Σ qty × cost-per-item   (cost in effect on the order's date)
– Handling           Σ qty × handling-cost   (cost in effect on the order's date)
– Operational expenses   each expense's daily share × days in the selected range
– Ambassador commission  10% × net sales of each attributed order
─────────────────
= NET PROFIT         Net margin = net profit ÷ net revenue
```

**Decisions locked in:**

- **Commission base:** 10% of **net sales** — product value *after* the ambassador's discount is
  applied, excluding shipping and excluding VAT.
- **Refunded / cancelled orders:** excluded from everything. No revenue, no commission.
- **Commission rate:** 10%, stored per ambassador so it can vary later without a schema change.

---

## 4. Architecture

A single integrated web application. One codebase holds the admin dashboard, the ambassador portal,
and the settings screens.

| Layer | Choice | Why |
|-------|--------|-----|
| App framework | **Next.js + TypeScript** | One codebase, server-rendered, conventional |
| Styling | **Tailwind CSS** | Consistent, easy to adjust |
| Database | **SQLite** via **Prisma** | A single file; nothing to run. Swaps to Postgres later without rewriting the app |
| Charts | **Recharts** | Simple, well documented |
| Auth | Email + password, 2 roles | `ADMIN` (sees everything) / `AMBASSADOR` (sees only their own) |
| Tests | Vitest (unit/integration) + Playwright (E2E) | See §9 |

### Module boundaries

Each unit has one clear purpose and can be tested on its own:

- **`lib/metrics/`** — the metrics engine. Pure functions: given orders, costs, expenses, and FX
  rates, produce the figures in §3. No database or HTTP knowledge. **This is where the logic lives
  and where the tests bite hardest.**
- **`lib/woo/`** — the WooCommerce client and sync. Talks to shops, upserts orders. Knows nothing
  about profit.
- **`lib/fx/`** — fetches and caches daily exchange rates. Converts an amount on a given date.
- **`lib/auth/`** — sessions, roles, and the rule that an ambassador may only read their own data.
- **`app/`** — pages and API routes. Thin; they call the modules above.

---

## 5. Data model

Ten tables.

| Table | Fields (essentials) |
|-------|---------------------|
| **Shop** | `id`, `name`, `currency` (NOK/SEK/DKK/EUR/USD), `wooUrl`, `wooKey`, `wooSecret`, `active` |
| **Order** | `id`, `shopId`, `externalId`, `number`, `placedAt`, `status`, `currency`, `grossSales`, `discountTotal`, `netSales`, `shippingCharged`, `taxTotal`, `total`, `couponCode`, `ambassadorId?` |
| **OrderItem** | `id`, `orderId`, `productId`, `sku`, `name`, `quantity`, `unitPrice`, `lineNetTotal` |
| **Product** | `id`, `shopId`, `externalId`, `sku`, `name`, `lastSellingPrice` |
| **ProductCost** | `id`, `productId`, `costPerItem`, `handlingCost`, `effectiveFrom` — **many rows per product = full history** |
| **OperationalExpense** | `id`, `shopId`, `label`, `category`, `amount`, `currency`, `recurrence`, `startDate`, `endDate?`, `status` |
| **Ambassador** | `id`, `name`, `email`, `commissionRate` (default `0.10`), `active` |
| **AmbassadorCode** | `id`, `ambassadorId`, `shopId?` (null = all shops), `code` (e.g. `EMMA10`) |
| **User** | `id`, `email`, `passwordHash`, `role` (`ADMIN`\|`AMBASSADOR`), `ambassadorId?` |
| **FxRate** | `date`, `base`, `quote`, `rate` — one row per currency pair per day |

**Notes**

- All money is stored **in the shop's own currency**, exactly as WooCommerce reported it. Conversion
  happens at read time, never at write time — so a rate change can never rewrite history.
- `Order.netSales` is stored (not recomputed on the fly) because it is the commission base and must
  be stable and auditable.
- `Product` rows are **discovered from orders** — any product ever sold appears automatically,
  matching the BeProfit behaviour the owner described.

---

## 6. Behaviour

### 6.1 Cost history (`effectiveFrom`)

A product's cost is not a single number; it is a **timeline**. Each `ProductCost` row says "from
this date onward, this product cost this much."

To cost an order line, take the `ProductCost` row for that product with the **latest
`effectiveFrom` that is on or before the order's date**. An order from March is therefore costed
with March's cost, even if the cost changed in June.

If no cost has been entered yet, cost is `0` and the product is flagged in the UI as missing —
never silently guessed.

### 6.2 Simplification of BeProfit's "apply from" modal

BeProfit asks, on every cost change: *apply to future orders / to the last 60 days / to a date
range?* — three overlapping options that are easy to get wrong.

**We replace all three with one field: "apply from this date."** It produces the same outcome
(each order uses the cost that was true when it was placed) with one rule instead of three.
Approved by the owner during design.

### 6.3 Operational expenses — "spread daily"

An expense has a recurrence: `ONE_TIME`, `DAILY`, `WEEKLY`, `MONTHLY`, or `YEARLY`.

To charge an expense to a date range, convert it to a **daily amount** and multiply by the number
of days in the range that the expense was active:

- `MONTHLY` 14 000 kr in a 31-day month → ~451.61 kr/day. A 7-day view is charged ~3 161 kr.
- `ONE_TIME` lands entirely on its `startDate` — it is only charged if that date falls in the range.
- An expense is only charged for days between its `startDate` and `endDate` (if set) while `status`
  is active.

This is what makes profit correct for **any** date range, not just whole months.

### 6.4 Ambassador attribution

An order carries the coupon code the customer used. If that code matches an `AmbassadorCode`, the
order is attributed to that ambassador and commission is `rate × netSales`.

An ambassador may hold several codes (e.g. one per shop). An order with no matching code is simply
unattributed. Attribution is resolved **at sync time** and stored on the order, so a later change to
codes cannot silently rewrite past commissions.

### 6.5 Currency consolidation

- **One shop selected** → figures shown in that shop's own currency.
- **Several shops selected** → everything converted to **USD**.

Conversion uses the FX rate **on the order's own date** (or the expense day's date), so historical
figures never shift when today's rates move. Rates come from a free daily source (ECB via
Frankfurter — no API key) and are cached in `FxRate`. If a day's rate is missing, the most recent
earlier rate is used and the figure is marked as approximate.

### 6.6 WooCommerce sync

Each shop stores its REST API URL, consumer key, and secret. A sync:

1. Requests orders **changed since the last successful sync** (`modified_after`).
2. Upserts orders, line items, and any newly-seen products.
3. Resolves ambassador attribution from the coupon code.
4. Records the sync time; on failure, records the error and leaves the last-sync time untouched so
   nothing is skipped.

Triggered by the **Refresh** button, and on a schedule once live. Credentials live in the database
(the app is self-hosted); they are never sent to the browser.

### 6.7 Access control

- **Admin** sees all shops, all ambassadors, all costs, all profit.
- **Ambassador** sees only their own sales, orders, commission, and rank. They never see other
  ambassadors, company costs, or profit.

This is enforced **on the server**, in the data layer — not by hiding elements in the UI.

---

## 7. Screens

| Screen | Who | Contents |
|--------|-----|----------|
| **Dashboard** | Admin | Shop selector (one / several / all) + date-range picker with presets (Today, Yesterday, This week/month/year, Last 7/30/90 days, custom). KPI cards: Net revenue, Orders, Avg order value, Net profit, Net margin, Ambassador sales. **Compare-shops table**: one row per shop — Orders, Net revenue, COGS, Op. Ex., Commission, Net profit, Margin — plus a Total row. **Top-ambassadors leaderboard.** |
| **Ambassadors** | Admin | Full list with sales, commission, rank. Create ambassadors, assign codes, set rate. |
| **Settings → Product Costs** | Admin | Per shop. Every product ever sold, cost + handling per item, missing (0) rows highlighted. Saving asks "apply from" date. Cost history viewable. |
| **Settings → Operational Expenses** | Admin | Per shop. Add/edit expenses: label, category, amount + currency, recurrence, first payment, status. |
| **Settings → Shops** | Admin | Add a shop: name, currency, WooCommerce credentials. Test connection. Sync. |
| **Ambassador portal** | Ambassador | Their sales, orders, commission, rank, sales-over-time chart, recent attributed orders. Nothing else. |

Visual direction: clean, BeProfit-like — purple/white, dense readable tables, KPI cards on top.
Mockups approved during design.

**Two display clarifications:**

- The compare table's **COGS column shows product cost + handling combined** (they are always both
  per-item costs of goods sold). They remain separate fields in the data and are broken out on
  hover, so nothing is lost.
- The **ambassador portal displays USD**, because an ambassador may sell across shops in different
  currencies and needs one comparable number. A per-ambassador payout currency can be added later
  without a schema change.

---

## 8. Sample data

The app ships with a seed of realistic sample data so it is usable before any live credentials
exist: the real shop names and currencies (Panetti NO/SE/DK/FI/DE, Mazzetti .no/.se/Denmark/Finland,
Massasjepistoler.no, Bellino.no), ~24 ambassadors with codes, a catalogue of products with costs,
operational expenses, and several months of orders — some attributed to ambassadors, some not, a few
refunded.

Live WooCommerce shops are connected one at a time as credentials become available. Both paths use
the same code.

---

## 9. Testing

Test-driven: a failing test first, then the code to pass it.

**Unit — the metrics engine (the priority).** This is where the money is, so this is where the tests
are hardest:
- COGS/handling pick the cost in effect **on the order's date**, not the newest cost.
- Expense spreading: monthly, weekly, yearly, daily, one-time; partial ranges; start/end boundaries;
  inactive expenses excluded.
- Commission = 10% of net sales, after discount, excluding VAT and shipping.
- Refunded/cancelled orders contribute nothing — not to revenue, not to commission.
- VAT is excluded from every revenue figure.
- FX conversion uses the order-date rate; a missing rate falls back to the latest earlier one.
- Profit and margin arithmetic, including a zero-revenue range (no division-by-zero).

**Integration — API and access control:**
- An ambassador requesting another ambassador's data is **denied** (this is a security test, not a
  UI test).
- Date-range and shop filters return the right slice.
- Sync upserts without creating duplicates when run twice.

**End-to-end (Playwright):**
- Admin logs in → dashboard loads → changes date range and shop selection → numbers update.
- Ambassador logs in → sees their own figures → cannot reach an admin page.

**Definition of done: the entire suite passes — all green — and the app has been driven in a real
browser to confirm the dashboard renders the seeded numbers correctly.**

---

## 10. Explicitly out of scope for Phase 1

To keep this shippable: no ad platforms, no ROAS/CTR, no bounce rate or web analytics, no shipping
provider, no customer-service metrics, no payment-processing fees, no returns forecasting, no
Google-Sheets sync, no CSV import, no multi-user teams beyond admin/ambassador.

Every one of these has a clean place to attach later — ad spend and shipping costs become new cost
sources feeding the same metrics engine; the compare table gains columns.

---

## 11. Risks

| Risk | Mitigation |
|------|------------|
| WooCommerce tax/discount fields vary by shop configuration | Sync stores the raw figures; net sales is computed explicitly and unit-tested. Verified against a real shop before trusting the numbers. |
| Wrong costs → wrong profit | Missing costs are highlighted, never guessed. Cost history is auditable. |
| FX rates drift or a source goes down | Rates cached daily; historical figures pinned to order-date rates; missing rates fall back and are marked approximate. |
| Ambassador sees another's data | Enforced server-side and covered by an explicit security test. |
