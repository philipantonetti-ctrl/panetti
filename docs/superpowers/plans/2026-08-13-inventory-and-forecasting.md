# Inventory and Forecasting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One "Inventory and forecasting" section that reads stock from the webshops, flags where shops disagree, and says for each product when it runs out, when to order, and how many.

**Architecture:** Pure functions first, database second, pages last. The SKU rule, the stock agreement, the burn rate and the forecast walk are all pure and unit-tested with no database. A thin loader assembles them from Prisma, one API route serves them, and the pages render. Stock arrives on the sweep of `/products` the sync already performs, so it costs no extra request.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Prisma 6 + PostgreSQL, Vitest 4, Tailwind.

## Global Constraints

- **Money and counts are integers.** Stock and quantities are whole units. No floats stored.
- **A SKU is unusable if blank or matching `/^0+$/`.** Six real products currently share `"0"` and span two different physical products. Unusable SKUs are excluded from forecasting and **named on the page**, never silently dropped.
- **One warehouse.** Forecast per SKU across all shops. Country is a breakdown of burn, never a separate stock pool.
- **Read only, both directions.** Nothing writes to WooCommerce or Visma.
- **Voided orders are not demand.** `VOIDED_STATUSES` is `['refunded', 'cancelled', 'failed', 'trash']` from `src/lib/metrics/types.ts`.
- **Null is not zero.** A missing stock figure reads "no stock data" and produces no dates. Zero means sold out.
- **Test placement.** Pure unit tests are `src/lib/inventory/*.test.ts` and run in the `app` vitest project. Any test touching the database MUST use SKUs unique to that test (e.g. `TEST-BURN-${Date.now()}`), because the `app` project runs in parallel. **Do not add patterns to `vitest.config.ts`** — its three projects partition the suite exactly and the file says so.
- **Default cover days is 90.** Constant `DEFAULT_COVER_DAYS`.
- **Forecast horizon is 365 days.** Constant `HORIZON_DAYS`.

---

## File Structure

**Created:**
- `src/lib/inventory/sku.ts` — what counts as a usable SKU
- `src/lib/inventory/stock.ts` — agree one stock figure across shops
- `src/lib/inventory/burn.ts` — sales rate and seasonal index
- `src/lib/inventory/forecast.ts` — the run-out walk, order-by date, quantity
- `src/lib/inventory/supply-items.ts` — create a SupplyItem per usable SKU
- `src/lib/inventory/load.ts` — assemble the above from Prisma
- `src/app/api/inventory/route.ts` — GET the forecast and stock
- `src/app/api/inventory/suppliers/route.ts` — supplier CRUD
- `src/app/api/inventory/items/route.ts` — per-SKU purchasing settings
- `src/app/api/inventory/purchase-orders/route.ts` — purchase order CRUD
- `src/app/inventory/InventoryTabs.tsx` — the button bar, rendered by all four pages
- `src/app/inventory/page.tsx` + `InventoryClient.tsx` — Forecast
- `src/app/inventory/stock/page.tsx` + `StockClient.tsx`
- `src/app/inventory/purchase-orders/page.tsx` + `PurchaseOrdersClient.tsx`
- `src/app/inventory/suppliers/page.tsx` + `SuppliersClient.tsx`

**Modified:**
- `prisma/schema.prisma` — stock columns on Product; Supplier, SupplyItem, PurchaseOrder
- `src/lib/woo/client.ts:335-356` — `fetchCatalogPrices` becomes `fetchCatalog`
- `src/lib/woo/sync.ts:644-660` — store stock alongside catalog price
- `src/components/shell/AppShell.tsx:105-115` — one new nav item after Products

---

### Task 1: The usable-SKU rule

**Files:**
- Create: `src/lib/inventory/sku.ts`
- Test: `src/lib/inventory/sku.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `normaliseSku(raw: string): string`, `isUsableSku(raw: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/sku.test.ts
import { describe, expect, it } from 'vitest'
import { isUsableSku, normaliseSku } from './sku'

describe('normaliseSku', () => {
  it('trims and uppercases so one product is one key', () => {
    expect(normaliseSku(' panpizpro ')).toBe('PANPIZPRO')
  })
})

describe('isUsableSku', () => {
  it('accepts a real SKU', () => expect(isUsableSku('PANPIZPRO')).toBe(true))
  it('rejects blank', () => expect(isUsableSku('   ')).toBe(false))

  it('rejects "0", which six live products share across two different items', () => {
    // Panetti Pizzetta Primo and Mazzetti Advanced Comfort both carry SKU "0".
    // Pooling them would average a pizza oven with a massage chair and
    // recommend containers of a product that does not exist.
    expect(isUsableSku('0')).toBe(false)
    expect(isUsableSku('000')).toBe(false)
  })

  it('does not reject a real SKU that merely contains zeros', () => {
    expect(isUsableSku('PPP-DC-001')).toBe(true)
    expect(isUsableSku('0A')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/sku.test.ts`
Expected: FAIL — "Failed to resolve import ./sku"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/inventory/sku.ts

/**
 * One product is one SKU, trimmed and uppercased.
 *
 * `Product` is shop-scoped, so the same physical item is up to nine rows. Every
 * purchasing fact — who makes it, how long it takes, how many fit a container —
 * belongs to the object rather than to a German listing, so SKU is the key.
 * `AmbassadorProduct` already keys on SKU for the same reason.
 */
export function normaliseSku(raw: string): string {
  return raw.trim().toUpperCase()
}

/**
 * False for a SKU that cannot identify a product.
 *
 * Blank is obvious. All-zeros is not: six live products carry the SKU "0", and
 * they are not one product — the set spans Panetti Pizzetta Primo AND Mazzetti
 * Advanced Comfort. Treating that as a key would pool a pizza oven's sales with
 * a massage chair's and order containers of the average. Such products are
 * excluded from the forecast and named on the page, never silently merged.
 */
export function isUsableSku(raw: string): boolean {
  const sku = normaliseSku(raw)
  if (sku.length === 0) return false
  return !/^0+$/.test(sku)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/sku.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/sku.ts src/lib/inventory/sku.test.ts
git commit -m "feat(inventory): a SKU of zero is not a SKU"
```

---

### Task 2: Agree one stock figure across shops

**Files:**
- Create: `src/lib/inventory/stock.ts`
- Test: `src/lib/inventory/stock.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type ShopStock = { shopName: string; quantity: number | null; updatedAt: Date | null }`
  - `type AgreedStock = { quantity: number | null; disagrees: boolean; byShop: ShopStock[] }`
  - `agreeStock(rows: ShopStock[]): AgreedStock`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/stock.test.ts
import { describe, expect, it } from 'vitest'
import { agreeStock, type ShopStock } from './stock'

const s = (shopName: string, quantity: number | null, updatedAt = new Date('2026-08-13')): ShopStock =>
  ({ shopName, quantity, updatedAt })

describe('agreeStock', () => {
  it('takes the figure the shops agree on', () => {
    const r = agreeStock([s('P-Norway', 906), s('P-Sweden', 906), s('P-Denmark', 906)])
    expect(r.quantity).toBe(906)
    expect(r.disagrees).toBe(false)
  })

  it('takes the most common figure and flags the disagreement', () => {
    // The live case on 2026-08-13: four shops said 906 and Germany said 939.
    const r = agreeStock([
      s('P-Denmark', 906), s('P-Finland', 906), s('P-Norway', 906),
      s('P-Sweden', 906), s('P-Germany', 939),
    ])
    expect(r.quantity).toBe(906)
    expect(r.disagrees).toBe(true)
  })

  it('breaks a tie on the freshest reading, not on shop order', () => {
    const r = agreeStock([
      s('P-Norway', 10, new Date('2026-08-01')),
      s('P-Sweden', 20, new Date('2026-08-13')),
    ])
    expect(r.quantity).toBe(20)
    expect(r.disagrees).toBe(true)
  })

  it('is null when no shop reports a figure, never zero', () => {
    // Zero means sold out and would sort to the top as an emergency. "We do not
    // know" must not be able to raise that alarm.
    const r = agreeStock([s('P-Norway', null), s('P-Sweden', null)])
    expect(r.quantity).toBeNull()
    expect(r.disagrees).toBe(false)
  })

  it('ignores shops with no figure when others have one', () => {
    const r = agreeStock([s('P-Norway', null), s('P-Sweden', 42)])
    expect(r.quantity).toBe(42)
    expect(r.disagrees).toBe(false)
  })

  it('keeps every shop in the breakdown so the disagreement is inspectable', () => {
    const r = agreeStock([s('P-Norway', 906), s('P-Germany', 939)])
    expect(r.byShop).toHaveLength(2)
  })

  it('reports nothing for an empty list', () => {
    expect(agreeStock([]).quantity).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/stock.test.ts`
Expected: FAIL — "Failed to resolve import ./stock"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/inventory/stock.ts

export type ShopStock = {
  shopName: string
  /** Null = this store does not manage stock for the item. */
  quantity: number | null
  updatedAt: Date | null
}

export type AgreedStock = {
  /** Null = no shop reported a figure. Deliberately not zero. */
  quantity: number | null
  /** True when the shops report more than one distinct figure. */
  disagrees: boolean
  byShop: ShopStock[]
}

/**
 * One stock figure from up to nine mirrors of it.
 *
 * The shops are not nine warehouses. Denmark, Finland, Norway and Sweden carry
 * IDENTICAL quantities for the same SKU, which is one physical warehouse
 * mirrored into each store. So the job is not to sum them — that would multiply
 * the warehouse by five — but to agree on what the one number is.
 *
 * The most common value wins, because a mirror that has drifted is outvoted by
 * the ones that have not. On 2026-08-13 that was exactly the situation: four
 * shops said 906 and Germany said 939.
 *
 * `disagrees` is the point of the function as much as `quantity` is. A drifting
 * mirror is invisible by nature — each store looks perfectly consistent on its
 * own — so the disagreement has to be said out loud.
 */
export function agreeStock(rows: ShopStock[]): AgreedStock {
  const known = rows.filter((r) => r.quantity !== null)
  if (known.length === 0) return { quantity: null, disagrees: false, byShop: rows }

  const counts = new Map<number, { n: number; freshest: number }>()
  for (const r of known) {
    const at = r.updatedAt?.getTime() ?? 0
    const seen = counts.get(r.quantity!)
    if (seen) {
      seen.n++
      seen.freshest = Math.max(seen.freshest, at)
    } else {
      counts.set(r.quantity!, { n: 1, freshest: at })
    }
  }

  // Most common; a tie goes to the freshest reading rather than to whichever
  // shop happened to be first in the list.
  let best = -1
  let bestOf = { n: 0, freshest: -1 }
  for (const [value, tally] of counts) {
    if (tally.n > bestOf.n || (tally.n === bestOf.n && tally.freshest > bestOf.freshest)) {
      best = value
      bestOf = tally
    }
  }

  return { quantity: best, disagrees: counts.size > 1, byShop: rows }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/stock.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/stock.ts src/lib/inventory/stock.test.ts
git commit -m "feat(inventory): nine mirrors of one warehouse, not nine warehouses"
```

---

### Task 3: Read stock on the catalogue sweep the sync already does

**Files:**
- Modify: `src/lib/woo/client.ts:335-356` (replace `fetchCatalogPrices`)
- Test: `src/lib/woo/client.test.ts` (append)

**Interfaces:**
- Consumes: `WooCredentials` from `./client`
- Produces: `type CatalogEntry = { price: number | null; stock: number | null }`, `fetchCatalog(creds: WooCredentials): Promise<Map<string, CatalogEntry>>` keyed by WooCommerce product id as a string

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/woo/client.test.ts
import { fetchCatalog } from './client'

describe('fetchCatalog', () => {
  const creds = { url: 'https://shop.test', key: 'k', secret: 's' }

  it('carries price and stock back from one sweep', async () => {
    // Both facts live on the same /products response. Fetching them separately
    // would double the requests for no new information.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { id: 1, price: '649.00', manage_stock: true, stock_quantity: 95 },
      ]), { status: 200 }),
    )
    const catalog = await fetchCatalog(creds)
    expect(catalog.get('1')).toEqual({ price: 64900, stock: 95 })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('reports stock as null when the store does not manage it', async () => {
    // Not zero. Zero means sold out; "not managed" means we do not know, and
    // the difference decides whether a product screams at the top of the page.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { id: 2, price: '10.00', manage_stock: false, stock_quantity: null },
      ]), { status: 200 }),
    )
    expect((await fetchCatalog(creds)).get('2')).toEqual({ price: 1000, stock: null })
    spy.mockRestore()
  })

  it('keeps stock when a product carries no price', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { id: 3, price: '', manage_stock: true, stock_quantity: 7 },
      ]), { status: 200 }),
    )
    expect((await fetchCatalog(creds)).get('3')).toEqual({ price: null, stock: 7 })
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/woo/client.test.ts -t fetchCatalog`
Expected: FAIL — `fetchCatalog` is not exported

- [ ] **Step 3: Write minimal implementation**

Replace `fetchCatalogPrices` in `src/lib/woo/client.ts` with:

```ts
export type CatalogEntry = {
  /** The store's own listed price, minor units, incl VAT. Null if unpriced. */
  price: number | null
  /**
   * Units on hand, or null when the store does not manage stock for this item.
   * Null is not zero: zero is sold out and belongs at the top of the forecast,
   * "we do not know" does not.
   */
  stock: number | null
}

/**
 * Each product's listed price AND its stock, keyed by WooCommerce product id.
 *
 * One sweep, two facts. Both already live on the same `/products` response, so
 * asking twice would double the request count of every completed sync to learn
 * nothing new.
 */
export async function fetchCatalog(creds: WooCredentials): Promise<Map<string, CatalogEntry>> {
  const catalog = new Map<string, CatalogEntry>()
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ per_page: '100', page: String(page) })
    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/products?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw await wooError(res)

    const batch = (await res.json()) as {
      id: number
      price?: string
      manage_stock?: boolean
      stock_quantity?: number | null
    }[]
    for (const p of batch) {
      const value = p.price ? parseFloat(p.price) : NaN
      catalog.set(String(p.id), {
        price: Number.isNaN(value) ? null : toMinor(value),
        stock: p.manage_stock === true && typeof p.stock_quantity === 'number' ? p.stock_quantity : null,
      })
    }
    if (batch.length < 100) break
  }

  return catalog
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/woo/client.test.ts`
Expected: PASS — all existing tests plus the 3 new ones

- [ ] **Step 5: Commit**

```bash
git add src/lib/woo/client.ts src/lib/woo/client.test.ts
git commit -m "feat(woo): one catalogue sweep now carries stock as well as price"
```

---

### Task 4: Store stock on every completed sync

**Files:**
- Modify: `prisma/schema.prisma` (Product, around line 57-73)
- Modify: `src/lib/woo/sync.ts:644-660`
- Test: `src/lib/woo/sync.stock.test.ts` (create)

**Interfaces:**
- Consumes: `fetchCatalog`, `CatalogEntry` from Task 3
- Produces: `Product.stockQuantity: Int?`, `Product.stockUpdatedAt: DateTime?`

- [ ] **Step 1: Add the columns**

In `prisma/schema.prisma`, inside `model Product`, after `catalogPrice`:

```prisma
  /// Units on hand as this shop reports them. Null = the store does not manage
  /// stock for this item, which is NOT zero — zero is sold out.
  ///
  /// Per shop, deliberately, even though the shops mirror ONE warehouse. Storing
  /// only an agreed figure would throw away the disagreement, and the
  /// disagreement is what reveals a drifting mirror: on 2026-08-13 four shops
  /// said 906 and Germany said 939.
  stockQuantity  Int?
  stockUpdatedAt DateTime?
```

Run: `npx prisma db push && npx prisma generate`

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/woo/sync.stock.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest'
import { db } from '../db'
import { storeCatalog } from './sync'

const SKU = `TEST-STOCK-${Date.now()}`

afterEach(async () => {
  await db.product.deleteMany({ where: { sku: SKU } })
  await db.shop.deleteMany({ where: { name: SKU } })
})

describe('storeCatalog', () => {
  it('writes price and stock, and stamps when stock was read', async () => {
    const shop = await db.shop.create({ data: { name: SKU, currency: 'NOK' } })
    const product = await db.product.create({
      data: { shopId: shop.id, externalId: '77', sku: SKU, name: 'Test' },
    })

    await storeCatalog(shop.id, new Map([['77', { price: 64900, stock: 95 }]]))

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.catalogPrice).toBe(64900)
    expect(after.stockQuantity).toBe(95)
    expect(after.stockUpdatedAt).not.toBeNull()
  })

  it('records a stock reading of null without wiping the stamp of a real one', async () => {
    // A store that stops managing stock should stop claiming a figure, but the
    // write must still be recorded so the page can say when we last looked.
    const shop = await db.shop.create({ data: { name: SKU, currency: 'NOK' } })
    const product = await db.product.create({
      data: { shopId: shop.id, externalId: '78', sku: SKU, name: 'Test' },
    })

    await storeCatalog(shop.id, new Map([['78', { price: null, stock: null }]]))

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.stockQuantity).toBeNull()
    expect(after.stockUpdatedAt).not.toBeNull()
  })

  it('leaves a product the catalogue did not mention completely alone', async () => {
    const shop = await db.shop.create({ data: { name: SKU, currency: 'NOK' } })
    const product = await db.product.create({
      data: { shopId: shop.id, externalId: '79', sku: SKU, name: 'Test', catalogPrice: 500 },
    })

    await storeCatalog(shop.id, new Map([['other', { price: 1, stock: 1 }]]))

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(after.catalogPrice).toBe(500)
    expect(after.stockUpdatedAt).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/woo/sync.stock.test.ts`
Expected: FAIL — `storeCatalog` is not exported

- [ ] **Step 4: Write the implementation**

In `src/lib/woo/sync.ts`, change the import from `fetchCatalogPrices` to `fetchCatalog` and add `type CatalogEntry`. Then add this exported function above `syncShop`:

```ts
/**
 * Write a shop's catalogue readings onto its products.
 *
 * Exported so it can be tested without running a whole sync. Only products the
 * catalogue actually mentioned are touched — a truncated page or a product the
 * store no longer lists must never blank a figure we already hold.
 */
export async function storeCatalog(
  shopId: string,
  catalog: Map<string, CatalogEntry>,
): Promise<void> {
  if (catalog.size === 0) return

  const known = await db.product.findMany({
    where: { shopId },
    select: { id: true, externalId: true, catalogPrice: true, stockQuantity: true },
  })

  const now = new Date()
  for (const p of known) {
    const entry = catalog.get(p.externalId)
    if (entry === undefined) continue // not mentioned: leave it exactly as it is

    const data: { catalogPrice?: number; stockQuantity: number | null; stockUpdatedAt: Date } = {
      // Always written, even when unchanged: the stamp is how the page says when
      // we last looked, and "unchanged" is itself a reading.
      stockQuantity: entry.stock,
      stockUpdatedAt: now,
    }
    if (entry.price !== null && entry.price !== p.catalogPrice) data.catalogPrice = entry.price

    await db.product.update({ where: { id: p.id }, data })
  }
}
```

Then replace the catalog block at `src/lib/woo/sync.ts:644-660` with:

```ts
      // Best-effort on a COMPLETED sync only: refresh each known product's own
      // listed price and its stock. A failure here never fails the sync — order
      // data is the priority, and the next completed sync simply retries.
      try {
        await storeCatalog(shop.id, await fetchCatalog(creds))
      } catch {
        // Retried on the next completed sync.
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/woo/sync.stock.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 6: Run the woo suite to prove nothing regressed**

Run: `npx vitest run src/lib/woo/ --testTimeout=20000`
Expected: PASS. (If 2-3 `sync.test.ts` tests time out on a full run, that is known contention — re-run that file alone to confirm.)

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma src/lib/woo/sync.ts src/lib/woo/sync.stock.test.ts
git commit -m "feat(inventory): keep each shop's stock reading, drift and all"
```

---

### Task 5: The purchasing tables

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `src/lib/inventory/schema.test.ts` (create)

**Interfaces:**
- Produces: models `Supplier`, `SupplyItem`, `PurchaseOrder` as written in the spec

- [ ] **Step 1: Add the models**

Append to `prisma/schema.prisma`:

```prisma
model Supplier {
  id        String   @id @default(cuid())
  name      String
  active    Boolean  @default(true)
  notes     String?
  createdAt DateTime @default(now())

  items SupplyItem[]
}

/// One physical product we buy, keyed on SKU rather than on a Product id.
///
/// `Product` is shop-scoped, so the same item is up to nine rows that cascade
/// away with their shop. How many units fill a container is a fact about the
/// object, not about a German listing. `AmbassadorProduct` keys on SKU for the
/// same reason.
model SupplyItem {
  id                String   @id @default(cuid())
  sku               String   @unique
  /// Snapshot for display, so a row still reads sensibly when no Product for it
  /// is loaded — and so a shop renaming its listing cannot rewrite a purchase
  /// history, exactly as OrderItem.name already guarantees.
  name              String
  supplierId        String?
  /// Estimates. A purchase order's own ETA overrides them, because production
  /// time varies with the season and how busy the factory is — the person who
  /// placed the order knows that, a per-product average cannot.
  productionDays    Int?
  deliveryDays      Int?
  unitsPerContainer Int?
  moq               Int?
  /// How long one order should last. Null falls back to DEFAULT_COVER_DAYS.
  coverDays         Int?
  active            Boolean  @default(true)
  createdAt         DateTime @default(now())

  /// SetNull, never Cascade: removing a supplier must unassign its products and
  /// never delete the purchase history that proves what was ordered. Same rule
  /// AdCampaign.shop already follows.
  supplier       Supplier?       @relation(fields: [supplierId], references: [id], onDelete: SetNull)
  purchaseOrders PurchaseOrder[]

  @@index([supplierId])
}

model PurchaseOrder {
  id           String    @id @default(cuid())
  supplyItemId String
  quantity     Int
  orderedAt    DateTime
  /// When it is expected to land. Null is honest and has a consequence: an
  /// order with no ETA never moves a run-out date, because counting stock whose
  /// arrival nobody knows would push out that date on a guess.
  eta          DateTime?
  /// Null = still on the water, so it still counts as incoming.
  receivedAt   DateTime?
  /// Visma's own purchase order id. Null on every hand-entered row. This is the
  /// single seam the Visma import plugs into.
  externalId   String?
  notes        String?
  createdAt    DateTime  @default(now())

  item SupplyItem @relation(fields: [supplyItemId], references: [id], onDelete: Cascade)

  @@index([supplyItemId, receivedAt])
}
```

Run: `npx prisma db push && npx prisma generate`

- [ ] **Step 2: Write the test**

```ts
// src/lib/inventory/schema.test.ts
import { describe, expect, it, afterEach } from 'vitest'
import { db } from '../db'

const SKU = `TEST-SCHEMA-${Date.now()}`

afterEach(async () => {
  await db.purchaseOrder.deleteMany({ where: { item: { sku: SKU } } })
  await db.supplyItem.deleteMany({ where: { sku: SKU } })
  await db.supplier.deleteMany({ where: { name: SKU } })
})

describe('purchasing tables', () => {
  it('unassigns products when a supplier is removed, and keeps their orders', async () => {
    // The whole point of SetNull. A supplier we stop using must not take the
    // record of what we bought from them with it.
    const supplier = await db.supplier.create({ data: { name: SKU } })
    const item = await db.supplyItem.create({
      data: { sku: SKU, name: 'Test', supplierId: supplier.id },
    })
    await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 600, orderedAt: new Date() },
    })

    await db.supplier.delete({ where: { id: supplier.id } })

    const after = await db.supplyItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(after.supplierId).toBeNull()
    expect(await db.purchaseOrder.count({ where: { supplyItemId: item.id } })).toBe(1)
  })

  it('refuses a second row for the same SKU', async () => {
    await db.supplyItem.create({ data: { sku: SKU, name: 'Test' } })
    await expect(db.supplyItem.create({ data: { sku: SKU, name: 'Again' } })).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/schema.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma src/lib/inventory/schema.test.ts
git commit -m "feat(inventory): suppliers, per-SKU purchasing facts, purchase orders"
```

---

### Task 6: Create a SupplyItem for every usable SKU

**Files:**
- Create: `src/lib/inventory/supply-items.ts`
- Test: `src/lib/inventory/supply-items.test.ts`

**Interfaces:**
- Consumes: `isUsableSku`, `normaliseSku` from Task 1
- Produces: `ensureSupplyItems(): Promise<number>` returning how many rows were created

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/supply-items.test.ts
import { describe, expect, it, afterEach } from 'vitest'
import { db } from '../db'
import { ensureSupplyItems } from './supply-items'

const TAG = `TEST-ITEMS-${Date.now()}`
const SKU = `${TAG}-A`

afterEach(async () => {
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.product.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.product.deleteMany({ where: { sku: '0', name: TAG } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

const shopWith = async (n: string, products: { sku: string; name: string; externalId: string }[]) => {
  const shop = await db.shop.create({ data: { name: `${TAG}-${n}`, currency: 'NOK' } })
  for (const p of products) await db.product.create({ data: { shopId: shop.id, ...p } })
  return shop
}

describe('ensureSupplyItems', () => {
  it('creates one row per usable SKU so nobody types 63 of them', async () => {
    await shopWith('no', [{ sku: SKU, name: 'Pasta Maker', externalId: '1' }])
    await ensureSupplyItems()
    const item = await db.supplyItem.findUniqueOrThrow({ where: { sku: SKU } })
    expect(item.name).toBe('Pasta Maker')
    expect(item.productionDays).toBeNull()
  })

  it('does not duplicate when a second shop lists the same SKU', async () => {
    await shopWith('no', [{ sku: SKU, name: 'Pasta Maker', externalId: '1' }])
    await shopWith('se', [{ sku: SKU, name: 'Pastamaskin', externalId: '2' }])
    await ensureSupplyItems()
    expect(await db.supplyItem.count({ where: { sku: SKU } })).toBe(1)
  })

  it('creates nothing for an unusable SKU', async () => {
    // "0" is shared by a pizza oven and a massage chair on the live stores.
    await shopWith('no', [{ sku: '0', name: TAG, externalId: '3' }])
    await ensureSupplyItems()
    expect(await db.supplyItem.count({ where: { sku: '0' } })).toBe(0)
  })

  it('never overwrites purchasing settings already entered', async () => {
    await shopWith('no', [{ sku: SKU, name: 'Pasta Maker', externalId: '1' }])
    await ensureSupplyItems()
    await db.supplyItem.update({ where: { sku: SKU }, data: { productionDays: 45 } })
    await ensureSupplyItems()
    expect((await db.supplyItem.findUniqueOrThrow({ where: { sku: SKU } })).productionDays).toBe(45)
  })

  it('reports how many it created, so a caller can stay silent when nothing changed', async () => {
    await shopWith('no', [{ sku: SKU, name: 'Pasta Maker', externalId: '1' }])
    expect(await ensureSupplyItems()).toBe(1)
    expect(await ensureSupplyItems()).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/supply-items.test.ts`
Expected: FAIL — "Failed to resolve import ./supply-items"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/inventory/supply-items.ts
import { db } from '../db'
import { isUsableSku, normaliseSku } from './sku'

/**
 * Give every product we sell a purchasing record, so the Suppliers page opens
 * already listing them all, each saying what it still needs.
 *
 * Nobody types 63 SKUs by hand. Run after a completed sync.
 *
 * Never updates and never deletes. A product whose shops stop listing it keeps
 * its lead times and its open orders — `active` is what hides a row, not
 * absence from a catalogue — and settings someone has entered are never
 * overwritten by a name discovered later.
 */
export async function ensureSupplyItems(): Promise<number> {
  const products = await db.product.findMany({ select: { sku: true, name: true } })

  const wanted = new Map<string, string>() // sku -> a name to show
  for (const p of products) {
    if (!isUsableSku(p.sku)) continue
    const sku = normaliseSku(p.sku)
    if (!wanted.has(sku)) wanted.set(sku, p.name)
  }
  if (wanted.size === 0) return 0

  const held = new Set(
    (
      await db.supplyItem.findMany({
        where: { sku: { in: [...wanted.keys()] } },
        select: { sku: true },
      })
    ).map((i) => i.sku),
  )

  let created = 0
  for (const [sku, name] of wanted) {
    if (held.has(sku)) continue
    await db.supplyItem.create({ data: { sku, name } })
    created++
  }
  return created
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/supply-items.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/supply-items.ts src/lib/inventory/supply-items.test.ts
git commit -m "feat(inventory): every product we sell arrives with a purchasing record"
```

---

### Task 7: Burn rate and seasonal index

**Files:**
- Create: `src/lib/inventory/burn.ts`
- Test: `src/lib/inventory/burn.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Sale = { day: Date; units: number }`
  - `BURN_WINDOW_DAYS = 60`, `SEASON_MIN_HISTORY_DAYS = 400`, `SEASON_WINDOW_DAYS = 28`
  - `dailyBurn(sales: Sale[], today: Date): number`
  - `hasSeasonalHistory(sales: Sale[], today: Date): boolean`
  - `seasonalIndex(sales: Sale[], day: Date, today: Date): number`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/burn.test.ts
import { describe, expect, it } from 'vitest'
import { dailyBurn, hasSeasonalHistory, seasonalIndex, type Sale } from './burn'

const TODAY = new Date('2026-08-13T00:00:00Z')
const daysBefore = (n: number) => new Date(TODAY.getTime() - n * 86400000)

/** One sale of `units` on each of the last `n` days. */
const steady = (n: number, units: number): Sale[] =>
  Array.from({ length: n }, (_, i) => ({ day: daysBefore(i), units }))

describe('dailyBurn', () => {
  it('averages units sold per day over the window', () => {
    // 60 days at 2 a day = 120 units over 60 days = 2.
    expect(dailyBurn(steady(60, 2), TODAY)).toBeCloseTo(2)
  })

  it('ignores sales older than the window, so last spring does not set today', () => {
    const old: Sale[] = [{ day: daysBefore(200), units: 10_000 }]
    expect(dailyBurn(old, TODAY)).toBe(0)
  })

  it('is zero when nothing sold, which the page reads as "not selling"', () => {
    expect(dailyBurn([], TODAY)).toBe(0)
  })
})

describe('hasSeasonalHistory', () => {
  it('is false under 400 days, so Germany at 11 months is honest about it', () => {
    expect(hasSeasonalHistory(steady(330, 1), TODAY)).toBe(false)
  })

  it('is true once a full year plus margin exists', () => {
    expect(hasSeasonalHistory([{ day: daysBefore(500), units: 1 }], TODAY)).toBe(true)
  })
})

describe('seasonalIndex', () => {
  it('is exactly 1 without enough history, never a guess', () => {
    expect(seasonalIndex(steady(100, 5), daysBefore(-30), TODAY)).toBe(1)
  })

  it('rises above 1 for a period that was busy last year', () => {
    // Flat 1/day for two years, except a burst around this time last year.
    const sales = steady(730, 1)
    for (let i = 360; i <= 374; i++) sales.push({ day: daysBefore(i), units: 20 })
    const index = seasonalIndex(sales, TODAY, TODAY)
    expect(index).toBeGreaterThan(1)
  })

  it('clamps, so one freak week cannot order a container', () => {
    const sales = steady(730, 1)
    sales.push({ day: daysBefore(365), units: 1_000_000 })
    expect(seasonalIndex(sales, TODAY, TODAY)).toBeLessThanOrEqual(4)
  })

  it('clamps at the bottom too', () => {
    // Two years of sales, all of them far from this date last year.
    const sales: Sale[] = []
    for (let i = 0; i < 60; i++) sales.push({ day: daysBefore(i), units: 50 })
    for (let i = 180; i < 240; i++) sales.push({ day: daysBefore(i), units: 50 })
    expect(seasonalIndex(sales, TODAY, TODAY)).toBeGreaterThanOrEqual(0.25)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/burn.test.ts`
Expected: FAIL — "Failed to resolve import ./burn"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/inventory/burn.ts

export type Sale = { day: Date; units: number }

const DAY = 86_400_000

/** How far back the current rate is measured. */
export const BURN_WINDOW_DAYS = 60

/**
 * A year plus margin. Below this a SKU has no "same time last year" to compare
 * against, whatever the shop's age — Panetti Germany opened in September 2025.
 */
export const SEASON_MIN_HISTORY_DAYS = 400

/** Width of the comparison window, centred on the target date a year back. */
export const SEASON_WINDOW_DAYS = 28

/** One freak week must not be allowed to order a container. */
const INDEX_MIN = 0.25
const INDEX_MAX = 4

const unitsBetween = (sales: Sale[], from: number, to: number): number =>
  sales.reduce((n, s) => (s.day.getTime() >= from && s.day.getTime() < to ? n + s.units : n), 0)

/**
 * Units sold per day, right now, summed across every shop.
 *
 * Across shops because the stores mirror ONE warehouse: what empties it is total
 * demand, not any single country's.
 */
export function dailyBurn(sales: Sale[], today: Date): number {
  const to = today.getTime() + DAY
  return unitsBetween(sales, to - BURN_WINDOW_DAYS * DAY, to) / BURN_WINDOW_DAYS
}

/** True when this SKU has a last year worth comparing against. */
export function hasSeasonalHistory(sales: Sale[], today: Date): boolean {
  if (sales.length === 0) return false
  const oldest = Math.min(...sales.map((s) => s.day.getTime()))
  return today.getTime() - oldest >= SEASON_MIN_HISTORY_DAYS * DAY
}

/**
 * How much busier than average this date was a year ago.
 *
 * Returns exactly 1 when there is not enough history — a flat rate stated
 * honestly, rather than a seasonal shape invented from ten months of data. The
 * caller shows "no seasonal history yet" on those rows.
 */
export function seasonalIndex(sales: Sale[], day: Date, today: Date): number {
  if (!hasSeasonalHistory(sales, today)) return 1

  const centre = day.getTime() - 365 * DAY
  const half = (SEASON_WINDOW_DAYS / 2) * DAY
  const inWindow = unitsBetween(sales, centre - half, centre + half)

  const yearTo = centre + half
  const overYear = unitsBetween(sales, yearTo - 365 * DAY, yearTo)
  if (overYear === 0) return 1

  const expected = (overYear / 365) * SEASON_WINDOW_DAYS
  if (expected === 0) return 1

  return Math.min(INDEX_MAX, Math.max(INDEX_MIN, inWindow / expected))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/burn.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/burn.ts src/lib/inventory/burn.test.ts
git commit -m "feat(inventory): a rate that knows what last year looked like, or says it cannot"
```

---

### Task 8: The forecast

**Files:**
- Create: `src/lib/inventory/forecast.ts`
- Test: `src/lib/inventory/forecast.test.ts`

**Interfaces:**
- Consumes: nothing (the caller supplies burn and index from Task 7)
- Produces:
  - `DEFAULT_COVER_DAYS = 90`, `HORIZON_DAYS = 365`
  - `type Arrival = { eta: Date | null; quantity: number }`
  - `type ForecastInput = { stock: number | null; burn: number; index: (day: Date) => number; arrivals: Arrival[]; productionDays: number | null; deliveryDays: number | null; moq: number | null; unitsPerContainer: number | null; coverDays: number | null }`
  - `type Forecast = { runsOutOn: Date | null; orderBy: Date | null; daysLate: number | null; quantity: number | null; onOrderWithoutEta: number; note: string | null }`
  - `forecast(input: ForecastInput, today: Date): Forecast`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/forecast.test.ts
import { describe, expect, it } from 'vitest'
import { forecast, type ForecastInput } from './forecast'

const TODAY = new Date('2026-08-13T00:00:00Z')
const inDays = (n: number) => new Date(TODAY.getTime() + n * 86400000)
const day = (d: Date) => d.toISOString().slice(0, 10)

const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  stock: 100, burn: 10, index: () => 1, arrivals: [],
  productionDays: 30, deliveryDays: 40, moq: null, unitsPerContainer: null, coverDays: null,
  ...over,
})

describe('forecast', () => {
  it('runs out when the stock is gone at the current rate', () => {
    // 100 units, 10 a day, so day 10 is the first day it reaches zero.
    expect(day(forecast(input(), TODAY).runsOutOn!)).toBe(day(inDays(9)))
  })

  it('orders back from the run-out date by production plus delivery', () => {
    const f = forecast(input({ stock: 1000 }), TODAY) // 100 days of cover
    expect(day(f.orderBy!)).toBe(day(new Date(f.runsOutOn!.getTime() - 70 * 86400000)))
  })

  it('says how late an order already is rather than showing a past date', () => {
    // 100 units at 10 a day runs out in 10 days, but lead time is 70 days.
    const f = forecast(input(), TODAY)
    expect(f.daysLate).toBe(61)
  })

  it('a container landing before the run-out pushes the date out', () => {
    const without = forecast(input(), TODAY)
    const with_ = forecast(input({ arrivals: [{ eta: inDays(5), quantity: 500 }] }), TODAY)
    expect(with_.runsOutOn!.getTime()).toBeGreaterThan(without.runsOutOn!.getTime())
  })

  it('a container landing after the run-out does not', () => {
    const without = forecast(input(), TODAY)
    const with_ = forecast(input({ arrivals: [{ eta: inDays(300), quantity: 500 }] }), TODAY)
    expect(day(with_.runsOutOn!)).toBe(day(without.runsOutOn!))
  })

  it('an order with no ETA never moves the date, and is reported instead', () => {
    // Counting stock whose arrival nobody knows would push out a real date on a
    // guess. The number is shown so someone goes and sets the ETA.
    const f = forecast(input({ arrivals: [{ eta: null, quantity: 500 }] }), TODAY)
    expect(day(f.runsOutOn!)).toBe(day(inDays(9)))
    expect(f.onOrderWithoutEta).toBe(500)
  })

  it('covers lead time plus the cover period', () => {
    // 10 a day over 30 + 40 + 90 days.
    expect(forecast(input({ stock: 1000 }), TODAY).quantity).toBe(1600)
  })

  it('never orders below the supplier minimum', () => {
    const f = forecast(input({ stock: 1000, burn: 1, moq: 500 }), TODAY)
    expect(f.quantity).toBe(500)
  })

  it('rounds up to whole containers', () => {
    const f = forecast(input({ stock: 1000, unitsPerContainer: 1000 }), TODAY)
    expect(f.quantity).toBe(2000) // 1600 needed -> two containers
  })

  it('a container rounding can never drop below the minimum', () => {
    const f = forecast(input({ stock: 1000, burn: 1, moq: 500, unitsPerContainer: 400 }), TODAY)
    expect(f.quantity).toBeGreaterThanOrEqual(500)
    expect(f.quantity! % 400).toBe(0)
  })

  it('says nothing about dates when stock is unknown, and does not assume zero', () => {
    const f = forecast(input({ stock: null }), TODAY)
    expect(f.runsOutOn).toBeNull()
    expect(f.quantity).toBeNull()
    expect(f.note).toBe('no stock data')
  })

  it('reads "not selling" when nothing has sold, rather than running out today', () => {
    const f = forecast(input({ burn: 0 }), TODAY)
    expect(f.runsOutOn).toBeNull()
    expect(f.note).toBe('not selling')
  })

  it('asks for lead times rather than inventing an order-by date', () => {
    const f = forecast(input({ productionDays: null }), TODAY)
    expect(f.runsOutOn).not.toBeNull()
    expect(f.orderBy).toBeNull()
    expect(f.quantity).toBeNull()
    expect(f.note).toBe('set lead times')
  })

  it('reports no risk when a year of selling does not empty the shelf', () => {
    const f = forecast(input({ stock: 100_000 }), TODAY)
    expect(f.runsOutOn).toBeNull()
    expect(f.note).toBe('no risk within a year')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/forecast.test.ts`
Expected: FAIL — "Failed to resolve import ./forecast"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/inventory/forecast.ts

const DAY = 86_400_000

/** How long one order should last once it lands, when nobody has said. */
export const DEFAULT_COVER_DAYS = 90

/** Nobody plans a kitchen appliance more than a year out. */
export const HORIZON_DAYS = 365

export type Arrival = {
  /** Null = on order with no expected date. Deliberately not counted. */
  eta: Date | null
  quantity: number
}

export type ForecastInput = {
  /** Null = no shop reported a figure. NOT zero. */
  stock: number | null
  burn: number
  index: (day: Date) => number
  arrivals: Arrival[]
  productionDays: number | null
  deliveryDays: number | null
  moq: number | null
  unitsPerContainer: number | null
  coverDays: number | null
}

export type Forecast = {
  runsOutOn: Date | null
  orderBy: Date | null
  /** Days the order-by date is already in the past. Null when it is not. */
  daysLate: number | null
  quantity: number | null
  /** Units on order that carry no ETA, so they moved nothing. */
  onOrderWithoutEta: number
  /** Why a figure is missing. Null when everything computed. */
  note: string | null
}

const startOfDay = (d: Date) => new Date(Math.floor(d.getTime() / DAY) * DAY)

/**
 * When this product runs out, when to order, and how many.
 *
 * The run-out date is walked day by day rather than divided, because stock does
 * not fall in a straight line: a container landing on a date lifts it back up,
 * and demand itself is seasonal. Dividing stock by a rate cannot express either.
 *
 * Every missing answer says WHY. A blank cell on a page like this is read as
 * "nothing to worry about", which is the one thing it must never mean.
 */
export function forecast(input: ForecastInput, today: Date): Forecast {
  const onOrderWithoutEta = input.arrivals
    .filter((a) => a.eta === null)
    .reduce((n, a) => n + a.quantity, 0)

  const blank = (note: string): Forecast => ({
    runsOutOn: null, orderBy: null, daysLate: null, quantity: null, onOrderWithoutEta, note,
  })

  if (input.stock === null) return blank('no stock data')
  if (input.burn <= 0) return blank('not selling')

  const from = startOfDay(today)
  const landing = new Map<number, number>()
  for (const a of input.arrivals) {
    if (!a.eta) continue // no date, no effect — a guessed arrival is worse than none
    const k = startOfDay(a.eta).getTime()
    landing.set(k, (landing.get(k) ?? 0) + a.quantity)
  }

  const demandOn = (d: Date) => input.burn * input.index(d)

  let stock = input.stock
  let runsOutOn: Date | null = null
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(from.getTime() + i * DAY)
    stock += landing.get(d.getTime()) ?? 0
    stock -= demandOn(d)
    if (stock <= 0) {
      runsOutOn = d
      break
    }
  }
  if (!runsOutOn) return blank('no risk within a year')

  if (input.productionDays === null || input.deliveryDays === null) {
    return { runsOutOn, orderBy: null, daysLate: null, quantity: null, onOrderWithoutEta, note: 'set lead times' }
  }

  const leadDays = input.productionDays + input.deliveryDays
  const orderBy = new Date(runsOutOn.getTime() - leadDays * DAY)
  const late = Math.ceil((from.getTime() - orderBy.getTime()) / DAY)

  // Cover the lead time and then the cover period, counted from when the shelf
  // empties — that is the stretch the new stock has to carry.
  const horizon = leadDays + (input.coverDays ?? DEFAULT_COVER_DAYS)
  let quantity = 0
  for (let i = 0; i < horizon; i++) {
    quantity += demandOn(new Date(runsOutOn.getTime() + i * DAY))
  }
  quantity = Math.ceil(quantity)

  // MOQ first, containers second. Doing it the other way round could round a
  // quantity back under the minimum the supplier will accept.
  if (input.moq !== null) quantity = Math.max(quantity, input.moq)
  if (input.unitsPerContainer !== null && input.unitsPerContainer > 0) {
    quantity = Math.ceil(quantity / input.unitsPerContainer) * input.unitsPerContainer
  }

  return {
    runsOutOn,
    orderBy,
    daysLate: late > 0 ? late : null,
    quantity,
    onOrderWithoutEta,
    note: null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/forecast.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/forecast.ts src/lib/inventory/forecast.test.ts
git commit -m "feat(inventory): walk the shelf forward day by day, containers and all"
```

---

### Task 9: Assemble the forecast from the database

**Files:**
- Create: `src/lib/inventory/load.ts`
- Test: `src/lib/inventory/load.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 7, 8
- Produces:
  - `type InventoryRow = { sku: string; name: string; supplierName: string | null; stock: AgreedStock; burn: number; seasonal: boolean; forecast: Forecast; byCountry: { country: string; units: number }[] }`
  - `type InventoryView = { rows: InventoryRow[]; unusable: { shopName: string; name: string; sku: string }[] }`
  - `loadInventory(today?: Date): Promise<InventoryView>`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/inventory/load.test.ts
import { describe, expect, it, afterEach } from 'vitest'
import { db } from '../db'
import { loadInventory } from './load'

const TAG = `TEST-LOAD-${Date.now()}`
const SKU = `${TAG}-A`
const TODAY = new Date('2026-08-13T00:00:00Z')

afterEach(async () => {
  await db.orderItem.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.order.deleteMany({ where: { shop: { name: { startsWith: TAG } } } })
  await db.purchaseOrder.deleteMany({ where: { item: { sku: { startsWith: TAG } } } })
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.product.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

async function sell(shopName: string, sku: string, stock: number | null, units: number, daysAgo: number, country: string) {
  const shop =
    (await db.shop.findFirst({ where: { name: shopName } })) ??
    (await db.shop.create({ data: { name: shopName, currency: 'NOK' } }))
  const product =
    (await db.product.findFirst({ where: { shopId: shop.id, sku } })) ??
    (await db.product.create({
      data: { shopId: shop.id, externalId: `${shopName}-${sku}`, sku, name: 'Pasta Maker',
              stockQuantity: stock, stockUpdatedAt: new Date() },
    }))
  const order = await db.order.create({
    data: {
      shopId: shop.id, externalId: `${sku}-${daysAgo}-${shopName}`, number: `${daysAgo}`,
      placedAt: new Date(TODAY.getTime() - daysAgo * 86400000), status: 'completed',
      currency: 'NOK', grossSales: 0, discountTotal: 0, netSales: 0,
      shippingCharged: 0, taxTotal: 0, total: 0, shippingCountry: country,
    },
  })
  await db.orderItem.create({
    data: { orderId: order.id, productId: product.id, sku, name: 'Pasta Maker',
            quantity: units, unitPrice: 0, lineNetTotal: 0 },
  })
}

describe('loadInventory', () => {
  it('sums demand across shops, because they share one warehouse', async () => {
    await sell(`${TAG}-no`, SKU, 100, 60, 5, 'NO')
    await sell(`${TAG}-se`, SKU, 100, 60, 5, 'SE')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const view = await loadInventory(TODAY)
    const row = view.rows.find((r) => r.sku === SKU)!
    expect(row.burn).toBeCloseTo(2) // 120 units over 60 days
    expect(row.stock.quantity).toBe(100) // agreed, not summed
  })

  it('does not count a cancelled order as demand', async () => {
    await sell(`${TAG}-no`, SKU, 100, 600, 5, 'NO')
    await db.order.updateMany({ where: { shop: { name: `${TAG}-no` } }, data: { status: 'cancelled' } })
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.burn).toBe(0)
  })

  it('shows which country is burning the stock', async () => {
    await sell(`${TAG}-no`, SKU, 100, 90, 5, 'NO')
    await sell(`${TAG}-de`, SKU, 100, 10, 5, 'DE')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    expect(row.byCountry[0]).toEqual({ country: 'NO', units: 90 })
  })

  it('names products whose SKU cannot be used instead of dropping them', async () => {
    const shop = await db.shop.create({ data: { name: `${TAG}-bad`, currency: 'NOK' } })
    await db.product.create({
      data: { shopId: shop.id, externalId: 'x', sku: '0', name: `${TAG} Massage Chair` },
    })
    const view = await loadInventory(TODAY)
    expect(view.unusable.some((u) => u.name === `${TAG} Massage Chair`)).toBe(true)
    expect(view.rows.some((r) => r.sku === '0')).toBe(false)
  })

  it('counts an open purchase order and ignores a received one', async () => {
    await sell(`${TAG}-no`, SKU, 100, 600, 5, 'NO')
    const item = await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })
    await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 500, orderedAt: TODAY,
              eta: new Date(TODAY.getTime() + 3 * 86400000) },
    })
    await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 9999, orderedAt: TODAY,
              eta: new Date(TODAY.getTime() + 4 * 86400000), receivedAt: TODAY },
    })

    const row = (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!
    // 100 on hand + 500 incoming at 10/day = far short of the 9999 row's effect.
    expect(row.forecast.runsOutOn).not.toBeNull()
    expect(row.forecast.runsOutOn!.getTime()).toBeLessThan(TODAY.getTime() + 100 * 86400000)
  })

  it('sorts the soonest run-out first', async () => {
    await sell(`${TAG}-no`, SKU, 10, 600, 5, 'NO')
    await sell(`${TAG}-no`, `${TAG}-B`, 100000, 600, 5, 'NO')
    await db.supplyItem.create({ data: { sku: SKU, name: 'Urgent' } })
    await db.supplyItem.create({ data: { sku: `${TAG}-B`, name: 'Fine' } })

    const rows = (await loadInventory(TODAY)).rows.filter((r) => r.sku.startsWith(TAG))
    expect(rows[0].sku).toBe(SKU)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/load.test.ts`
Expected: FAIL — "Failed to resolve import ./load"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/inventory/load.ts
import { db } from '../db'
import { VOIDED_STATUSES } from '../metrics/types'
import { dailyBurn, hasSeasonalHistory, seasonalIndex, type Sale } from './burn'
import { forecast, type Forecast } from './forecast'
import { isUsableSku, normaliseSku } from './sku'
import { agreeStock, type AgreedStock, type ShopStock } from './stock'

export type InventoryRow = {
  sku: string
  name: string
  supplierName: string | null
  stock: AgreedStock
  burn: number
  /** False = no last year to compare against, so the rate is flat and says so. */
  seasonal: boolean
  forecast: Forecast
  byCountry: { country: string; units: number }[]
}

export type InventoryView = {
  rows: InventoryRow[]
  /** Products excluded because their SKU cannot identify a product. */
  unusable: { shopName: string; name: string; sku: string }[]
}

/** Two years, so a seasonal index has a year to compare against. */
const HISTORY_DAYS = 730

/**
 * Every purchasable product with its stock, its rate and its forecast.
 *
 * One pass over sales history rather than a query per SKU: 63 products against
 * 36,000 order lines is one round trip, not sixty-three.
 */
export async function loadInventory(today: Date = new Date()): Promise<InventoryView> {
  const since = new Date(today.getTime() - HISTORY_DAYS * 86_400_000)

  const [items, products, lines] = await Promise.all([
    db.supplyItem.findMany({
      where: { active: true },
      select: {
        id: true, sku: true, name: true, productionDays: true, deliveryDays: true,
        moq: true, unitsPerContainer: true, coverDays: true,
        supplier: { select: { name: true } },
        purchaseOrders: {
          where: { receivedAt: null },
          select: { quantity: true, eta: true },
        },
      },
    }),
    db.product.findMany({
      select: {
        sku: true, name: true, stockQuantity: true, stockUpdatedAt: true,
        shop: { select: { name: true } },
      },
    }),
    db.orderItem.findMany({
      where: {
        order: {
          placedAt: { gte: since },
          status: { notIn: [...VOIDED_STATUSES] },
        },
      },
      select: {
        sku: true, quantity: true,
        order: { select: { placedAt: true, shippingCountry: true } },
      },
    }),
  ])

  // Sales, stock and countries, bucketed by SKU in one pass each.
  const sales = new Map<string, Sale[]>()
  const countries = new Map<string, Map<string, number>>()
  for (const l of lines) {
    if (!isUsableSku(l.sku)) continue
    const sku = normaliseSku(l.sku)
    if (!sales.has(sku)) sales.set(sku, [])
    sales.get(sku)!.push({ day: l.order.placedAt, units: l.quantity })

    const country = (l.order.shippingCountry ?? '').trim().toUpperCase() || 'Unknown'
    if (!countries.has(sku)) countries.set(sku, new Map())
    const c = countries.get(sku)!
    c.set(country, (c.get(country) ?? 0) + l.quantity)
  }

  const stocks = new Map<string, ShopStock[]>()
  const unusable: InventoryView['unusable'] = []
  for (const p of products) {
    if (!isUsableSku(p.sku)) {
      unusable.push({ shopName: p.shop.name, name: p.name, sku: p.sku })
      continue
    }
    const sku = normaliseSku(p.sku)
    if (!stocks.has(sku)) stocks.set(sku, [])
    stocks.get(sku)!.push({
      shopName: p.shop.name,
      quantity: p.stockQuantity,
      updatedAt: p.stockUpdatedAt,
    })
  }

  const rows: InventoryRow[] = items.map((item) => {
    const sku = normaliseSku(item.sku)
    const mine = sales.get(sku) ?? []
    const burn = dailyBurn(mine, today)
    const seasonal = hasSeasonalHistory(mine, today)
    const stock = agreeStock(stocks.get(sku) ?? [])

    return {
      sku,
      name: item.name,
      supplierName: item.supplier?.name ?? null,
      stock,
      burn,
      seasonal,
      forecast: forecast(
        {
          stock: stock.quantity,
          burn,
          index: (d) => seasonalIndex(mine, d, today),
          arrivals: item.purchaseOrders.map((o) => ({ eta: o.eta, quantity: o.quantity })),
          productionDays: item.productionDays,
          deliveryDays: item.deliveryDays,
          moq: item.moq,
          unitsPerContainer: item.unitsPerContainer,
          coverDays: item.coverDays,
        },
        today,
      ),
      byCountry: [...(countries.get(sku) ?? new Map())]
        .map(([country, units]) => ({ country, units }))
        .sort((a, b) => b.units - a.units),
    }
  })

  // Soonest first. A row with no run-out date has nothing to chase, so it sorts
  // after every row that does — but it is still present, because a product that
  // stopped selling or lost its stock figure is worth seeing.
  rows.sort((a, b) => {
    const at = a.forecast.runsOutOn?.getTime() ?? Infinity
    const bt = b.forecast.runsOutOn?.getTime() ?? Infinity
    return at - bt
  })

  return { rows, unusable }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/load.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/load.ts src/lib/inventory/load.test.ts
git commit -m "feat(inventory): one pass over history answers every product at once"
```

---

### Task 10: The read API

**Files:**
- Create: `src/app/api/inventory/route.ts`
- Test: `src/app/api/inventory/route.test.ts`

**Interfaces:**
- Consumes: `loadInventory` from Task 9
- Produces: `GET /api/inventory` returning `{ rows, unusable }` with all dates as ISO strings

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/inventory/route.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { GET } from './route'

describe('GET /api/inventory', () => {
  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue(null)
    const res = await GET(new Request('http://test/api/inventory'))
    expect(res.status).toBe(403)
  })

  it('never lets a browser cache stock figures', async () => {
    vi.mocked(currentUser).mockResolvedValue({
      id: 'u1', email: 'a@b.c', role: 'ADMIN',
    } as never)
    const res = await GET(new Request('http://test/api/inventory'))
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/inventory/route.test.ts`
Expected: FAIL — "Failed to resolve import ./route"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/inventory/route.ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadInventory } from '@/lib/inventory/load'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * What is on the shelf, what it is costing us per day, and when to order more.
 *
 * `unusable` rides along deliberately. Products excluded for want of a real SKU
 * are the ones most likely to be quietly wrong, so the page names them rather
 * than showing a shorter list that looks complete.
 */
export async function GET(_req: Request) {
  try {
    assertAdmin(await currentUser())

    const { rows, unusable } = await loadInventory()

    return NextResponse.json(
      {
        rows: rows.map((r) => ({
          ...r,
          stock: {
            ...r.stock,
            byShop: r.stock.byShop.map((s) => ({
              ...s,
              updatedAt: s.updatedAt?.toISOString() ?? null,
            })),
          },
          forecast: {
            ...r.forecast,
            runsOutOn: r.forecast.runsOutOn?.toISOString() ?? null,
            orderBy: r.forecast.orderBy?.toISOString() ?? null,
          },
        })),
        unusable,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load inventory' },
      { status: 500, headers: NO_STORE },
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/inventory/route.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/app/api/inventory/route.ts src/app/api/inventory/route.test.ts
git commit -m "feat(inventory): serve the forecast, and name what it had to leave out"
```

---

### Task 11: The write API — suppliers, settings, purchase orders

**Files:**
- Create: `src/app/api/inventory/suppliers/route.ts`
- Create: `src/app/api/inventory/items/route.ts`
- Create: `src/app/api/inventory/purchase-orders/route.ts`
- Test: `src/app/api/inventory/write.test.ts`

**Interfaces:**
- Consumes: Prisma models from Task 5, `ensureSupplyItems` from Task 6
- Produces:
  - `GET/POST/DELETE /api/inventory/suppliers` — `{ id?, name, active?, notes? }`
  - `GET/PUT /api/inventory/items` — PUT body `{ sku, supplierId, productionDays, deliveryDays, moq, unitsPerContainer, coverDays }`, all nullable but `sku`
  - `GET/POST/PUT/DELETE /api/inventory/purchase-orders` — `{ id?, supplyItemId, quantity, orderedAt, eta, receivedAt, notes }`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/inventory/write.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { PUT as putItem } from './items/route'
import { POST as postSupplier } from './suppliers/route'

const TAG = `TEST-WRITE-${Date.now()}`
const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

afterEach(async () => {
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
  await db.supplier.deleteMany({ where: { name: { startsWith: TAG } } })
})

const post = (body: unknown) =>
  new Request('http://test', { method: 'POST', body: JSON.stringify(body) })

describe('inventory write routes', () => {
  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValue(null)
    expect((await postSupplier(post({ name: TAG }))).status).toBe(403)
  })

  it('creates a supplier', async () => {
    admin()
    const res = await postSupplier(post({ name: `${TAG}-supplier` }))
    expect(res.status).toBe(200)
    expect(await db.supplier.count({ where: { name: `${TAG}-supplier` } })).toBe(1)
  })

  it('refuses a supplier with no name rather than creating a blank one', async () => {
    admin()
    expect((await postSupplier(post({ name: '  ' }))).status).toBe(400)
  })

  it('saves purchasing settings against a SKU', async () => {
    admin()
    await db.supplyItem.create({ data: { sku: `${TAG}-A`, name: 'Test' } })
    const res = await putItem(
      new Request('http://test', {
        method: 'PUT',
        body: JSON.stringify({
          sku: `${TAG}-A`, productionDays: 30, deliveryDays: 40,
          moq: 500, unitsPerContainer: 1000, coverDays: null, supplierId: null,
        }),
      }),
    )
    expect(res.status).toBe(200)
    const item = await db.supplyItem.findUniqueOrThrow({ where: { sku: `${TAG}-A` } })
    expect(item.productionDays).toBe(30)
    expect(item.unitsPerContainer).toBe(1000)
  })

  it('refuses a negative lead time', async () => {
    admin()
    await db.supplyItem.create({ data: { sku: `${TAG}-B`, name: 'Test' } })
    const res = await putItem(
      new Request('http://test', {
        method: 'PUT',
        body: JSON.stringify({ sku: `${TAG}-B`, productionDays: -5 }),
      }),
    )
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/inventory/write.test.ts`
Expected: FAIL — cannot resolve `./suppliers/route`

- [ ] **Step 3: Write the suppliers route**

```ts
// src/app/api/inventory/suppliers/route.ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

const guard = async (fn: () => Promise<NextResponse>) => {
  try {
    assertAdmin(await currentUser())
    return await fn()
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not save', 500)
  }
}

export async function GET() {
  return guard(async () =>
    NextResponse.json(
      await db.supplier.findMany({ orderBy: { name: 'asc' } }),
      { headers: NO_STORE },
    ),
  )
}

export async function POST(req: Request) {
  return guard(async () => {
    const body = (await req.json()) as { name?: string; notes?: string }
    const name = (body.name ?? '').trim()
    // A blank name makes a row nobody can identify later, and nothing else in
    // the app can repair it.
    if (!name) return fail('A supplier needs a name', 400)

    const supplier = await db.supplier.create({ data: { name, notes: body.notes ?? null } })
    return NextResponse.json(supplier, { headers: NO_STORE })
  })
}

export async function DELETE(req: Request) {
  return guard(async () => {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail('Which supplier?', 400)
    // Its products are unassigned by the schema's SetNull; their purchase
    // history survives, because it records what actually happened.
    await db.supplier.delete({ where: { id } })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  })
}
```

- [ ] **Step 4: Write the items route**

```ts
// src/app/api/inventory/items/route.ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { ensureSupplyItems } from '@/lib/inventory/supply-items'
import { normaliseSku } from '@/lib/inventory/sku'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

/** Null clears a setting; a number must be a non-negative whole number. */
function whole(value: unknown, field: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: `${field} must be a whole number of 0 or more` }
  }
  return { ok: true, value }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    // Opening the page is the moment to make sure every product we sell has a
    // row, so the list is never empty and nobody types 63 SKUs.
    await ensureSupplyItems()
    return NextResponse.json(
      await db.supplyItem.findMany({
        orderBy: { name: 'asc' },
        include: { supplier: { select: { id: true, name: true } } },
      }),
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not load items', 500)
  }
}

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const body = (await req.json()) as Record<string, unknown>
    const sku = normaliseSku(String(body.sku ?? ''))
    if (!sku) return fail('Which product?', 400)

    const fields = ['productionDays', 'deliveryDays', 'moq', 'unitsPerContainer', 'coverDays'] as const
    const data: Record<string, number | null | string> = {}
    for (const f of fields) {
      if (!(f in body)) continue
      const parsed = whole(body[f], f)
      if (!parsed.ok) return fail(parsed.error, 400)
      data[f] = parsed.value
    }
    if ('supplierId' in body) data.supplierId = (body.supplierId as string | null) ?? null

    const item = await db.supplyItem.update({ where: { sku }, data })
    return NextResponse.json(item, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not save', 500)
  }
}
```

- [ ] **Step 5: Write the purchase-orders route**

```ts
// src/app/api/inventory/purchase-orders/route.ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

const guard = async (fn: () => Promise<NextResponse>) => {
  try {
    assertAdmin(await currentUser())
    return await fn()
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not save', 500)
  }
}

const date = (v: unknown): Date | null => {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

export async function GET() {
  return guard(async () =>
    NextResponse.json(
      await db.purchaseOrder.findMany({
        orderBy: { orderedAt: 'desc' },
        include: { item: { select: { sku: true, name: true } } },
      }),
      { headers: NO_STORE },
    ),
  )
}

export async function POST(req: Request) {
  return guard(async () => {
    const b = (await req.json()) as Record<string, unknown>
    const quantity = Number(b.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0) return fail('How many units?', 400)
    const orderedAt = date(b.orderedAt)
    if (!orderedAt) return fail('When was it ordered?', 400)
    if (!b.supplyItemId) return fail('Which product?', 400)

    const order = await db.purchaseOrder.create({
      data: {
        supplyItemId: String(b.supplyItemId),
        quantity,
        orderedAt,
        // Null is allowed and honest. An order with no ETA is shown on the
        // forecast row but never moves a run-out date.
        eta: date(b.eta),
        notes: (b.notes as string | null) ?? null,
      },
    })
    return NextResponse.json(order, { headers: NO_STORE })
  })
}

export async function PUT(req: Request) {
  return guard(async () => {
    const b = (await req.json()) as Record<string, unknown>
    if (!b.id) return fail('Which order?', 400)

    const data: Record<string, unknown> = {}
    if ('eta' in b) data.eta = date(b.eta)
    if ('receivedAt' in b) data.receivedAt = date(b.receivedAt)
    if ('notes' in b) data.notes = (b.notes as string | null) ?? null
    if ('quantity' in b) {
      const quantity = Number(b.quantity)
      if (!Number.isInteger(quantity) || quantity <= 0) return fail('How many units?', 400)
      data.quantity = quantity
    }

    const order = await db.purchaseOrder.update({ where: { id: String(b.id) }, data })
    return NextResponse.json(order, { headers: NO_STORE })
  })
}

export async function DELETE(req: Request) {
  return guard(async () => {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail('Which order?', 400)
    await db.purchaseOrder.delete({ where: { id } })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  })
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/app/api/inventory/write.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 7: Commit**

```bash
git add src/app/api/inventory/ && git commit -m "feat(inventory): enter suppliers, lead times and what is on the water"
```

---

### Task 12: One sidebar item and the button bar

**Files:**
- Modify: `src/components/shell/AppShell.tsx` (add to the `Analytics` items, after Products at line 115)
- Create: `src/app/inventory/InventoryTabs.tsx`
- Test: `src/app/inventory/InventoryTabs.test.tsx`

**Interfaces:**
- Produces: `InventoryTabs` (client component, its own file); routes `/inventory`, `/inventory/stock`, `/inventory/purchase-orders`, `/inventory/suppliers`

**Note:** the button bar is its own file rather than living in `layout.tsx`. A
`layout.tsx` carrying `'use client'` would turn the whole segment into a client
boundary just to render four links, and every page under it is a server
component that reads the database directly.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/inventory/InventoryTabs.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InventoryTabs } from './InventoryTabs'

vi.mock('next/navigation', () => ({ usePathname: () => '/inventory' }))

describe('InventoryTabs', () => {
  it('offers all four views from one place', () => {
    render(<InventoryTabs />)
    for (const label of ['Forecast', 'Stock', 'Purchase orders', 'Suppliers & lead times']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy()
    }
  })

  it('marks the view you are on, so the buttons say where you are', () => {
    render(<InventoryTabs />)
    expect(screen.getByRole('link', { name: 'Forecast' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Stock' }).getAttribute('aria-current')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/inventory/InventoryTabs.test.tsx`
Expected: FAIL — cannot resolve `./InventoryTabs`

- [ ] **Step 3: Add the nav item**

In `src/components/shell/AppShell.tsx`, immediately after the `/products` entry (which ends at line 115), add:

```tsx
      {
        href: '/inventory',
        label: 'Inventory and forecasting',
        icon: icon(
          <>
            <path d="M3 7h18v5H3z" />
            <path d="M5 12v8h14v-8" />
            <path d="M10 16h4" />
          </>,
        ),
      },
```

- [ ] **Step 4: Write the button bar**

```tsx
// src/app/inventory/InventoryTabs.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Four views behind one sidebar entry.
 *
 * One entry rather than four, because the sidebar already carries 14 items and
 * Philip asked for a single tab. Each button is a real route, so a link to the
 * purchase orders is a link someone can send, and the back button behaves.
 *
 * Forecast is first and is the index route: it is the answer, and the answer
 * should not be behind a click.
 */
const VIEWS = [
  { href: '/inventory', label: 'Forecast' },
  { href: '/inventory/stock', label: 'Stock' },
  { href: '/inventory/purchase-orders', label: 'Purchase orders' },
  { href: '/inventory/suppliers', label: 'Suppliers & lead times' },
] as const

export function InventoryTabs() {
  const pathname = usePathname()

  return (
    <div role="tablist" className="flex flex-wrap gap-1">
      {VIEWS.map((v) => {
        // Exact match for the index, prefix for the rest — otherwise /inventory
        // would light up on every child route at once.
        const active = v.href === '/inventory' ? pathname === v.href : pathname.startsWith(v.href)
        return (
          <Link
            key={v.href}
            href={v.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] transition-colors duration-150 ${
              active
                ? 'bg-accent-soft font-semibold text-accent-ink'
                : 'text-muted hover:bg-panel hover:text-ink'
            }`}
          >
            {v.label}
          </Link>
        )
      })}
    </div>
  )
}
```

No `layout.tsx` is created. The four pages each render `<InventoryTabs />`
themselves, which keeps every page a server component that can read the database
directly.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/inventory/InventoryTabs.test.tsx`
Expected: PASS, 2 tests

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/AppShell.tsx src/app/inventory/
git commit -m "feat(inventory): one sidebar entry, four views behind it"
```

---

### Task 13: The Forecast and Stock pages

**Files:**
- Create: `src/app/inventory/page.tsx`, `src/app/inventory/InventoryClient.tsx`
- Create: `src/app/inventory/stock/page.tsx`, `src/app/inventory/stock/StockClient.tsx`
- Test: `src/app/inventory/InventoryClient.test.tsx`

**Interfaces:**
- Consumes: `GET /api/inventory` from Task 10, `InventoryTabs` from Task 12
- Produces: `InventoryClient` and `StockClient`, both taking `{ rows, unusable }` already fetched

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/inventory/InventoryClient.test.tsx
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { InventoryClient, type Row } from './InventoryClient'

const row = (over: Partial<Row> = {}): Row => ({
  sku: 'PANPIZPRO', name: 'Pizzetta Pro', supplierName: null,
  stock: { quantity: 247, disagrees: false, byShop: [] },
  burn: 4, seasonal: true,
  forecast: {
    runsOutOn: '2026-11-17T00:00:00.000Z', orderBy: '2026-08-25T00:00:00.000Z',
    daysLate: null, quantity: 620, onOrderWithoutEta: 0, note: null,
  },
  byCountry: [{ country: 'NO', units: 90 }],
  ...over,
})

// Assert against the rendered text as a whole rather than getByText. A phrase
// like "61 days late" lives in a <span> inside a <td>, and both elements match
// it — getByText throws on multiple matches, so it would fail on correct markup.
const shows = (ui: ReactElement, pattern: RegExp) =>
  expect(render(ui).container.textContent).toMatch(pattern)

describe('InventoryClient', () => {
  it('answers the question the page exists for', () => {
    const { container } = render(<InventoryClient rows={[row()]} unusable={[]} />)
    expect(container.textContent).toMatch(/Pizzetta Pro/)
    expect(container.textContent).toMatch(/620/)
  })

  it('says why a row has no dates instead of leaving it blank', () => {
    // A blank cell reads as "nothing to worry about", which is the one thing it
    // must never mean.
    shows(
      <InventoryClient rows={[row({
        forecast: { runsOutOn: null, orderBy: null, daysLate: null, quantity: null,
                    onOrderWithoutEta: 0, note: 'set lead times' },
      })]} unusable={[]} />,
      /set lead times/,
    )
  })

  it('warns when the shops disagree about the stock', () => {
    shows(
      <InventoryClient rows={[row({
        stock: { quantity: 906, disagrees: true, byShop: [] },
      })]} unusable={[]} />,
      /shops disagree/i,
    )
  })

  it('shows an order that is already late as late, not as a past date', () => {
    shows(
      <InventoryClient rows={[row({
        forecast: { runsOutOn: '2026-08-20T00:00:00.000Z', orderBy: '2026-06-01T00:00:00.000Z',
                    daysLate: 61, quantity: 620, onOrderWithoutEta: 0, note: null },
      })]} unusable={[]} />,
      /61 days late/i,
    )
  })

  it('names products it had to leave out rather than showing a shorter list', () => {
    const { container } = render(
      <InventoryClient rows={[]} unusable={[
        { shopName: 'Panetti Norway', name: 'Pizzetta Primo', sku: '0' },
      ]} />,
    )
    expect(container.textContent).toMatch(/Pizzetta Primo/)
    expect(container.textContent).toMatch(/needs a SKU/i)
  })

  it('flags a rate with no last year to compare against', () => {
    shows(<InventoryClient rows={[row({ seasonal: false })]} unusable={[]} />, /no seasonal history/i)
  })

  it('teaches the next action when there is nothing at all', () => {
    // Matched on a phrase that appears exactly once, so the assertion cannot
    // pass by accidentally hitting the "Suppliers & lead times" link text.
    shows(<InventoryClient rows={[]} unusable={[]} />, /Nothing to forecast yet/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/inventory/InventoryClient.test.tsx`
Expected: FAIL — cannot resolve `./InventoryClient`

- [ ] **Step 3: Write InventoryClient**

```tsx
// src/app/inventory/InventoryClient.tsx
'use client'

export type Row = {
  sku: string
  name: string
  supplierName: string | null
  stock: { quantity: number | null; disagrees: boolean; byShop: unknown[] }
  burn: number
  seasonal: boolean
  forecast: {
    runsOutOn: string | null
    orderBy: string | null
    daysLate: number | null
    quantity: number | null
    onOrderWithoutEta: number
    note: string | null
  }
  byCountry: { country: string; units: number }[]
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

export function InventoryClient({ rows, unusable }: { rows: Row[]; unusable: { shopName: string; name: string; sku: string }[] }) {
  if (rows.length === 0 && unusable.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        Nothing to forecast yet. Set a supplier and lead times under{' '}
        <span className="font-semibold text-ink">Suppliers &amp; lead times</span>, and the
        forecast fills in as soon as your shops report stock.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2.5">Product</th>
                <th className="px-4 py-2.5">In stock</th>
                <th className="px-4 py-2.5">Per day</th>
                <th className="px-4 py-2.5">Runs out</th>
                <th className="px-4 py-2.5">Order by</th>
                <th className="px-4 py-2.5">How many</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-ink">{r.name}</span>
                    <span className="ml-2 text-[12px] text-faint">{r.sku}</span>
                    {!r.seasonal && (
                      <span className="ml-2 text-[11px] text-muted">no seasonal history yet</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.stock.quantity ?? '—'}
                    {r.stock.disagrees && (
                      <span className="ml-2 text-[11px]" style={{ color: 'var(--warn)' }}>
                        shops disagree
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{r.burn.toFixed(1)}</td>
                  <td className="px-4 py-2.5">
                    {when(r.forecast.runsOutOn) ?? (
                      <span className="text-muted">{r.forecast.note}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.forecast.daysLate !== null ? (
                      <span style={{ color: 'var(--loss)' }}>
                        order now, {r.forecast.daysLate} days late
                      </span>
                    ) : (
                      (when(r.forecast.orderBy) ?? <span className="text-muted">—</span>)
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {r.forecast.quantity ?? '—'}
                    {r.forecast.onOrderWithoutEta > 0 && (
                      <span className="ml-2 text-[11px] text-muted">
                        {r.forecast.onOrderWithoutEta} on order, no ETA
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unusable.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
          <p className="text-[13px] font-semibold text-ink">
            {unusable.length} product{unusable.length === 1 ? '' : 's'} needs a SKU before it can be
            forecast
          </p>
          <p className="mt-1 text-[12px] text-muted">
            These share a SKU that cannot identify a product, so their sales cannot be pooled
            safely. Give each one its own SKU in the webshop.
          </p>
          <ul className="mt-3 space-y-1 text-[12px] text-muted">
            {unusable.map((u, i) => (
              <li key={`${u.shopName}-${u.sku}-${i}`}>
                <span className="text-ink">{u.name}</span> — {u.shopName}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Write the two server pages**

```tsx
// src/app/inventory/page.tsx
import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { loadInventory } from '@/lib/inventory/load'
import { InventoryTabs } from './InventoryTabs'
import { InventoryClient } from './InventoryClient'

export const dynamic = 'force-dynamic'

export default async function InventoryPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  const { rows, unusable } = await loadInventory()

  return (
    <AppShell email={user.email}>
      <PageHeader title="Inventory and forecasting" subtitle="When you run out, and when to order" />
      <PageBody>
        <div className="mb-5">
          <InventoryTabs />
        </div>
        <InventoryClient
          rows={rows.map((r) => ({
            ...r,
            forecast: {
              ...r.forecast,
              runsOutOn: r.forecast.runsOutOn?.toISOString() ?? null,
              orderBy: r.forecast.orderBy?.toISOString() ?? null,
            },
            stock: { ...r.stock, byShop: r.stock.byShop },
          }))}
          unusable={unusable}
        />
      </PageBody>
    </AppShell>
  )
}
```

```tsx
// src/app/inventory/stock/page.tsx
import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { loadInventory } from '@/lib/inventory/load'
import { InventoryTabs } from '../InventoryTabs'
import { StockClient } from './StockClient'

export const dynamic = 'force-dynamic'

export default async function StockPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  const { rows } = await loadInventory()

  return (
    <AppShell email={user.email}>
      <PageHeader title="Inventory and forecasting" subtitle="What each shop says is on the shelf" />
      <PageBody>
        <div className="mb-5">
          <InventoryTabs />
        </div>
        <StockClient
          rows={rows.map((r) => ({
            sku: r.sku,
            name: r.name,
            quantity: r.stock.quantity,
            disagrees: r.stock.disagrees,
            byShop: r.stock.byShop.map((s) => ({
              shopName: s.shopName,
              quantity: s.quantity,
              updatedAt: s.updatedAt?.toISOString() ?? null,
            })),
          }))}
        />
      </PageBody>
    </AppShell>
  )
}
```

```tsx
// src/app/inventory/stock/StockClient.tsx
'use client'

export type StockRow = {
  sku: string
  name: string
  quantity: number | null
  disagrees: boolean
  byShop: { shopName: string; quantity: number | null; updatedAt: string | null }[]
}

/**
 * What each shop says, side by side.
 *
 * Disagreements sort to the top, because a mirror that has drifted is invisible
 * on any single store — each one looks perfectly consistent with itself.
 */
export function StockClient({ rows }: { rows: StockRow[] }) {
  const sorted = [...rows].sort((a, b) => Number(b.disagrees) - Number(a.disagrees))

  if (sorted.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        No stock reported yet. Stock arrives with the next completed sync of each shop.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {sorted.map((r) => (
        <div key={r.sku} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] font-semibold text-ink">
              {r.name} <span className="ml-1 font-normal text-faint">{r.sku}</span>
            </p>
            <p className="text-[13px] tabular-nums text-ink">
              {r.quantity ?? 'no stock data'}
              {r.disagrees && (
                <span className="ml-2 text-[11px]" style={{ color: 'var(--warn)' }}>
                  shops disagree
                </span>
              )}
            </p>
          </div>
          {r.disagrees && (
            <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
              {r.byShop.map((s) => (
                <li key={s.shopName}>
                  {s.shopName}: <span className="tabular-nums text-ink">{s.quantity ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/inventory/InventoryClient.test.tsx`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add src/app/inventory/
git commit -m "feat(inventory): the forecast page, and every blank says why"
```

---

### Task 14: The Suppliers and Purchase orders pages

**Files:**
- Create: `src/app/inventory/suppliers/page.tsx`, `src/app/inventory/suppliers/SuppliersClient.tsx`
- Create: `src/app/inventory/purchase-orders/page.tsx`, `src/app/inventory/purchase-orders/PurchaseOrdersClient.tsx`
- Test: `src/app/inventory/suppliers/SuppliersClient.test.tsx`

**Interfaces:**
- Consumes: the routes from Task 11, `InventoryTabs` from Task 12
- Produces: `SuppliersClient({ items, suppliers })`, `PurchaseOrdersClient({ orders, items })`

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/inventory/suppliers/SuppliersClient.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SuppliersClient, type Item } from './SuppliersClient'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1', sku: 'PANPIZPRO', name: 'Pizzetta Pro', supplierId: null,
  productionDays: null, deliveryDays: null, moq: null,
  unitsPerContainer: null, coverDays: null,
  ...over,
})

describe('SuppliersClient', () => {
  // Same reason as InventoryClient's tests: a product name sits in a <p> inside
  // a <div>, and both match. getByText throws on multiple matches.
  it('lists every product so nobody has to type a SKU', () => {
    const { container } = render(<SuppliersClient items={[item()]} suppliers={[]} />)
    expect(container.textContent).toMatch(/Pizzetta Pro/)
  })

  it('shows what a product still needs, rather than looking finished', () => {
    const { container } = render(<SuppliersClient items={[item()]} suppliers={[]} />)
    expect(container.textContent).toMatch(/needs lead times/i)
  })

  it('saves a lead time', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    render(<SuppliersClient items={[item()]} suppliers={[]} />)

    const production = screen.getByLabelText(/production days/i)
    await userEvent.type(production, '30')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/inventory/items',
      expect.objectContaining({ method: 'PUT' }),
    )
    fetchSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/inventory/suppliers/SuppliersClient.test.tsx`
Expected: FAIL — cannot resolve `./SuppliersClient`

- [ ] **Step 3: Write SuppliersClient**

```tsx
// src/app/inventory/suppliers/SuppliersClient.tsx
'use client'

import { useState } from 'react'

export type Item = {
  id: string
  sku: string
  name: string
  supplierId: string | null
  productionDays: number | null
  deliveryDays: number | null
  moq: number | null
  unitsPerContainer: number | null
  coverDays: number | null
}

export type Supplier = { id: string; name: string }

const FIELDS = [
  { key: 'productionDays', label: 'Production days' },
  { key: 'deliveryDays', label: 'Delivery days' },
  { key: 'moq', label: 'MOQ' },
  { key: 'unitsPerContainer', label: 'Units per 40HQ' },
  { key: 'coverDays', label: 'Cover days' },
] as const

/**
 * The purchasing facts, one row per product.
 *
 * Every product we sell is listed whether or not anyone has filled it in, and a
 * row that is not ready says so. A page that looked complete while half its
 * rows were empty would produce a forecast full of dashes and no explanation.
 */
export function SuppliersClient({ items, suppliers }: { items: Item[]; suppliers: Supplier[] }) {
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState<string | null>(null)

  const value = (item: Item, key: string) =>
    draft[item.sku]?.[key] ?? (item[key as keyof Item] === null ? '' : String(item[key as keyof Item]))

  async function save(item: Item) {
    setSaving(item.sku)
    const edits = draft[item.sku] ?? {}
    const body: Record<string, unknown> = { sku: item.sku }
    for (const f of FIELDS) {
      if (!(f.key in edits)) continue
      body[f.key] = edits[f.key] === '' ? null : Number(edits[f.key])
    }
    if ('supplierId' in edits) body.supplierId = edits.supplierId || null

    await fetch('/api/inventory/items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(null)
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const ready = item.productionDays !== null && item.deliveryDays !== null
        return (
          <div key={item.sku} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[13px] font-semibold text-ink">
                {item.name} <span className="ml-1 font-normal text-faint">{item.sku}</span>
              </p>
              {!ready && (
                <span className="text-[11px]" style={{ color: 'var(--warn)' }}>
                  needs lead times before it can be forecast
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-[12px] text-muted">
                <span className="block pb-1">Supplier</span>
                <select
                  value={value(item, 'supplierId')}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [item.sku]: { ...d[item.sku], supplierId: e.target.value } }))
                  }
                  className="rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
                >
                  <option value="">—</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>

              {FIELDS.map((f) => (
                <label key={f.key} className="text-[12px] text-muted">
                  <span className="block pb-1">{f.label}</span>
                  <input
                    aria-label={f.label}
                    inputMode="numeric"
                    value={value(item, f.key)}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [item.sku]: { ...d[item.sku], [f.key]: e.target.value } }))
                    }
                    className="w-24 rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
                  />
                </label>
              ))}

              <button
                onClick={() => save(item)}
                disabled={saving === item.sku}
                className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
              >
                {saving === item.sku ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Write PurchaseOrdersClient and both server pages**

```tsx
// src/app/inventory/purchase-orders/PurchaseOrdersClient.tsx
'use client'

import { useState } from 'react'

export type Order = {
  id: string
  quantity: number
  orderedAt: string
  eta: string | null
  receivedAt: string | null
  item: { sku: string; name: string }
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

/**
 * What is on order and when it lands.
 *
 * An order with no ETA is listed with the reason spelled out, because it is
 * doing nothing for the forecast until someone sets one — counting stock whose
 * arrival nobody knows would push a run-out date out on a guess.
 */
export function PurchaseOrdersClient({
  orders,
  items,
}: {
  orders: Order[]
  items: { id: string; sku: string; name: string }[]
}) {
  const [busy, setBusy] = useState(false)

  async function markReceived(id: string) {
    setBusy(true)
    await fetch('/api/inventory/purchase-orders', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, receivedAt: new Date().toISOString() }),
    })
    setBusy(false)
  }

  if (orders.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        Nothing on order. Add a purchase order here and the forecast will count it as
        incoming stock from the day it is expected to land.
        {items.length === 0 && ' No products are set up yet either.'}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            <th className="px-4 py-2.5">Product</th>
            <th className="px-4 py-2.5">Units</th>
            <th className="px-4 py-2.5">Ordered</th>
            <th className="px-4 py-2.5">Expected</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-b border-line last:border-0">
              <td className="px-4 py-2.5 text-ink">{o.item.name}</td>
              <td className="px-4 py-2.5 tabular-nums">{o.quantity}</td>
              <td className="px-4 py-2.5">{when(o.orderedAt)}</td>
              <td className="px-4 py-2.5">
                {when(o.eta) ?? (
                  <span style={{ color: 'var(--warn)' }}>no ETA, so it moves no date</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right">
                {o.receivedAt ? (
                  <span className="text-muted">received {when(o.receivedAt)}</span>
                ) : (
                  <button
                    onClick={() => markReceived(o.id)}
                    disabled={busy}
                    className="text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Mark received
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

```tsx
// src/app/inventory/suppliers/page.tsx
import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { ensureSupplyItems } from '@/lib/inventory/supply-items'
import { InventoryTabs } from '../InventoryTabs'
import { SuppliersClient } from './SuppliersClient'

export const dynamic = 'force-dynamic'

export default async function SuppliersPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  await ensureSupplyItems()
  const [items, suppliers] = await Promise.all([
    db.supplyItem.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    db.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
  ])

  return (
    <AppShell email={user.email}>
      <PageHeader title="Inventory and forecasting" subtitle="Who makes what, and how long it takes" />
      <PageBody>
        <div className="mb-5"><InventoryTabs /></div>
        <SuppliersClient
          items={items.map((i) => ({
            id: i.id, sku: i.sku, name: i.name, supplierId: i.supplierId,
            productionDays: i.productionDays, deliveryDays: i.deliveryDays,
            moq: i.moq, unitsPerContainer: i.unitsPerContainer, coverDays: i.coverDays,
          }))}
          suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        />
      </PageBody>
    </AppShell>
  )
}
```

```tsx
// src/app/inventory/purchase-orders/page.tsx
import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { InventoryTabs } from '../InventoryTabs'
import { PurchaseOrdersClient } from './PurchaseOrdersClient'

export const dynamic = 'force-dynamic'

export default async function PurchaseOrdersPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  const [orders, items] = await Promise.all([
    db.purchaseOrder.findMany({
      orderBy: { orderedAt: 'desc' },
      include: { item: { select: { sku: true, name: true } } },
    }),
    db.supplyItem.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
  ])

  return (
    <AppShell email={user.email}>
      <PageHeader title="Inventory and forecasting" subtitle="What is on the water" />
      <PageBody>
        <div className="mb-5"><InventoryTabs /></div>
        <PurchaseOrdersClient
          orders={orders.map((o) => ({
            id: o.id, quantity: o.quantity,
            orderedAt: o.orderedAt.toISOString(),
            eta: o.eta?.toISOString() ?? null,
            receivedAt: o.receivedAt?.toISOString() ?? null,
            item: o.item,
          }))}
          items={items.map((i) => ({ id: i.id, sku: i.sku, name: i.name }))}
        />
      </PageBody>
    </AppShell>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/inventory/suppliers/SuppliersClient.test.tsx`
Expected: PASS, 3 tests

- [ ] **Step 6: Run the whole suite and the build**

Run: `npx vitest run --testTimeout=20000`
Expected: PASS. Known flake: 2-3 `src/lib/woo/sync.test.ts` timeouts under full-suite load are contention, not a regression — re-run that file alone to confirm.

Run: `npx tsc --noEmit && npm run build`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/app/inventory/
git commit -m "feat(inventory): enter who makes it, how long it takes, and what is on the water"
```

---

## Phase 3, deferred: Visma purchase order import

Not planned here, deliberately. `PurchaseOrder.externalId` is the entire seam: an
importer creates and updates those rows instead of a person typing them, and
nothing downstream changes.

It cannot be planned yet without guessing. We have no Visma access, and the path
to it — register a developer organisation at `oauth.developers.visma.com`,
register a Service application, get the API integration approved by Visma, then
publish invite-only to the App Store for the customer's own approval — has not
started. Writing endpoint-level steps against a response shape nobody has seen
would be exactly the guessing this work is meant to replace.

It gets its own spec and plan once access exists. Nothing above waits for it.

## What Philip must supply before the forecast shows real numbers

1. **The supplier list**, and which supplier makes which product.
2. **Production days and delivery days per product.** Until both are set, a row
   says "set lead times" and gives no order-by date.
3. **MOQ and units per 40HQ container**, where they apply.
4. **A real SKU for the six products currently sharing `"0"`.** Until then they
   are named on the page and excluded.
5. **Confirmation that it is one warehouse.** The stock data says so; his word
   would settle it.
