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

`GET https://www.mybring.com/reports/api/generate` — HTTP 200:

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
— HTTP 200, real invoices, all three headers we already send for tracking
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
offers the `MASTER-SPECIFIED_INVOICE` report, whose lines include
`WAYBILL_NUMBER`, `GrossPrice` and `AMOUNT` — documented as "Invoiced shipping
costs". `WAYBILL_NUMBER` is the tracking number, which is `Shipment`'s unique
key. That join is the whole feature.

Also offered on all four, unused for now and recorded so nobody re-discovers
them: `COMPLETE_STATUS_INCLUDING_FREIGHT_COST`,
`PARCELS-FREIGHT_STATISTICS_SUMMED`, `PARCELS-FREIGHT_STATISTICS_DETAILED`,
`PARCELS-ECONOMY_AND_STATISTICS`.

### DHL cannot do this

No billing, invoice, eBilling or MyBill endpoint exists anywhere in DHL's
public API catalogue. MyBill is a portal a person logs into. **DHL's figure
stays hand-entered**, which is why `CarrierCost` survives this change rather
than being replaced by it.

## What we store

### `ShipmentCost` — one row per invoice line

Not a column on `Shipment`. A parcel can appear on more than one invoice: a
surcharge, a re-weigh, a correction, a credit note. Collapsing that into one
column loses the second of them and makes a credit note impossible to express.
This is the reason `ShipmentEvent` is its own table, and the same reason
applies.

```
model ShipmentCost {
  id             String   @id @default(cuid())
  trackingNumber String   // WAYBILL_NUMBER, joins Shipment.trackingNumber
  customerNumber String   // which Bring account was billed
  invoiceNumber  String
  lineRef        String   // distinguishes two lines on one invoice for one parcel
  amount         Int      // minor units of `currency`
  currency       String
  chargedAt      DateTime // TRX_DATE
  description    String?  // ITEM_DESCRIPTION, so a surcharge is legible
  weightGrams    Int?     // FREIGHT_CALC_WEIGHT, recorded because we have it
  readAt         DateTime @updatedAt

  @@unique([invoiceNumber, lineRef])
  @@index([trackingNumber])
}
```

Unique on the invoice line rather than the parcel, which is what makes
re-reading a report a no-op instead of a duplicate — the same seam
`ShipmentEvent` and `PurchaseOrder.externalId` already use.

**`lineRef` is not a documented field and slice 1 must settle it.** The
specified invoice report's published fields are `PICK_UP_POSTAL_CODE`,
`RECEIVER_NAME`, `DELIVERY_POSTAL_CODE`, `WAYBILL_NUMBER`, `FREIGHT_PAYER`,
`ITEM_DESCRIPTION`, `DESCRIPTION`, `FREIGHT_CALC_WEIGHT`, `TRX_DATE`,
`NUMBER_OF_PACKAGES`, `GrossPrice` and `AMOUNT`. **None of them is a line
number.** If a real downloaded report carries one, use it. If it does not, the
key is the composite `invoiceNumber + WAYBILL_NUMBER + ITEM_DESCRIPTION +
AMOUNT`, and the consequence must be stated rather than discovered: two
genuinely identical charges on one parcel would collapse into one row. That is
the safer failure — under-counting a duplicate beats double-charging freight on
every re-read — but it is a real limit and the ingest should count collapsed
rows so it is visible.

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

### `BringReportRun` — the job

```
model BringReportRun {
  id             String   @id @default(cuid())
  customerNumber String
  period         String   // 'YYYY-MM'
  reportId       String?  // Bring's, once generated
  statusUrl      String?
  state          String   // REQUESTED | READY | STORED | FAILED
  requestedAt    DateTime
  collectedAt    DateTime?
  rowsStored     Int      @default(0)
  rowsUnmatched  Int      @default(0)
  error          String?

  @@unique([customerNumber, period])
}
```

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

Reports are requested per customer number per calendar month. A closed month is
requested once and never again unless its row is cleared. The current month is
re-requested, because Bring keeps adding to it.

**A first backfill is therefore slow, and that is acceptable.** Four customer
numbers over twelve months is 48 reports at one generate per tick, so roughly
half a day of cron ticks before the history is complete. Nothing is waiting on
it: the page shows what has landed and names the months it has not read yet,
the same way the Cost per parcel card already names months with no invoice. The
alternative — several reports per tick — spends the budget the parcel poll and
the delivery alert are holding, and freight history arriving by tomorrow is
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
matched is **not** invoiced-costed at all — it falls through to the next rung —
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

1. **Reports client and line mapper.** `src/lib/bring/reports.ts` — generate,
   status, download, and a pure mapper from report lines to typed rows. No
   database. Shipped with tests and visible nowhere.
2. **Ingest.** `ShipmentCost`, `BringReportRun`, the two-phase collector, wired
   into `/api/cron/sync` after the existing Visma stages and before the parcel
   poll. Still visible nowhere.
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
