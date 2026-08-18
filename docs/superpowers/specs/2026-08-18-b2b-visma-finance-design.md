# B2B sales from Visma, shipping cost, receivables and disputes

2026-08-18

Four things the client asked for in one message. They are four independent
subsystems and this document treats them as four, in the order they should be
built. Every number below was measured against the live ERP and the live
database on 2026-08-18, not estimated.

## The one finding that shapes everything

Visma invoices the webshops as well as the B2B customers, so "import invoices
as sales" without a filter counts every webshop order twice — once from
WooCommerce, once from Visma — and roughly doubles revenue.

The client then described a case that looks like the same thing and is not:

> sometimes we have a mazzetti.no customer that wants to pay with invoice. Then
> we add his order to mazzetti.no webshop manually, and then we invoice manually
> from the system later. We dont want this sale to be registered twice, however
> we still want to be warned if invoice is not paid in time.

So the sale must not come from Visma, but the debt must. **Sales and
receivables need two different filters, not one.** That is the central design
decision here and the rest follows from it.

### The evidence

Open documents in Visma, `customerdocument?status=Open`. **This was the first
page of 1000, not the whole ledger** — the page came back full, so more existed,
and every attempt to fetch page 2 was rate-limited (see below). The proportions
below are a sample, not a census:

| group | docs | overdue | balance |
|---|---|---|---|
| linked B2B customers | 0 | 0 | — |
| `- Webkunde` collective accounts | 994 | 993 | 463 199 DKK, 4 040 187 NOK, 449 526 SEK, 37 580 EUR |
| named customers | 6 | 6 | 63 249 NOK, 49 998 SEK, 24 999 DKK, 399 EUR |

993 of the 994 Webkunde documents have `documentDueDate == documentDate` and a
median age of 113 days, oldest 431. Those are checkout-paid webshop orders that
Visma books as invoices and never reconciles in this ledger. They are not debt,
and warning on them would produce 993 false alarms.

The six named ones are real: Konfliktrådene, Halsnæs Kommune,
Eriksdalstrafikskola, Nordic Acceleration Group AB, FRÜTEC GmbH, and one
2023 balance from Hans Hoff Petersen.

**What the first COMPLETE production import actually found**, once slice 3
shipped and the cron paged the whole ledger on 2026-08-18 — recorded here
because it is the number that matters and it is three and a half times the
sample:

| | |
|---|---|
| receivables imported | **21** |
| overdue | **8** |
| not yet due | 10 |
| no due date | 3 |
| overdue totals | 108 248 NOK, 49 998 SEK, 24 999 DKK, 5 423 EUR |

Every one of the six above survived, joined by fifteen the sample never showed —
including two invoices to `Verkkokauppa`, the customer this document had
declared absent from Visma. **A capped page is a sample. Label it as one, and
never conclude an absence from it.**

Four of those six are provably the client's described flow — the order is
already in our database from the webshop, matching to the cent:

| Visma invoice | our order | |
|---|---|---|
| Eriksdalstrafikskola 114757, 4 999 SEK | Panetti Sweden #9820, 2025-05-14, 4 999.00 SEK | exact |
| Nordic Acceleration Group 117578, 44 999 SEK | Mazzetti Sweden #8987, 2025-07-21, 44 999.00 SEK | exact |
| Halsnæs Kommune 123424, 24 999 DKK | Mazzetti Denmark #10241, 2025-11-09, 24 999.00 DKK | exact |
| FRÜTEC 126290, 399 EUR | Panetti Germany #15211, 2026-04-28, 399.00 EUR | exact |

None of the four is flagged as B2B in our database. Only 15 of 26 191 orders
are. So the sales filter and the receivables filter genuinely select different
sets, and building one filter for both would be wrong in one direction or the
other.

### The two filters

- **A sale** is an invoice whose Visma customer number is linked to a
  `B2bCustomer`. Nothing else. An unlinked customer is ignored entirely, so a
  Webkunde row can never become revenue.
- **A receivable** is any open document whose customer is NOT a `- Webkunde`
  collective account. That is 6 today rather than 999.

The rules are deliberately not symmetrical, because the client's requirement is
not symmetrical.

## What already exists

- `B2bCustomer` — `shopId`, `name`, `currency`, `vatPercent`, unique on
  `[shopId, name]`. Four rows, all active. No Visma link field.
- `B2bPrice` — per customer, per product, minor units ex VAT.
- B2B orders are ordinary `Order` rows carrying `b2bCustomerId`. `src/lib/b2b/pricing.ts`
  already produces exactly the shape `mapOrder()` produces from WooCommerce, so
  an imported invoice has a well-trodden path into the database.
- `FulfillmentRate` — shipping cost **per order**, per shop, effective-dated.
  `Order.fulfillmentCost` overrides it per order.
- `postSlack(webhookUrl, text)` in `src/lib/slack/notify.ts`. One webhook, stored
  encrypted on `DeliveryConfig`, used only by delivery alerts.
- Visma client `vismaGet` with token caching, and a working import pattern in
  `src/lib/visma/import.ts`.
- FX conversion in `src/lib/fx/rates.ts`, needed because receivables span four
  currencies.

Nothing for Klarna, anywhere.

## Visma API facts that constrain the build

- `controller/api/v1/customerinvoice` — `invoiceLines[]` carry `inventoryNumber`
  (the SKU), `quantity`, `unitPrice`, `unitPriceInCurrency`, `cost`, `amount`,
  `discountAmount`, `uom`, plus `customer`, `documentDate`, `documentDueDate`,
  `referenceNumber`, `currencyId`, `status`, `balance`. Everything a sale needs.
- `controller/api/v1/customerdocument` — the AR ledger. Same header fields, no
  lines. `status=Open` filters server-side.
- `controller/api/v1/customer` — `number`, `name`, `status`, `creditTerms`,
  `creditLimit`, `creditDaysPastDue`.
- **Paging is `pageNumber`, and it is mandatory here.** `skip` is ignored and
  returns page 1 again. `pageSize` caps at 1000 on `customerdocument`, and the
  unfiltered first page is oldest-first (2022 credit notes), so an unpaged read
  answers the wrong question entirely.
- **Rate limited, harder than it first appears.** Roughly ten quick calls earn a
  429. Worse, the limit is a rolling window that a burst exhausts for minutes:
  after a session of probing, six consecutive attempts at a single page with
  escalating backoff — 20, 40, 60, 80, 100, 120 seconds — were all refused. A
  paged read of the full ledger is therefore not something a 15-minute cron can
  do naively. Slice 3 must page slowly, tolerate a partial read without
  discarding the previous snapshot, and treat 429 as "try next run" rather than
  as an error. The same snapshot-with-a-guard shape `importVismaStock` uses.
- `creditTerms` and `paymentMethod` are empty on the list form. They exist on
  the single-document form only, so they cannot be used as a filter without one
  request per document. The `- Webkunde` name test needs no extra request.

## Slice 1 — B2B sales from Visma invoices

**Goal.** An invoice raised in Visma for a linked B2B customer becomes an order
in our system, with its lines, without anyone typing it in.

**Link.** `B2bCustomer` gains `vismaCustomerNumber String? @unique`. Set from a
picker on the existing B2B customer screen, listing Visma customers by number
and name. Explicit, survives a rename on either side, and one wrong character
fails closed rather than matching the wrong company.

Name matching is rejected, and the reason turned out to be stronger than first
written. `Verkkokauppa.com` appeared to be absent from Visma entirely — a search
of every customer for `/verkko|kauppa/` returned nothing. **That was wrong, and
wrong in the way that matters**: `controller/api/v1/customer` caps at 1000 rows,
the search only ever saw the first page, and the customer is really there as
`Verkkokauppa` — no `.com` — under number **10488**. The first complete
receivables import found it immediately, holding two open invoices.

So name matching would not merely have failed for that customer; it would have
failed while looking like a fact about the data. A number cannot do that. It
also survives a rename on either side, and cannot bind to the wrong company if
two ever share a name.

**Numbers confirmed live on 2026-08-18**, read out of our own receivables table
rather than from the API: `Verkkokauppa.com` 10488, `Play Nöjesdistribution AB`
20012, `JPK Trading Kft` 10681. `Bagaren och Kocken` has no open invoice, so its
number is still unknown and it stays unlinked until one appears.

**Import.** A new `importVismaB2bSales()` beside the existing purchase-order
import, on the same 15-minute cron, best-effort, never throwing.

- Read `customerinvoice`, paged with `pageNumber`, paced.
- Keep only documents whose `customer.number` is a linked `vismaCustomerNumber`.
- Keep only `documentType == 'Invoice'`. Credit notes are a separate question
  and are out of scope; they are logged and skipped, counted by reason the way
  `mapVismaOrders` already reports skips.
- Map each to an `Order` with `b2bCustomerId` set, `externalId` = the Visma
  reference number prefixed so it cannot collide with a WooCommerce id, and
  `OrderItem` rows from `invoiceLines` joined to `Product` by
  `inventoryNumber` on the customer's shop.
- Idempotent on `externalId`, so a re-run updates rather than duplicates —
  the same guarantee the purchase-order import gives.

**Not in scope:** writing anything back to Visma. Read-only, as the whole
integration is today.

**Testing.** Pure mapper tested against a fixture captured from the live
payload, covering: an unlinked customer is ignored; a credit note is skipped
with a reason; a line whose SKU is unknown is skipped without losing the order;
quantities and prices convert to minor units correctly; a re-run does not
duplicate. Importer tested with a stubbed fetch against the real database, as
`import-stock.test.ts` does.

## Slice 2 — shipping cost per SKU

**Goal.** Replace "flat cost per order" with "cost per unit, by SKU", so an
order of fifty pizza ovens does not carry the same shipping cost as an order
of one.

**Model.** `ShippingRate { sku, perUnit, currency, effectiveFrom }`, keyed by
SKU for the same reason `SupplyItem` is: the cost belongs to the object, not to
a Norwegian listing of it. Effective-dated, so a rate change never rewrites
history — the same shape `ProductCost` and `FulfillmentRate` already use.

**Resolution.** An order's shipping cost is the sum over its lines of
`quantity * rateOn(sku, order.placedAt)`. Where no SKU rate exists, fall back to
the existing `FulfillmentRate` per-order figure, so nothing regresses on the day
this ships and rates can be filled in gradually.

`Order.fulfillmentCost`, the manual override, keeps winning over both.

**Testing.** Pure resolver: per-unit multiplies by quantity; the newest rate at
or before the order date wins; a missing SKU falls back to the per-order rate;
an order with no rates at all behaves exactly as today.

## Slice 3 — receivables and Slack warnings

**Goal.** See what is owed and when it is due, and be told in Slack when an
invoice passes its due date and is still open in Visma.

**Import.** `importVismaReceivables()` on the same cron. Read
`customerdocument?status=Open`, paged and paced. Store one row per document:
reference number, customer name and number, document date, due date, currency,
amount, balance, and whether the customer is linked to a `B2bCustomer`.

**The filter.** Exclude customers whose name ends in `- Webkunde`. Those are the
webshop collective accounts: 994 of 1000 open documents, 993 of them "overdue"
by a same-day due date, median 113 days. Including them would bury the six real
ones under a thousand false alarms and the feature would be turned off within a
day.

This is a name test on a collective account, which is fragile if the accounts
are ever renamed. It is chosen anyway because the alternative — reading
`creditTerms` from the single-document endpoint — costs one HTTP request per
document against an API that 429s after ten. The test is one line, it is
commented with that reasoning, and the count it excludes is logged every run so
a rename shows up as a sudden jump rather than silence.

**Page.** `/finance`, admin only, listing open invoices: customer, reference,
due date, days overdue, balance in its own currency, and a total converted
through `src/lib/fx/rates.ts` because the six span NOK, SEK, DKK and EUR. Sorted
most overdue first.

**Slack.** A second webhook, `financeSlackWebhookUrl`, stored encrypted beside
the delivery one. A daily job posts one message listing invoices past due and
still open, with the total. One message per day, not one per invoice, and
nothing at all when the list is empty — the delivery alerts already follow both
rules.

**Testing.** Pure selector: a `- Webkunde` customer is excluded; a named
customer past due is included; a named customer not yet due is excluded; a zero
balance is excluded; mixed currencies total correctly. Slack sender tested with
a stubbed webhook, including the "say nothing when there is nothing" case.

## Slice 4 — Klarna disputes to Slack

**Blocked, and it should stay blocked until one question is answered.**

There is no Klarna code, configuration or credential anywhere in the repository.
Klarna's Disputes API needs merchant API credentials — a username and password
issued per merchant, distinct from the merchant portal login. Nothing in this
project has them and nothing has ever called Klarna.

Before any of this can be designed:

1. Does the client have Klarna **API** credentials, or only the merchant portal?
2. Which Klarna region and merchant id, and which of the shops sell through it?

If the credentials exist, the shape is small and mirrors the delivery poller:
poll the Disputes API on a schedule, store dispute id and status, post to the
finance Slack channel on a dispute we have not seen before. If they do not, the
honest answer is that this cannot be built, and no amount of code changes that.

## Order of work

1. **Slice 3, receivables and Slack.** It is the client's clearest pain, it is
   independent of everything else, and it is the only slice with real data
   waiting for it today — six invoices, four of them provably his own flow.
2. **Slice 1, B2B sales.** Larger, and it has work to do on day one — a claim
   this document previously got backwards. The sampled page suggested the
   linkable customers had nothing open; the first complete import showed
   otherwise, with open invoices for both `JPK Trading Kft` and
   `Play Nöjesdistribution AB`. Two readings of the same ledger disagreed
   because one of them was a capped page, which is the lesson worth keeping:
   on this endpoint, a single page is a sample and must be labelled as one.
3. **Slice 2, shipping cost.** Useful alone, but its value is in costing the
   orders slice 1 brings in.
4. **Slice 4, Klarna.** Only once the credential question is answered.

Each slice is its own branch, its own tests and its own deploy. Nothing here
needs to ship as one change, and none of it should.

## Open questions for the client

1. ~~**Verkkokauppa.com** is in our software but does not exist in Visma.~~
   **ANSWERED 2026-08-18, and by the data rather than by the client.** It is
   Visma customer **10488**, filed as `Verkkokauppa` without the `.com`. The
   original search missed it because the customer endpoint caps at 1000 rows.
   Nothing needs asking; the customer needs linking.
2. **Klarna API credentials** — portal only, or real API access? Slice 4 cannot
   start without this.
3. **Hans Hoff Petersen**, 23 250 NOK, due 2023-02-01, still open. Is that a
   live debt or an old balance nobody has written off? It will head the overdue
   list at 1 294 days on day one.
4. **Credit notes.** 292 of the 1000 documents are credit notes. Slice 1 skips
   them. Should a credit note against a linked B2B customer reduce that
   customer's recorded sales?
