# Delivery tracking (Bring) — design

**Date:** 2026-08-06
**Status:** approved, ready for an implementation plan

## The ask

Two things, from the client:

1. See how many days it takes for each order to reach the customer.
2. Get a Slack notification when a delivery runs past the company's delivery policy.

He has a Bring account. Bring has an open API.

A follow-up narrowed it considerably. The warehouse books the parcels, and it books
them **under its own Bring customer number, not his** — which is why none of this
tracking appears in his Bring backend, only on Bring's public tracking site. The
warehouse can email a file (PDF today, hopefully CSV) pairing order number with
tracking number. Their WMS, NYCE, has an API he is still chasing.

## What already exists

| Piece | Where |
| --- | --- |
| Provider integration shape | `src/lib/woo/{client,map,sync}.ts`, repeated by `src/lib/ads/` |
| Encrypted credentials | `src/lib/secrets.ts`, `enc:v1:` prefix, key from `AUTH_SECRET` |
| A 15-minute cron with a deadline budget | `src/app/api/cron/sync/route.ts`, `maxDuration = 300` |
| Timeline-of-values pattern | `ProductCost` / `FulfillmentRate`, read via `costOn()` / `fulfillmentOn()` |
| A backfill loop over existing orders | `backfillCustomers`, `src/lib/woo/sync.ts:189` |
| Per-account error containment | `src/lib/ads/sync.ts:152` |
| Webhook receiver with a per-shop secret | `src/app/api/webhooks/woo/[shopId]` |

Nothing about shipping exists. `Order` (`prisma/schema.prisma:83`) has no tracking,
no carrier, no delivery date and no destination country — `shippingCharged` is a
money column. There is no outbound notification of any kind anywhere in the
codebase; toasts are in-browser only.

## The one hard problem, and why it is already solved

Bring's data is about **shipments**. The database is about **orders**. Nothing joins
them.

Because the warehouse ships under its own customer number, two otherwise obvious
joins are unavailable:

- **Bring Event Cast push is out.** A subscription is on *your* customer number.
  His would see none of these parcels.
- **Searching Bring by `senderReference` is out.** An authenticated search only
  finds shipments you own.

The warehouse's file supplies the join directly, from the party that booked the
parcel, today, with no dependency on NYCE.

**The link is a seam, not an assumption.** `Shipment.linkSource` records which
strategy produced it — `FILE`, `NYCE`, `WOO`, `MANUAL` — and NYCE later drops into
the same slot without moving anything downstream.

## Decisions

### The clock runs order placed → available, and the split is shown

```
warehouseDays = placedAt   → handedInAt      (how long the warehouse held it)
transitDays   = handedInAt → availableAt     (how long Bring held it)
totalDays     = placedAt   → availableAt     ← the headline, judged against the promise
collectedAt                                   ← recorded and shown, never judged
```

The headline is the customer's whole wait, because that is what the customer
experiences and what the client asked for. The split is shown because it is the
only thing that tells him *which half* to fix.

An order with several parcels is available when the **last** one is.

### The clock stops when the parcel is available, not when it is collected

`READY_FOR_PICKUP` for a pickup point, `DELIVERED` for a home delivery. That moment
is where the company's obligation ends.

This matters more in the Nordics than it would elsewhere: a large share of parcels
sit at a pickup point for days, and Bring only reports `DELIVERED` on collection.
Judging against collection would fire alerts about customers who took a week to walk
to the shop — noise nobody can act on. `collectedAt` is still stored and shown in
the drill-down.

### The promise is per destination country, on a timeline

```prisma
model DeliveryPromise {
  country       String   // ISO-2, or '*' for the fallback
  days          Int
  businessDays  Boolean  @default(true)
  effectiveFrom DateTime
  @@unique([country, effectiveFrom])
}
```

The row with the latest `effectiveFrom <= Order.placedAt` wins, exactly the rule
`costOn()` and `fulfillmentOn()` already implement. A promise changed today never
rewrites last month's on-time rate.

Per country because he ships to Norway, Sweden, Denmark, Finland and Germany and
they cannot share one number. This shape also contains the simple case: if the
promise really is one number, the same number goes in every row.

**Consequence:** `Order` needs `shippingCountry`, which the Woo sync does not
currently extract (`src/lib/woo/map.ts:97` reads only `billing.first_name`,
`last_name`, `email`).

### Business days by default, per country

A Friday-afternoon order with a three-day promise is not late on Monday. Calendar
days would mark every weekend order late and fill the Slack channel with noise.
Evaluated in the shop's timezone, falling back to `Setting.timezone`
(`prisma/schema.prisma:239`, default `Europe/Oslo`).

Per-row rather than global, so Germany can be calendar while Norway is business.

**Public holidays are not modelled.** Constitution Day and Christmas will produce a
handful of false lates. Stated rather than hidden; a holiday table is a later
addition if it proves to matter.

### Polling, not push

Event Cast is unavailable (above). The cron polls Bring's Tracking API by tracking
number.

Polling every live parcel every fifteen minutes would be tens of thousands of wasted
calls a day, so the cadence is tiered on `Shipment.nextPollAt`:

| State | Poll |
| --- | --- |
| Booked, not yet handed in | every 6h |
| In transit | every 2h |
| Within a day of the promise, or past it | every run |
| Available, awaiting collection | daily, up to 30 days |
| Delivered, returned or cancelled | never again (`terminal = true`) |

Freshness costs nothing here. A delivery timestamp four hours stale gives the same
day count, and noticing three hours late that a parcel is two days overdue changes
nobody's morning.

### Slack via an incoming webhook

One `https://hooks.slack.com/services/...` URL, stored encrypted like the shop keys.
No OAuth, no scopes, no app review, and he can create it himself in two minutes. A
full Slack app would only buy channel selection at runtime, which is not worth the
setup.

### Alerts are batched into the existing cron, and fire once per order

No second cron. Every run posts at most one message; most runs post nothing.

## Data model

```prisma
model Shipment {
  id             String  @id @default(cuid())
  trackingNumber String  @unique
  carrier        String  @default("BRING")
  // Nullable: a parcel can be known before its link is. Unlinked parcels are
  // counted on screen, never silently dropped.
  orderId        String?
  linkSource     String?              // FILE | NYCE | WOO | MANUAL

  bookedAt       DateTime?            // PRE_NOTIFIED — label made, nothing moved
  handedInAt     DateTime?            // HANDED_IN
  availableAt    DateTime?            // READY_FOR_PICKUP or DELIVERED — the clock stop
  collectedAt    DateTime?            // COLLECTED / DELIVERED
  outcome        String?              // DELIVERED | RETURNED | CANCELLED

  lastStatus String?
  nextPollAt DateTime?
  terminal   Boolean @default(false)
  lastError  String?                  // stored, never thrown

  @@index([terminal, nextPollAt])
}

model ShipmentEvent {
  id          String   @id @default(cuid())
  shipmentId  String
  status      String
  occurredAt  DateTime
  description String?
  location    String?

  // Bring restates events. This makes re-ingestion a no-op rather than a
  // duplicate, which is what lets the sync run as often as it likes.
  @@unique([shipmentId, status, occurredAt])
}
```

Milestones are denormalised onto `Shipment` for query speed, but derived from
`ShipmentEvent` and recomputed on every ingest, so the events remain the source of
truth. They are also what the drill-down timeline renders.

**On `Order`:**

- `shippingCountry String?` — backfilled from Woo, following `backfillCustomers`
  (`src/lib/woo/sync.ts:189`). Null means "not yet checked"; `''` means "checked,
  the store has none", matching the existing `customerName` convention.
- `deliveryAlertedAt DateTime?` — so nothing can alert twice, ever.

**On `Shop`:**

- `deliveryTrackingFrom DateTime?` — **null means this shop is not tracked at all.**
  It carries two jobs at once, and both are necessary. A shop that ships from
  somewhere else entirely (Germany is the likely case) must not have every one of its
  orders read `Not shipped yet` and alert. And for a tracked shop, orders placed
  before the date read `Before tracking started`, never alert, and never enter the
  median — without which the day this ships, every order in history is "past its
  promise and not delivered" and Slack receives a thousand-line message.

  It is backdateable: if the warehouse can supply old files, importing them and
  moving the date back gives real history on day one rather than an empty page.

**Config**, a singleton of its own rather than crowding `Setting` (which is purely
formats), following the `AdPlatformApp` precedent (`prisma/schema.prisma:262`):

```prisma
model DeliveryConfig {
  id             String @id @default("singleton")
  bringApiUid    String?   // Mybring account email
  bringApiKey    String?   // encrypted
  bringClientUrl String?   // X-Bring-Client-URL
  slackWebhookUrl String?  // encrypted
  lastSyncAt     DateTime?
  lastError      String?
}

model TrackingImport {
  id            String   @id @default(cuid())
  filename      String
  source        String   // UPLOAD | EMAIL
  receivedAt    DateTime @default(now())
  rowsParsed    Int
  rowsLinked    Int
  rowsUnmatched Int
  error         String?
}
```

`TrackingImport` exists so that "did yesterday's file land, and did all of it
match?" is a question with an answer on screen.

## Architecture

### `src/lib/bring/parse.ts` (new)

```ts
export function parseTrackingFile(buf: Buffer, filename: string): TrackingPair[]
```

CSV is a header lookup, tolerant of column-name variation.

PDF is text extraction, then this rule instead of guessing formats: pull every token
that could be a tracking number, and pair each with the nearest token that **matches
an order number already in the database**. We do not need to know his order-number
format or their table layout — we look up what we already hold. A row matching
nothing lands in the unmatched pile with its raw text, visible rather than dropped.

Pure and synchronous; the real warehouse files become fixtures.

### `src/lib/bring/link.ts` (new)

Resolves pairs to orders and writes `Shipment` rows.

`Order.number` is **not unique across shops** (`@@unique([shopId, externalId])` is
the only uniqueness there). If a file says `1234` and two shops both hold a `1234`,
we do not guess: it goes to unmatched with a "matched 2 orders" reason for manual
resolution. Rare, but a wrong link would poison a delivery figure permanently.

### `src/lib/bring/client.ts` (new)

`GET https://api.bring.com/tracking/api/v2/tracking.json?q=<tracking number>` with
`X-Mybring-API-Uid`, `X-Mybring-API-Key`, `X-Bring-Client-URL`.

Copies `src/lib/woo/client.ts` deliberately: a 30s ceiling (`:44`), `requestBudgetMs`
clamped to the run's remaining deadline (`:52`), error bodies truncated to 300 chars
(`:63`), `isTimeoutAbort` checking `.cause` (`:72`).

### `src/lib/bring/map.ts` (new)

Bring's `consignmentSet[].packageSet[].eventSet[]` into `ShipmentEvent` rows, plus
milestone derivation from the status vocabulary: `PRE_NOTIFIED`, `HANDED_IN`,
`IN_TRANSIT`, `READY_FOR_PICKUP`, `DELIVERED`, `COLLECTED`, `ATTEMPTED_DELIVERY`,
`DEVIATION`, `RETURN`, `DELIVERED_SENDER`, `DELIVERY_CANCELLED`.

**Returns are an outcome, not permanent lateness.** A parcel that goes `RETURN` or
`DELIVERED_SENDER` never becomes available; without this the late list only ever
grows. It leaves the median (it was never delivered) and shows as `Returned`.

### `src/lib/bring/sync.ts` (new)

Selects `terminal = false AND nextPollAt <= now`, oldest first — the same fairness
rule `syncAllShops` gets from ordering by `lastRunAt`. Upserts events, recomputes
milestones, sets the next tier, marks terminal.

Per-shipment failures are written to `lastError` and never thrown, matching
`src/lib/ads/sync.ts:152`: one dead parcel must not stop the rest. Runs inside the
cron's remaining budget and stops starting batches when time runs short.

### `src/lib/delivery/days.ts` (new)

Pure business-day arithmetic between two instants in a named timezone, and the
deadline for an order given its promise. No database access, fully unit-testable.

### `src/lib/delivery/promise.ts` (new)

`promiseOn(points, country, date)`, mirroring `costOn()` and `fulfillmentOn()`
exactly, falling back to the `'*'` row.

### `src/lib/slack/notify.ts` (new)

POST JSON to the decrypted webhook URL, with a timeout. Failure is stored in
`DeliveryConfig.lastError`, never thrown into the cron.

### `src/app/api/cron/sync/route.ts` (modified)

After shops and ads, before or alongside FX, both wrapped best-effort in the same
style as the existing ad and FX steps:

1. `syncShipments()` within the remaining deadline
2. `flushDeliveryAlerts()`

The response object gains honest counts (`shipments`, `shipmentsFailed`,
`alertsSent`).

### The alert rule

One query: orders whose shop is tracked and whose `placedAt >= Shop.deliveryTrackingFrom`,
`deliveryAlertedAt IS NULL`, **status not in `VOIDED_STATUSES`**, past their deadline,
and **not yet available**.

Excluding voided orders is not a detail. A refunded or cancelled order is never going
to be delivered, so without that clause every refund in the tracked window becomes a
permanent late delivery and Slack fills with orders nobody is waiting for. The
constant already exists (`src/lib/metrics/types.ts`) and is reused rather than
restated.

That rule covers both live failure modes — a parcel crawling through Bring, and an
order the warehouse never booked at all. The second is the worse of the two, and a
shipment-driven alert would miss it entirely because there is no shipment.

**A returned parcel alerts too, once, with its own reason.** The customer did not get
their order, which is exactly the thing he needs to know. It is the "leaves the late
list" case below that keeps it from sitting there forever afterwards: alerting is a
one-time event, the late list is a live queue, and a return belongs in the first and
not the second.

The message: a header (`3 orders past their delivery promise`) and one line per
order carrying number, shop, country, days over, what is actually happening (`Not
shipped`, `In transit since 3 Aug`, `At pickup point`, `Returned to sender`), a link
into the app and a link to Bring's public tracking page. Capped at 25 lines with
`and 12 more`, so a bad day cannot exceed Slack's payload limit.

`deliveryAlertedAt` is stamped **after** Slack returns 200, never before. If Slack is
down the alert waits for the next run instead of vanishing.

### `src/app/api/delivery/import/route.ts` (new)

Admin-only, multipart, feeding `parseTrackingFile` then `link`. Returns the counts
and writes a `TrackingImport` row. An inbound-email webhook later feeds the same two
functions; the upload box stays permanently as the fix for the morning the email does
not arrive.

### `src/app/delivery/` (new page)

`page.tsx` (server, auth + shop list) and `DeliveryClient.tsx`, following
`marketing/page.tsx` and `MarketingClient.tsx`. Header carries the existing
`ShopFilter` and `DateFilter`.

Four tiles: median days to delivery, on-time rate, late right now, no tracking.
Then the warehouse/transit split as two stacked bars. Then a distribution by day
count, because a median alone hides the tail that generates the complaints. Then a
per-country table, since the promise is per country. Then the list of currently-late
orders, which is the only part anyone acts on. Then the unlinked bucket, and the
upload box.

**Median, not average.** Two parcels stuck in customs for a month would drag a mean
into fiction.

Nav entry `Delivery` in the Analytics section of `AppShell.tsx:48`, after Orders.

### `src/app/api/orders/route.ts` and the Orders table (modified)

One new column, `Delivery`, reading as a plain answer: `3 days`, `In transit, day 4`,
`Not shipped yet`, `No tracking`, `Before tracking started`. Late values carry the
`--loss` token. Shipments are bulk-loaded once per page, never per row, matching how
that route already handles costs, rates and FX.

The existing drill-down gains a timeline: placed, handed to Bring, available,
collected, with the raw Bring events beneath it.

### `src/app/settings/delivery/` (new page)

Bring credentials with a **Test connection** button; the Slack webhook with a **Send
test message** button; the promises table, edited the way product costs are; the
tracking start date; the import history with its matched/unmatched counts.

The test buttons are not decoration. An alerting feature nobody has ever seen fire is
an alerting feature nobody trusts.

## Access, throughout

Admin only, `assertAdmin` plus `Cache-Control: private, no-store`, the same boundary
as `api/orders/route.ts`. Ambassadors and the marketing role never see any of it.

## Errors and empty states

| Condition | Behaviour |
| --- | --- |
| Bring credentials unset | Delivery page explains what is missing and links to settings. No polling. |
| Slack webhook unset | Everything else works; alerting is shown as off, not silently skipped. |
| Shop with `deliveryTrackingFrom` null | Excluded entirely. Column reads `—`, never alerts, never in the median. |
| Order before its shop's `deliveryTrackingFrom` | `Before tracking started`. Never alerts, never counted. |
| Order after it with no shipment | `Not shipped yet`, and alerts once past its deadline. |
| Order refunded or cancelled | Never alerts. Column reads whatever the parcel actually did, or `—`. |
| Shipment with no linked order | Counted in the unlinked bucket, manually linkable. |
| File row matching several orders | Unmatched, with the reason shown. Never guessed. |
| Parcel returned or cancelled | Own outcome. Alerts once, then leaves the median and the late list. |
| No `shippingCountry` on an order | Falls back to the `'*'` promise row. |
| Bring returns nothing for a number | `lastError` on that shipment only; every other parcel proceeds. |

## Testing

Written first, RED confirmed before GREEN.

`days.test.ts` — a Friday order with a 3-day business promise is due Wednesday, not
Monday; a calendar promise crosses the weekend; DST transitions in `Europe/Oslo` do
not shift a deadline by an hour; timezone comes from the shop, then the setting.

`promise.test.ts` — the latest `effectiveFrom <= placedAt` wins; a promise added
today does not rewrite last month; unknown country falls back to `'*'`; no rows at
all yields no judgement rather than a zero-day promise.

`parse.test.ts` — real warehouse fixtures, CSV and PDF; a reordered CSV column still
parses; a PDF row whose order number is unknown lands unmatched; nothing crashes on
a garbage file.

`link.test.ts` — an order number held by two shops is refused, not guessed;
re-importing the same file links nothing twice.

`map.test.ts` — `READY_FOR_PICKUP` sets `availableAt` and a later `COLLECTED` does
not move it; a home delivery sets both from `DELIVERED`; `RETURN` sets the outcome
and never sets `availableAt`; re-ingesting the same event set changes no row.

`sync.test.ts` — a failing shipment does not stop the others; a terminal shipment is
never polled again; the deadline stops the batch.

`alerts.test.ts` — an order past its deadline with no shipment alerts; the same order
does not alert on the next run; a Slack failure leaves `deliveryAlertedAt` null so
the next run retries; **a refunded order past its deadline never alerts**; **a shop
with `deliveryTrackingFrom` null never alerts**; an order placed before its shop's
date never alerts; a returned parcel alerts once with its own reason; more than 25
late orders produce one capped message.

`route.test.ts` — non-admin gets 403 on every new route.

## Phasing

| | |
| --- | --- |
| **0** | Probe the Tracking API with one warehouse-booked number. Decides everything below. |
| **1** | Schema, parser, upload, Bring polling, Delivery page, Orders column. Answers "how many days" for real. |
| **2** | Promises, business-day maths, Slack, settings page. The alerting half. |
| **3** | Inbound email, so the file lands by itself. |
| **4** | NYCE into the link seam when access arrives. Nothing else moves. |

Phase 1 is useful standing alone, which is why the split is there.

## Open questions

- **Whether Bring's Tracking API returns parcels booked under another customer
  number.** Every design above rests on this. The public tracking site shows full
  event history to anyone holding a number, and the API key identifies the caller
  rather than scoping which parcels may be read — so it should work, but "should" is
  not "does". One authenticated call with one real tracking number settles it, and
  it happens before any code is written.
- **Bring's rate limit is undocumented as far as the research went.** The tiered
  cadence is sized to be modest rather than to fit a known ceiling. If a limit turns
  up, the tiers are one table to adjust and nothing else moves.
- **Whether `q` accepts several tracking numbers in one call.** If it does, call
  volume falls by roughly the batch size. Checked in the same phase 0 probe, because
  it costs one extra request to find out.
- **Whether the warehouse can send CSV instead of PDF.** Identical effort for them,
  and it removes the most fragile part of this design. PDF extraction breaks silently
  when a template changes, and silently-broken linking means orders quietly stop
  being tracked.
- **Whether the warehouse can grant access to their Bring customer number in
  Mybring**, or book with the Woo order number as sender's reference. Either restores
  Event Cast push and search-by-order-number. An upgrade, not a prerequisite.

## Out of scope

- Carriers other than Bring. Worth revisiting only if a meaningful share of orders
  ship DHL, PostNord or GLS, in which case a tracking aggregator beats N integrations.
- Public holiday calendars.
- Notifying the customer. This is internal visibility only.
- Delivery cost. `fulfillmentCost` and `FulfillmentRate` already cover the money;
  this feature is about time.
- Attributing lateness to a cause. The warehouse/transit split says which half; it
  does not say why.
