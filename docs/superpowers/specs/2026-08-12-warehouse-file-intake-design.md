# Warehouse file intake - design

**Date:** 2026-08-12
**Status:** approved, ready for an implementation plan
**Supersedes:** the linking assumption in `2026-08-06-bring-delivery-tracking-design.md`

## The ask

From the client:

> Btw, in terms of tracking orders etc, this is the excel file the warehouse can send
> us to a spesific email daily, if we want to make sure that we can track delviery
> times etc. Can you see if this would work?

and, after a first answer:

> So we would need an spesific recieiver email that could be linked to the software,
> so we dont have to add it manually, but the system will be able to read the
> information automatically from the file

Two things, then: does the warehouse's standard daily report work, and can it arrive
by email rather than by hand.

The sample is `LTAS_Eod_Report_20260811.xlsx` - 34 parcel rows over 27 orders, one
day, Norway only. Columns: `Datum`, `Antal`, `Order`, `Namn`, `KolliID`,
`Sändningsref`, `Levsätt`, `Vikt`, `COD`, `COD ID`.

## What already exists

The delivery subsystem was built on 2026-08-06 and is complete but switched off.

| Piece | Where |
| --- | --- |
| `Shipment`, `ShipmentEvent`, `DeliveryPromise`, `TrackingImport` | `prisma/schema.prisma:462-567` |
| Bring tracking client | `src/lib/bring/client.ts` |
| Consignment mapper | `src/lib/bring/map.ts` |
| Poller with milestone tiers and deadline budget | `src/lib/bring/sync.ts` |
| File import and linking | `src/lib/bring/{import,parse,link}.ts` |
| Upload page | `src/app/delivery/`, `src/app/api/delivery/import/route.ts` |
| Median days, warehouse/transit split, on-time rate | `src/lib/delivery/stats.ts` |
| Slack late alerts | `src/lib/delivery/alerts.ts` |

Live state at the time of writing: 9 shops, **all** with `deliveryTrackingFrom = NULL`;
0 `Shipment` rows; 0 `TrackingImport` rows. `DeliveryConfig` holds working Bring
credentials and `lastSyncAt = 2026-08-12T05:46Z` with no error.

## What the 2026-08-06 design assumed, and why it was wrong

That design said the warehouse would send a file "pairing order number with tracking
number", and `parse.ts` was built on it: find the order numbers we already hold, take
the nearest tracking-shaped token.

**The `Order` column is not our order number.** It is the warehouse's own counter,
and it is also what they book with at Bring - the tracking payload carries it as
`senderReference`. It happens to occupy the same numeric range as Panetti Norway's
order numbers, which makes it the worst kind of wrong: every value matches a real
order, just not the right one.

Checked against live data, all 27 orders in the sample:

| Sample says | Our order with that number | Where that customer actually is |
| --- | --- | --- |
| `027286` JAPAN SUSHI AS | "Lene Jakobsen" | Mazzetti Norway #11844 |
| `027307` Sarah Linnea Voll | "Lars Martin Fauchald" | Panetti Norway #27399 |
| `027315` Tom Robin Wang | "Lars Birger Simonsen" | Mazzetti Norway #11869 |

**0 of 27 correct.** The offsets are not constant (92, 90, 95, 100…) because the
warehouse counts across both Panetti and Mazzetti in one sequence. `externalId` was
ruled out too: on Panetti Norway `number` and `externalId` are identical on every row.

Asking the warehouse to add a column was the obvious move and was rejected in review:
it makes us depend on a third party's report format forever, for data we can get
ourselves.

## The join that does work

Bring returns the recipient's email address on every parcel:

```
.consignmentSet[0].packageSet[0].recipientEmailAddress
```

`Order.customerEmail` already exists on every order. That is an exact key.

Measured against the sample, one Bring request per shipment number, matching
`customerEmail` case-insensitively within 30 days before dispatch:

```
exactly one order : 27/27
several orders    :  0
no order found    :  0
no email on parcel:  0
```

It separates Panetti from Mazzetti unaided, and it catches the business order
(`JAPAN SUSHI AS`) that a customer-name join misses entirely. For comparison, a
normalised name-plus-date-window join scored 25/27 with one miss and one ambiguity.

The consequence that shapes everything below: **the only thing we need from the
warehouse's file is long numbers.** Not columns, not headings, not their order number.

## Design

### Flow

1. The warehouse emails the report, unchanged, to a Postmark inbound address.
2. Postmark POSTs the message and its attachments to `/api/delivery/inbound`.
3. We extract every token of 15 or more digits from the attachment.
4. For each distinct number, one Bring lookup. The response yields the consignment id,
   every `packageNumber` in it, and `recipientEmailAddress`.
5. Match the email to an order. Write one `Shipment` per package, all pointing at that
   order.
6. `src/lib/bring/sync.ts` polls them from there. Nothing downstream changes.

Step 3 is deliberately dumb. Column order, headings, extra stores, a switch back to
PDF - none of it matters. Both `KolliID` and `Sändningsref` are valid Bring lookup
keys, so we do not need to know which column we grabbed.

The rule is precise: strip non-digits from each cell or whitespace-separated token,
keep what is 15 digits or longer. `KolliID` is 18 and `Sändningsref` is 17, so both
clear it. The threshold exists to sit above the two near misses in this file -
`COD`/`COD ID` are 6 digits, and `Datum` collapses to 14 (`20260811081924`) if a
reader hands us the whole cell as one string. `looksLikeTracking` in `parse.ts` is
deliberately not reused here: at 8-plus digits it would swallow that timestamp.

### Which number is stored

`mapConsignments` keys its results on `packageNumber` (`src/lib/bring/map.ts:102`).
So `Shipment.trackingNumber` must hold the **`KolliID`** (18 digits), never the
`Sändningsref` (17 digits). Storing the shipment reference would make every poll miss
its own record and stamp "Bring does not know this number yet" forever.

A consignment carries all of its packages, so a lookup by either number returns
everything needed. Numbers already accounted for by an earlier response are skipped.

Measured by running the committed parser over the sample file, that is **61 distinct
long numbers** - the 27 seventeen-digit `Sändningsref` values plus the 34 eighteen-digit
`KolliID` values - reducing to **27 Bring lookups** and **34 `Shipment` rows**, one per
package. The 61 is the figure to reason about when judging how long an import takes,
because it is what the parser hands to `resolveConsignments`; the 27 is what actually
leaves the building.

### Matching rule

For each consignment with a recipient email, find orders where:

- `customerEmail` equals it, case-insensitively
- the shop has `deliveryTrackingFrom` set
- `placedAt` is at or before the moment the file reached us, and within 30 days of it
- `voidedAt` is null

The upper bound is `TrackingImport.receivedAt`, **not** the file's `Datum` column.
Reading `Datum` would mean parsing their table again, which is the dependency this
design exists to remove. The report arrives the evening of dispatch, so receipt is a
few hours later than dispatch and strictly safer: the bound exists to stop a parcel
attaching to an order the same customer placed *after* it shipped, and a later bound
only widens the candidate set, which the exact-email match and the refusal rule below
already handle. On the sample this changes nothing - all 27 stay unique.

Exactly one match links. Zero or more than one is refused and recorded with its reason
in `TrackingImport.unmatched`, which the `/delivery` page already renders.

Refusing rather than taking the newest is deliberate, and follows the rule `link.ts`
already sets for ambiguous order numbers: a wrong link poisons that order's delivery
figure permanently and silently, while a refused one is visible on screen. On the
sample this costs nothing, because nothing is ambiguous.

`linkSource` gains a fifth value, `BRING_EMAIL`, alongside `FILE | NYCE | WOO | MANUAL`.

### Intake

New route `POST /api/delivery/inbound`:

- authenticated by a shared secret in the URL, compared with `timingSafeEqual`
- attachments limited to `.xlsx`, `.csv`, `.txt`, `.pdf` and a size cap
- every delivery recorded in `TrackingImport` with `source: 'EMAIL'`, parsed or not,
  so a morning where nothing arrives is visible rather than silent
- returns 200 to Postmark on anything it has already recorded, so a failure here never
  makes Postmark retry a file we have taken

`.xlsx` support is new. `parse.ts` accepts PDF, CSV and TXT today.

### Bug found while proving this out

`src/lib/bring/sync.ts:20` sets `BATCH = 10` and `fetchTracking` sends ten `q`
parameters in one request. **Bring does not honour more than one.** Measured: asking
for 10 returned 1 consignment, asking for 2 returned 0, asking for 1 returned the
right one every time across 27 numbers.

Nothing is broken today only because there are no shipments. On the day this is
switched on, 9 of every 10 parcels would take the `if (!found)` branch
(`sync.ts:150`), be stamped `lastError: 'Bring does not know this number yet'`, and be
pushed six hours out. No data loss, but tracking would crawl and the error field would
lie.

Fix: one number per request. The existing per-request deadline check already bounds a
run, so a large backlog degrades into "as many as fit" rather than a timeout.

### Switching on

`deliveryTrackingFrom` set for **Panetti Norway** and **Mazzetti Norway** only, since
this file is Norway-only. Sweden, Denmark, Germany and Finland stay off until we know
whether the warehouse reports on them. This is data, not code.

## Not building

No order-number parsing, no customer-name matching, no address matching, no column
mapping, no historical backfill, no change requested of the warehouse.

## Testing

- `parse.ts`: the real `.xlsx` as a fixture, asserting it yields the 34 package
  numbers and 27 shipment references.
- Matching: recorded Bring responses as fixtures, asserting 27 links and 0 unmatched.
  The 27-of-27 result becomes a regression test that fails loudly if either side drifts.
- Ambiguity: two orders sharing an email inside the window must refuse, not guess.
- Intake: wrong secret is rejected; a duplicate delivery does not double-link, because
  `Shipment.trackingNumber` is unique and the upsert adopts rather than rebuilds.
- `sync.ts`: one number per request.

**Fixtures must be anonymised.** The sample file and the Bring responses carry real
customer names, emails, phone numbers and home addresses. Nothing identifying goes
into the repository.

## Open question

Does the warehouse ship the Swedish, Danish, German and Finnish orders too? Panetti
Sweden did 200 and Panetti Denmark 126 in the last 30 days, and none appear in this
file. It does not block the build - the email join is shop-agnostic and would pick
them up the day their rows appear - but it decides which shops get switched on.
