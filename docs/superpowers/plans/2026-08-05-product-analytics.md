# Product Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/products` page showing per-product orders, quantity, revenue, COGS, profit and margin over a date range, merged across stores on SKU with a per-store drill-down, viewable multi-store only when the stores share a currency.

**Architecture:** A pure aggregation function (`productFigures`) fed by a dedicated loader (`loadProductsInput`), exposed through an admin-only JSON route, rendered by a client page that reuses the existing `ShopFilter` and `DateFilter`. The engine's private refund-reversal helper `entriesIn` is exported and shared so the two pages can never disagree about a refund.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.4, Prisma 6.19.3 / PostgreSQL, Vitest 4.1.10, Tailwind v4.

## Global Constraints

- All money is INTEGER MINOR UNITS. Never a float. Convert for display only, via `formatMoney(minor, currency)` from `@/lib/money`.
- Profit is `netSales - cogs`. Nothing is apportioned - no shipping, fees, fulfillment, commission or ad spend.
- `Figures.marketing` (ad spend, added in `037c96b`) is a SHOP-level figure. No column on this page consumes it.
- Multi-store view requires a single shared currency. A mixed selection is refused, never converted.
- Display currency is the group's own currency, never USD.
- Products merge on `sku`, EXCEPT where `sku === externalId` (the no-SKU fallback at `map.ts:101`), which never merge.
- `orders` means DISTINCT orders, counting sale entries only (`sign === 1`).
- Costs resolve through `costOn(history, order.placedAt)` - dated, never "current".
- Ratios with a zero denominator return `0` from the lib and render `-` in the UI, matching `ratios()` in `marketing.ts`.
- Tests run against the local portable Postgres. NEVER against live Neon. `npm run db:seed` WIPES ALL DATA.
- Do NOT use `git stash`, `git checkout --`, `git restore`, or `git reset --hard` at any point. Commit forward only.
- Before every commit, run `git branch --show-current` and confirm it is `feat/product-analytics`. A background sync worktree has moved this checkout before.

---

### Task 1: Export the refund-reversal helper from the engine

Making `entriesIn` shared, and generic so it preserves richer item types. No behaviour changes - the existing engine tests passing unchanged is the proof.

**Files:**
- Modify: `src/lib/metrics/engine.ts:70-96`
- Test: `src/lib/metrics/engine.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `export type Entry<T extends EngineOrder = EngineOrder> = { order: T; sign: 1 | -1 }` and `export function entriesIn<T extends EngineOrder>(orders: T[], from: Date, to: Date, tzFor: (id: string) => string): Entry<T>[]`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/metrics/engine.test.ts`:

```ts
describe('entriesIn (shared with the product page)', () => {
  const tzFor = () => 'UTC'

  it('gives a live order one positive entry', () => {
    const res = entriesIn([order()], new Date('2026-07-01'), new Date('2026-07-01'), tzFor)
    expect(res).toHaveLength(1)
    expect(res[0].sign).toBe(1)
  })

  it('gives a refunded order a positive entry on its placed day and a negative one on its voided day', () => {
    const refunded = order({
      status: 'refunded',
      placedAt: new Date('2026-07-01'),
      voidedAt: new Date('2026-07-05'),
    })
    const res = entriesIn([refunded], new Date('2026-07-01'), new Date('2026-07-31'), tzFor)
    expect(res.map((e) => e.sign).sort()).toEqual([-1, 1])
  })

  it('leaves a refunded order alone when we never learned the void date', () => {
    const refunded = order({ status: 'refunded', voidedAt: null })
    expect(entriesIn([refunded], new Date('2026-07-01'), new Date('2026-07-31'), tzFor)).toEqual([])
  })

  it('preserves the caller’s own item type', () => {
    const rich = { ...order(), items: [{ productId: 'p1', quantity: 2, lineNetTotal: 90000, sku: 'SKU-1' }] }
    const res = entriesIn([rich], new Date('2026-07-01'), new Date('2026-07-01'), tzFor)
    // Compiles only if the generic carried `sku` through rather than widening.
    expect(res[0].order.items[0].sku).toBe('SKU-1')
  })
})
```

Add `entriesIn` to the existing import at the top of the file:

```ts
import { computeMetrics, entriesIn } from './engine'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/metrics/engine.test.ts`
Expected: FAIL - `entriesIn is not exported by ./engine` (or `entriesIn is not a function`).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/metrics/engine.ts`, replace the `Entry` type and the `entriesIn` signature. The body is unchanged; only the type line, the `export` keywords and the generic are new:

```ts
/**
 * An order as the period sees it. A sale is one entry at +1. A refund is TWO:
 * the original sale still stands on the day it happened, and the whole order
 * comes back off on the day the money did. Every figure is multiplied by
 * `sign`, so the reversal is the same arithmetic rather than a second set of
 * rules that could drift from it.
 *
 * Exported because the product page must reverse a refund the same way this
 * one does. A private copy is how two screens come to disagree about a refund.
 * Generic so a caller carrying richer line items (the product page needs sku,
 * name and unitPrice) gets them back rather than having them widened away.
 */
export type Entry<T extends EngineOrder = EngineOrder> = { order: T; sign: 1 | -1 }

export function entriesIn<T extends EngineOrder>(
  orders: T[],
  from: Date,
  to: Date,
  tzFor: (id: string) => string,
): Entry<T>[] {
  const out: Entry<T>[] = []
  // ...body unchanged...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/metrics/engine.test.ts`
Expected: PASS, including every pre-existing test in the file. If any pre-existing test now fails, the export changed behaviour - revert the body change, keep only the signature.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/product-analytics
git add src/lib/metrics/engine.ts src/lib/metrics/engine.test.ts
git commit -m "refactor: export entriesIn so the product page reverses refunds identically"
```

---

### Task 2: Currency grouping helpers

Small, pure, and used by both the client and the API route. Built first so both later tasks can rely on it.

**Files:**
- Create: `src/lib/currency-groups.ts`
- Test: `src/lib/currency-groups.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export type ShopLike = { id: string; name: string; currency: string }`
  - `export function groupByCurrency<T extends ShopLike>(shops: T[]): { currency: string; shops: T[] }[]`
  - `export function selectedShops<T extends ShopLike>(shops: T[], selected: string[]): T[]`
  - `export const NO_SHOPS = 'none'` is NOT redefined here - import it from `@/components/filters/ShopFilter`

- [ ] **Step 1: Write the failing test**

Create `src/lib/currency-groups.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { groupByCurrency, selectedShops } from './currency-groups'

const SHOPS = [
  { id: 'no', name: 'Panetti Norway', currency: 'NOK' },
  { id: 'de', name: 'Panetti Germany', currency: 'EUR' },
  { id: 'fi', name: 'Panetti Finland', currency: 'EUR' },
  { id: 'se', name: 'Panetti Sweden', currency: 'SEK' },
]

describe('groupByCurrency', () => {
  it('puts two EUR countries in one group', () => {
    const groups = groupByCurrency(SHOPS)
    const eur = groups.find((g) => g.currency === 'EUR')!
    expect(eur.shops.map((s) => s.id).sort()).toEqual(['de', 'fi'])
  })

  it('orders groups by currency so the UI never reshuffles between renders', () => {
    expect(groupByCurrency(SHOPS).map((g) => g.currency)).toEqual(['EUR', 'NOK', 'SEK'])
  })

  it('returns nothing for no shops', () => {
    expect(groupByCurrency([])).toEqual([])
  })
})

describe('selectedShops', () => {
  it('treats an empty selection as every shop', () => {
    expect(selectedShops(SHOPS, [])).toHaveLength(4)
  })

  it('treats the none sentinel as no shops at all', () => {
    expect(selectedShops(SHOPS, ['none'])).toEqual([])
  })

  it('keeps only the chosen ids', () => {
    expect(selectedShops(SHOPS, ['de', 'fi']).map((s) => s.id)).toEqual(['de', 'fi'])
  })

  it('ignores an id that matches no shop rather than inventing one', () => {
    expect(selectedShops(SHOPS, ['de', 'ghost']).map((s) => s.id)).toEqual(['de'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/currency-groups.test.ts`
Expected: FAIL - cannot resolve `./currency-groups`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/currency-groups.ts`:

```ts
import { NO_SHOPS } from '@/components/filters/ShopFilter'

/**
 * Adding two stores' money together is only honest when they trade in the same
 * currency. This is the rule the product page is gated on: `Shop` records a
 * currency and no country, and currency is what protects the arithmetic anyway
 * - Finland and Germany are different countries, both EUR, and EUR + EUR is
 * correct.
 */

export type ShopLike = { id: string; name: string; currency: string }

/** Grouped by currency, groups ordered by currency code so renders are stable. */
export function groupByCurrency<T extends ShopLike>(shops: T[]): { currency: string; shops: T[] }[] {
  const byCurrency = new Map<string, T[]>()
  for (const shop of shops) {
    const list = byCurrency.get(shop.currency) ?? []
    list.push(shop)
    byCurrency.set(shop.currency, list)
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, group]) => ({ currency, shops: group }))
}

/**
 * ShopFilter's selection vocabulary resolved to actual shops: empty means all
 * of them, the NO_SHOPS sentinel means none. An unknown id is dropped rather
 * than fabricated, so a stale URL cannot conjure a shop.
 */
export function selectedShops<T extends ShopLike>(shops: T[], selected: string[]): T[] {
  if (selected.includes(NO_SHOPS)) return []
  if (selected.length === 0) return shops
  return shops.filter((s) => selected.includes(s.id))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/currency-groups.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/product-analytics
git add src/lib/currency-groups.ts src/lib/currency-groups.test.ts
git commit -m "feat: currency grouping helpers for the product page's multi-store rule"
```

---

### Task 3: `productFigures` - the aggregation

The core of the feature. Pure, no database.

**Files:**
- Create: `src/lib/metrics/products.ts`
- Test: `src/lib/metrics/products.test.ts`

**Interfaces:**
- Consumes: `entriesIn`, `Entry` (Task 1); `costOn` from `./costs`; `convert` from `./fx`; `sum` from `../money`; `CostBook`, `EngineOrder`, `EngineOrderItem`, `EngineShop`, `RateTable` from `./types`
- Produces:

```ts
export type ProductLine = EngineOrderItem & { sku: string; name: string; unitPrice: number }
export type ProductOrder = Omit<EngineOrder, 'items'> & { items: ProductLine[] }
export type ProductMeta = { productId: string; shopId: string; sku: string; externalId: string; name: string; imageUrl: string | null }
export type ProductTotals = { orders: number; quantity: number; grossSales: number; netSales: number; cogs: number; profit: number; margin: number }
export type ProductStoreRow = ProductTotals & { shopId: string; shopName: string; productId: string; name: string; hasCost: boolean }
export type ProductRow = ProductTotals & { key: string; sku: string; name: string; imageUrl: string | null; hasCost: boolean; stores: ProductStoreRow[] }
export type ProductInput = { shops: EngineShop[]; orders: ProductOrder[]; products: Map<string, ProductMeta>; costs: CostBook; rates: RateTable; displayCurrency: string; from: Date; to: Date; timezone?: string; shopTimezones?: Map<string, string> }
export type ProductResult = { displayCurrency: string; rows: ProductRow[]; total: ProductTotals; uncosted: number }
export function productFigures(input: ProductInput): ProductResult
export function mergeKey(meta: ProductMeta): string
```

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/products.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { productFigures, mergeKey } from './products'
import { buildRateTable } from './fx'
import type { CostBook, EngineShop } from './types'
import type { ProductMeta, ProductOrder } from './products'

const shops: EngineShop[] = [
  { id: 'de', name: 'Panetti Germany', currency: 'EUR' },
  { id: 'fi', name: 'Panetti Finland', currency: 'EUR' },
]

// 1 NOK = 0.10 USD, 1 EUR = 1.00 USD  -> 1 EUR = 10 NOK
const rates = buildRateTable([
  { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-01'), currency: 'EUR', rate: 1 },
])

// The same product listed in two stores, sharing one SKU.
const products = new Map<string, ProductMeta>([
  ['p-de', { productId: 'p-de', shopId: 'de', sku: 'PZ-PRO', externalId: '42', name: 'Elektrischer Pizzaofen', imageUrl: 'de.png' }],
  ['p-fi', { productId: 'p-fi', shopId: 'fi', sku: 'PZ-PRO', externalId: '77', name: 'Sahkoinen pizzauuni', imageUrl: null }],
])

// 30.00 EUR/item + 2.00 handling from 1 Jan 2026.
const costs: CostBook = new Map([
  ['p-de', [{ costPerItem: 3000, handlingCost: 200, effectiveFrom: new Date('2026-01-01') }]],
  ['p-fi', [{ costPerItem: 3000, handlingCost: 200, effectiveFrom: new Date('2026-01-01') }]],
])

function order(over: Partial<ProductOrder> = {}): ProductOrder {
  return {
    id: 'o1',
    shopId: 'de',
    placedAt: new Date('2026-07-01'),
    status: 'completed',
    voidedAt: null,
    currency: 'EUR',
    costCurrency: 'EUR',
    grossSales: 20000,
    discountTotal: 0,
    netSales: 20000,
    shippingCharged: 0,
    taxTotal: 0,
    total: 20000,
    ambassadorId: null,
    commissionRate: 0,
    items: [{ productId: 'p-de', sku: 'PZ-PRO', name: 'Elektrischer Pizzaofen', quantity: 2, unitPrice: 10000, lineNetTotal: 20000 }],
    ...over,
  }
}

const run = (orders: ProductOrder[], over: Partial<Parameters<typeof productFigures>[0]> = {}) =>
  productFigures({
    shops,
    orders,
    products,
    costs,
    rates,
    displayCurrency: 'EUR',
    from: new Date('2026-07-01'),
    to: new Date('2026-07-31'),
    ...over,
  })

describe('productFigures', () => {
  it('computes one product in one store', () => {
    const res = run([order()])
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row.sku).toBe('PZ-PRO')
    expect(row.orders).toBe(1)
    expect(row.quantity).toBe(2)
    expect(row.grossSales).toBe(20000) // 2 x 100.00
    expect(row.netSales).toBe(20000)
    expect(row.cogs).toBe(6400) // 2 x (3000 + 200)
    expect(row.profit).toBe(13600)
    expect(row.margin).toBeCloseTo(0.68)
  })

  it('merges the same SKU across two stores and the children sum to the parent', () => {
    const fi = order({
      id: 'o2',
      shopId: 'fi',
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Sahkoinen pizzauuni', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 }],
      netSales: 10000,
    })
    const res = run([order(), fi])

    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row.stores).toHaveLength(2)
    expect(row.quantity).toBe(3)
    expect(row.netSales).toBe(30000)
    expect(row.orders).toBe(2)
    expect(sumOf(row.stores, 'netSales')).toBe(row.netSales)
    expect(sumOf(row.stores, 'cogs')).toBe(row.cogs)
    expect(sumOf(row.stores, 'quantity')).toBe(row.quantity)
    expect(sumOf(row.stores, 'orders')).toBe(row.orders)
  })

  it('never merges products that have no real SKU', () => {
    // map.ts falls back to the Woo product id when a listing has no SKU, and
    // those ids are per-store sequential: two stores' product #42 are not one product.
    const noSku = new Map<string, ProductMeta>([
      ['p-de', { productId: 'p-de', shopId: 'de', sku: '42', externalId: '42', name: 'Ofen', imageUrl: null }],
      ['p-fi', { productId: 'p-fi', shopId: 'fi', sku: '42', externalId: '42', name: 'Uuni', imageUrl: null }],
    ])
    const fi = order({
      id: 'o2',
      shopId: 'fi',
      items: [{ productId: 'p-fi', sku: '42', name: 'Uuni', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 }],
    })
    const res = run([order(), fi], { products: noSku })
    expect(res.rows).toHaveLength(2)
  })

  it('removes a refunded order on the day the money went back', () => {
    const refunded = order({ status: 'refunded', placedAt: new Date('2026-07-01'), voidedAt: new Date('2026-07-05') })
    const whole = run([refunded])
    expect(whole.rows[0].netSales).toBe(0)
    expect(whole.rows[0].cogs).toBe(0)

    // The sale alone, before the refund landed.
    const before = run([refunded], { from: new Date('2026-07-01'), to: new Date('2026-07-03') })
    expect(before.rows[0].netSales).toBe(20000)
  })

  it('counts a reversal as no order at all', () => {
    const refunded = order({ status: 'refunded', placedAt: new Date('2026-07-01'), voidedAt: new Date('2026-07-05') })
    expect(run([refunded]).rows[0].orders).toBe(1) // the sale, not the reversal
  })

  it('counts an order listing the same product twice as one order', () => {
    const twice = order({
      items: [
        { productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 },
        { productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 },
      ],
    })
    const row = run([twice]).rows[0]
    expect(row.orders).toBe(1)
    expect(row.quantity).toBe(2)
  })

  it('reads the cost that was true on the order date, not the newest one', () => {
    const dated: CostBook = new Map([
      ['p-de', [
        { costPerItem: 3000, handlingCost: 0, effectiveFrom: new Date('2026-01-01') },
        { costPerItem: 9000, handlingCost: 0, effectiveFrom: new Date('2026-07-15') },
      ]],
    ])
    expect(run([order()], { costs: dated }).rows[0].cogs).toBe(6000) // 2 x 3000, the July 1st cost
  })

  it('converts a B2B order invoiced in another currency', () => {
    // A NOK-invoiced order from a EUR shop: 2000.00 NOK = 200.00 EUR.
    const b2b = order({ currency: 'NOK', costCurrency: 'EUR', netSales: 200000, grossSales: 200000,
      items: [{ productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 2, unitPrice: 100000, lineNetTotal: 200000 }] })
    const row = run([b2b]).rows[0]
    expect(row.netSales).toBe(20000) // converted to EUR
    expect(row.cogs).toBe(6400) // costs were already EUR, untouched
  })

  it('marks a product with no cost entered, and margins do not silently read as 100%', () => {
    const row = run([order()], { costs: new Map() }).rows[0]
    expect(row.hasCost).toBe(false)
    expect(row.cogs).toBe(0)
    expect(run([order()], { costs: new Map() }).uncosted).toBe(1)
  })

  it('yields no margin rather than Infinity when nothing was sold', () => {
    const free = order({ netSales: 0, grossSales: 0,
      items: [{ productId: 'p-de', sku: 'PZ-PRO', name: 'Ofen', quantity: 1, unitPrice: 0, lineNetTotal: 0 }] })
    const row = run([free]).rows[0]
    expect(row.margin).toBe(0)
    expect(Number.isFinite(row.margin)).toBe(true)
  })

  it('sums the total and recomputes its margin rather than averaging the rows', () => {
    const fi = order({ id: 'o2', shopId: 'fi',
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Uuni', quantity: 1, unitPrice: 10000, lineNetTotal: 10000 }],
      netSales: 10000, grossSales: 10000 })
    const res = run([order(), fi])
    expect(res.total.netSales).toBe(30000)
    expect(res.total.cogs).toBe(9600)
    expect(res.total.margin).toBeCloseTo(res.total.profit / res.total.netSales)
  })

  it('sorts the best earner first', () => {
    const cheap = new Map(products)
    cheap.set('p2', { productId: 'p2', shopId: 'de', sku: 'CHEAP', externalId: '99', name: 'Brush', imageUrl: null })
    const small = order({ id: 'o2', netSales: 500, grossSales: 500,
      items: [{ productId: 'p2', sku: 'CHEAP', name: 'Brush', quantity: 1, unitPrice: 500, lineNetTotal: 500 }] })
    const res = run([order(), small], { products: cheap })
    expect(res.rows.map((r) => r.sku)).toEqual(['PZ-PRO', 'CHEAP'])
  })

  it('names a merged row after its biggest seller so it reads in one language', () => {
    const fi = order({ id: 'o2', shopId: 'fi', netSales: 90000, grossSales: 90000,
      items: [{ productId: 'p-fi', sku: 'PZ-PRO', name: 'Sahkoinen pizzauuni', quantity: 9, unitPrice: 10000, lineNetTotal: 90000 }] })
    expect(run([order(), fi]).rows[0].name).toBe('Sahkoinen pizzauuni')
  })

  it('ignores an unpaid order entirely', () => {
    expect(run([order({ status: 'pending' })]).rows).toEqual([])
  })
})

describe('mergeKey', () => {
  it('keys on the SKU when there is a real one', () => {
    expect(mergeKey({ productId: 'p', shopId: 's', sku: 'PZ-PRO', externalId: '42', name: 'x', imageUrl: null }))
      .toBe('sku:PZ-PRO')
  })

  it('keys on the product itself when the SKU is only the Woo id', () => {
    const key = mergeKey({ productId: 'p', shopId: 's', sku: '42', externalId: '42', name: 'x', imageUrl: null })
    expect(key).not.toBe('sku:42')
    expect(key).toContain('p')
  })
})

function sumOf<T>(rows: T[], field: keyof T): number {
  return rows.reduce((a, r) => a + (r[field] as number), 0)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/metrics/products.test.ts`
Expected: FAIL - cannot resolve `./products`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/metrics/products.ts`:

```ts
import { sum } from '../money'
import { costOn } from './costs'
import { entriesIn } from './engine'
import { convert } from './fx'
import type { CostBook, EngineOrder, EngineOrderItem, EngineShop, RateTable } from './types'

/**
 * How each product performed, per store, over one period.
 *
 * Profit here is net sales minus COGS and NOTHING else. Shipping, gateway fees,
 * fulfillment and ambassador commission sit on the ORDER, not the product;
 * splitting them by share of line value would turn every figure on the page
 * into an estimate. Ad spend is per campaign and is excluded for the same
 * reason, more strongly - no data we hold ties a campaign to a product.
 *
 * Refund handling is not reimplemented here. `entriesIn` is the engine's own,
 * so a refund comes off this page on exactly the day it comes off the
 * Dashboard, permanently.
 */

export type ProductLine = EngineOrderItem & { sku: string; name: string; unitPrice: number }
export type ProductOrder = Omit<EngineOrder, 'items'> & { items: ProductLine[] }

export type ProductMeta = {
  productId: string
  shopId: string
  sku: string
  /** The Woo product id. Equal to `sku` exactly when the listing had no SKU. */
  externalId: string
  name: string
  imageUrl: string | null
}

export type ProductTotals = {
  orders: number
  quantity: number
  grossSales: number
  netSales: number
  cogs: number
  profit: number
  margin: number
}

export type ProductStoreRow = ProductTotals & {
  shopId: string
  shopName: string
  productId: string
  name: string
  hasCost: boolean
}

export type ProductRow = ProductTotals & {
  key: string
  sku: string
  name: string
  imageUrl: string | null
  hasCost: boolean
  stores: ProductStoreRow[]
}

export type ProductInput = {
  shops: EngineShop[]
  orders: ProductOrder[]
  products: Map<string, ProductMeta>
  costs: CostBook
  rates: RateTable
  displayCurrency: string
  from: Date
  to: Date
  timezone?: string
  shopTimezones?: Map<string, string>
}

export type ProductResult = {
  displayCurrency: string
  rows: ProductRow[]
  total: ProductTotals
  uncosted: number
}

/**
 * What makes two rows the same product.
 *
 * The SKU, except when there isn't one: `map.ts` falls back to the Woo product
 * id (`li.sku || String(li.product_id)`), and those ids are per-store
 * sequential. Merging on them would fold two different stores' product #42
 * into a single row that adds up unrelated money.
 */
export function mergeKey(meta: ProductMeta): string {
  if (meta.sku && meta.sku !== meta.externalId) return `sku:${meta.sku}`
  return `product:${meta.productId}`
}

/** One store's slice of one product, accumulated as entries arrive. */
type Bucket = {
  meta: ProductMeta
  shopName: string
  orderIds: Set<string>
  quantity: number
  grossSales: number
  netSales: number
  cogs: number
  hasCost: boolean
}

function totalsOf(b: Bucket): ProductTotals {
  const profit = b.netSales - b.cogs
  return {
    orders: b.orderIds.size,
    quantity: b.quantity,
    grossSales: b.grossSales,
    netSales: b.netSales,
    cogs: b.cogs,
    profit,
    margin: b.netSales === 0 ? 0 : profit / b.netSales,
  }
}

export function productFigures(input: ProductInput): ProductResult {
  const { orders, products, costs, rates, displayCurrency, from, to } = input

  const tz = input.timezone ?? 'UTC'
  const tzFor = (shopId: string) => input.shopTimezones?.get(shopId) ?? tz
  const shopNames = new Map(input.shops.map((s) => [s.id, s.name]))

  // productId -> that product's figures in its own store.
  const buckets = new Map<string, Bucket>()

  for (const entry of entriesIn(orders, from, to, tzFor)) {
    const { order, sign } = entry

    // Revenue crosses from the ORDER's currency; costs from the SHOP's. A B2B
    // order can be invoiced in EUR while its shop's costs stay in NOK, and
    // reading one as the other is a tenfold error.
    const conv = (amount: number) => convert(amount, order.currency, order.placedAt, displayCurrency, rates)
    const convCost = (amount: number) => convert(amount, order.costCurrency, order.placedAt, displayCurrency, rates)

    for (const item of order.items) {
      const meta = products.get(item.productId)
      if (!meta) continue // a line whose product row we did not load; never invent one

      let bucket = buckets.get(item.productId)
      if (!bucket) {
        bucket = {
          meta,
          shopName: shopNames.get(meta.shopId) ?? '',
          orderIds: new Set(),
          quantity: 0,
          grossSales: 0,
          netSales: 0,
          cogs: 0,
          hasCost: true,
        }
        buckets.set(item.productId, bucket)
      }

      // A reversal is not an un-placed order, so only the sale side is tallied.
      if (sign === 1) bucket.orderIds.add(order.id)

      const cost = costOn(costs.get(item.productId) ?? [], order.placedAt)
      if (cost.costPerItem === 0) bucket.hasCost = false

      bucket.quantity += sign * item.quantity
      bucket.grossSales += sign * conv(item.unitPrice * item.quantity)
      bucket.netSales += sign * conv(item.lineNetTotal)
      bucket.cogs += sign * convCost(item.quantity * (cost.costPerItem + cost.handlingCost))
    }
  }

  // Fold the per-store buckets into merged rows.
  const merged = new Map<string, Bucket[]>()
  for (const bucket of buckets.values()) {
    const key = mergeKey(bucket.meta)
    const list = merged.get(key) ?? []
    list.push(bucket)
    merged.set(key, list)
  }

  const rows: ProductRow[] = [...merged.entries()].map(([key, group]) => {
    const stores: ProductStoreRow[] = group
      .map((b) => ({
        ...totalsOf(b),
        shopId: b.meta.shopId,
        shopName: b.shopName,
        productId: b.meta.productId,
        name: b.meta.name,
        hasCost: b.hasCost,
      }))
      .sort((a, b) => b.netSales - a.netSales)

    const add = (pick: (s: ProductStoreRow) => number) => sum(stores.map(pick))
    const netSales = add((s) => s.netSales)
    const cogs = add((s) => s.cogs)
    const profit = netSales - cogs

    // The biggest seller names the row, so a merged product reads in one
    // language instead of whichever store happened to be loaded first.
    const lead = stores[0]

    return {
      key,
      sku: group[0].meta.sku,
      name: lead.name,
      imageUrl: group.find((b) => b.meta.imageUrl)?.meta.imageUrl ?? null,
      orders: add((s) => s.orders),
      quantity: add((s) => s.quantity),
      grossSales: add((s) => s.grossSales),
      netSales,
      cogs,
      profit,
      margin: netSales === 0 ? 0 : profit / netSales,
      hasCost: stores.every((s) => s.hasCost),
      stores,
    }
  })

  rows.sort((a, b) => b.profit - a.profit)

  const add = (pick: (r: ProductRow) => number) => sum(rows.map(pick))
  const netSales = add((r) => r.netSales)
  const cogs = add((r) => r.cogs)
  const profit = netSales - cogs

  return {
    displayCurrency,
    rows,
    total: {
      orders: add((r) => r.orders),
      quantity: add((r) => r.quantity),
      grossSales: add((r) => r.grossSales),
      netSales,
      cogs,
      profit,
      // Recomputed from the totals, never an average of the row margins.
      margin: netSales === 0 ? 0 : profit / netSales,
    },
    uncosted: rows.filter((r) => !r.hasCost).length,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/metrics/products.test.ts`
Expected: PASS, 16 tests.

If `sku` comes out wrong on merged rows, simplify that line to `sku: group[0].meta.sku` - the defensive expression above is redundant and should be reduced to that.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/product-analytics
git add src/lib/metrics/products.ts src/lib/metrics/products.test.ts
git commit -m "feat: per-product figures, merged on SKU, refunds reversed via the engine's own rule"
```

---

### Task 4: `loadProductsInput` - the loader and the currency guard

**Files:**
- Create: `src/lib/data/load-products.ts`
- Test: `src/lib/data/load-products.integration.test.ts`

**Interfaces:**
- Consumes: `ProductInput`, `ProductMeta`, `ProductOrder` (Task 3); `groupByCurrency` (Task 2)
- Produces:
  - `export class MixedCurrencyError extends Error { groups: { currency: string; shops: { id: string; name: string }[] }[] }`
  - `export async function loadProductsInput(args: { shopIds?: string[]; from: Date; to: Date; timezone?: string }): Promise<ProductInput>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/data/load-products.integration.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { loadProductsInput, MixedCurrencyError } from './load-products'
import { productFigures } from '../metrics/products'
import { db } from '../db'

// Same reasoning as load.integration.test.ts: ensureRates otherwise reaches
// api.frankfurter.app, which is flaky offline. loadRates stays real.
vi.mock('../fx/rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fx/rates')>()),
  ensureRates: vi.fn(),
}))

// These run against the seeded database. Run `npm run db:seed` first.
const RANGE = { from: new Date('2026-01-01'), to: new Date('2026-07-14') }

describe('loadProductsInput', () => {
  it('reads one shop in its own currency and produces real product rows', async () => {
    const shop = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })

    const input = await loadProductsInput({ shopIds: [shop.id], ...RANGE })
    const res = productFigures(input)

    expect(input.displayCurrency).toBe('NOK')
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.total.netSales).toBeGreaterThan(0)
    expect(res.total.cogs).toBeGreaterThan(0) // costs are seeded, so COGS must be real
  })

  it('refuses a selection spanning two currencies instead of converting it', async () => {
    const no = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })
    const se = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.se' } })

    await expect(loadProductsInput({ shopIds: [no.id, se.id], ...RANGE })).rejects.toThrow(MixedCurrencyError)
  })

  it('names the currency groups it refused, so the UI can offer them', async () => {
    const no = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })
    const se = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.se' } })

    const err = await loadProductsInput({ shopIds: [no.id, se.id], ...RANGE }).catch((e) => e)
    expect(err).toBeInstanceOf(MixedCurrencyError)
    expect(err.groups.map((g: { currency: string }) => g.currency).sort()).toEqual(['NOK', 'SEK'])
  })

  it('allows several shops that share one currency', async () => {
    const shops = await db.shop.findMany({ where: { currency: 'NOK', active: true }, take: 2 })
    if (shops.length < 2) return // seed changed; nothing to assert

    const input = await loadProductsInput({ shopIds: shops.map((s) => s.id), ...RANGE })
    expect(input.displayCurrency).toBe('NOK')
    expect(input.shops).toHaveLength(2)
  })

  it('carries the sku, name and unit price the aggregation needs', async () => {
    const shop = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })
    const input = await loadProductsInput({ shopIds: [shop.id], ...RANGE })

    const line = input.orders.flatMap((o) => o.items)[0]
    expect(line).toBeDefined()
    expect(typeof line.sku).toBe('string')
    expect(typeof line.name).toBe('string')
    expect(typeof line.unitPrice).toBe('number')

    const meta = input.products.get(line.productId)
    expect(meta).toBeDefined()
    expect(typeof meta!.externalId).toBe('string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Make sure the local Postgres is running and seeded first. Then:

Run: `npx vitest run src/lib/data/load-products.integration.test.ts`
Expected: FAIL - cannot resolve `./load-products`.

If instead it fails with `Can't reach database server at 127.0.0.1:5432`, the local Postgres is not running. Start it (see `docs/` or the project's local DB notes), reseed with `npm run db:seed`, and re-run. Never point `DATABASE_URL` at Neon to make a test pass.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/data/load-products.ts`:

```ts
import { db } from '../db'
import { utcDay } from '../dates'
import { zoneDayEndUtc, zoneDayStartUtc } from '../tz'
import { groupByCurrency } from '../currency-groups'
import { buildRateTable } from '../metrics/fx'
import { ensureRates, loadRates } from '../fx/rates'
import type { CostBook } from '../metrics/types'
import type { ProductInput, ProductMeta, ProductOrder } from '../metrics/products'

/**
 * Everything the product page needs for one query.
 *
 * Deliberately NOT `loadMetricsInput`. That one selects only productId,
 * quantity and lineNetTotal from order items; this page also needs the sku,
 * name and unit price. Widening the shared select would make every Dashboard
 * request haul three unused columns across thousands of rows.
 *
 * The display currency is the selected shops' shared currency - not USD.
 * Mixing currencies is refused rather than converted, because a product table
 * that silently consolidates is one a client cannot check against his own till.
 */

export type LoadProductsArgs = {
  shopIds?: string[] // undefined = every active shop
  from: Date
  to: Date
  timezone?: string
}

export type CurrencyGroup = { currency: string; shops: { id: string; name: string }[] }

export class MixedCurrencyError extends Error {
  readonly groups: CurrencyGroup[]
  constructor(groups: CurrencyGroup[]) {
    super('The selected stores use different currencies, so their product totals cannot be added together.')
    this.name = 'MixedCurrencyError'
    this.groups = groups
  }
}

export async function loadProductsInput(args: LoadProductsArgs): Promise<ProductInput> {
  const { from, to } = args

  const shopRows = await db.shop.findMany({
    where: { active: true, ...(args.shopIds?.length ? { id: { in: args.shopIds } } : {}) },
    orderBy: { name: 'asc' },
  })

  const groups = groupByCurrency(shopRows.map((s) => ({ id: s.id, name: s.name, currency: s.currency })))
  if (groups.length > 1) throw new MixedCurrencyError(groups)

  const shops = shopRows.map((s) => ({ id: s.id, name: s.name, currency: s.currency }))
  const shopIds = shops.map((s) => s.id)
  // No shops at all still has to return something the aggregation can chew on.
  const displayCurrency = groups[0]?.currency ?? 'USD'

  const tz = args.timezone ?? 'UTC'
  const shopTimezones = new Map(shopRows.map((s) => [s.id, s.timezone ?? tz]))
  const zones = [...new Set([tz, ...shopTimezones.values()])]
  const fromDay = utcDay(from).toISOString().slice(0, 10)
  const toDay = utcDay(to).toISOString().slice(0, 10)
  const windowStart = new Date(Math.min(...zones.map((z) => zoneDayStartUtc(fromDay, z).getTime())))
  const windowEnd = new Date(Math.max(...zones.map((z) => zoneDayEndUtc(toDay, z).getTime())))

  const currencyByShop = new Map(shopRows.map((s) => [s.id, s.currency]))

  const orderRows = await db.order.findMany({
    where: {
      shopId: { in: shopIds },
      OR: [
        { placedAt: { gte: windowStart, lte: windowEnd } },
        // An order placed before this window but refunded inside it must still
        // be fetched, or its products can never be taken back off.
        { voidedAt: { gte: windowStart, lte: windowEnd } },
      ],
    },
    select: {
      id: true,
      shopId: true,
      placedAt: true,
      status: true,
      voidedAt: true,
      currency: true,
      grossSales: true,
      discountTotal: true,
      netSales: true,
      shippingCharged: true,
      taxTotal: true,
      total: true,
      ambassadorId: true,
      items: {
        select: { productId: true, sku: true, name: true, quantity: true, unitPrice: true, lineNetTotal: true },
      },
    },
  })

  const orders: ProductOrder[] = orderRows.map((o) => ({
    id: o.id,
    shopId: o.shopId,
    placedAt: o.placedAt,
    status: o.status,
    voidedAt: o.voidedAt,
    currency: o.currency,
    costCurrency: currencyByShop.get(o.shopId) ?? o.currency,
    grossSales: o.grossSales,
    discountTotal: o.discountTotal,
    netSales: o.netSales,
    shippingCharged: o.shippingCharged,
    taxTotal: o.taxTotal,
    total: o.total,
    ambassadorId: o.ambassadorId,
    // Commission never reaches a product figure, so the rate is not looked up.
    commissionRate: 0,
    items: o.items.map((i) => ({
      productId: i.productId,
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineNetTotal: i.lineNetTotal,
    })),
  }))

  const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId)))]

  const productRows = await db.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, shopId: true, sku: true, externalId: true, name: true, imageUrl: true },
  })
  const products = new Map<string, ProductMeta>(
    productRows.map((p) => [
      p.id,
      { productId: p.id, shopId: p.shopId, sku: p.sku, externalId: p.externalId, name: p.name, imageUrl: p.imageUrl },
    ]),
  )

  const costRows = await db.productCost.findMany({
    where: { productId: { in: productIds } },
    orderBy: { effectiveFrom: 'asc' },
  })
  const costs: CostBook = new Map()
  for (const c of costRows) {
    const list = costs.get(c.productId) ?? []
    list.push({ costPerItem: c.costPerItem, handlingCost: c.handlingCost, effectiveFrom: c.effectiveFrom })
    costs.set(c.productId, list)
  }

  // Every shop shares one currency here, so the only thing that can still need
  // a rate is an order invoiced in a different one - a B2B order, typically.
  const inPlay = new Set([displayCurrency, ...orders.map((o) => o.currency)])
  if (inPlay.size > 1) await ensureRates(from, to, [...inPlay])

  return {
    shops,
    orders,
    products,
    costs,
    rates: buildRateTable(await loadRates()),
    displayCurrency,
    from,
    to,
    timezone: tz,
    shopTimezones,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/data/load-products.integration.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/product-analytics
git add src/lib/data/load-products.ts src/lib/data/load-products.integration.test.ts
git commit -m "feat: product loader, refusing a mixed-currency selection rather than converting it"
```

---

### Task 5: The API route

**Files:**
- Create: `src/app/api/products/analytics/route.ts`
- Test: `src/app/api/products/analytics/route.test.ts`

**Interfaces:**
- Consumes: `loadProductsInput`, `MixedCurrencyError` (Task 4); `productFigures` (Task 3); `rangeFromQuery`, `shopIdsFromQuery` from `@/lib/api/range`
- Produces: `GET /api/products/analytics?preset=…|from=…&to=…&shops=a,b` returning
  `{ displayCurrency, rows, total, uncosted, range: { from, to } }`, or 400 `{ error, groups }`, or 403 `{ error }`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/products/analytics/route.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

// No cookie = no user; enough to reach the route's refusal path without a DB.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
const { GET } = await import('./route')

describe('GET /api/products/analytics', () => {
  it('refuses anonymous callers, and even the refusal is never cacheable', async () => {
    const res = await GET(new Request('http://localhost/api/products/analytics?preset=this_month'))
    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/products/analytics/route.test.ts`
Expected: FAIL - cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/api/products/analytics/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadProductsInput, MixedCurrencyError } from '@/lib/data/load-products'
import { productFigures } from '@/lib/metrics/products'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const input = await loadProductsInput({ shopIds, from, to, timezone })
    const result = productFigures(input)

    return NextResponse.json(
      { ...result, range: { from: from.toISOString(), to: to.toISOString() } },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })

    // The client normally prevents this, but a hand-typed ?shops= must not slip
    // past. The groups travel with the refusal so the page can offer them.
    if (e instanceof MixedCurrencyError)
      return NextResponse.json({ error: e.message, groups: e.groups }, { status: 400, headers: NO_STORE })

    console.error(e)
    return NextResponse.json({ error: 'Could not load product analytics' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/products/analytics/route.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/product-analytics
git add src/app/api/products/analytics/
git commit -m "feat: admin-only product analytics endpoint"
```

---

### Task 6: The table component

Presentational only - it receives rows, it does not fetch. Expansion is local state.

**Files:**
- Create: `src/components/Thumb.tsx`
- Create: `src/app/products/ProductsTable.tsx`
- Test: `src/app/products/ProductsTable.test.tsx`
- Modify: `src/app/orders/OrdersClient.tsx:97-102` (delete the local `Thumb`, import the shared one)
- Modify: `src/app/portal/PortalClient.tsx:61-66` (same)

**Interfaces:**
- Consumes: `ProductRow`, `ProductTotals` (Task 3); `formatMoney` from `@/lib/money`
- Produces:
  - `export function Thumb({ src, alt }: { src: string | null; alt: string }): JSX.Element`
  - `export function ProductsTable({ rows, total, currency }: { rows: ProductRow[]; total: ProductTotals; currency: string }): JSX.Element`

**Why the extraction:** `Thumb` is currently defined identically in two files. This
task would make a third copy. Extract it once, to `src/components/Thumb.tsx`, and
point all three at it. Copy the existing body VERBATIM - including its
eslint-disable comment and its placeholder branch - so the two existing pages
cannot change appearance. Their existing tests passing unchanged is the proof.

- [ ] **Step 1: Write the failing test**

Create `src/app/products/ProductsTable.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ProductsTable } from './ProductsTable'
import type { ProductRow, ProductTotals } from '@/lib/metrics/products'

const store = (over: Partial<ProductRow['stores'][number]> = {}) => ({
  shopId: 'de',
  shopName: 'Panetti Germany',
  productId: 'p-de',
  name: 'Elektrischer Pizzaofen',
  orders: 1,
  quantity: 2,
  grossSales: 20000,
  netSales: 20000,
  cogs: 6400,
  profit: 13600,
  margin: 0.68,
  hasCost: true,
  ...over,
})

const row = (over: Partial<ProductRow> = {}): ProductRow => ({
  key: 'sku:PZ-PRO',
  sku: 'PZ-PRO',
  name: 'Elektrischer Pizzaofen',
  imageUrl: null,
  orders: 1,
  quantity: 2,
  grossSales: 20000,
  netSales: 20000,
  cogs: 6400,
  profit: 13600,
  margin: 0.68,
  hasCost: true,
  stores: [store()],
  ...over,
})

const TOTAL: ProductTotals = {
  orders: 1, quantity: 2, grossSales: 20000, netSales: 20000, cogs: 6400, profit: 13600, margin: 0.68,
}

const cellsOf = (name: string): string[] =>
  [...screen.getByText(name).closest('tr')!.querySelectorAll('td')].map((td) => td.textContent ?? '')

describe('ProductsTable', () => {
  it('names its columns in order', () => {
    render(<ProductsTable rows={[row()]} total={TOTAL} currency="EUR" />)
    const headers = [...document.querySelectorAll('th')].map((th) => th.textContent)
    expect(headers).toEqual(['Product', 'Orders', 'Qty', 'Gross', 'Revenue', 'COGS', 'Profit', 'Margin'])
  })

  it('shows a product with its figures', () => {
    render(<ProductsTable rows={[row()]} total={TOTAL} currency="EUR" />)
    const cells = cellsOf('Elektrischer Pizzaofen')
    expect(cells[1]).toBe('1')
    expect(cells[2]).toBe('2')
    expect(cells[7]).toBe('68.0%')
  })

  it('hides the per-store rows until the product is expanded', () => {
    const merged = row({ stores: [store(), store({ shopId: 'fi', shopName: 'Panetti Finland', productId: 'p-fi' })] })
    render(<ProductsTable rows={[merged]} total={TOTAL} currency="EUR" />)

    expect(screen.queryByText('Panetti Finland')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Elektrischer Pizzaofen/ }))
    expect(screen.getByText('Panetti Finland')).toBeInTheDocument()
  })

  it('offers no expansion for a product that sold in only one store', () => {
    render(<ProductsTable rows={[row()]} total={TOTAL} currency="EUR" />)
    expect(screen.queryByRole('button', { name: /Elektrischer Pizzaofen/ })).not.toBeInTheDocument()
  })

  it('marks a product whose cost was never entered', () => {
    render(<ProductsTable rows={[row({ hasCost: false })]} total={TOTAL} currency="EUR" />)
    expect(screen.getByTitle(/no cost entered/i)).toBeInTheDocument()
  })

  it('shows no margin rather than 0.0% when nothing was sold', () => {
    const dead = row({ netSales: 0, profit: 0, margin: 0, cogs: 0 })
    render(<ProductsTable rows={[dead]} total={TOTAL} currency="EUR" />)
    expect(cellsOf('Elektrischer Pizzaofen')[7]).toBe('-')
  })

  it('says so plainly when nothing sold in the period', () => {
    render(<ProductsTable rows={[]} total={TOTAL} currency="EUR" />)
    expect(screen.getByText('No products sold in this period.')).toBeInTheDocument()
  })

  it('shows the product photo when the shop has one', () => {
    render(<ProductsTable rows={[row({ imageUrl: 'https://shop.example/oven.png' })]} total={TOTAL} currency="EUR" />)
    expect(screen.getByAltText('Elektrischer Pizzaofen')).toHaveAttribute('src', 'https://shop.example/oven.png')
  })

  it('leaves a quiet placeholder rather than a broken image when there is no photo', () => {
    render(<ProductsTable rows={[row({ imageUrl: null })]} total={TOTAL} currency="EUR" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('totals the footer from the rows', () => {
    render(<ProductsTable rows={[row()]} total={TOTAL} currency="EUR" />)
    expect(screen.getByText('Total').closest('tr')!.textContent).toContain('68.0%')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/products/ProductsTable.test.tsx`
Expected: FAIL - cannot resolve `./ProductsTable`.

- [ ] **Step 3a: Extract the shared thumbnail**

Create `src/components/Thumb.tsx`, moving the body verbatim from `src/app/orders/OrdersClient.tsx:97-102`:

```tsx
/** A small product picture, or a quiet placeholder when the shop has none. */
export function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-md bg-panel" />
  // eslint-disable-next-line @next/next/no-img-element -- shop images are arbitrary remote hosts
  return <img src={src} alt={alt} className="h-8 w-8 shrink-0 rounded-md object-cover" />
}
```

In `src/app/orders/OrdersClient.tsx` AND `src/app/portal/PortalClient.tsx`: delete
the local `Thumb` function and add `import { Thumb } from '@/components/Thumb'`.
Change nothing else in either file - every existing call site keeps its props.

Run `npx vitest run src/app/orders/ src/app/portal/` before continuing. Both
suites must pass unchanged; if either fails, the extraction altered behaviour
and must be corrected before moving on.

- [ ] **Step 3b: Write the table**

Create `src/app/products/ProductsTable.tsx`:

```tsx
'use client'

import { Fragment, useState } from 'react'
import { formatMoney } from '@/lib/money'
import { Thumb } from '@/components/Thumb'
import type { ProductRow, ProductTotals } from '@/lib/metrics/products'

/**
 * One product per row, merged across stores, expanding into the stores that
 * make it up. Every figure is exact: nothing on this page is apportioned, so
 * no column here can disagree with an order the client opens to check it.
 */

/**
 * A margin with nothing to divide by is unknown, never 0.0%. Same convention
 * as `ratios()` in marketing.ts and the dash in BreakdownTable.
 */
function marginText(netSales: number, margin: number): string {
  if (netSales === 0) return '-'
  return `${(margin * 100).toFixed(1)}%`
}

function countText(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * `costOn` returns zero when no cost was ever entered, which makes an uncosted
 * product report a 100% margin - a lie that looks like a triumph. Every such
 * row says so.
 */
function CostWarning() {
  return (
    <span title="This product has no cost entered, so its margin is not real." className="ml-1.5 text-loss">
      ⚠
    </span>
  )
}

export function ProductsTable({
  rows,
  total,
  currency,
}: {
  rows: ProductRow[]
  total: ProductTotals
  currency: string
}) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())

  function toggle(key: string) {
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (rows.length === 0) {
    return (
      <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        <p className="px-5 py-8 text-center text-[13px] text-muted">No products sold in this period.</p>
      </section>
    )
  }

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel text-left text-[11px] font-semibold text-faint">
              <th className="px-4 py-2">Product</th>
              <th className="px-4 py-2 text-right">Orders</th>
              <th className="px-4 py-2 text-right">Qty</th>
              <th className="px-4 py-2 text-right">Gross</th>
              <th className="px-4 py-2 text-right">Revenue</th>
              <th className="px-4 py-2 text-right">COGS</th>
              <th className="px-4 py-2 text-right">Profit</th>
              <th className="px-4 py-2 text-right">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = openKeys.has(row.key)
              // One store is not a breakdown - there is nothing to reveal.
              const expandable = row.stores.length > 1

              return (
                <Fragment key={row.key}>
                  <tr
                    className={`border-b border-line ${expandable ? 'cursor-pointer hover:bg-panel' : ''}`}
                    onClick={expandable ? () => toggle(row.key) : undefined}
                  >
                    <td className="py-2 pl-4 pr-4">
                      <div className="flex items-center gap-2.5">
                        <Thumb src={row.imageUrl} alt={row.name} />
                        {expandable ? (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggle(row.key)
                            }}
                            className="flex items-center gap-1.5 text-left text-[13px] font-medium text-ink"
                          >
                            <span
                              aria-hidden="true"
                              className={`inline-block w-3 text-faint transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
                            >
                              ›
                            </span>
                            {row.name}
                          </button>
                        ) : (
                          // pl-[18px] keeps an unexpandable name aligned with the
                          // expandable ones, whose chevron occupies that space.
                          <span className="block pl-[18px] text-[13px] text-ink">{row.name}</span>
                        )}
                        {!row.hasCost && <CostWarning />}
                      </div>
                    </td>
                    <td className="num px-4 py-2 text-right text-ink">{countText(row.orders)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{countText(row.quantity)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{formatMoney(row.grossSales, currency)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{formatMoney(row.netSales, currency)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{formatMoney(row.cogs, currency)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{formatMoney(row.profit, currency)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{marginText(row.netSales, row.margin)}</td>
                  </tr>

                  {expandable &&
                    isOpen &&
                    row.stores.map((s) => (
                      <tr key={`${row.key}:${s.shopId}`} className="border-b border-line bg-panel/40">
                        <td className="py-2 pl-10 pr-4 text-[12px] text-muted">
                          {s.shopName}
                          {!s.hasCost && <CostWarning />}
                        </td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{countText(s.orders)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{countText(s.quantity)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{formatMoney(s.grossSales, currency)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{formatMoney(s.netSales, currency)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{formatMoney(s.cogs, currency)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{formatMoney(s.profit, currency)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{marginText(s.netSales, s.margin)}</td>
                      </tr>
                    ))}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-panel text-[13px] font-semibold text-ink">
              <td className="px-4 py-2">Total</td>
              <td className="num px-4 py-2 text-right">{countText(total.orders)}</td>
              <td className="num px-4 py-2 text-right">{countText(total.quantity)}</td>
              <td className="num px-4 py-2 text-right">{formatMoney(total.grossSales, currency)}</td>
              <td className="num px-4 py-2 text-right">{formatMoney(total.netSales, currency)}</td>
              <td className="num px-4 py-2 text-right">{formatMoney(total.cogs, currency)}</td>
              <td className="num px-4 py-2 text-right">{formatMoney(total.profit, currency)}</td>
              <td className="num px-4 py-2 text-right">{marginText(total.netSales, total.margin)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/products/ProductsTable.test.tsx src/app/orders/ src/app/portal/`
Expected: PASS - 10 new table tests, plus the orders and portal suites unchanged.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/product-analytics
git add src/components/Thumb.tsx src/app/products/ProductsTable.tsx src/app/products/ProductsTable.test.tsx src/app/orders/OrdersClient.tsx src/app/portal/PortalClient.tsx
git commit -m "feat: product table with per-store drill-down, sharing the thumbnail component"
```

---

### Task 7: The page, the mixed-currency guard, and the nav entry

**Files:**
- Create: `src/app/products/page.tsx`
- Create: `src/app/products/ProductsClient.tsx`
- Create: `src/app/products/ProductsClient.test.tsx`
- Modify: `src/components/shell/AppShell.tsx` (the `NAV` array at line 48)

**Interfaces:**
- Consumes: `ProductsTable` (Task 6); `groupByCurrency`, `selectedShops` (Task 2); `ProductRow`, `ProductTotals` (Task 3); `ShopFilter`, `NO_SHOPS`, `Shop` from `@/components/filters/ShopFilter`; `DateFilter` from `@/components/filters/DateFilter`; `AppShell`, `PageBody`, `PageHeader` from `@/components/shell/AppShell`
- Produces: the `/products` route

- [ ] **Step 1: Write the failing test**

Create `src/app/products/ProductsClient.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ProductsClient } from './ProductsClient'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/lib/use-live-tick', () => ({ useLiveTick: () => 0 }))

const SHOPS = [
  { id: 'no', name: 'Panetti Norway', currency: 'NOK' },
  { id: 'de', name: 'Panetti Germany', currency: 'EUR' },
  { id: 'fi', name: 'Panetti Finland', currency: 'EUR' },
]

const EMPTY = {
  displayCurrency: 'NOK',
  rows: [],
  total: { orders: 0, quantity: 0, grossSales: 0, netSales: 0, cogs: 0, profit: 0, margin: 0 },
  uncosted: 0,
  range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z' },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(EMPTY), { status: 200 })))
})

describe('ProductsClient', () => {
  it('loads every shop by default', async () => {
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
  })

  it('refuses a mixed-currency selection without asking the server', async () => {
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    ;(fetch as ReturnType<typeof vi.fn>).mockClear()

    fireEvent.click(screen.getByLabelText('Shops'))
    fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
    fireEvent.click(screen.getByLabelText('Panetti Germany'))

    expect(await screen.findByText(/Mixed currencies/i)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('offers each currency group as a one-click fix', async () => {
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())

    fireEvent.click(screen.getByLabelText('Shops'))
    fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
    fireEvent.click(screen.getByLabelText('Panetti Germany'))

    expect(await screen.findByRole('button', { name: /Show the 1 NOK store/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Show the 1 EUR store/ })).toBeInTheDocument()
  })

  it('recovers when a currency group is chosen', async () => {
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())

    fireEvent.click(screen.getByLabelText('Shops'))
    fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
    fireEvent.click(screen.getByLabelText('Panetti Germany'))
    fireEvent.click(await screen.findByRole('button', { name: /Show the 1 NOK store/ }))

    await waitFor(() => expect(screen.queryByText(/Mixed currencies/i)).not.toBeInTheDocument())
  })

  it('says how many products have no cost entered', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ ...EMPTY, uncosted: 7 }), { status: 200 }),
    )
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    expect(await screen.findByText(/7 products have no cost entered/i)).toBeInTheDocument()
  })

  it('shows the reason when the server refuses', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Could not load product analytics' }), { status: 500 }),
    )
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    expect(await screen.findByText('Could not load product analytics')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/products/ProductsClient.test.tsx`
Expected: FAIL - cannot resolve `./ProductsClient`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/products/ProductsClient.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, NO_SHOPS, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { ProductsTable } from './ProductsTable'
import { groupByCurrency, selectedShops } from '@/lib/currency-groups'
import { useLiveTick } from '@/lib/use-live-tick'
import type { Preset } from '@/lib/dates'
import type { ProductRow, ProductTotals } from '@/lib/metrics/products'

type Payload = {
  displayCurrency: string
  rows: ProductRow[]
  total: ProductTotals
  uncosted: number
  range: { from: string; to: string }
}

/** Skeletons in the shape of the content - never a spinner inside a table. */
function Skeleton() {
  return <div className="skeleton h-[420px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
}

/**
 * Adding NOK to EUR would produce a table that looks meaningful and is not, so
 * the page refuses rather than converting. Each currency group is offered as a
 * button: the fix is one click, not "go and un-tick things".
 */
function MixedCurrencies({
  groups,
  onPick,
}: {
  groups: { currency: string; shops: Shop[] }[]
  onPick: (ids: string[]) => void
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
      <h2 className="text-[13px] font-semibold text-ink">
        Mixed currencies: {groups.map((g) => g.currency).join(' and ')}
      </h2>
      <p className="mt-1 max-w-xl text-[13px] text-muted">
        These stores do not share a currency, so their product totals cannot be added together.
        Pick one group and the figures are exact, in that group’s own currency.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {groups.map((g) => (
          <button
            key={g.currency}
            type="button"
            onClick={() => onPick(g.shops.map((s) => s.id))}
            className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:border-faint"
          >
            Show the {g.shops.length} {g.currency} {g.shops.length === 1 ? 'store' : 'stores'}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ProductsClient({
  email,
  shops,
  initialPreset,
}: {
  email: string
  shops: Shop[]
  initialPreset?: Preset
}) {
  const [preset, setPreset] = useState<Preset | 'custom'>(initialPreset ?? 'this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const tick = useLiveTick()

  // Decided here rather than on the server: a request that cannot produce an
  // honest answer is better never sent than sent and refused.
  const chosen = selectedShops(shops, selected)
  const groups = groupByCurrency(chosen)
  const mixed = groups.length > 1

  useEffect(() => {
    if (mixed) {
      setLoading(false)
      return
    }

    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    if (selected.length) params.set('shops', selected.join(','))

    const ctrl = new AbortController()
    fetch(`/api/products/analytics?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load')
        return res.json()
      })
      .then((json: Payload) => {
        setData(json)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [preset, from, to, selected, tick, mixed])

  const currency = data?.displayCurrency ?? ''

  return (
    <AppShell email={email}>
      <PageHeader
        title="Products"
        subtitle="Revenue, cost and profit per product. Every figure is exact - nothing is split across products."
      >
        <ShopFilter
          shops={shops}
          selected={selected}
          onChange={(next) => {
            setLoading(true)
            setSelected(next)
          }}
        />
        <DateFilter
          preset={preset}
          from={from}
          to={to}
          onChange={(next) => {
            setLoading(true)
            setPreset(next.preset)
            if (next.from !== undefined) setFrom(next.from)
            if (next.to !== undefined) setTo(next.to)
          }}
        />
      </PageHeader>

      <PageBody>
        {mixed ? (
          <MixedCurrencies
            groups={groups}
            onPick={(ids) => {
              setLoading(true)
              setSelected(ids)
            }}
          />
        ) : selected.includes(NO_SHOPS) ? (
          <p className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-8 text-center text-[13px] text-muted">
            No shops selected.
          </p>
        ) : (
          <>
            {error && (
              <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
                {error}
              </div>
            )}

            {data && data.uncosted > 0 && (
              <p className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
                {data.uncosted} {data.uncosted === 1 ? 'product has' : 'products have'} no cost entered, so
                their margins are not real.{' '}
                <Link href="/settings/costs" className="font-semibold text-accent hover:underline">
                  Add costs
                </Link>
              </p>
            )}

            {loading && !data ? (
              <Skeleton />
            ) : data ? (
              <div
                aria-busy={loading}
                className={`transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-50' : ''}`}
              >
                <ProductsTable rows={data.rows} total={data.total} currency={currency} />
              </div>
            ) : null}
          </>
        )}
      </PageBody>
    </AppShell>
  )
}
```

Create `src/app/products/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { ProductsClient } from './ProductsClient'
import type { Preset } from '@/lib/dates'

export default async function ProductsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  const setting = await getSetting()
  return <ProductsClient email={user.email} shops={shops} initialPreset={setting.defaultPreset as Preset} />
}
```

In `src/components/shell/AppShell.tsx`, add to the Analytics `items` array, immediately after the `/marketing` entry:

```tsx
      {
        href: '/products',
        label: 'Products',
        icon: icon(
          <>
            <path d="M20 7 12 3 4 7v10l8 4 8-4V7Z" />
            <path d="m4 7 8 4 8-4" />
            <path d="M12 11v10" />
          </>,
        ),
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/products/`
Expected: PASS - 8 table tests plus 6 client tests.

- [ ] **Step 5: Run the full suite and the linter**

```bash
npx vitest run
npm run lint
```
Expected: every test passes, no lint errors. If DB tests fail with `Can't reach database server`, start the local Postgres and reseed - do not point at Neon.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must print feat/product-analytics
git add src/app/products/ src/components/shell/AppShell.tsx
git commit -m "feat: the Products page, gated on a shared currency"
```

---

### Task 8: See it working in a browser

Tests passing is not the same as the page being right. This task produces a screenshot.

**Files:** none changed unless a defect is found.

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Run it in the BACKGROUND and BARE. Never pipe it through `head` or `tail` - `head` exits after N lines, closes the pipe, and Next then blocks forever on its next write while still holding port 3000.

- [ ] **Step 2: Sign in and open the page**

Sign in as the seeded admin, then visit `http://localhost:3000/products`.

- [ ] **Step 3: Check these five things by eye**

1. Default (all shops) shows the **mixed-currency panel**, because the seed spans NOK, SEK, DKK and EUR. The buttons name each group.
2. Clicking "Show the 4 NOK stores" loads a table with money formatted as NOK.
3. A product sold in more than one NOK store has a ▸ and expands into per-store rows whose figures add up to the parent.
4. A product sold in one store only has no ▸ at all.
5. Switching the date range to one with no sales shows "No products sold in this period."

- [ ] **Step 4: Capture a screenshot for the record**

Save to the scratchpad directory, not the repo.

- [ ] **Step 5: Fix anything wrong, then commit**

If a defect appears, use superpowers:systematic-debugging - find the root cause before changing anything, and add a failing test for it first.

```bash
git branch --show-current   # must print feat/product-analytics
git add -u                  # NEVER `git add -A`: it sweeps up next-env.d.ts,
                            # which npm run build rewrites and npm run dev flips back
git commit -m "fix: <whatever the browser found>"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Merge on SKU, drill down per store | 3, 6 |
| No merge where `sku === externalId` | 3 |
| Same-currency gate, native display currency | 2, 4, 7 |
| Profit = net sales − COGS, nothing apportioned | 3 |
| No ad spend column | 3 (no field exists to render) |
| Refunds reverse via the engine's own rule | 1, 3 |
| Dated costs | 3 |
| Distinct-order counting, sale entries only | 3 |
| Totals summed, margin recomputed | 3, 6 |
| Uncosted products visible | 3, 6, 7 |
| Admin-only, `private, no-store` | 5 |
| 400 on mixed currency from a hand-typed URL | 4, 5 |
| Empty states | 6, 7 |
| Nav entry | 7 |
| Thumbnail from `Product.imageUrl` | loaded in 4, carried in 3, rendered in 6 |

**No open gaps.** An earlier draft carried `imageUrl` without rendering it; the thumbnail is now rendered in Task 6 through a shared `Thumb` component, which also removes an existing duplication between `OrdersClient` and `PortalClient`.

**Type consistency:** `ProductTotals` is the shared shape; `ProductRow` and `ProductStoreRow` both extend it, so `formatMoney(row.netSales)` and `formatMoney(store.netSales)` take the same path in Task 6. `mergeKey` is used in Task 3 only and tested there. `MixedCurrencyError.groups` has the same shape in Task 4 (thrown), Task 5 (serialised) and Task 7 (the client's own `groupByCurrency` result) - `{ currency, shops }` throughout.
