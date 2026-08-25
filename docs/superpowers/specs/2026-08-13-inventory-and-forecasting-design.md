# Inventory and forecasting - design

Date: 2026-08-13
Status: approved shape, spec for review

## The ask

Philip, verbatim:

> I want to for example have the stock balance in Visma to be connected with our
> software, so it can do Demand Forecasting. The system already knows sales
> history, seasonality, country, campaign plans, current stock, supplier lead
> time, shipping time from China. Then it predicts "We will run out of PrimoMix
> in Germany on November 17." or "Order 620 units before August 25."
> No Excel. No guessing.

And, on a follow-up:

> Visma holds the purchase orders to suppliers with dates we ordered. We could
> add in the software ETA for each purchasing order. Production times vary a
> little bit even for the same products based on which time of the year and how
> busy the factory is. However we could add an estimated production time and
> delivery time for each product. We could also add how many units each Product
> fills for a 40HQ container, or like a MOQ. And we could connect our suppliers
> with the different products we sell.

## What already exists, measured

Every figure below was read from the live database or the live stores on
2026-08-13, not assumed.

| Thing | State |
|---|---|
| Sales history | 25,959 orders, 36,903 order lines, 2021-02-14 to 2026-08-13 |
| Products | 166 rows, 63 distinct SKUs, none blank |
| Stock | Already in WooCommerce. 31 of 35 German products and 48 of 55 Norwegian products have `manage_stock` on with a quantity |
| Country | On every order, `Order.shippingCountry` |
| Suppliers | Nothing. No model, no data |
| Lead times | Nothing |
| Campaign plans | Nothing. `AdCampaignSpend` is spend that already happened, not a plan |

Sales history per shop matters, because seasonality needs a year:

```
Mazzetti Norway   2021-02-14   2,344 orders
Panetti Norway    2023-09-20  15,919 orders
Panetti Sweden    2024-01-29   4,084 orders
Panetti Denmark   2024-03-07   1,908 orders
Panetti Finland   2024-05-29     769 orders
Mazzetti Sweden   2022-09-21     201 orders
Mazzetti Denmark  2025-01-23      77 orders
Mazzetti Finland  2025-10-15      53 orders
Panetti Germany   2025-09-16     604 orders   <- 11 months, no seasonal history
```

## Two assumptions in the ask that are wrong

**"Connect the stock balance in Visma."** Stock is already in WooCommerce and we
already hold the credentials. Visma would take weeks of ISV registration and two
Visma-side approvals to deliver a number we can read today. Visma is still worth
connecting, but for the purchasing side - purchase orders, measured lead times,
and what is already on the water - not for stock.

**"Run out of PrimoMix in Germany."** There is no German stock. Comparing the
same SKU across shops shows Denmark, Finland, Norway and Sweden carrying
*identical* quantities, which is one shared warehouse mirrored into each store:

```
PANPIZPRO      DK=1108  FI=1108  NO=1108  SE=1108   DE=247
PANPERPIZSHO   DK=1314  FI=1314  NO=1314  SE=1314   DE=1467
PANPRIMIXBLA   DK=906   FI=906   NO=906   SE=906    DE=939
```

So the forecast is **per physical product, across all shops**. The page still
shows which country is burning the stock, so "Germany is 10% of PrimoMix" is
answerable. Germany differing from the other four on 20 of 39 shared SKUs is a
real anomaly, surfaced by phase 1 rather than explained by this design.

## The SKU collision that must not be ignored

`Product` is shop-scoped (`@@unique([shopId, externalId])`), so one physical item
exists as up to nine rows. Purchasing facts - who makes it, how long it takes,
how many fit a container - belong to the object, not to a German listing. They
must therefore key on SKU. The codebase already sets this precedent:
`AmbassadorProduct` is keyed on SKU "because Product is shop-scoped and cascades
away with its shop".

But the SKU data is not clean. Six products share the SKU `0`, and they are not
the same product:

```
SKU "0"  ->  Panetti Pizzetta Primo    (Sweden, Finland, Denmark, Norway)
         ->  Mazzetti Advanced Comfort (Sweden, Norway)
```

Pooling those would average a pizza oven with a massage chair and recommend
ordering containers of a product that does not exist.

**Rule:** a SKU is unusable if it is blank or matches `/^0+$/`. Products with an
unusable SKU are excluded from the forecast and **listed on the page as needing a
SKU**. Never silently dropped - the same principle the delivery page already
applies to unlinked parcels.

## Navigation

One new sidebar item under Analytics, per Philip's instruction, because the
sidebar already carries 14 items across three sections and he does not want more.

```
Analytics   … Products · Inventory and forecasting  <- new, /inventory
```

`/inventory` shows a row of buttons and the Forecast beneath them:

```
[ Forecast ]  [ Stock ]  [ Purchase orders ]  [ Suppliers & lead times ]
```

Each button is a real route (`/inventory`, `/inventory/stock`,
`/inventory/purchase-orders`, `/inventory/suppliers`) so links are shareable and
the back button behaves. Forecast is the default view.

A concern was raised and overruled: putting configuration behind the same buttons
as the daily answer costs a click on the forecast every day. Philip chose one
tab; this design follows that choice.

## Phase 1 - Stock visibility

**Read.** `fetchCatalogPrices` in `src/lib/woo/client.ts` already pages through
`/wp-json/wc/v3/products` on every completed sync. Extend that one sweep to also
return `stock_quantity` and `manage_stock`. One request, two facts - no second
pass over the catalogue.

**Store.** Two new columns on `Product`:

```prisma
stockQuantity  Int?      // null = the store does not manage stock for this item
stockUpdatedAt DateTime?
```

**Agree.** For a SKU, gather `stockQuantity` from every shop's Product with that
SKU. The agreed figure is the **most common value**; a tie breaks to the row with
the newest `stockUpdatedAt`. If the values are not all equal the SKU is flagged
`disagrees`, with the per-shop numbers shown.

**Show.** `/inventory/stock` lists each SKU with its agreed quantity, a warning
where shops disagree, and the per-shop breakdown behind it.

Phase 1 is useful alone: it is what surfaced Germany carrying different numbers
from the other four.

## Phase 2 - Purchasing data and forecast

### Data model

```prisma
model Supplier {
  id        String   @id @default(cuid())
  name      String
  active    Boolean  @default(true)
  notes     String?
  createdAt DateTime @default(now())
  items     SupplyItem[]
}

/// One physical product we buy. Keyed on SKU, not on a Product id, because
/// Product is shop-scoped: the same item is up to nine rows, and a container
/// fill is a fact about the object, not about a German listing.
model SupplyItem {
  id                String   @id @default(cuid())
  sku               String   @unique
  name              String   // snapshot, for display when no Product is loaded
  supplierId        String?
  productionDays    Int?     // estimate. A purchase order's own ETA overrides it
  deliveryDays      Int?     // estimate
  unitsPerContainer Int?     // 40HQ fill
  moq               Int?
  coverDays         Int?     // how long an order should last; default 90
  active            Boolean  @default(true)
  createdAt         DateTime @default(now())

  supplier       Supplier?       @relation(fields: [supplierId], references: [id], onDelete: SetNull)
  purchaseOrders PurchaseOrder[]

  @@index([supplierId])
}

model PurchaseOrder {
  id           String    @id @default(cuid())
  supplyItemId String
  quantity     Int
  orderedAt    DateTime
  /// When it is expected to land. Entered by hand, because production time
  /// varies with the season and how busy the factory is - a per-product
  /// estimate cannot know that, but the person who placed the order can.
  eta          DateTime?
  /// Null = still on the water, so it still counts as incoming stock.
  receivedAt   DateTime?
  /// Visma's own purchase order id. Null on every hand-entered row. This is the
  /// seam phase 3 plugs into.
  externalId   String?
  notes        String?
  createdAt    DateTime @default(now())

  item SupplyItem @relation(fields: [supplyItemId], references: [id], onDelete: Cascade)

  @@index([supplyItemId, receivedAt])
}
```

`onDelete: SetNull` on the supplier link, not Cascade: removing a supplier must
unassign its products, never delete the purchase history that proves what was
ordered. Same rule `AdCampaign.shop` already follows.

### Where SupplyItem rows come from

Nobody types 63 SKUs. After each completed sync, any usable SKU present on a
`Product` that has no `SupplyItem` gets one created, with `name` taken from the
Product and every purchasing field left null. So the Suppliers page opens already
listing every product we sell, each saying what it still needs.

A `SupplyItem` is never deleted by the sync. A product the shops stop listing
keeps its purchasing history and its open orders; `active` is what hides it.

### The forecast

Per SupplyItem, across all shops, since it is one warehouse.

**Burn rate.** Units of that SKU sold per day over a trailing 60 days, summed
across every shop, excluding voided orders - a cancelled order never consumed
stock, so it is not demand. `VOIDED_STATUSES` from `src/lib/metrics/types.ts`
already names them.

**Seasonality.** For a future day D, a seasonal index scales the burn:

```
index(D) = units sold in the 28 days centred on D minus one year
           ------------------------------------------------------
           (units sold in the 365 days ending there) / 365 * 28
```

Clamped to [0.25, 4.0] so one freak week cannot dominate. Requires the SKU's own
first recorded sale to be at least 400 days ago - the SKU's history, not the
shop's, because a product added last month has no last year whatever the shop's
age. Below that, `index = 1.0` and the row is labelled **"no seasonal history
yet"** on the page. Panetti Germany has 11 months, so this label is not
hypothetical.

**Demand.** `demand(D) = burn * index(D)`

**Nothing selling.** A SKU with no sales in the trailing 60 days has a burn of
zero, so it never runs out and the row reads "not selling". It is sorted last,
never dropped - a product that stopped selling is worth seeing, and a zero here
must never be mistaken for a missing figure.

**Runs out.** Walk forward, at most 365 days:

```
stock = agreed stock
for each day D from today:
    stock += quantity of open purchase orders whose eta is D
    stock -= demand(D)
    if stock <= 0: runs out on D
```

Past 365 days with stock remaining, the row reads "no risk within a year".

An open purchase order with **no ETA** is deliberately left out of the walk. It
is still shown on the row as "N units on order, no ETA", because counting stock
whose arrival date nobody knows would push out a run-out date on a guess. The
label is the prompt to go and set the ETA.

**No stock figure at all.** If no shop reports a quantity for the SKU, the row
reads "no stock data" and produces no dates. It is not treated as zero - zero
means sold out and would raise a false alarm at the top of the list.

**Order by.** `runsOut - (productionDays + deliveryDays)`. If that date has
already passed, the row reads "order now, N days late". If either lead time is
unset, the row reads "set lead times" rather than showing a fabricated date.

**How many.**

```
cover   = coverDays ?? 90
horizon = productionDays + deliveryDays + cover
qty     = sum of demand over `horizon` days starting at runsOut
qty     = max(qty, moq ?? 0)
if unitsPerContainer: qty = ceil(qty / unitsPerContainer) * unitsPerContainer
```

MOQ is applied before the container rounding, so an order can only ever be
rounded up, never squeezed back below the minimum the supplier will accept.

### The pages

- **Forecast** (`/inventory`) - one row per SKU, soonest run-out first. Stock,
  run-out date, order-by date, quantity. Rows needing configuration say what is
  missing. A separate short list names products with an unusable SKU.
- **Stock** (`/inventory/stock`) - phase 1.
- **Purchase orders** (`/inventory/purchase-orders`) - add, edit, mark received.
- **Suppliers & lead times** (`/inventory/suppliers`) - suppliers, and per SKU:
  supplier, production days, delivery days, MOQ, units per container, cover days.

## Phase 3 - Visma purchase order import

`PurchaseOrder.externalId` is the whole seam. An importer creates and updates
rows from Visma instead of a person typing them, and everything downstream is
unchanged.

**Deliberately not specified further.** We have no Visma access yet, and the
registration path (developer portal, Visma approval of the API integration, then
customer approval via an invite-only App Store listing) has not started. Writing
endpoint-level detail now would be guessing at a response shape nobody has seen.
This phase gets its own spec once access exists.

Phases 1 and 2 must not wait for it.

## Not building

- **Campaign plans.** Nothing in any system holds a future campaign. Including
  them means someone hand-entering every planned campaign, which is the Excel
  the ask exists to remove. Revisit once the rest is trusted.
- **Per-country forecasting.** There is one warehouse. Country appears as a
  breakdown of burn, not as a separate stock pool.
- **Writing anything to WooCommerce or Visma.** Read only, both directions.

## Testing

- `extractStock` - a product with `manage_stock: false` yields null, not zero.
- Agreed stock - mode across shops; tie breaks to newest; disagreement flagged.
- Unusable SKU - blank and `"0"` and `"000"` are excluded and reported, and the
  Pizzetta Primo / Advanced Comfort pair never pools.
- Burn - voided orders excluded; a SKU sold in five shops sums across all five.
- Seasonal index - under 400 days of history returns exactly 1.0 and sets the
  flag; the clamp holds at both ends.
- Run-out walk - an incoming purchase order landing before the run-out date
  pushes the date out; one landing after it does not.
- A purchase order with no ETA never moves the run-out date, and is still
  reported on the row.
- A received purchase order is not counted as incoming a second time.
- Order-by in the past reads "order now, N days late" rather than a past date.
- Quantity - rounds up to MOQ, then up to a whole container, in that order. A
  container rounding can never drop the quantity back under the MOQ.
- A SKU with no lead times set produces no order-by date and no quantity, and
  says so.
- A SKU with no stock figure anywhere reads "no stock data" and is not treated
  as zero.
- A SKU with no sales in the window reads "not selling", sorts last, and is not
  dropped.
- SupplyItem creation - a new Product with a usable SKU gets a row; a second
  shop listing the same SKU does not create a duplicate; an unusable SKU gets
  none; and a Product disappearing never deletes an existing row.

## Open questions

1. **Is it one warehouse?** The stock data says yes. Philip has not confirmed in
   words. If he says separate stock per country, the aggregation changes but
   nothing else does.
2. **Why does Germany differ from the other four?** Phase 1 surfaces it; the
   cause is not this design's job.
3. **Default cover days.** 90 is assumed. Philip may want it per supplier.
