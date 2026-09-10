# Parcels that wear the wrong carrier, and orders that wait for them

**Date:** 2026-09-10
**Status:** design, awaiting review
**Asked by:** Philip, via Marvin, with two screenshots of the Delivery page:
"for the matching of tracking links and orders, it doesn't seem to work so
well, any way we can improve this? ... seems client and I confuse."

## What the page shows today

- **Unlinked parcels (41).** Every row says carrier "Bring", status "-", and
  links to Bring's tracking page, which finds nothing.
- **No tracking yet (18).** Orders from 7 to 9 Sept, under a heading that says
  "No warehouse file has mentioned these orders yet".

## What is actually true (measured 2026-09-10)

All 17 parcel numbers visible in the screenshot were checked against both
carriers' live tracking APIs, with the client's own keys.

| Checked | Bring | DHL |
| --- | --- | --- |
| 17 of 17 | "No shipments found" | Known, with a live status |

The 17 are:

- 12 **DHL eCommerce** parcels to **Germany**, 16 to 19 kg (ovens and kitchen
  machines). Nine were already **delivered** on 8 or 9 Sept while the page
  showed them as Bring parcels with no status.
- 5 **DHL Freight** shipments of 154 kg (massage chairs): Sweden x3, Finland
  x1, Germany x1. Each carries a 10-digit DHL Freight consignment number in
  DHL's answer (`references[type=domestic-consignment-id]`).

Every one is a valid GS1 label (check digit verified) from the warehouse's own
number series, `4733253800...`. The same series is used for the Bring parcels
that DO link. The label says who packed the parcel, not who carries it.

**Why the importer gets it wrong.** `importWarehouseFile` treats every
373/473-shaped number as a Bring parcel: it asks Bring, and when Bring answers
"no parcel" it stores the number as carrier `BRING` with no order, retries
Bring for seven nights, then leaves it. The poller keeps asking Bring about it
every six hours, forever. Nothing ever asks DHL.

**Why the second list misleads.** Those parcels' orders sit under "No tracking
yet" beneath a heading that says no file mentioned them. The file did. Order
14697 in the screenshot is a different case with the same symptom: its Bring
parcel was in the 7 Sept file and was **refused** because the customer had two
orders in 30 days, one of which already held a parcel. That reason exists
today only as a line under "Recent imports"; nothing connects it to the order.

**What a DHL parcel can be matched on.** DHL's answer carries the destination
country and city, the weight, the booking time and the status. It carries no
recipient name and no email. The warehouse file carries a recipient name
(`Namn`) and a delivery-method code (`Levsätt`) that the importer ignores by
design. So for DHL parcels an exact automatic key does not exist yet; a person
can pick the order in seconds when shown the country, the date, the weight and
the candidate orders' products. That is phase 1. Reading the file's name column
and matching on it is phase 2, and is not designed here: its hit rate must be
measured on real files against real orders first.

## Goals

1. A parcel is shown with the carrier that actually has it, its real status,
   and a link that opens.
2. Every parcel we could not attach to an order sits in ONE list with the
   reason, the facts a person needs, the candidate orders, and a Link button.
   Nothing is guessed; a person decides.
3. An order that waits for a parcel we hold but could not attach says so, on
   its own row, with the reason.
4. Repeat customers stop being refused when the answer is deterministic.

## Non-goals

- Matching by recipient name (phase 2, after measurement).
- Reading any column of the warehouse file. The file is still "long numbers
  only".
- Changing what counts as late, delivered or on time.
- A DHL export importer change. The existing `DHL_FILE` path is untouched; it
  is simply joined to when its numbers appear in a DHL answer.

## Design

### 1. A parcel's carrier is discovered, not assumed

`Shipment.carrier` gains a third value, `UNKNOWN`. The importer stores every
number Bring did not resolve as `UNKNOWN`, not `BRING`. The importer's own
seven-night Bring retry stage is removed; the poller owns identification from
now on (below). Existing rows are healed by the same rule with no migration:
an **unlinked** `BRING` row that Bring answers "no parcel" for becomes
`UNKNOWN` on its next poll, and is identified from there.

The importer does NOT ask DHL. DHL allows one call every six seconds and 240 a
day; the inbound route has 50 seconds for a whole file. The poller already
runs every 15 minutes with that spacing and that budget, so identification
belongs there.

**Identification** (new module `src/lib/delivery/identify.ts`) runs inside the
poll loop for rows whose carrier is `UNKNOWN`:

1. Ask Bring (unmetered). If Bring knows the number: carrier becomes `BRING`,
   the recipient email and name, destination country, consignment id and
   booking time are stored, and the row is linked by email (section 3).
2. Otherwise ask DHL, under the run's DHL budget and spacing. If DHL knows it:
   carrier becomes `DHL`, destination country, weight, booking time, DHL's
   shipment id (as the consignment id) and its references are stored, events
   are mapped and written exactly as a normal DHL poll does, and the row is
   linked by DHL Freight reference where one exists (section 3).
3. If neither knows it: `nextPollAt` moves 24 hours on, `lastError` says
   "Neither Bring nor DHL knows this number". After 14 days from `createdAt`
   the row becomes terminal with reason "No carrier knew this number in 14
   days". It stays listed, dismissible (section 5).

A `DHL` row DHL does not know behaves as today (retry in six hours). It does
not flip back to Bring: a number DHL once knew is DHL's.

### 2. What a parcel row remembers

New columns on `Shipment`, all nullable:

| Column | Filled from | Why |
| --- | --- | --- |
| `consignmentId String?` | Bring `consignmentId`; DHL `id` | The "already holds a parcel" rule must not refuse the second box of a two-box consignment. Bring parcel 14689 has two boxes today. |
| `destinationCountry String?` | Bring `recipientAddress.countryCode`; DHL `destination.address.countryCode` | Candidate orders are filtered by it; the page shows it. |
| `weightKg Float?` | Bring `weightInKgs`; DHL `details.weight` (KG or KGM) | 1.6 kg is an accessory, 16 kg is an oven, 154 kg is a chair. It is how a person tells candidates apart. |
| `recipientEmail String?` | Bring, lower-cased | Candidates by email; the per-order note in "No tracking yet". Never shown on the page. |
| `recipientName String?` | Bring `recipientName` | Shown in place of the email. |
| `unlinkedReason String?` | The refusal, in the words the import already writes | The "Why" column. Cleared on link. |
| `identifiedAt DateTime?` | When a carrier first answered | Tells "not asked yet" from "asked, nobody knows". |

`bookedAt` already exists and is set by the milestone mapper.

### 3. Linking rules

**By email (Bring), in `matchByEmail`:** two changes to the candidate query.

- An order that already holds a linked shipment from a **different**
  consignment is not a candidate. Same consignment is fine: that is the
  second box. A shipment with no consignment id recorded (rows written
  before this change) counts as a different consignment, so the rule can only
  refuse, never wrongly accept.
- The upper bound on `placedAt` is the parcel's booking time when the carrier
  gave one, else the file's arrival time as today. An order placed after the
  label was made cannot be the one the label is for. On 7 Sept, orders 14688
  and 14690 (one customer, twelve hours apart) were both refused; with these
  two rules the first parcel links to 14688 by time, and the second then sees
  14688 holding a parcel and links to 14690.

The refusal text and the "never take the newest" discipline stay as they are.

**By DHL Freight reference:** if DHL's answer lists a
`domestic-consignment-id` and a linked `Shipment` with that tracking number
exists (the `DHL_FILE` path wrote it), the row links to that order with
`linkSource = 'DHL_REF'`. It is a second parcel row for the same physical
shipment, exactly as a second box is. Duplicate Woo notes are not a concern
today: notes are on for Panetti Denmark only and DHL carries no Danish parcels.

**Refused parcels are stored, not dropped.** When the import refuses a Bring
consignment (no order, or several), it still writes one `Shipment` row per
package: carrier `BRING`, no order, recipient facts, `unlinkedReason`,
`nextPollAt` tomorrow. The poller re-runs the email match nightly for 14 days,
so a refusal that the rules above resolve later (the twin gets its own parcel)
resolves itself. Today a refused parcel exists only as a line of JSON.

**By hand:** `PATCH /api/delivery/parcels/[trackingNumber]` with
`{ orderId }` links the row (`linkSource = 'MANUAL'`, reason cleared,
`nextPollAt` now). With `{ dismiss: true }` it marks the row terminal with
reason "Not a customer parcel (dismissed by <email>)" so pallet freight and
inbound stock leave the list. Operations role and admin may do both; the guard
is `assertOperations`. The order must exist and belong to a delivery-tracked
shop; the parcel must be unlinked.

### 4. Candidates, computed by the server

For each unlinked row the Delivery API adds `candidates`, up to six, newest
first, each `{ orderId, number, shop, customerName, placedAt, items: "1 x
Panetti ProMix" }`, plus `candidatesTotal`:

- Row has a recipient email: orders with that email (case-insensitive) in
  tracked shops, placed in the 30 days before the booking time (or the row's
  creation), not voided. Orders already holding another consignment's parcel
  are still listed but flagged `holdsParcel: true` so the person sees why the
  machine did not choose.
- Otherwise, with a destination country: orders in tracked shops shipping to
  that country, same window, not voided, with no linked shipment.
- Otherwise: none; the person types an order number.

Items come from `OrderItem` (name, quantity). This is what lets a person tell
a 154 kg chair from a 1.6 kg accessory.

### 5. The page

**"Parcels without an order"** replaces "Unlinked parcels". Columns: Parcel
(linked to the carrier that has it; no link for `UNKNOWN`), Carrier, To
(country), Booked, Weight, Last status, Why. Under each row, when there are
candidates: one button per candidate, "Link to 15864 · Tobias K. · 7 Sept ·
1 x Panetti ProMix", with "(has a parcel)" appended when flagged, then "and N
more" when capped. Always: an "Order number" input with a shop select and a
Link button, and a "Not a customer parcel" button. A link or a dismissal
reloads the page data. The count in the heading is the true total, as now.

**"No tracking yet"** changes its sub-heading to: "We hold no parcel for these
orders. Some are simply not shipped yet. Where the warehouse file named a
parcel we could not attach, the row says so and the parcel is listed below."
Each row whose customer email matches an unlinked row's recipient email gets a
second line: "A parcel for this customer was in the file of 7 Sept but was not
attached: <reason>" with the parcel number as an in-page link to the section.
DHL parcels carry no email, so their orders get no such line in phase 1; that
is what phase 2 is for.

**Tracking links.** An 18-digit DHL number opens DHL's unified tracking page
(`https://www.dhl.com/se-en/home/tracking.html?tracking-id=`); a 10-digit one
keeps the DHL Freight page as today. An `UNKNOWN` carrier shows "Unknown" and
no link; the tracking-url helper no longer falls back to Bring for a carrier
it does not know.

### 6. Poller budget

`DHL_CALLS_PER_RUN` stays 2. Identifying the 41 stranded rows costs one DHL
call each, so the backlog clears in about 21 runs, roughly five hours, and then
those rows are ordinary DHL parcels polled by the existing tiers. Bring calls
are unmetered. Identification of an `UNKNOWN` row counts against the same
per-run DHL budget as any DHL poll.

## Data flow, end to end

1. 18:00: the warehouse file arrives. Long numbers are extracted. Bring is
   asked about each. Known ones are linked by email, or stored refused with
   the reason. Unknown ones are stored as `UNKNOWN`.
2. Next poll: `UNKNOWN` rows are identified. Bring first, DHL second. Facts
   and events are written; a link is attempted.
3. Every night for 14 days: refused Bring rows re-run the email match under
   the new rules. Dead numbers become terminal after 14 days.
4. The Delivery page lists what is still unattached, with candidates. A
   person links or dismisses. The next poll polls the newly linked parcel.
5. Once linked, everything downstream (delivery figures, late list, Woo notes
   where switched on) works as it does for any linked parcel.

## Error handling

- Identification failures (network, 429) are recorded on the row as today's
  poll failures are, and retried in an hour.
- A PATCH on a linked parcel, an unknown order, an untracked shop or a
  terminal row answers 400 with a plain sentence.
- The import keeps its guarded-block discipline: a throw mid-way records what
  is known before rethrowing.

## Testing

- `match.integration.test.ts`: the two new candidate rules, including the
  two-box case that must NOT be refused, and the 14688/14690 chain.
- `identify.test.ts`: pure mapping from recorded Bring and DHL answers
  (fixtures captured today, names and addresses masked) to the facts stored;
  the "neither knows" and "14 days" rules.
- `sync.integration.test.ts`: an `UNKNOWN` row is asked of Bring then DHL;
  an unlinked `BRING` row Bring does not know becomes `UNKNOWN`; the DHL
  budget is respected.
- `import.integration.test.ts`: refused consignments write rows; unresolved
  numbers are stored as `UNKNOWN`; the retry stage is gone.
- Route tests for the PATCH: link, dismiss, and every refusal.
- `DeliveryClient.test.tsx`: the section renders reason, candidates and
  buttons; a click sends the right PATCH; the "No tracking yet" note appears
  for a matching email.
- `route.integration.test.ts` for `/api/delivery`: candidates by email and by
  country, capped at six with a true total.
- One Playwright journey: an unlinked parcel is linked by hand and leaves the
  list; the order leaves "No tracking yet".

## Open questions for phase 2 (not blocking)

- The `Levsätt` values the warehouse uses for DHL products are unknown; the
  sample file shows only `BOXHD_NO` and `342_NO` (Bring). Three recent files
  are needed to see them.
- Whether `Namn` equals `Order.customerName` closely enough to match on. To
  be measured, never assumed.
