# Visma purchase order import - design

Date: 2026-08-14
Status: approved shape, spec for review

## The ask

Philip, on the forecasting feature:

> We could add in the software ETA (Estimated time of arrival) for each
> purchasing order.

Visma already stores it. Every purchase order carries `promisedOn`, and every
line carries its own `promised` date. Nobody needs to type anything - we read
what the ERP already knows, along with how much of each order has actually
arrived.

This is phase 3 of `2026-08-13-inventory-and-forecasting-design.md`, which
deliberately left it unspecified because no Visma access existed at the time.
Access now exists.

## What was verified, not assumed

Measured against the live company on 2026-08-14.

**The connection.** Read-only, approved by the tenant, working:

- token: `POST https://connect.visma.com/connect/token`, `client_credentials`,
  `scope=vismanet_erp_service_api:read`, `tenant_id` as a parameter
- **requests go to `https://integration.visma.net/API`**, path shape
  `controller/api/v1/<resource>`
- the Developer Portal's stated "API Base URL" (`api.finance.visma.net/erp/service`)
  is the token's *audience*, NOT a request host. Every path under it 404s. This
  cost several rounds of guessing and is recorded so nobody repeats it.
- no `ipp-company-id` header needed; the company rides in the token
- tokens last 3600s

**The join works.** All **38 of 38** of our usable SKUs exist in Visma as
`inventoryNumber`. A purchase order line names the product directly, so no
mapping table is needed and no fuzzy matching is involved.

Visma holds 480 items across Cosori, Levoit, Mazzetti, Delicious and Panetti;
412 are stocked. Ours are a clean subset.

**A purchase order carries everything required:**

```
orderNbr    500000              supplier   Jieyang Qingzhan (China)
status      Cancelled           currency   USD
date        2022-11-15          promisedOn 2022-11-15
lines[]
  lineNbr         1
  inventory.number  1298        warehouse  Oslo Lagerhotell
  orderQty        800           qtyOnReceipts  0
  promised        2022-11-15    canceled   true
```

## What already exists

- `PurchaseOrder` with `externalId`, documented as "the single seam the Visma
  import plugs into". It has no unique constraint - this design adds one.
- `/inventory/purchase-orders`, currently listing hand-entered orders only.
- `loadInventory` already treats open purchase orders (`receivedAt: null`) as
  incoming stock and walks their ETAs forward. The forecast itself needs no
  change; `load.ts:143`, which turns a purchase order into an arrival, needs a
  one-line change explained under **Quantities** below.

## Design

### Scope

**Purchase orders only.** Stock stays on WooCommerce.

Visma stock is genuinely better - one authoritative figure rather than nine
mirrors that drift - and the fields exist (`quantityOnHand`, `available`,
`availableForShipment` on stocked items). But swapping the source changes what
`agreeStock` means and carries its own risk. Recorded here so the follow-up is
short; not built now.

### Units

`src/lib/visma/client.ts` - get a token, make a GET. One dependency on the
outside world, one caller, mirroring how `src/lib/woo/client.ts` is arranged.
Caches the token in memory for its lifetime rather than fetching one per request.

`src/lib/visma/purchase-orders.ts` - turn Visma orders into our rows. Pure
mapping, no database and no network, so the arithmetic that decides what counts
as incoming is tested against recorded fixtures. It takes the receipt dates as a
plain `Map<string, Date>` argument rather than fetching them, which is what keeps
it pure.

`src/lib/visma/import.ts` - the database side. Two GETs, not one: purchase orders
and purchase receipts. The receipts exist only to date the completed orders, and
both are single bounded requests, so fetching them together costs one extra call
per sync.

### Schema changes

Two, both additive, neither destructive to existing rows:

```prisma
externalId        String?  @unique   // was: no constraint
receivedQuantity  Int?               // new
```

Every existing row has `externalId: null`, and Postgres permits many nulls in a
unique index, so the constraint applies cleanly to hand-entered data.

### Mapping

One Visma order line becomes one `PurchaseOrder` row.

| Ours | From Visma |
|---|---|
| `externalId` | `` `${orderNbr}-${lineNbr}` `` |
| `supplyItemId` | looked up by `sku = line.inventory.number` |
| `orderedAt` | order `date` |
| `eta` | line `promised`, falling back to order `promisedOn`, else null |
| `quantity` | `orderQty` - what was ordered, always |
| `receivedQuantity` | `qtyOnReceipts` - new nullable column |
| `receivedAt` | the joined receipt date, once `line.completed` (see below) |

### Quantities

This is the decision the whole import turns on.

Units already received are **already in the stock figure** that WooCommerce
reports. Counting the full `orderQty` as incoming would count them twice: once
on the shelf, once on the water. The forecast would then believe more stock is
coming than really is, and tell Philip to order too little - the exact failure
this feature exists to prevent, arrived at by a different route.

The obvious fix is to import `orderQty − qtyOnReceipts` into the existing
`quantity` column and change nothing else. **Do not do that.** It makes one
column mean two things - outstanding on an open row, zero on a fully received one
- so a completed 800-unit order would be stored as `quantity: 0` and the page
could never show what actually landed.

Instead, store both numbers as themselves and add one nullable column:

```prisma
quantity          Int   // ordered
receivedQuantity  Int?  // null on hand-entered rows, which track no receipts
```

Outstanding is then derived where it is needed, in the one place that already
turns a purchase order into an arrival (`src/lib/inventory/load.ts:143`):

```ts
quantity: Math.max(0, o.quantity - (o.receivedQuantity ?? 0))
```

`Math.max` because an over-receipt in Visma - more delivered than ordered - must
not subtract from other orders' incoming stock.

A hand-entered row has `receivedQuantity: null`, so it falls back to `o.quantity`
and behaves exactly as it does today. Nothing that exists changes meaning.

### When an order counts as received - measured, not assumed

This section originally said to stamp `receivedAt` once
`qtyOnReceipts >= orderQty`, and to fall back to `lastModifiedDateTime` for the
date. **Both were wrong.** Probing the live company on 2026-08-14 settled it, and
the numbers are worth keeping because each one killed a plausible design.

**Quantity is not the completion test.** 719 lines across 227 orders:

| status | `completed` | receipts vs ordered | lines |
|---|---|---|---|
| Closed | `true` | received ≥ ordered | 613 |
| Closed | `true` | **received < ordered** | **59** |
| Cancelled | `true` | received < ordered | 7 |
| Open | `false` | received < ordered | 37 |
| Hold | `false` | received < ordered | 3 |

Those 59 are the problem. Order 500148 is `Closed`, `openQuantity: 0`, every line
`completed: true` - and `qtyOnReceipts: 0`, with no receipt anywhere in the
company referencing it. It was closed without goods passing through the receipt
mechanism. A quantity test reads that as "17 units still coming", forever, with
an ETA in 2024. Confirmed against the detail endpoint, so it is the data and not
a lossy list response.

**`line.completed` is the test.** It is `true` on every Closed and Cancelled
line and `false` on every Open and Hold line, with no exceptions in 719 rows.
Cancellation is checked first, since cancelled lines also carry `completed: true`.

**The date comes from the receipt, joined.** Orders carry
`purchaseReceipts[].receiptNumber`; `controller/api/v1/purchasereceipt` carries
`receiptNbr` and a real `date`. **195 of 195 references resolved, none missing.**

**`lastModifiedDateTime` would have been badly wrong.** Orders 500023, 500024 and
500025 have a receipt date of `2023-11-14` and a last-modified of `2026-07-29` -
out by nearly three years. The original fallback would have reported goods as
arriving in 2026 that landed in 2023.

So:

1. A completed line takes the date of the order's latest resolved receipt.
2. Seven Closed orders have no receipt at all. They fall back to
   `lastModifiedDateTime`, and the page labels that column **"recorded"** rather
   than "received", because it is when the record last changed and nothing more.
3. Never the clock.

The arithmetic is unaffected either way: `receivedAt` being non-null takes the
row out of the incoming set before any subtraction happens.

### What is skipped, and loudly

- **Cancelled orders** - `status === 'Cancelled'`, or a line with `canceled: true`.
- **Orders on hold** - `status === 'Hold'`. Two exist, for 1288 and 2644 units,
  neither released to the supplier. An order nobody has actually placed must not
  move a run-out date, for the same reason an order with no ETA does not: it
  would push the date out on something that may never be ordered.
- **Lines for products we do not sell** - Cosori, Levoit and the rest. Matched by
  SKU against `SupplyItem`; no match means not ours. This is the large one:
  653 of 719 lines belong to the other brands sharing the ERP.
- **Completed orders** are imported rather than dropped, so the page can show
  what landed. They contribute no incoming stock either way.

Each import records how many lines it read, imported, and skipped **with the
reason**. A line silently ignored because its SKU did not match is
indistinguishable from a line that did not exist, and that is precisely how a
missing purchase order goes unnoticed.

### Idempotency

`externalId` becomes `@unique`, and the import upserts on it. Re-running changes
nothing that has not changed in Visma. This matters because the import runs on a
schedule and a purchase order's quantities move as goods arrive.

**Hand-entered rows are never touched.** Only rows whose `externalId` is non-null
belong to the import; a row someone typed has `externalId: null` and is invisible
to it.

### Trigger

Extend the existing cron. Two bounded API calls, and purchase orders change
slowly - 227 orders and 208 receipts in the whole company's history, so both fit
in a single page each with room to spare.

A failure must not fail the wider sync - same rule the WooCommerce catalogue
refresh already follows. It records the error and the next run retries.

### The page

`/inventory/purchase-orders` gains a source column: rows with an `externalId`
read "Visma", the rest "added here". Someone looking at a wrong number needs to
know whether to fix it in Visma or in this app, and that distinction is invisible
today.

A partially received order shows all three numbers rather than one - `800
ordered · 300 landed · 500 still coming` - because "500" alone invites the
question of what happened to the other 300, and the honest answer is already in
the row. Rows with `receivedQuantity: null` show only the quantity, as now.

The "Mark received" button is hidden on Visma rows - receipt is Visma's fact, and
letting someone overwrite it here would produce two answers to one question.

### Configuration

Three values, all from the environment, none in code:

```
VISMA_CLIENT_ID       isv_panetti_inventory_forecast
VISMA_TENANT_ID       83949a19-af32-11ec-b60b-0638767d04b5
VISMA_CLIENT_SECRET   (Vercel env var; never committed, never in chat)
```

Absent credentials mean the import is skipped quietly, exactly as
`ensureWebhooks` skips when no `APP_URL` exists. A missing integration is not an
error.

## Not building

- **Stock from Visma.** Deferred, field names recorded above.
- **Writing anything to Visma.** The token only holds `read`; there is no path.
- **Supplier import.** Visma has supplier records, but suppliers here carry
  lead times someone maintains by hand. Overwriting those with ERP contact data
  would lose the only part that matters to the forecast.

## Testing

Six real orders are recorded as fixtures in `src/lib/visma/__fixtures__/`, one
per shape the mapper has to get right, with costs and supplier details stripped:
open with our products (500254), open with a single large Panetti line (500259),
closed with a receipt (500017), **closed with no receipt and zero
`qtyOnReceipts`** (500148), cancelled (500000) and on hold (500235). The fourth
is the one that matters - it is the case that breaks a quantity-based test.

- Mapping is pure, so most of it needs no database:
  - 800 ordered with 300 received stores `quantity: 800`, `receivedQuantity: 300`
  - **order 500148 is not incoming.** Closed, `completed: true`, `qtyOnReceipts:
    0` - it must come back with `receivedAt` set, or 47 units of 2024 stock
    haunt the forecast forever
  - a cancelled order, a cancelled line and an order on hold are all skipped,
    each counted under its own reason
  - a line for a SKU we do not stock is skipped, and counted with its reason
  - line `promised` wins over order `promisedOn`; absent both, `eta` is null,
    which the forecast already treats as "moves no date"
  - a completed line with a resolvable receipt takes the receipt's date; one
    without falls back to `lastModifiedDateTime`
- Arithmetic, at `load.ts`, which is where a mistake would silently move a
  run-out date:
  - that same order contributes **500** incoming units, not 800 and not 300
  - a fully received order contributes 0
  - an over-receipt (900 landed against 800 ordered) contributes 0, never −100
  - a hand-entered row (`receivedQuantity: null`) contributes its full quantity,
    exactly as it does today - this is the regression test for the new column
- Import: re-running twice changes nothing; a hand-entered row (`externalId:
  null`) survives an import untouched.
- Client: a failed token request does not throw into the caller's sync.
- No credentials configured means the import is skipped, not failed.

## Open questions

1. ~~**How far back?**~~ **Settled.** The company holds 227 purchase orders and
   208 receipts in total, so both fetch in one page each and the import reads
   everything. No date filter, no paging. The import reports a full page rather
   than trusting it, so if the company ever outgrows that it says so instead of
   silently dropping orders.
2. **Multiple warehouses.** Lines carry a warehouse ("Oslo Lagerhotell"). We treat
   stock as one pool, so warehouse is imported for display and ignored by the
   forecast. Worth confirming with Philip that there is one physical warehouse.
3. **Supplier country data is wrong in Visma** - the Chinese factory on order
   500000 is recorded as `CH - SWITZERLAND`. Not ours to fix, but it would
   corrupt any country-based supplier reporting.
