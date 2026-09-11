# Label-name matching: parcels attach themselves to orders

Date: 2026-09-11. Status: approved by Philip ("go"), to be planned and built.
Follows `2026-09-10-parcel-identity-design.md` (phase 1, live as PR #130).

## The problem in one paragraph

The Delivery page section "Parcels without an order" lists 42 parcels. 38 of
them are DHL's. DHL's tracking answer carries the destination country, the
weight and the events, but never the recipient's name or email, so the page
falls back to showing every order in that country and asking a person to press
"Link to". That is manual work, and Philip did not understand the concept.
Meanwhile the warehouse's own daily file (`LTAS_EoD_Exp_Report_<date>_18-00.xlsx`)
carries the recipient's name on every row (column `Namn`), and the importer
throws it away by design: phase 1 read only the long numbers so the file's
layout could change without an outage.

## What was measured before designing (2026-09-11, live database, read only)

The recipient name Bring holds for a label is the same string the warehouse
prints in its file, because both come from the label the warehouse made from
the order. So the name Bring returns is a fair stand-in for the file's `Namn`.

| On 90 linked Bring parcels (linked by email, the ground truth)              | Result   |
| --------------------------------------------------------------------------- | -------- |
| Label name equals `Order.customerName` after folding case, accents, word order | 90 of 90 |
| Exactly one order in the 30 days before booking carries that name (no country filter) | 90 of 90 |
| Same, with the country filter and the "holds no other parcel" rule           | 90 of 90 |

The backlog: 28 DHL parcels to DE (16 to 19 kg ovens), 7 DHL Freight chairs of
154 kg (NO, FI, SE, DE), 3 parcels to TR of 36 kg from 21 Aug, one 480 kg
pallet to DE, and 4 Bring rows from 28 Aug that predate `unlinkedReason`.
Orders in the last 30 days with no parcel yet: DE 39 of 44, NO 199 of 671.

Not measured, because no real file is on this machine: the exact text in the
`Namn` column (case, "Last First" order, company names). The matcher folds
case, accents and word order, and every import reports how many names it
read, so a surprise on the first real file is visible, never silent.

## Goals

1. A parcel whose label names a customer attaches itself to that customer's
   order, for every carrier, with no person involved.
2. The rule never guesses: exactly one order or nothing, with the reason in
   words when it is nothing.
3. Nothing already linked, by a person or by an earlier rule, is ever moved.
4. Re-uploading an old warehouse file fills in the names of parcels already
   stored and links them, so the backlog clears with one upload per day's file.
5. The page section reads as "the few parcels that need a person", with one
   dropdown per parcel instead of a wall of buttons.

## Non-goals

- Reading the warehouse's `Order` column (their counter, wrong every time).
- Reading `Levsätt` to pick the carrier (the codes for DHL products are
  unknown; the poller identifies carriers within a day already).
- Reading `Vikt`, `Antal`, `Datum` (carriers give weight and booking time).
- Automating the DHL Freight portal export (no API is known for it).
- Fuzzy name matching (Levenshtein, initials). Folded-exact only.

## Design

### 1. A name key on orders

`Order.customerNameKey String?` with `@@index([customerNameKey, placedAt])`.

`nameKey(name)` in `src/lib/delivery/name-key.ts` (pure): Unicode NFD, strip
combining marks (the range U+0300 to U+036F, written as an escape in the
regex, never as literal characters), lower-case, replace every run of
characters outside `a-z0-9` with one space, split, sort the words, join with
one space. `nameKey('Röthke, Martin') === nameKey('martin ROTHKE') === 'martin rothke'`.
An empty or whitespace name gives `''`.

Same tri-state as `customerName`: null = not computed yet, `''` = computed,
nothing there. Written wherever `customerName` is written: `mapOrder` in
`src/lib/woo/map.ts`, `backfillCustomers` in `src/lib/woo/sync.ts` (from the
final name it writes), `src/lib/visma/import.ts`, and the B2B order form's
create path. A backfill in the 15-minute sync tick (`/api/cron/sync`, before
the parcel poll) computes the key for rows where it is null and `customerName`
is not null, newest first, up to 5,000 rows per tick, written as one
`UPDATE ... FROM unnest(...)` statement per batch of 1,000 so a tick spends
seconds, not minutes. No Woo call is made. Once history is filled it costs one
cheap query per tick.

### 2. The label reader

`src/lib/bring/labels.ts`, `readLabels(buf: Buffer, filename: string): Labels | null`
where `Labels = { names: Map<string, string>; rows: number }`.

- Only `.xlsx` is read (the warehouse sends nothing else); other extensions
  return null.
- Uses `xlsxToRows` from `src/lib/dhl/sheet.ts` (rows keyed by header).
- The name column is the header whose folded form (`nameKey` of the header)
  is `namn`. Other headers are ignored. If no such header exists, or the
  sheet has no rows, return null.
- For each row with a non-empty name: every cell in the row whose digits
  number 15 or more (the same `MIN_DIGITS` rule as `extractLongNumbers`) maps
  its digit string to the trimmed name. So the KolliID (18 digits) and the
  Sändningsref (17 digits) both find the name, and no column heading beyond
  `Namn` is depended on. `rows` counts rows that contributed a name.
- Never throws for a layout surprise: an unreadable archive returns null
  (the number path will throw its own user-facing error).

### 3. The name matcher

`matchByName(name, receivedAt, scope)` in `src/lib/bring/match.ts`, beside
`matchByEmail`, returning the same `MatchOutcome`.

`scope: MatchScope & { country?: string | null }`.

- `nameKey(name)` empty: `{ orderId: null, reason: 'The label carries no name' }`.
- Candidates: `customerNameKey` equals the key; shop is delivery-tracked;
  `placedAt` within `MATCH_WINDOW_DAYS` before `scope.bookedAt ?? receivedAt`;
  `voidedAt` null; NOT holding a parcel from another consignment (the same
  `heldByAnother` clause as the email match); and, only when `scope.country`
  is given, `shippingCountry` equals it case-insensitively.
- Exactly one: `{ orderId }`.
- None: `The label says ${name} and no order in the last 30 days has that name`
  (with ` in ${country}` appended when the country was applied).
- Two or more: `The label says ${name} and ${count} orders in the last 30 days
  have that name: ${numbers}`, with the same `CANDIDATES_NAMED` cap and "and
  others" wording as the email match.

The email match stays first wherever both are possible. The name is tried
only when the email match returned no order. When both fail, the reason kept
is the email's when Bring gave an email, else the name's. A row with neither
keeps the carrier-specific reason (see 6).

### 4. One place that attaches a row

`src/lib/delivery/attach.ts`:

```ts
export type AttachRow = {
  id: string; trackingNumber: string; orderId: string | null
  recipientEmail: string | null; recipientName: string | null
  bookedAt: Date | null; createdAt: Date
  consignmentId: string | null; destinationCountry: string | null
  dismissedAt: Date | null
}
export async function decideAttach(row: AttachRow): Promise<AttachDecision>
export async function attach(row: AttachRow): Promise<AttachResult>
export async function sweepUnlinked(now: Date): Promise<{ tried: number; linked: number }>
```

Where `AttachResult` is `{ linked: true; source } | { linked: false; source:
null; reason: string | null }`.

`attach` does nothing when `row.orderId` is not null or `row.dismissedAt` is
not null: a dismissed row is never attached by any path, whatever the
matching rules would otherwise decide. Otherwise email match (when
`recipientEmail`), then name match (when `recipientName`), country from the
row, with the upper bound taken from `row.bookedAt ?? row.createdAt`; on
success writes `orderId`, `linkSource` (`BRING_EMAIL` or `FILE_NAME`) and
`unlinkedReason: null`; on failure writes the reason chosen by rule 3, but
never overwrites an existing reason with `null`.

`sweepUnlinked`: up to 50 rows with `orderId null`, `dismissedAt null`,
`recipientEmail` or `recipientName` not null, `updatedAt` older than one hour,
oldest `updatedAt` first; calls `attach` on each. Because every attempt
rewrites the reason (and so `updatedAt`), a row is retried at most hourly and a
large backlog is spread over ticks. Called once per parcel-poll run at the
start of `syncShipments`, before the due rows are read, so a freshly linked
row polls as a linked one. It replaces `rematchByEmail`, which is deleted
along with its call in the ordinary-poll branch.

### 5. Importer changes (`importWarehouseFile`, Bring branch only)

- `const labels = readLabels(buf, filename)` right after `parseTrackingNumbers`.
- Resolved consignments: `facts.recipientName = c.recipientName ?? nameFor(c)`
  where `nameFor` looks up each package number, then the consignment id, in
  `labels.names`. The email match runs as today; when it returns no order,
  `matchByName` runs with `country: c.destinationCountry`. A name link writes
  `linkSource: 'FILE_NAME'`. The refused-row bookkeeping is unchanged except
  that the reason follows rule 3.
- Unresolved Bring-shaped numbers (stored UNKNOWN): the upsert's `create`
  carries `recipientName` from the labels; after the upsert an
  `updateMany({ where: { trackingNumber, recipientName: null }, data: { recipientName } })`
  fills a row that had none (a carrier's name, when one exists, is never
  overwritten by the file's). Then, if the row is still unlinked, `attach` is
  called on it with no country. This is what makes a re-upload link the
  backlog: the numbers are already rows, the file now gives them names.
- A number that the name links this way counts in `linked` and is NOT an
  unmatched row; a named row that could not be linked keeps its existing
  unmatched line with the name reason appended after " - ".
- `TrackingImport.namesRead Int?`: `labels ? labels.rows : 0` for this path;
  the DHL-export path and the old order-number path write null.
- `ImportResult.namesRead: number | null` likewise.

### 6. Poller changes (`src/lib/delivery/identify.ts`, `sync.ts`)

- `IdentifyRow` gains `recipientName: string | null` and the sync selects it.
- `applyIdentification` writes `recipientName: facts.recipientName ?? row.recipientName`
  so DHL (which returns null) never wipes the file's name.
- Linking inside `applyIdentification`, for a row with no order: Bring means
  email, then name with `facts.destinationCountry`. DHL means `DHL_REF` as
  today; when that yields no order, name with the country; when it yields two
  or more orders the "a person must choose" reason stays and the name is not
  tried.
- The DHL reason when there is no name becomes: `DHL parcel to ${country}: DHL
  gives no name or email, and no warehouse file has named this parcel yet.
  Upload the file for its day and it will match itself.`
- The ordinary-poll re-match call is removed (the sweep in 4 covers it).

### 7. Candidates for the dropdown (`src/lib/delivery/candidates.ts`)

`Candidate` gains `sameName: boolean`. When the row has a `recipientName`,
orders in the window whose `customerNameKey` equals its key (tracked shops,
not voided, any country) are fetched and listed FIRST with `sameName: true`;
the rest are the existing email-or-country set, minus any already listed.
`CANDIDATE_LIMIT` becomes 30 (a dropdown holds it; six buttons did not).
`total` stays the count of the whole set before the cap.

### 8. The page section

Title: "Parcels that need a person (N)". Subtitle: "Parcels are matched to
orders by the customer's email or by the name on the label, automatically.
These are the ones no rule could place, each with the reason."

Per parcel, one table row: parcel number (link when there is one), carrier,
to, booked, weight, last status, the name on the label (or "no name yet"),
and the reason. Below it one control line:

- `<select aria-label="Order">`: first option "Choose the order", then each
  candidate as `${number} · ${customerName} · ${date} · ${items}`, with
  " · same name as the label" appended for `sameName` and " · already has a
  parcel" for `holdsParcel`. The same-name ones come first.
- "Link" (disabled until an order is chosen; busy guard as today).
- "Not a customer parcel" (dismiss, as today).
- "Other order" link that reveals the shop select and order-number input
  with their own "Link", exactly today's typed path, hidden by default.
- "and N more" is dropped; candidates beyond the cap are shown as a last,
  disabled option "N more, use Other order".

The `id="unattached"` anchor and the API contract stay; the `UnlinkedParcel`
type gains nothing (recipientName is already sent). The "Recent imports" list
shows `namesRead` after the linked count as "N names" and, when it is 0,
"no names read from this file" in the warning colour; null shows nothing.

### 9. Docs

`docs/delivery-tracking-guide.md`: the section paragraph is rewritten in the
new words, and a short "Re-reading old files" note says that uploading a
day's warehouse file again is safe and fills in names.

## Error handling

- A file with no `Namn` header: `namesRead 0`, everything else as today.
- A name that folds to nothing (a row of punctuation): treated as no name.
- Two rows in one file with the same number and different names: the last
  wins in the map; the number is still one parcel and Bring's own name, when
  it has one, wins anyway.
- The name matcher's database read failing inside the import is caught by the
  existing guarded block and recorded on the `TrackingImport` row.
- The sweep catches per-row errors and continues; its counts are returned in
  `ShipmentSyncResult` as `swept` and `sweptLinked`.

## Testing

- `name-key.test.ts`: case, accents (ø, ä, ü, é), word order, punctuation,
  empty, digits kept.
- `labels.test.ts`: an xlsx built with `zipSync` (the `dhl/parse.test.ts`
  pattern) with `Datum, Antal, Order, Namn, KolliID, Sändningsref, Levsätt,
  Vikt`: names found by KolliID and by Sändningsref; a header spelt `NAMN`;
  no `Namn` header gives null; a row with an empty name contributes nothing;
  a csv returns null.
- `match.integration.test.ts`: name unique links; two orders same name
  refused naming both; none refused; country mismatch excluded; order
  holding another consignment's parcel excluded; the second box of the same
  consignment still matches; accents and order folded.
- `attach.integration.test.ts`: email first, name second, reason choice,
  never moves a linked row, sweep retries only rows older than an hour and
  at most 50.
- `identify.integration.test.ts`: DHL facts with a file name on the row give
  a `FILE_NAME` link and the name is kept; DHL_REF ambiguity keeps its
  reason; Bring email failure falls through to name.
- `import.integration.test.ts`: a file naming an already-stored UNKNOWN row
  fills its name and links it (`FILE_NAME`), `namesRead` recorded; Bring's
  name wins over the file's; a file with no `Namn` header still links by
  email and records `namesRead 0`; a resolved consignment whose email matches
  nothing links by name.
- `candidates.integration.test.ts`: same-name candidates first with the flag.
- Backfill test: keys computed newest first, `''` for an empty name, rows
  already keyed untouched.
- `e2e/delivery-link-by-hand.spec.ts`: updated for the dropdown (select by the
  order's value, then Link); a second scenario asserts a same-name option is
  listed first.
- The app and delivery vitest projects green; eslint; `next build` in the
  primary checkout after merge (worktree builds fail on a Turbopack symlink).

## Rollout

1. Merge; production `db-push` adds the two columns and the index.
2. The first sync ticks backfill `customerNameKey` (newest first, so the
   30-day window is keyed within the first tick).
3. Philip uploads the warehouse files for 21 Aug to 10 Sept again on the
   Delivery page. Each fills in names and links; the import line shows
   "N names".
4. What remains listed needs a person by nature: the 3 parcels to TR and the
   480 kg pallet are dismissed or linked by hand.
