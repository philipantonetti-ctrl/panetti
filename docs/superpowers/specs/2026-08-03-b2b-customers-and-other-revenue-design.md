# B2B customers and other revenue

2026-08-03

## Why

Not every order comes through a webshop. Business clients order by email, at
prices negotiated with them, in a currency they chose, sometimes on campaign
discount. Today none of that money exists in the app: the Dashboard answers
"did we actually make money" with only the WooCommerce half of the answer.

The client asked for two things. A place to register a B2B customer — name, the
store they buy from, the currency they pay in, and their own price per product.
Then an "add other revenue" action: pick the customer, pick what they bought,
watch their agreed prices fill themselves in, and apply a campaign discount in
either percent or a fixed amount.

## The one decision everything follows from

**A B2B order is an ordinary `Order` row with ordinary `OrderItem` lines.**

`computeMetrics()` in `src/lib/metrics/engine.ts` is the only place any money
figure in this product is calculated, and it reads `Order` + `OrderItem`. An
order written in that shape is counted by the Dashboard, the trend chart, the
compare table, the Orders page and the per-shop currency conversion without any
of them being taught about B2B. Revenue, COGS, margin and net profit all follow
for free.

Confirmed with the client: B2B revenue folds into the same headline numbers, is
marked as B2B wherever it appears, and numbers its orders in its own sequence
rather than borrowing the webshop's.

## What is different about a B2B order

Three things, and only three:

1. **It pays no payment-gateway fee.** The client invoices these customers; the
   Dintero percentage plus fixed part would silently shave profit off every one.
2. **It carries its own fulfillment cost**, typed on entry, instead of the
   shop's standing per-order rate. A pallet to a business is not a parcel to a
   consumer.
3. **Its currency need not be the shop's.** Nordic Retail AS pays in EUR while
   buying from Mazzetti.no, a NOK store.

Everything else — VAT excluded from revenue, cost timelines by order date,
refunded and cancelled orders earning nothing — is identical, and identical on
purpose.

## The currency bug this uncovers

`Order.currency` has always equalled its shop's currency, because every order so
far arrived from that shop's WooCommerce. The engine quietly depends on it:

```ts
// engine.ts:126-130 — cost comes from ProductCost, which is in SHOP currency…
const cost = costOn(costs.get(item.productId) ?? [], order.placedAt)
const line = item.quantity * (cost.costPerItem + cost.handlingCost)
return conv(line, order)   // …but conv() converts from ORDER currency
```

Put a EUR order on a NOK shop and a NOK cost is read as though it were EUR.
`convert()` multiplies by the *from* currency's USD rate, so how wrong the
answer is depends on which view you are in:

| view | display currency | correct | buggy | error |
|---|---|---|---|---|
| One shop selected | NOK | 22000 (unconverted) | 22000 × 1.1 = 24200 | 10% too high |
| Consolidated | USD | 22000 × 0.1 = 2200 | 22000 × 1.1 = 24200 | **11× too high** |

The consolidated case is the headline Dashboard figure, and there the order
shows a large false loss. The same assumption sits in `fulfillmentOn()` (a
`FulfillmentRate` is documented "minor units, shop currency" and is likewise
converted from the order's) and is hand-copied into
`src/app/api/orders/route.ts:176-189`.

We fix the assumption rather than avoid it. Storing the order converted was
rejected: `prisma/schema.prisma:10-11` states the rule the whole product rests
on — *"Conversion to USD happens at read time only — never stored converted"* —
and a frozen conversion would show the client NOK for an invoice written in EUR.

## Data model

Two new tables. Both additive, so `scripts/db-push.mjs` ships them on a push.

```prisma
// A business customer who buys off the webshop. Their orders are ordinary
// Order rows — what makes them different is an agreed price list, their own
// currency, and an invoice instead of a card.
model B2bCustomer {
  id         String   @id @default(cuid())
  shopId     String
  name       String
  currency   String   // what they pay in; need not be the shop's
  vatPercent Float    @default(0) // 25 domestic, 0 reverse-charge or export
  email      String?
  note       String?
  active     Boolean  @default(true)
  createdAt  DateTime @default(now())

  shop   Shop        @relation(fields: [shopId], references: [id], onDelete: Cascade)
  prices B2bPrice[]
  orders Order[]

  @@unique([shopId, name])
  @@index([shopId])
}

// This customer's agreed price for one product, in the CUSTOMER'S currency,
// excluding VAT. Deliberately NOT a timeline like ProductCost: it only ever
// pre-fills the order form, and the price actually charged is frozen on the
// OrderItem, so history cannot shift when a price is renegotiated.
model B2bPrice {
  id         String @id @default(cuid())
  customerId String
  productId  String
  unitPrice  Int    // minor units, customer currency, ex VAT

  customer B2bCustomer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  product  Product     @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@unique([customerId, productId])
}
```

`Order` gains two columns:

```prisma
  // Set = this order was entered by hand for a business customer. It is the
  // B2B marker, and the reason the order pays no gateway fee.
  b2bCustomerId   String?
  // What shipping this order actually cost us, in the SHOP's currency (the
  // same frame as FulfillmentRate.perOrder). null = a webshop order, which
  // uses the shop's standing rate instead.
  fulfillmentCost Int?

  b2bCustomer B2bCustomer? @relation(fields: [b2bCustomerId], references: [id], onDelete: Restrict)

  @@index([b2bCustomerId])
```

`OrderItem` gains two, so re-opening an order shows "10%" rather than "€89 off":

```prisma
  discountValue Int?    // 10 (percent) or 2000 (minor units per unit), as typed
  discountKind  String? // "PERCENT" | "AMOUNT"
```

Back-references are added to `Shop` (`b2bCustomers`) and `Product` (`b2bPrices`).

There is no `source` column. `b2bCustomerId != null` already answers it, and a
second column could disagree with the first. Everything that needs to know an
order is B2B — the badge, the Orders filter, the engine's fee rule — derives it
from that one field.

### The rest of the Order row

Fields a B2B order sets that are not otherwise obvious:

| field | value | why |
|---|---|---|
| `status` | `"completed"` on entry | The order happened; it earns from the moment it is recorded. Editing can set `refunded` or `cancelled`, and `EXCLUDED_STATUSES` then zeroes it exactly as for a webshop order, with no special case. |
| `couponCode` | `null` | No coupon was used. |
| `ambassadorId` | `null` | No ambassador is ever paid on a B2B order. |
| `customerName` | the B2B customer's name | **Not null.** `backfillCustomers()` (`woo/sync.ts:169`) queues every order with `customerName: null` and asks WooCommerce for it — for a `b2b:` external id it would ask forever and get nothing. Filling it keeps the order out of that queue and makes the Orders page search find these customers by name. |
| `customerEmail` | the customer's email, or `''` | `''` means "checked, none on file", the convention `mapOrder()` already uses. |

### Order numbering and identity

B2B orders number `B-0001`, `B-0002`… per shop, and take
`externalId = "b2b:B-0001"`. A WooCommerce `externalId` is always
`String(woo.id)` — plain digits — so a sync or a webhook can never collide with
or overwrite a hand-entered order through `@@unique([shopId, externalId])`.

`nextB2bNumber(shopId)` — in `src/lib/b2b/numbering.ts`, with the pure
`B-NNNN` parse and format beside it so both can be tested without a database —
reads the highest existing number for the shop and adds one, inside the
transaction that writes the order. The unique constraint catches a double-click;
one retry, then the route errors honestly rather than guessing.

### Deleting a customer

Refused with 409 while they have orders, offering "deactivate" instead — the
same move `Ambassador` and `Shop` make. `onDelete: Restrict` is the backstop.
History must not evaporate because someone tidied a list.

## The money math

New pure module `src/lib/b2b/pricing.ts`, beside `src/lib/metrics/`. No
database, no React, no I/O — arithmetic that can be tested exhaustively.

```ts
export type DiscountKind = 'PERCENT' | 'AMOUNT'

export type B2bLine = {
  quantity: number
  unitPrice: number     // minor units, customer currency, ex VAT, BEFORE discount
  discountValue: number // 0 when there is none
  discountKind: DiscountKind
}

lineTotals(line) -> { gross, discount, net }

orderTotals(lines, shippingCharged, vatPercent) -> {
  grossSales, discountTotal, netSales, shippingCharged, taxTotal, total
}
```

Those six are exactly the money columns on `Order`, so the route stores the
result field for field. Each line maps onto an `OrderItem` the same way:
`unitPrice` is the price **before** discount (matching `mapOrder()`, where it is
`subtotal / quantity`) and `lineNetTotal` is `lineTotals().net`. The Orders page
already renders both, so a B2B order's contents display with no new code.

Rules:

- **A discount is per unit.** `AMOUNT` means "€20 off each chair", which puts it
  in the same frame as the unit price beside it on the form. The picker reads
  `%` and `€ / unit` so it cannot be misread.
- `PERCENT` uses `pct()` from `src/lib/money.ts` — round half away from zero,
  like every other rounding in the product.
- A line's discount is clamped to `[0, gross]`. A discount cannot invent revenue.
- `grossSales = Σ gross`, `discountTotal = Σ discount`,
  `netSales = grossSales − discountTotal`.
- `taxTotal = pct(netSales + shippingCharged, vatPercent / 100)`. `vatPercent`
  is a percentage — 25 means 25% — and shipping follows the goods' rate.
- `total = netSales + shippingCharged + taxTotal`.

Those names are the ones `mapOrder()` produces from WooCommerce. That is what
makes `net revenue = net sales + shipping` and
`gross revenue = net revenue + VAT` hold in the engine without a special case.

## Engine changes

`EngineOrder` (`src/lib/metrics/types.ts`) gains three fields:

```ts
  /** Currency the shop's product costs and fulfillment rates are stored in. */
  costCurrency: string
  /** This order's own fulfillment cost, in costCurrency. null = use the shop's rate. */
  fulfillmentCost: number | null
  /** Does the payment gateway take a cut? False for an invoiced B2B order. */
  chargesGatewayFee: boolean
```

and three lines in `engine.ts` consume them:

| Where | Today | After |
|---|---|---|
| COGS, `engine.ts:126-130` | converts from `order.currency` | converts from `order.costCurrency` |
| Fulfillment, `engine.ts:103-106` | always the shop's rate | `order.fulfillmentCost ?? fulfillmentOn(...)`, converted from `costCurrency` |
| Gateway fee, `engine.ts:110-119` | every order | only orders where `chargesGatewayFee` |

For every order that exists today `costCurrency === currency`,
`fulfillmentCost` is `null` and `chargesGatewayFee` is `true`, so the output is
bit-identical. **The existing engine suite passing unmodified is the evidence
for that claim**, and the plan treats it as a gate, not a formality.

The same three corrections go into `src/app/api/orders/route.ts:176-189`, which
holds a hand-copy of this arithmetic for its per-order figures.

## Loader changes

`src/lib/data/load.ts`:

- select `b2bCustomerId` and `fulfillmentCost` on the order query
- build a `shopId -> currency` map from the shop rows already fetched
- map the three new `EngineOrder` fields:
  `costCurrency` from that map (falling back to the order's own currency),
  `fulfillmentCost` straight through, `chargesGatewayFee: o.b2bCustomerId === null`
- replace the `needsRates` condition at `load.ts:149-156`

`needsRates` today reads shop and expense currencies plus the gateway fee's, so
a EUR order on a NOK shop would never trigger a rate fetch and would pass
through unconverted. It becomes: gather every currency in play — display, shops,
orders, expenses, the fee — and fetch when the set holds more than one. One set
and one size check, in place of two independently-reasoned clauses: simpler to
reason about and unable to miss a case. (Simpler, not shorter — it is a few
lines longer than what it replaces.)

## Screens

### `/b2b` — the B2B page

Nav: Analytics, after Ambassadors. Shop filter in the `PageHeader`, reusing
`ShopFilter`. Two cards:

- **Business customers** — name, shop, currency, VAT, agreed prices, orders,
  revenue. `+ Add customer`. A row opens the customer. Revenue is shown in the
  **customer's own** currency: every one of their orders is in it, so no
  conversion is involved and none can mislead. The column therefore has **no
  total row** — adding EUR to NOK down a column would be the confident wrong
  number `PRODUCT.md` forbids. The consolidated figure already exists, converted
  properly, on the Dashboard.
- **B2B orders** — number, customer, date, net sales, profit, status, actions.
  `+ Add order`. The 25 most recent, with a link to the Orders page filtered to
  B2B for the full history. This card is a working surface, not an archive.

Empty states teach the next action, per `DESIGN.md`: "No business customers yet
— add one and you can start entering their orders."

### `/b2b/[id]` — one customer

Their agreed price list and their order history. Deactivate lives here.

The price list carries two currencies, so both columns name theirs in the
header: **our cost** comes from `ProductCost` and is in the shop's currency;
**agreed price** is in the customer's. They are not comparable at a glance and
the table must not pretend they are — no margin column, because a margin here
would need an FX rate and a date, and the honest per-order margin is already on
the Orders page.

### Add / edit customer

Name, shop, currency, VAT %, email, note, and a starting price list. Currency
uses `SearchableSelect` over `allCurrencies()` with the `isConvertible()`
warning `ExpensesClient` already shows — a currency we hold no rate for says so
rather than quietly mis-totalling.

The shop locks once the customer has an order: changing it would orphan the
price list and re-home revenue that has already been reported.

### Add order

Pick the customer; shop, currency and VAT lock in as context. Then a date and
product lines:

| field | behaviour |
|---|---|
| Product | picker scoped to that customer's shop — see the limit below |
| Qty | ≥ 1 |
| Unit price | prefilled from the price book; empty and highlighted when there is no agreed price, with a "save as this customer's price" checkbox. Editing a prefilled price is a one-off unless the box is ticked. |
| Discount | value plus a `%` / `€ per unit` toggle |
| Line total | live |

Below the lines: shipping charged to the customer (ex VAT, customer currency)
and shipping we paid (labelled in the **shop's** currency, because it is a cost
and costs live in the shop's currency). A totals panel shows gross sales,
discount, net sales, shipping, VAT and total, live.

`Save` and `Save and add another`, matching the expenses form.

### The product picker's limit, and saying so

A `Product` row is only created when a product **sells** — `storeOrder()`
discovers products from order lines, and the catalogue pass in `syncShop()`
(`woo/sync.ts:405`) only refreshes prices for products it already holds. So a
product that has never sold through the webshop cannot be picked for a B2B
order.

Confirmed with the client: leave the sync as it is. Their business clients buy
from the same range as their online customers, and pulling the whole catalogue
would turn Product Costs from "things we have sold" into a full catalogue
listing that nobody asked for.

The picker therefore says so rather than looking broken. When a search matches
nothing: *"Only products that have sold through this shop can be added. Sync the
shop, or check the name."* Per `PRODUCT.md` — say when you don't know, never
show a confident wrong thing.

### Orders page

A Source filter (All / Webshop / B2B) and a B2B badge on the row.
`OrdersClient.tsx` and its route. The filter is a `where` on `b2bCustomerId`
being null or not — nothing new is stored to support it.

## Routes

Every one `assertAdmin` and `Cache-Control: private, no-store`, with Zod bodies,
following `/api/expenses`.

```
GET  POST            /api/b2b/customers
GET  PATCH  DELETE   /api/b2b/customers/[id]   DELETE 409s while orders exist
GET  POST            /api/b2b/orders
     PATCH  DELETE   /api/b2b/orders/[id]
```

`PATCH /api/b2b/customers/[id]` takes the whole price list and replaces it, in a
transaction — the same "rewrite, don't diff" rule as order lines, for the same
reason: simpler and always correct. Replacing a price never touches an order
already placed, because the charged price lives on the `OrderItem`.

**The server recomputes every total.** The browser's figures are display only;
whatever it posts, the route derives `grossSales`, `discountTotal`, `netSales`,
`taxTotal` and `total` itself from `orderTotals()` on the customer's VAT rate
and the posted lines. It also rejects:

- a `productId` that does not belong to the customer's shop
- `quantity < 1` or a negative `unitPrice`
- a `PERCENT` discount outside 0–100
- an `AMOUNT` discount above the unit price
- an unparseable date

Order lines are rewritten inside a transaction rather than diffed — the rule
`storeOrder()` already follows, so an order and its lines land together or not
at all.

## Error handling

As the app already does it. A failed action toasts and leaves the modal open
with what was typed still in it — closing would discard the entry while the list
shows nothing added. A failed page load says so in the table body, because an
empty table reads as "you have no customers", which would be a lie.

## Tests

Tests first for the pure module and the engine deltas, as this repo does.

| file | proves |
|---|---|
| `src/lib/b2b/pricing.test.ts` | percent vs amount, rounding half away from zero, clamping, VAT, zero-discount and zero-VAT cases |
| `src/lib/metrics/engine.test.ts` | cost currency ≠ order currency; a B2B order pays no gateway fee; a B2B order uses its own fulfillment cost — **plus the existing suite passing unmodified** |
| `src/app/api/b2b/customers/route.test.ts` | admin-only, validation, the delete refusal, price list replacement |
| `src/app/api/b2b/orders/route.test.ts` | server recompute beats posted totals, product-belongs-to-shop, numbering under a double-click, line rewrite on edit |
| `src/app/api/orders/route.test.ts` | the source filter and the B2B marker |
| `src/app/api/portal/security.test.ts` | an ambassador can neither see a B2B order nor earn commission on one |
| `src/app/b2b/B2bClient.test.tsx` | price prefill, the discount toggle, the highlighted empty price |
| `e2e/b2b.spec.ts` | create a customer with a price, enter an order, the Dashboard number moves |

## Build order

One feature, but it has a natural spine. Each step leaves the app working and
green:

1. **Schema** — the two tables and the four columns. Additive, ships alone.
2. **`src/lib/b2b/pricing.ts`** and its tests. Pure, no dependencies.
3. **Engine and loader** — the three `EngineOrder` fields, the three `engine.ts`
   lines, the `needsRates` rewrite, the same three fixes in the Orders route.
   Gate: the existing engine and orders suites pass unmodified.
4. **Customer routes and screens** — `/b2b`, `/b2b/[id]`, add/edit customer.
   Usable on its own: you can register customers and their prices.
5. **Order entry** — the add-order modal and `/api/b2b/orders`. This is the step
   where money starts arriving.
6. **Orders page** — badge and Source filter.
7. **e2e**.

Steps 1–3 change existing money code and nothing else; 4–7 only add. That split
is deliberate, so a regression in the numbers can only have come from step 3.

## Out of scope

Named so nobody wonders where they went:

- **Google Sheets sync.** It appears in the BeProfit screenshot the client sent;
  it is BeProfit's integration, not a request.
- Invoice PDFs, paid/unpaid tracking, credit terms, per-customer payment terms.
- A price-history timeline on `B2bPrice`. The charged price is frozen on the
  `OrderItem`, so history is already safe without one.
