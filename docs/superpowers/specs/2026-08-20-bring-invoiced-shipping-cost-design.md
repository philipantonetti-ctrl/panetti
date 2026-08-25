# Shipping cost from Bring's own invoices

2026-08-20

The client asked one question:

> through the API, are we able to calculate average cost per shipment? With the
> API to Bring and DHL?

The answer we already had on file was no. `src/lib/delivery/carrier-cost.ts`
says so in its first paragraph, and the Cost per parcel card asks him to type
the monthly invoice in by hand because of it.

That answer was wrong. Every figure below was measured against the live Bring
API on 2026-08-20 with the client's own credentials, not estimated.

## The one finding that shapes everything

**The parcels bill to the client's own Bring customer numbers.** The comment at
the top of `src/lib/bring/client.ts` states the opposite:

> Parcels here are booked under the WAREHOUSE's Bring customer number, not the
> client's. The credentials identify the caller; they do not scope which
> parcels may be read.

The first half is false. The warehouse books shipments *using* Ledende
Teknologi's customer numbers, so Bring invoices the client directly, and the
client's own Mybring login can read those invoices. Everything in this document
follows from that.

`GET https://www.mybring.com/reports/api/generate` - HTTP 200:

| customer number | name |
|---|---|
| 20007277815 | LEDENDE TEKNOLOGI AS |
| 20020152102 | LEDENDE TEKNOLOGI AS SE-NO |
| 20020467369 | LEDENDE TEKNOLOGI AS SE-NO HD |
| 20012412431 | Ledande Teknologi Sverige AB |

**Enumerate through the Reports API, not Customer Info.** Customer Info
returned only the first three; the Swedish entity appears only in Reports. A
build that discovers customer numbers through Customer Info silently misses one
company's freight entirely, and nothing on screen would say so.

## What is actually reachable

`GET https://www.mybring.com/invoicearchive/api/invoices/{customerNumber}.json`
- HTTP 200, real invoices, all three headers we already send for tracking
(`X-Mybring-API-Uid`, `X-Mybring-API-Key`, `X-Bring-Client-URL`):

| customer | invoice | date | total | currency | issuer | spec |
|---|---|---|---|---|---|---|
| 20020467369 | 4710001522 | 31.07.2026 | 105 983.87 | NOK | Bring Home Delivery Norge | yes |
| 20020467369 | 4710001374 | 30.06.2026 | 103 944.47 | NOK | Bring Home Delivery Norge | yes |
| 20020152102 | 4040281196 | 31.07.2026 | 77 466.14 | SEK | Bring eCommerce Logistics | yes |
| 20020152102 | 4070009812 | 31.07.2026 | 6 240.00 | SEK | Bring eCommerce Logistics | **no** |
| 20007277815 | 1101039726 | 31.07.2026 | 2 681.88 | NOK | Posten Bring AS | yes |
| 20007277815 | 4040280541 | 31.07.2026 | 486.80 | SEK | Bring eCommerce Logistics | yes |

Three facts in that table decide the design.

**One month is many invoices, from several legal entities, in more than one
currency.** July 2026 alone is six invoices across three Bring companies in NOK
and SEK. `CarrierCost` holds one amount and one currency per carrier per month,
and `carrierAverages` refuses to sum across currencies on purpose. Nothing here
fits that shape.

**Not every invoice has a specification.** 4070009812 came back
`invoiceSpecificationAvailable: false`, `batchSource: MANUAL_ORDER_OM`. Some
money is therefore never attributable to a parcel, and a design that assumes
otherwise will quietly under-count freight.

**The specification carries the parcel number.** Every one of the four accounts
offers `MASTER-SPECIFIED_INVOICE`. One was downloaded and measured on
2026-08-20 - invoice 4710001522, customer 20020467369:

| | |
|---|---|
| lines | 144 |
| distinct `WAYBILL_NUMBER` | 29 |
| lines per parcel | ~5 |
| blank waybills | 0 |
| currencies | NOK only, per line in `INVOICE_CURRENCY_CODE` |

`WAYBILL_NUMBER` is 17 digits, equals `RECEIVER_REFERENCE` on every line, and
passes `looksLikeTracking` unchanged. It is `Shipment`'s unique key. **That
join is the whole feature.**

**A parcel is never one line.** Each of the 29 carries a base service plus its
surcharges, billed separately:

```
3123 Home Delivery Curbside     3123 Fuel Surcharge
3123 Toll road                  3123 Depot Time
3123 Notification before planning   3123 Attempted Delivery
```

So a parcel's cost is the **sum** of its lines, which is the second reason
`ShipmentCost` is rows rather than a column on `Shipment`.

Two fields worth knowing and not using. `ORDER_NUMBER` is Bring's own order id,
not a shop order number. `SENDER_REFERENCE` is a six-digit warehouse reference
(`024426`, `024917`) in the same shape as the `Order` column of the warehouse's
daily file - a possible second join, deliberately not relied on until someone
confirms what it refers to.

Also offered on all four, unused for now and recorded so nobody re-discovers
them: `COMPLETE_STATUS_INCLUDING_FREIGHT_COST`,
`PARCELS-FREIGHT_STATISTICS_SUMMED`, `PARCELS-FREIGHT_STATISTICS_DETAILED`,
`PARCELS-ECONOMY_AND_STATISTICS`.

## The download is refusing API credentials - measured 2026-08-21

**This section overrules the reachability claim above.** Everything below was
measured at 02:00 GMT on 2026-08-21 against the same credentials, from the same
machine, that produced the fixture in `src/lib/bring/fixtures/specified-invoice.xml`
at 15:30 CEST the day before.

Bring still builds the report. It will not hand over the file.

| endpoint | with `X-Mybring-API-Uid` + `X-Mybring-API-Key` |
|---|---|
| `api.bring.com/tracking/api/v2/tracking.json` | **200** |
| `invoicearchive/api/invoices/{customer}.json` | **200**, 27 invoices across 4 accounts |
| `reports/api/generate` (customer list) | **200**, the same four numbers |
| `reports/api/generate/{customer}/MASTER-SPECIFIED_INVOICE/?invoiceNumber=` | **200**, returns a `statusUrl` |
| `reports/api/report/{id}/status/` | **200**, `DONE`, hands back `xmlUrl` and `xlsUrl` |
| **`reports/api/report/{id}.xml`** | **406 Not Acceptable** |
| **`reports/api/report/{id}.xlsx`** | **406 Not Acceptable** |
| **`reports/api/generate/{customer}/`** (report list) | **406 Not Acceptable** |

So the credentials are good, the reports subsystem answers, the report reaches
`DONE` - and the two endpoints that return report CONTENT refuse. Both of those
two worked on 2026-08-20: the fixture is a real download stamped
`FinishedAt 2026-08-20T15:30:35.752+02:00`, and the list of report types this
document quotes further up came from the endpoint that now 406s.

**It is not the Accept header, and not our code.** Ruled out by measurement,
each on a freshly generated report:

- `application/xml`, `text/xml`, `application/json`, `*/*`, and no Accept at
  all: 406 every time. A correct 406 is impossible against `*/*`, so this is a
  canned refusal, not content negotiation.
- Chrome, curl and Node user agents: 406 every time.
- Carrying the `AUTHGATEWAY_ROUTE` cookie forward from the generate and status
  calls, in case the file was pinned to one backend: 406.
- Three retries spaced six seconds apart: 406.
- Invoices 4710001522, 4710001374 and 4040281196, across two customer numbers,
  including the exact invoice that downloaded yesterday: 406.

**The one informative variant.** Sent with NO credentials, the same URL returns
**200 and a 3 881-byte HTML login page**. So the gateway serves that path to a
browser session and refuses it to an API key. Whether that is a deliberate
change, a permission that has come off this Mybring user, or a fault, cannot be
told from outside - and this is the point at which the honest answer is to ask
Bring rather than to guess again.

### What this does and does not change

**The ingest still ships, and it is not wasted.** Discovery and request are real
work and both succeed: production will hold a `BringReportRun` row for all 27
invoices, correctly split into the 25 with a specification and the 2 without.
Only `collect` fails, and the fix wave committed on 2026-08-21 is exactly what
makes that survivable rather than destructive: the failure is written to the row
with Bring's own message, backed off an hour, and retried - so the first tick
after Bring serves a file again completes the collect with nothing lost and
nothing to re-run by hand.

**Nothing on screen changes and no figure moves**, because slices 3 and 4 were
already deferred. A client looking at the Delivery page today sees exactly what
he saw yesterday.

**`bringCostsUnmatched` stays 0 until a collect succeeds**, so the number slices
3 and 4 wait on is still unknown, for a new reason. The waybill join is untested
against production, and now cannot be tested from here at all: the report is the
only place `WAYBILL_NUMBER` appears.

**The next action is a question to Bring**, not a code change: ask why
`reports/api/report/{id}.xml` answers 406 to an API key that their own generate
and status endpoints accept, when it served the same report the previous
afternoon. Until that is answered, this feature is built, tested and dormant.

### DHL cannot do this

No billing, invoice, eBilling or MyBill endpoint exists anywhere in DHL's
public API catalogue. MyBill is a portal a person logs into. **DHL's figure
stays hand-entered**, which is why `CarrierCost` survives this change rather
than being replaced by it.

## What we store

### `ShipmentCost` - one row per invoice line

Not a column on `Shipment`. A parcel can appear on more than one invoice: a
surcharge, a re-weigh, a correction, a credit note. Collapsing that into one
column loses the second of them and makes a credit note impossible to express.
This is the reason `ShipmentEvent` is its own table, and the same reason
applies.

```
model ShipmentCost {
  id             String   @id @default(cuid())
  trackingNumber String   // WAYBILL_NUMBER, joins Shipment.trackingNumber
  customerNumber String   // ACCOUNT_NUMBER, which Bring account was billed
  invoiceNumber  String
  amount         Int      // minor units of `currency`, from AMOUNT (ex tax)
  currency       String   // INVOICE_CURRENCY_CODE, per line
  chargedAt      DateTime // TRX_DATE
  itemNumber     String   // ITEM_NUMBER, e.g. 105633
  description    String   // ITEM_DESCRIPTION, e.g. "3123 Toll road"
  readAt         DateTime @updatedAt

  @@index([invoiceNumber])
  @@index([trackingNumber])
}
```

**No unique constraint, and that is the finding, not an oversight.**

The report was downloaded and measured on 2026-08-20 (invoice 4710001522,
customer 20020467369, 144 lines). It carries **no line identifier**.
`TRX_NUMBER`, the only candidate, is the invoice number repeated on all 144
rows. And content cannot substitute for one: the composite
`WAYBILL_NUMBER + ITEM_NUMBER + ITEM_DESCRIPTION + AMOUNT` yields **135
distinct keys for 144 lines**. Waybill 73325383643994654 alone carries three
identical charge sets:

| lines | item | description | amount |
|---|---|---|---|
| ×3 | 105489 | 3123 Home Delivery Curbside | 1 140.84 |
| ×3 | 105633 | 3123 Toll road | 35.94 |
| ×3 | 105492 | 3123 Notification before planning | 46.07 |
| ×3 | 105491 | 3123 Fuel Surcharge | 136.90 |
| ×2 | 105490 | 3123 Attempted Delivery | 0.00 |

Deduplicating by content would drop nine of that parcel's fourteen lines and
under-report its freight by roughly two thirds. This is not a rare edge case
to guard against later; it is present on one parcel in twenty-nine of the very
first invoice read.

**So idempotency comes from replacing an invoice wholesale, not from a
per-line key.** Ingesting invoice N deletes every `ShipmentCost` for that
invoice number and inserts the report's lines in one transaction. Re-reading is
then naturally a no-op, a corrected re-issue replaces cleanly, and no line is
ever silently merged with its twin.

### The reconciliation gate

The line amounts reconcile exactly to the invoice header, measured:

| | lines sum to | header says |
|---|---|---|
| `AMOUNT` | 84 786.85 | `amount` 84 786.85 |
| `TOTAL_INCL_TAX` | 105 983.87 | `totalAmount` 105 983.87 |
| `TAX_AMOUNT` | 21 197.02 | `taxAmount` 21 197.02 |

**An ingest whose lines do not sum to the invoice header is rejected, not
stored.** It is the cheapest possible proof that a whole invoice arrived and
parsed, and without it a truncated download looks exactly like a cheap month.

`AMOUNT` is the money, **not `GrossPrice`**. The documentation names
`GrossPrice`; in the real report it is `0.00` on all 144 lines. Where the docs
and the data disagree, the data wins.

Amounts are ex tax on purpose. Every other cost in this product excludes VAT,
because VAT was never our money.

A parcel billed in two different currencies across two entities is **refused,
not summed**, and flagged. It is the same rule `carrierAverages` already
applies, and there is no rate on this page to convert with.

`trackingNumber` is a plain string with no foreign key, deliberately. An
invoice line can arrive for a parcel we do not hold, and refusing it would
throw away the evidence that we are missing a parcel. Unmatched lines are
counted and named on screen, exactly as unmatched parcels already are.

A summed `costMinor` and `costCurrency` are denormalised onto `Shipment` and
rewritten on every ingest, precisely as the milestone columns already are:
rows are the truth, the column is for speed.

### `BringReportRun` - the job

```
model BringReportRun {
  id             String   @id @default(cuid())
  customerNumber String
  invoiceNumber  String   // the report's only parameter
  invoiceDate    DateTime
  reportId       String?  // Bring's, parsed out of statusUrl
  statusUrl      String?
  state          String   // PENDING | REQUESTED | STORED | FAILED | NO_SPEC
  requestedAt    DateTime?
  collectedAt    DateTime?
  rowsStored     Int      @default(0)
  rowsUnmatched  Int      @default(0)
  error          String?

  @@unique([invoiceNumber])
  @@index([state])
}
```

**Keyed on the invoice, not on a month**, because that is the only thing the
report accepts. Measured: `MASTER-SPECIFIED_INVOICE` takes one parameter,
`invoiceNumber`. A date range returns `400 Invalid input parameters`.

`NO_SPEC` is a real terminal state, not a failure. Invoice 4070009812
(6 240.00 SEK, `batchSource: MANUAL_ORDER_OM`) came back
`invoiceSpecificationAvailable: false`. Such an invoice can never be broken
down, and recording that plainly is what stops it being retried forever and
what lets the page say how much money it cannot attribute.

## How a report is fetched without blocking a run

The Reports API is asynchronous: generate returns 202 with a `statusUrl`, the
status endpoint answers DONE, NOT_DONE or FAILED, and only then can the report
be downloaded. There is no such pattern anywhere in this repo, and inventing a
blocking poller inside the fifteen-minute cron would be the one thing that
stage's carefully budgeted deadlines exist to prevent.

So the job spans runs instead. One tick does **at most one generate and one
collect**, and `BringReportRun.state` remembers where it got to. A report that
is not ready is collected on a later tick. A failure is written to `error` and
never thrown, like every other stage after the shops.

This is the watermark culture the codebase already runs on: bounded cost per
tick, nothing lost, retry free.

The whole cycle, per tick:

1. **Discover.** List invoices for each of the four customer numbers
   (`invoicearchive`, cheap, one call each). Every invoice not already known
   becomes a `BringReportRun` row: `PENDING`, or `NO_SPEC` where
   `invoiceSpecificationAvailable` is false.
2. **Request.** Take the oldest `PENDING` row, generate its report, store the
   `statusUrl`, mark it `REQUESTED`.
3. **Collect.** Take the oldest `REQUESTED` row, check its status. `DONE`
   means download, reconcile against the invoice header, replace that
   invoice's lines, mark `STORED`. Anything else is left for the next tick.

Oldest-first is the same fairness rule `syncAllShops` and `syncShipments`
already use: without it a run that cannot reach everything starves the same
rows forever.

Measured, the report generated fast enough to be `DONE` on the first status
check, so most invoices will land in a single tick. The design does not depend
on that - it simply means the backlog usually clears faster than the worst case
below.

**A first backfill is therefore slow, and that is acceptable.** Roughly six
invoices a month across four customer numbers is about seventy invoices for a
year, so at one request and one collect per tick the history fills over several
hours of cron. Nothing waits on it: the page shows what has landed and names
what it has not read, the same way the Cost per parcel card already names
months with no invoice. Spending more of the tick would take budget from the
parcel poll and the delivery alert, and freight history arriving by tomorrow is
worth nothing against an alert that failed to send tonight.

## Where the number lands

`computeMetrics` resolves fulfillment most-specific-first. It gains exactly one
rung:

```
order.fulfillmentCost     typed by a person on a B2B order
  ?? invoicedShipping      NEW - what Bring actually billed for this order's parcels
  ?? perSku                per-unit rates by SKU
  ?? shop flat rate        the standing per-order rate on the order's day
```

**Typed stays above invoiced.** A person who knew the deal and wrote a number
on a B2B order is making a deliberate statement; an invoice line is a fact
about a parcel. Where they disagree the human wins, because that is what the
field is for.

**The new rung carries its own currency.** `EngineOrder.fulfillmentCost` is
documented as being in `costCurrency`, the shop's. A Bring invoice is in NOK or
SEK regardless of which shop sold the item, so a Danish shop's parcel arrives
in the wrong frame. The rung is therefore `{ amount, currency }` and converts
with `crossConvert` at the order's date, like every other cross-currency figure
here. Folding it into the existing field would silently widen a contract whose
own comment warns that reading one currency as another is a tenfold error.

**An order can have several parcels.** Its invoiced shipping is the sum of the
matched lines for every parcel on it. An order with two parcels where only one
matched is **not** invoiced-costed at all - it falls through to the next rung -
because half a shipping cost is worse than an estimate.

## What this fixes for free

**The scope trap disappears.** Monthly totals had to assume the invoice and our
parcel count describe the same set of shipments. They do not: Bring carries
things for this company that these webshops never sold. Joining on waybill
number means only lines matched to a parcel we hold are ever counted, so the
question stops being askable.

**The multi-currency problem dissolves.** We never sum invoices, so six
invoices across three entities in two currencies in one month is no longer a
contradiction to resolve. Each parcel carries the currency it was billed in and
converts at its own date.

**The Cost per parcel card narrows rather than changes.** Bring's figure becomes
derived from matched parcel costs. Hand entry stays for DHL, which has no API.

## History: an explicit start date, off by default

Once the engine prefers invoiced cost, every past order with a matched parcel
restates its shipping cost and therefore its profit. The client reconciles
against BeProfit monthly, so figures moving under him without explanation is a
real cost, not a hypothetical one.

The repo already has the idiom: `Shop.deliveryTrackingFrom` means "do not judge
anything older than this". A single workspace-level `invoicedCostFrom` on
`DeliveryConfig` does the same job here.

**Null by default**, so shipping this changes no number anywhere. Setting a date
is a deliberate act with a visible boundary, and orders before it keep the
estimate they have always had.

## Testing

Following the existing split exactly:

- **Pure, in the `app` project.** The report line mapper, the order-to-parcel
  join, the multi-line summing, the credit-note case, the not-every-parcel-
  matched case. No database, no network, fixtures recorded from the real report.
- **Integration, in the `delivery` project.** Ingest into `ShipmentCost`, the
  denormalisation onto `Shipment`, re-ingesting the same report as a no-op.
  That project already runs `fileParallelism: false` because these files share
  singletons, and `BringReportRun` is another one.
- **The job state machine** driven by an injected clock and an injected fetch,
  the way `syncShipments` already takes `now` and `sleep`. A test must never
  wait on a real poll.

## The four slices

1. **Clients and mappers, all pure.** `src/lib/bring/invoices.ts` (list
   invoices for a customer number) and `src/lib/bring/reports.ts` (generate,
   status, download). Plus the two mappers: invoice JSON to typed rows, and
   report XML to typed lines, including the reconciliation check that lines
   must sum to the invoice header. No database, tested against the recorded
   real report, visible nowhere.
2. **Ingest.** `ShipmentCost`, `BringReportRun`, the discover/request/collect
   cycle, and the wholesale per-invoice replace. Wired into `/api/cron/sync`
   after the existing Visma stages and before the parcel poll. Still visible
   nowhere.
3. **Delivery page.** Real cost per parcel, per order and in the Cost per parcel
   card; Bring's monthly figure becomes derived; unmatched invoice lines get
   counted and named the way unmatched parcels are.
4. **Profit.** The engine rung and `invoicedCostFrom`. **Profit figures move in
   this slice and in no other**, which is the whole reason it is separate.

## What we are not building

**Rating or quoting.** The Shipping Guide API returns prices, and the warehouse
file turns out to carry `Vikt` (weight) and `Levsätt` (service) per parcel that
we currently discard, so a quote is genuinely within reach. It is still a quote.
It drifts from the invoice on every fuel surcharge, volumetric rounding and
remote-area fee. We have the invoice; the estimate is not worth building.

**Invoice PDFs.** The archive can return them. Nothing would read them.

**A per-invoice screen.** The invoice is a means to a per-parcel figure, not a
thing the client asked to look at. If he later wants to reconcile our total
against a Bring invoice, that is its own small feature with its own evidence.

## What still needs a person

Nothing blocks slice 1. Two operational facts are worth confirming before slice
4 turns profit figures over:

- Which months he considers closed and reported, so `invoicedCostFrom` starts
  after the last one he has already reconciled against BeProfit.
- Whether the 6 240.00 SEK manual-order invoice with no specification is a
  freight cost at all, or something else booked to the same account. It is the
  only measured example of money we can see and cannot attribute.

- **Whether waybill 73325383643994654 was really billed three times.** Its
  Home Delivery Curbside, Toll road, Notification and Fuel Surcharge lines each
  appear three times on invoice 4710001522, at 1 140.84 NOK a time for the
  service alone. Three deliveries to one address, three packages under one
  waybill, and a billing error all look identical from here. This is not a
  blocker - the design stores what the invoice says either way - but it is the
  first thing this feature will surface, and it is worth knowing which it is
  before the client sees it.
