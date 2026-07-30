# Which products each ambassador got from us

Date: 2026-07-30
Status: approved (design confirmed in session: SKU identity, full gift ledger,
ambassadors see their own, edited inside the existing Edit modal).

## What the client asked

> For the ambassador, is it possible to also choose 1 or multiple products that
> which the ambassador got from us? So we can also see that on the ambassador
> tab, which product each ambassador owns? And then maybe an overview over how
> many ambassadors is linked to each of our products?

Three things: record what we sent someone, show it on the ambassadors tab, and
count ambassadors per product.

## The decision that shapes everything: what "a product" is

`Product` is **shop-scoped** (`@@unique([shopId, externalId])`) and discovered
from orders. The same physical item therefore exists as a separate row in every
shop that has ever sold it — the seed alone creates 6 catalogue items across 11
shops, so 66 rows describe 6 real products.

A gift is a fact about a physical object, not about a store's listing. So the
ledger keys on **`sku`**, the product identity across shops. The overview then
reads "4 ambassadors have the Advanced Comfort" — one honest number per real
product — instead of splitting that chair across eleven near-empty rows.

## Design

**One new table, additive only.**

```prisma
model AmbassadorProduct {
  id           String   @id @default(cuid())
  ambassadorId String
  sku          String   // product identity ACROSS shops
  name         String   // snapshot at gifting time
  quantity     Int      @default(1)
  receivedAt   DateTime
  note         String?
  createdAt    DateTime @default(now())

  ambassador Ambassador @relation(fields: [ambassadorId], references: [id], onDelete: Cascade)

  @@index([ambassadorId])
  @@index([sku])
}
```

`Ambassador` gains `products AmbassadorProduct[]`. Nothing else in the schema
changes, so `prisma db push` in the build script applies it without the
destructive-change flag.

Four choices worth naming:

- **`sku`, not a `productId` foreign key.** A `Product` row cascades away with
  its shop. A gift must not vanish because a store was removed — the same
  instinct that freezes ambassador attribution onto orders rather than
  recomputing it.
- **`name` is a snapshot**, exactly like `OrderItem.name`, so the ledger still
  reads correctly after a shop renames its listing.
- **`onDelete: Cascade` on the ambassador**, matching `AmbassadorCode`.
  Deleting an ambassador who has sold is already refused with a 409, so no
  history is at risk from this.
- **No unique constraint on `(ambassadorId, sku)`.** Two chairs sent on two
  dates are two rows. That is what a ledger is; collapsing them would lose the
  second date and the second note.

**Counting is a pure function.** The overview must count **distinct
ambassadors** per SKU — one person holding two of the same chair is one person,
not two. That subtlety lives in `src/lib/ambassador-products.ts`:

```ts
summariseProducts(rows) -> { sku, name, ambassadors, units }[]
```

Sorted by `ambassadors` descending, then `units`, then `name`, so the order is
total and the test is deterministic. It imports no Prisma and reads no request:
the same treatment every other calculation in this codebase gets.

**Two new route files, because the read paths already exist.**

| Route | Guard | Purpose |
|---|---|---|
| `GET /api/ambassador-products` | `assertStaff` | The overview **and** the picker catalogue, in one call |
| `POST /api/ambassador-products` | `assertStaff` | Add one gift |
| `DELETE /api/ambassador-products/[id]` | `assertStaff` | Remove one gift |

Two more reads need no route of their own; they extend responses the pages
already fetch:

- `GET /api/ambassadors` gains `products[]` on each ambassador, feeding both the
  roster chips and the Edit modal.
- `GET /api/portal` gains `products[]` for the session's own ambassador.

`assertStaff` matches `/api/ambassadors` exactly, so Marketing manages gifts —
they run the ambassador program. Every financial route keeps `assertAdmin`
untouched. The portal read takes its ambassador id **from the session, never
the request**, so there is no id for a caller to tamper with; that is the rule
`/api/portal` already states about itself.

**The picker catalogue.** Distinct `sku` and `name` from `Product`. A SKU sold
in several shops has several rows and therefore several candidate names, so the
tie is broken deterministically rather than by luck: rows are read
`orderBy: [{ name: 'asc' }]` and the first name seen for a SKU wins. `Product`
carries no `updatedAt`, so "most recent" is not available and is not invented.
Delivered by the same `GET` that returns the overview, so the ambassadors page
makes one request, not two.

## UI

**Roster** gains a `Products` column of chips (`Advanced Comfort ×1`) mirroring
the existing Codes column, with the date and note in the `title`, and `—` when
empty.

**Edit modal** gains a `Products` section directly under Codes, following that
section's established pattern to the letter: commission is a value you save,
while each product add and remove **acts the moment you press it**, because each
is its own request the server can refuse for its own reason. The add row reuses
the existing `SearchableSelect` for the product, plus quantity, date, and an
optional note.

**Overview card** sits between the statistics and the roster: Product · SKU ·
Ambassadors · Units.

**Portal** gains a read-only "Your products" card. Ambassadors see what they
were given; they can change nothing.

## Error handling

Zod validates the POST body and the first issue's message is returned, the
pattern every route here uses. `quantity` is an integer of at least 1,
`receivedAt` must parse as a date and is stored at UTC midnight via `utcDay`
(the convention every dated value in this codebase follows), `sku` and `name`
are required, and `note` is optional with a 200-character ceiling.

An unknown ambassador is a 404. DELETE uses `deleteMany` scoped by id and treats
`count === 0` as a 404 — the rule the codes route already follows, so a no-op is
never reported as success.

Portal and roster reads degrade honestly: an ambassador with no gifts shows an
empty state, never a missing card.

## Testing

- **Unit** — `summariseProducts`: distinct counting when one person holds two of
  a SKU, sorting, the empty case.
- **Route** — POST validation and creation, DELETE scoping and its 404,
  `assertStaff` returning 403 for an AMBASSADOR session, and the portal
  returning only the caller's own rows.
- **Component** — the modal's Products section and the roster chips.
- **End to end** (`e2e/ambassador-products.spec.ts`) — an admin adds a gift, the
  chip appears in the roster, the count appears in the overview, then that
  ambassador signs in and sees it read-only in their portal. One spec, the whole
  loop the client described.
- **Seed** — a few seeded ambassadors receive products, so the page is never
  empty on a fresh database and the e2e spec has something to find.

## Known limitation, accepted

Products are discovered from orders, so a product that has never sold in any
shop does not appear in the picker. With the current catalogue all selling, this
costs nothing today. A free-text fallback is deliberately not built: it would
let a typo create a SKU that matches no real product and quietly fragment the
overview. If gifting-before-first-sale becomes real, the fix is to seed the
catalogue from WooCommerce products rather than from order lines.
