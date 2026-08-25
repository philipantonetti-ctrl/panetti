# B2B Customers and Other Revenue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner register business customers with their own agreed prices, currency and VAT rate, then enter the orders those customers place by email - so that revenue, COGS and profit appear in the same numbers as the webshop.

**Architecture:** A B2B order is written as an ordinary `Order` row with ordinary `OrderItem` lines, so `computeMetrics()` counts it with no knowledge that B2B exists. Two new tables hold the customer and their price book; four new columns on `Order`/`OrderItem` hold what makes a B2B order different. Along the way we correct a latent assumption in the metrics engine - that an order's currency equals its shop's - which a EUR order on a NOK shop would otherwise turn into COGS ten times too high.

**Tech Stack:** Next.js 16 (App Router), React 19, Prisma 6 + PostgreSQL, Zod 4, Tailwind 4, Vitest (unit + integration against a real Postgres), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-08-03-b2b-customers-and-other-revenue-design.md`

## Global Constraints

- **All money is an integer number of minor units** (øre, cents), never a float. Use `toMinor`/`toMajor`/`pct`/`sum` from `src/lib/money.ts`. `pct(minor, rate)` rounds half away from zero - use it for every percentage.
- **Money is always tagged with the currency it is in.** Conversion happens at read time only, never stored converted (`prisma/schema.prisma:10-11`).
- **Schema changes must be additive.** `npm run build` runs `scripts/db-push.mjs`, which refuses anything destructive without an explicit flag. No column may be dropped or retyped.
- **Every money endpoint is admin-only** - `assertAdmin(await currentUser())` inside a `try`, catching `AuthError` → 403 - and carries `Cache-Control: private, no-store`.
- **Tests run against a real local Postgres**, from `DATABASE_URL` in `.env`. Never point them at the live Neon database.
- **The dev server must never be piped** (`npm run dev | head` wedges the port). Run it bare and in the background.
- **Never run `git stash`, `git checkout --`, `git restore`, or `git reset --hard`.** They silently revert work in this repo.
- **Edit files with the Edit/Write tools only.** PowerShell `Get-Content`/`Set-Content` mojibakes the UTF-8 in these files.
- **Every commit message ends with** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` on its own line after a blank line. Commit steps below show the subject only; append the trailer.
- **Discount semantics: `AMOUNT` is per unit.** €20 off each chair, not €20 off the line. This is fixed and every layer must agree.
- Run the full suite with `npm test`. Run one file with `npx vitest run <path>`. Run one test with `npx vitest run <path> -t "<name>"`.

## File Structure

**Created:**

| file | responsibility |
|---|---|
| `src/lib/b2b/pricing.ts` | Pure line and order arithmetic: discounts, VAT, totals. No I/O. |
| `src/lib/b2b/pricing.test.ts` | Its tests. |
| `src/lib/b2b/numbering.ts` | The `B-NNNN` / `b2b:` identity scheme, pure half and DB half. |
| `src/lib/b2b/numbering.test.ts` | Its tests. |
| `src/app/api/b2b/customers/route.ts` | List and create customers. |
| `src/app/api/b2b/customers/route.test.ts` | Its tests. |
| `src/app/api/b2b/customers/[id]/route.ts` | Read, edit (price list replaced wholesale), delete-or-refuse. |
| `src/app/api/b2b/customers/[id]/route.test.ts` | Its tests. |
| `src/app/api/b2b/orders/route.ts` | **`POST` only** - create a B2B order, recomputing every total server-side. Listing is `/api/orders?source=b2b`, which already computes per-order profit; a second list endpoint would be a second copy of that arithmetic. |
| `src/app/api/b2b/orders/route.test.ts` | Its tests. |
| `src/app/api/b2b/orders/[id]/route.ts` | Edit and delete one B2B order. |
| `src/app/api/b2b/orders/[id]/route.test.ts` | Its tests. |
| `src/app/b2b/page.tsx` | Server page: auth + shop list, then the client. |
| `src/app/b2b/B2bClient.tsx` | The B2B screen: customers card, orders card, both modals' hosts. |
| `src/app/b2b/B2bClient.test.tsx` | Its tests. |
| `src/app/b2b/CustomerModal.tsx` | Add/edit a customer and their starting price list. |
| `src/app/b2b/OrderModal.tsx` | Enter a B2B order: lines, discounts, live totals. |
| `src/app/b2b/OrderModal.test.tsx` | Its tests. |
| `src/app/b2b/[id]/page.tsx` | Server page for one customer. |
| `src/app/b2b/[id]/CustomerClient.tsx` | Price list editing, a summary of what they have bought, and a link through to their orders. |
| `e2e/b2b.spec.ts` | Customer → price → order → the Dashboard number moves. |

**Modified:**

| file | change |
|---|---|
| `prisma/schema.prisma` | `B2bCustomer`, `B2bPrice`; four columns and three back-references. |
| `src/lib/metrics/types.ts` | `EngineOrder` gains `costCurrency`, `fulfillmentCost`, `chargesGatewayFee`. |
| `src/lib/metrics/engine.ts` | COGS and fulfillment convert from `costCurrency`; gateway fee skips B2B. |
| `src/lib/metrics/engine.test.ts` | Factory gains `costCurrency`; three new cases. **No existing assertion changes.** |
| `src/lib/metrics/ambassadors.test.ts`, `gross-revenue.test.ts`, `trend.test.ts` | Factory gains `costCurrency`. One line each. |
| `src/lib/data/load.ts` | Selects the new columns, maps the new fields, rewrites `needsRates`. |
| `src/lib/data/load.integration.test.ts` | Covers the new mapping. |
| `src/app/api/orders/route.ts` | Same three figure fixes; `source` in the payload and as a filter. |
| `src/app/api/orders/route.test.ts` | Covers both. |
| `src/app/orders/OrdersClient.tsx` | B2B badge and Source filter. |
| `src/components/shell/AppShell.tsx` | `B2B` nav item under Analytics. |
| `src/components/shell/AppShell.test.tsx` | Covers it. |

---

### Task 1: Schema - the two tables and the four columns

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `B2bCustomer { id, shopId, name, currency, vatPercent, email, note, active, createdAt }` and `B2bPrice { id, customerId, productId, unitPrice }`; `Order.b2bCustomerId: string | null`, `Order.fulfillmentCost: number | null`; `OrderItem.discountValue: number | null`, `OrderItem.discountKind: string | null`. Every later task depends on these names.

- [ ] **Step 1: Add the two models**

Append to `prisma/schema.prisma`:

```prisma
// A business customer who buys off the webshop. Their orders are ordinary
// Order rows - what makes them different is an agreed price list, their own
// currency, and an invoice instead of a card.
model B2bCustomer {
  id         String   @id @default(cuid())
  shopId     String
  name       String
  currency   String   // what they pay in; need not be the shop's
  vatPercent Float    @default(0) // 25 domestic, 0 reverse-charge or export
  email      String?
  note       String?
  active     Boolean  @default(true)
  createdAt  DateTime @default(now())

  shop   Shop        @relation(fields: [shopId], references: [id], onDelete: Cascade)
  prices B2bPrice[]
  orders Order[]

  @@unique([shopId, name])
  @@index([shopId])
}

// This customer's agreed price for one product, in the CUSTOMER'S currency,
// excluding VAT. Deliberately NOT a timeline like ProductCost: it only ever
// pre-fills the order form, and the price actually charged is frozen on the
// OrderItem, so renegotiating a price can never rewrite a past order.
model B2bPrice {
  id         String @id @default(cuid())
  customerId String
  productId  String
  unitPrice  Int    // minor units, customer currency, ex VAT

  customer B2bCustomer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  product  Product     @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@unique([customerId, productId])
}
```

- [ ] **Step 2: Add the columns and back-references**

In `model Shop`, beside `adAccounts`:

```prisma
  b2bCustomers     B2bCustomer[]
```

In `model Product`, beside `items`:

```prisma
  b2bPrices B2bPrice[]
```

In `model Order`, after `ambassadorId`:

```prisma
  // Set = this order was entered by hand for a business customer. It is the
  // B2B marker, and the reason the order pays no gateway fee.
  b2bCustomerId   String?
  // What shipping this order actually cost us, in the SHOP's currency (the
  // same frame as FulfillmentRate.perOrder). null = a webshop order, which
  // uses the shop's standing rate instead.
  fulfillmentCost Int?
```

In `model Order`, beside the `ambassador` relation:

```prisma
  b2bCustomer B2bCustomer? @relation(fields: [b2bCustomerId], references: [id], onDelete: Restrict)
```

In `model Order`, beside the other indexes:

```prisma
  @@index([b2bCustomerId])
```

In `model OrderItem`, after `lineNetTotal`:

```prisma
  // What was typed on the B2B order form, kept so re-opening it shows "10%"
  // rather than the amount it worked out to. null on every webshop order.
  discountValue Int?    // 10 (percent) or 2000 (minor units per unit)
  discountKind  String? // "PERCENT" | "AMOUNT"
```

- [ ] **Step 3: Push the schema and regenerate the client**

Run: `npx prisma db push && npx prisma generate`
Expected: "Your database is now in sync with your Prisma schema." No prompt about data loss. If it asks to reset, STOP - something is not additive.

- [ ] **Step 4: Verify nothing existing broke**

Run: `npm test`
Expected: PASS, the same count as before this task. The new columns are nullable and unread, so no behaviour changed.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: tables for B2B customers and their agreed prices"
```

---

### Task 2: `src/lib/b2b/pricing.ts` - the money math

**Files:**
- Create: `src/lib/b2b/pricing.ts`
- Test: `src/lib/b2b/pricing.test.ts`

**Interfaces:**
- Consumes: `pct`, `sum` from `src/lib/money.ts`.
- Produces:
  - `type DiscountKind = 'PERCENT' | 'AMOUNT'`
  - `type B2bLine = { quantity: number; unitPrice: number; discountValue: number; discountKind: DiscountKind }`
  - `lineTotals(line: B2bLine): { gross: number; discount: number; net: number }`
  - `type OrderTotals = { grossSales, discountTotal, netSales, shippingCharged, taxTotal, total }` - all `number`
  - `orderTotals(lines: B2bLine[], shippingCharged: number, vatPercent: number): OrderTotals`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/b2b/pricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { lineTotals, orderTotals, type B2bLine } from './pricing'

const line = (over: Partial<B2bLine> = {}): B2bLine => ({
  quantity: 1,
  unitPrice: 10000, // 100.00
  discountValue: 0,
  discountKind: 'PERCENT',
  ...over,
})

describe('lineTotals', () => {
  it('takes a percentage off the whole line', () => {
    // 10 x 89.00 = 890.00, less 10% = 801.00
    const t = lineTotals(line({ quantity: 10, unitPrice: 8900, discountValue: 10 }))
    expect(t).toEqual({ gross: 89000, discount: 8900, net: 80100 })
  })

  it('takes a fixed amount off EACH UNIT, not off the line', () => {
    // 4 x 245.00 = 980.00, less 20.00 per chair = 900.00
    const t = lineTotals(
      line({ quantity: 4, unitPrice: 24500, discountValue: 2000, discountKind: 'AMOUNT' }),
    )
    expect(t).toEqual({ gross: 98000, discount: 8000, net: 90000 })
  })

  it('charges the full price when there is no discount', () => {
    expect(lineTotals(line({ quantity: 3 }))).toEqual({ gross: 30000, discount: 0, net: 30000 })
  })

  it('rounds a percentage half away from zero, like every other figure', () => {
    // 3 x 33.33 = 99.99; 10% of that is 9.999 -> 10.00
    const t = lineTotals(line({ quantity: 3, unitPrice: 3333, discountValue: 10 }))
    expect(t.discount).toBe(1000)
    expect(t.net).toBe(8999)
  })

  it('never discounts more than the line is worth', () => {
    // A discount cannot invent revenue: net floors at zero, never goes negative.
    const percent = lineTotals(line({ quantity: 2, discountValue: 150 }))
    expect(percent).toEqual({ gross: 20000, discount: 20000, net: 0 })

    const amount = lineTotals(
      line({ quantity: 2, discountValue: 99999, discountKind: 'AMOUNT' }),
    )
    expect(amount).toEqual({ gross: 20000, discount: 20000, net: 0 })
  })

  it('ignores a negative discount rather than adding to the price', () => {
    expect(lineTotals(line({ discountValue: -50 })).discount).toBe(0)
  })
})

describe('orderTotals', () => {
  const lines: B2bLine[] = [
    { quantity: 10, unitPrice: 8900, discountValue: 10, discountKind: 'PERCENT' },
    { quantity: 4, unitPrice: 24500, discountValue: 2000, discountKind: 'AMOUNT' },
  ]

  it('adds the lines up the way the engine defines net sales', () => {
    const t = orderTotals(lines, 0, 0)
    expect(t.grossSales).toBe(187000) // 890.00 + 980.00
    expect(t.discountTotal).toBe(16900) // 89.00 + 80.00
    expect(t.netSales).toBe(170100)
  })

  it('charges VAT on the goods AND the shipping', () => {
    // net 1701.00 + shipping 50.00 = 1751.00; 25% = 437.75
    const t = orderTotals(lines, 5000, 25)
    expect(t.shippingCharged).toBe(5000)
    expect(t.taxTotal).toBe(43775)
    expect(t.total).toBe(218875) // 175100 + 43775
  })

  it('records no VAT for a reverse-charge or export customer', () => {
    const t = orderTotals(lines, 5000, 0)
    expect(t.taxTotal).toBe(0)
    expect(t.total).toBe(175100) // exactly net sales plus shipping
  })

  it('is all zeros for an empty order', () => {
    expect(orderTotals([], 0, 25)).toEqual({
      grossSales: 0, discountTotal: 0, netSales: 0,
      shippingCharged: 0, taxTotal: 0, total: 0,
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/b2b/pricing.test.ts`
Expected: FAIL - "Failed to resolve import './pricing'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/b2b/pricing.ts`:

```ts
/**
 * What a B2B order is worth.
 *
 * Pure arithmetic on integer minor units, in the CUSTOMER's currency. The field
 * names are deliberately the ones `mapOrder()` produces from WooCommerce, so an
 * order built from this lands in the database in exactly the shape the metrics
 * engine already reads - no special case anywhere downstream.
 */
import { pct, sum } from '../money'

export type DiscountKind = 'PERCENT' | 'AMOUNT'

export type B2bLine = {
  quantity: number
  /** Minor units, ex VAT, BEFORE any discount. */
  unitPrice: number
  /** 10 for "10%", or 2000 for "20.00 off each one". 0 when there is none. */
  discountValue: number
  discountKind: DiscountKind
}

export type LineTotals = { gross: number; discount: number; net: number }

/**
 * One line's worth.
 *
 * An AMOUNT discount is PER UNIT - "20.00 off each chair" - which is the frame
 * the unit price beside it on the form is already in. The discount is clamped
 * to [0, gross]: a discount reduces revenue and can never invent it, and a
 * negative one is a typo, not a surcharge.
 */
export function lineTotals(line: B2bLine): LineTotals {
  const gross = line.quantity * line.unitPrice

  const raw =
    line.discountKind === 'PERCENT'
      ? pct(gross, line.discountValue / 100)
      : line.discountValue * line.quantity

  const discount = Math.min(Math.max(raw, 0), gross)
  return { gross, discount, net: gross - discount }
}

export type OrderTotals = {
  grossSales: number
  discountTotal: number
  netSales: number
  shippingCharged: number
  taxTotal: number
  total: number
}

/**
 * The whole order.
 *
 * `vatPercent` is a percentage - 25 means 25% - and it falls on the goods and
 * the shipping alike, because shipping follows the rate of what is being
 * shipped. VAT is recorded, never counted as revenue: the engine's
 * `netRevenue` is net sales plus shipping, and `grossRevenue` adds the VAT back
 * only to say what the customer actually paid.
 */
export function orderTotals(
  lines: B2bLine[],
  shippingCharged: number,
  vatPercent: number,
): OrderTotals {
  const totals = lines.map(lineTotals)

  const grossSales = sum(totals.map((t) => t.gross))
  const discountTotal = sum(totals.map((t) => t.discount))
  const netSales = grossSales - discountTotal
  const taxTotal = pct(netSales + shippingCharged, vatPercent / 100)

  return {
    grossSales,
    discountTotal,
    netSales,
    shippingCharged,
    taxTotal,
    total: netSales + shippingCharged + taxTotal,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/b2b/pricing.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/b2b/pricing.ts src/lib/b2b/pricing.test.ts
git commit -m "feat: what a B2B order is worth, per line and in total"
```

---

### Task 3: `src/lib/b2b/numbering.ts` - the B-NNNN identity

**Files:**
- Create: `src/lib/b2b/numbering.ts`
- Test: `src/lib/b2b/numbering.test.ts`

**Interfaces:**
- Consumes: `db` from `src/lib/db.ts` (only in `nextB2bNumber`).
- Produces:
  - `parseB2bNumber(number: string): number` - `"B-0007"` → `7`, anything else → `0`
  - `formatB2bNumber(n: number): string` - `7` → `"B-0007"`
  - `b2bExternalId(number: string): string` - `"B-0007"` → `"b2b:B-0007"`
  - `nextB2bNumber(shopId: string): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/b2b/numbering.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { b2bExternalId, formatB2bNumber, parseB2bNumber } from './numbering'

describe('formatB2bNumber', () => {
  it('pads to four digits so a list sorts the way it reads', () => {
    expect(formatB2bNumber(1)).toBe('B-0001')
    expect(formatB2bNumber(42)).toBe('B-0042')
    expect(formatB2bNumber(9999)).toBe('B-9999')
  })

  it('simply gets longer past four digits rather than wrapping', () => {
    expect(formatB2bNumber(10000)).toBe('B-10000')
  })
})

describe('parseB2bNumber', () => {
  it('reads its own format back', () => {
    expect(parseB2bNumber('B-0007')).toBe(7)
    expect(parseB2bNumber('B-10000')).toBe(10000)
  })

  it('returns 0 for anything that is not one of ours', () => {
    // A WooCommerce number, an empty string, junk. 0 means "counts for
    // nothing when we look for the highest", which is exactly right.
    expect(parseB2bNumber('1042')).toBe(0)
    expect(parseB2bNumber('')).toBe(0)
    expect(parseB2bNumber('B-')).toBe(0)
    expect(parseB2bNumber('B-abc')).toBe(0)
  })
})

describe('b2bExternalId', () => {
  it('namespaces the id so a WooCommerce order can never collide with it', () => {
    // Woo external ids are always String(woo.id) - plain digits.
    expect(b2bExternalId('B-0007')).toBe('b2b:B-0007')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/b2b/numbering.test.ts`
Expected: FAIL - "Failed to resolve import './numbering'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/b2b/numbering.ts`:

```ts
/**
 * How a hand-entered order is identified.
 *
 * B2B orders carry their own sequence - B-0001, B-0002 - rather than borrowing
 * the webshop's numbers, and their `externalId` is namespaced `b2b:`. A
 * WooCommerce `externalId` is always `String(woo.id)`, plain digits, so the
 * `@@unique([shopId, externalId])` that the sync and the webhook upsert on can
 * never match a hand-entered order and overwrite it.
 */
import { db } from '../db'

const PREFIX = 'B-'
const PAD = 4

/** 7 -> "B-0007". Past four digits it simply gets longer; nothing wraps. */
export function formatB2bNumber(n: number): string {
  return PREFIX + String(n).padStart(PAD, '0')
}

/** "B-0007" -> 7. Anything that is not ours -> 0, so it loses every max(). */
export function parseB2bNumber(number: string): number {
  if (!number.startsWith(PREFIX)) return 0
  const digits = number.slice(PREFIX.length)
  if (!/^\d+$/.test(digits)) return 0
  return Number(digits)
}

export function b2bExternalId(number: string): string {
  return `b2b:${number}`
}

/**
 * The next number for this shop.
 *
 * Reads every B2B number the shop holds and takes the highest, rather than
 * `orderBy: { number: 'desc' }` - string ordering puts "B-9999" above
 * "B-10000" and would hand back a number already taken. These are typed by
 * hand, so the list is small enough that reading it costs nothing.
 *
 * Call inside the transaction that writes the order. Two saves racing still
 * collide on `@@unique([shopId, externalId])`; the caller retries once.
 */
export async function nextB2bNumber(shopId: string): Promise<string> {
  const rows = await db.order.findMany({
    where: { shopId, b2bCustomerId: { not: null } },
    select: { number: true },
  })

  const highest = rows.reduce((best, r) => Math.max(best, parseB2bNumber(r.number)), 0)
  return formatB2bNumber(highest + 1)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/b2b/numbering.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/b2b/numbering.ts src/lib/b2b/numbering.test.ts
git commit -m "feat: B2B orders number themselves, in their own sequence"
```

---

### Task 4: The engine learns that costs carry their own currency

This is the one task that edits live money code. The gate is that **no existing assertion changes** - only the shared `order()` factories gain one field, and every expected number stays exactly as it is.

**Files:**
- Modify: `src/lib/metrics/types.ts`
- Modify: `src/lib/metrics/engine.ts:88-148`
- Modify: `src/lib/metrics/engine.test.ts:22-40` (factory) and append three cases
- Modify: `src/lib/metrics/ambassadors.test.ts:8`, `src/lib/metrics/gross-revenue.test.ts:16`, `src/lib/metrics/trend.test.ts:54` (factories, one line each)

**Interfaces:**
- Consumes: `B2bLine` is not used here. `convert` from `./fx`, `fulfillmentOn` from `./engine`.
- Produces: `EngineOrder.costCurrency: string` (**required**), `EngineOrder.fulfillmentCost?: number | null`, `EngineOrder.chargesGatewayFee?: boolean`. Task 5 fills all three from the database.

- [ ] **Step 1: Add the three fields to `EngineOrder`**

In `src/lib/metrics/types.ts`, inside `export type EngineOrder`, after `currency: string`:

```ts
  /**
   * The currency this order's PRODUCT COSTS and FULFILLMENT RATE are held in -
   * its shop's. Usually the same as `currency`, and deliberately required
   * rather than defaulted: a B2B order can be invoiced in EUR while the shop's
   * costs stay in NOK, and silently reading one as the other is a tenfold
   * error in COGS. The compiler should make every caller say which it means.
   */
  costCurrency: string
```

and after `commissionRate: number`:

```ts
  /**
   * What shipping this order actually cost us, in `costCurrency`. Absent or
   * null = an ordinary webshop order, which is charged the shop's standing
   * per-order rate instead.
   */
  fulfillmentCost?: number | null
  /**
   * Does the payment gateway take a cut? Absent = yes, which is every order
   * that arrived through a checkout. False for an invoiced B2B order.
   */
  chargesGatewayFee?: boolean
```

- [ ] **Step 2: Add `costCurrency` to the four test factories**

Existing tests must still compile. In each factory add the field beside `currency`, matching the shop that factory uses. **Change nothing else - no assertion moves.**

`src/lib/metrics/engine.test.ts:28` (after `currency: 'NOK',`):

```ts
    costCurrency: 'NOK',
```

`src/lib/metrics/ambassadors.test.ts`, `src/lib/metrics/gross-revenue.test.ts`, `src/lib/metrics/trend.test.ts`: find the `currency: '...'` line in each `order()` factory and add `costCurrency` on the next line with the **same** value.

- [ ] **Step 3: Run the whole suite to prove the refactor is inert**

Run: `npm test`
Expected: PASS, the same count as Task 1. If a number moved, the factory picked up the wrong currency - fix that, do not adjust an assertion.

- [ ] **Step 4: Write the three failing tests**

Append to `src/lib/metrics/engine.test.ts`, inside `describe('computeMetrics', ...)`:

```ts
  // A business customer invoiced in EUR, buying from a NOK shop. Product costs
  // live in the SHOP's currency, so reading them as the order's would multiply
  // COGS by the EUR/NOK rate - about tenfold - and show a large false loss.
  it('reads product costs in the SHOP currency, not the order currency', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [order({ currency: 'EUR', costCurrency: 'NOK' })],
      expenses: [],
      costs,
      rates: buildRateTable([
        { date: new Date('2026-07-01'), currency: 'NOK', rate: 0.1 },
        { date: new Date('2026-07-01'), currency: 'EUR', rate: 1.1 },
      ]),
      displayCurrency: 'NOK',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
    })

    // 2 x (100.00 + 10.00) kr = 220.00 kr, displayed in kr - unchanged.
    // Converted from EUR it would have been 2 420.00 kr.
    expect(res.total.cogs).toBe(22000)
  })

  it('charges an invoiced B2B order no gateway fee', () => {
    const input = {
      shops: [shops[0]],
      expenses: [],
      costs,
      rates,
      displayCurrency: 'NOK',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
      processingFee: { percent: 2, fixedMinor: 300, currency: 'NOK' },
    }

    const webshop = computeMetrics({ ...input, orders: [order()] })
    expect(webshop.total.transactionFees).toBe(2650) // 2% of 1175.00 + 3.00

    const b2b = computeMetrics({ ...input, orders: [order({ chargesGatewayFee: false })] })
    expect(b2b.total.transactionFees).toBe(0)
    // The fee it did not pay is profit it keeps.
    expect(b2b.total.netProfit).toBe(webshop.total.netProfit + 2650)
  })

  it('uses a B2B order’s own shipping cost instead of the shop’s rate', () => {
    const input = {
      shops: [shops[0]],
      expenses: [],
      costs,
      rates,
      displayCurrency: 'NOK',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
      fulfillmentRates: new Map([
        ['no', [{ perOrder: 9900, effectiveFrom: new Date('2026-01-01') }]],
      ]),
    }

    expect(computeMetrics({ ...input, orders: [order()] }).total.fulfillment).toBe(9900)
    expect(
      computeMetrics({ ...input, orders: [order({ fulfillmentCost: 45000 })] }).total.fulfillment,
    ).toBe(45000)
    // Zero is a real answer - "we did not ship it" - not "fall back to the rate".
    expect(
      computeMetrics({ ...input, orders: [order({ fulfillmentCost: 0 })] }).total.fulfillment,
    ).toBe(0)
  })
```

- [ ] **Step 5: Run them to verify they fail**

Run: `npx vitest run src/lib/metrics/engine.test.ts`
Expected: FAIL on all three - COGS comes back 24200 (22000 × the EUR→USD rate
of 1.1, because `convert()` multiplies by the *from* currency's rate), fees
2650, fulfillment 9900.

- [ ] **Step 6: Make the three changes in `engine.ts`**

In `computeMetrics`, just below the existing `conv` helper (`engine.ts:93-94`), add its sibling:

```ts
    // Product costs and fulfillment rates are held in the SHOP's currency,
    // which a B2B order invoiced in another currency does not share.
    const convCost = (amount: number, order: EngineOrder) =>
      convert(amount, order.costCurrency, order.placedAt, displayCurrency, rates)
```

Replace the fulfillment block (`engine.ts:103-106`):

```ts
    // Fulfillment: what this order actually cost to ship when it says so - a
    // hand-entered B2B order does - otherwise the shop's rate on its day.
    const ratesForShop = input.fulfillmentRates?.get(shop.id) ?? []
    const fulfillment = sum(
      shopOrders.map((o) =>
        convCost(o.fulfillmentCost ?? fulfillmentOn(ratesForShop, o.placedAt), o),
      ),
    )
```

In the `transactionFees` block (`engine.ts:110-119`), filter before mapping:

```ts
    const fee = input.processingFee
    const transactionFees = !fee
      ? 0
      : sum(
          shopOrders
            // An invoiced order never went through the gateway, so the gateway
            // took nothing. Charging it anyway quietly shaves profit off every one.
            .filter((o) => o.chargesGatewayFee !== false)
            .map((o) => {
              const pctPart = Math.round((o.total * fee.percent) / 100)
              const fixedPart = crossConvert(fee.fixedMinor, fee.currency, o.currency, o.placedAt, rates)
              return conv(pctPart + fixedPart, o)
            }),
        )
```

In the `cogs` block (`engine.ts:122-132`), change the returned line from `conv(line, order)` to:

```ts
            return convCost(line, order)
```

- [ ] **Step 7: Run the engine tests**

Run: `npx vitest run src/lib/metrics/engine.test.ts`
Expected: PASS - the three new cases and every pre-existing one, with no assertion edited.

- [ ] **Step 8: Give the loader the real value - no stopgap**

`costCurrency` is required, so `src/lib/data/load.ts` stops compiling until it is set. Set it **correctly** now rather than parking the bug in a placeholder. Above the `orderRows` query, beside `rateByAmbassador`:

```ts
  // A shop's costs are in ITS currency. An order need not share it - a B2B
  // customer can be invoiced in EUR from a NOK store.
  const currencyByShop = new Map(shopRows.map((s) => [s.id, s.currency]))
```

and in the `orders` mapping, after `currency: o.currency,`:

```ts
    costCurrency: currencyByShop.get(o.shopId) ?? o.currency,
```

Task 5 adds the other two fields and the `needsRates` fix on top of this.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS. Every order in the database today is a WooCommerce order whose currency IS its shop's, so no number moves.

- [ ] **Step 10: Commit**

```bash
git add src/lib/metrics/types.ts src/lib/metrics/engine.ts src/lib/metrics/engine.test.ts src/lib/metrics/ambassadors.test.ts src/lib/metrics/gross-revenue.test.ts src/lib/metrics/trend.test.ts src/lib/data/load.ts
git commit -m "fix: product costs are the shop's currency, not the order's"
```

---

### Task 5: The loader fills the new fields and stops missing FX

**Files:**
- Modify: `src/lib/data/load.ts:61-104` (select and map), `:149-156` (`needsRates`)
- Test: `src/lib/data/load.integration.test.ts`

**Note:** Task 4 already added `currencyByShop` and the `costCurrency` mapping. This task adds the other two fields, the two new selects, and the `needsRates` rewrite on top.

**Interfaces:**
- Consumes: `EngineOrder.costCurrency`, `.fulfillmentCost`, `.chargesGatewayFee` from Task 4.
- Produces: nothing new. `loadMetricsInput` keeps its signature.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/data/load.integration.test.ts` (follow the file's existing setup and cleanup conventions - reuse its shop fixture helpers rather than inventing new ones):

```ts
describe('loadMetricsInput and B2B orders', () => {
  it('gives every order the SHOP’s currency as its cost currency', async () => {
    // A EUR order on a NOK shop: its own money is EUR, but the costs behind
    // it are NOK. Getting this wrong is a tenfold error in COGS.
    const shop = await db.shop.create({
      data: { name: 'Cost currency [load-test]', currency: 'NOK' },
    })
    const customer = await db.b2bCustomer.create({
      data: { shopId: shop.id, name: 'Nordic Retail [load-test]', currency: 'EUR', vatPercent: 0 },
    })
    await db.order.create({
      data: {
        shopId: shop.id, externalId: 'b2b:B-0001', number: 'B-0001',
        placedAt: new Date('2026-07-01'), status: 'completed', currency: 'EUR',
        grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0,
        taxTotal: 0, total: 10000, b2bCustomerId: customer.id, fulfillmentCost: 4200,
      },
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    const order = input.orders.find((o) => o.id !== undefined && o.currency === 'EUR')!
    expect(order.costCurrency).toBe('NOK')
    expect(order.fulfillmentCost).toBe(4200)
    expect(order.chargesGatewayFee).toBe(false)
  })

  it('marks an ordinary webshop order as paying the gateway fee', async () => {
    const shop = await db.shop.create({
      data: { name: 'Webshop [load-test]', currency: 'NOK' },
    })
    await db.order.create({
      data: {
        shopId: shop.id, externalId: '9001', number: '9001',
        placedAt: new Date('2026-07-01'), status: 'completed', currency: 'NOK',
        grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0,
        taxTotal: 0, total: 12500,
      },
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    const order = input.orders[0]
    expect(order.costCurrency).toBe('NOK')
    expect(order.chargesGatewayFee).toBe(true)
    expect(order.fulfillmentCost).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/data/load.integration.test.ts`
Expected: FAIL - `fulfillmentCost` and `chargesGatewayFee` are `undefined`. (`costCurrency` already reads `'NOK'` correctly; Task 4 set it.)

- [ ] **Step 3: Select the two new columns**

In `src/lib/data/load.ts`, inside the `db.order.findMany` `select` block (after `total: true,`):

```ts
      b2bCustomerId: true,
      fulfillmentCost: true,
```

- [ ] **Step 4: Map the two remaining fields**

`currencyByShop` and `costCurrency` are already there from Task 4. In the `orders` mapping, add beside `costCurrency`:

```ts
    fulfillmentCost: o.fulfillmentCost,
    // An invoiced B2B order never touched the gateway.
    chargesGatewayFee: o.b2bCustomerId === null,
```

- [ ] **Step 5: Rewrite `needsRates`**

Replace `src/lib/data/load.ts:149-156` entirely:

```ts
  // Every currency in play. More than one means something has to cross, and
  // crossing needs a rate. The previous version looked only at shop, expense
  // and fee currencies, so a EUR order on a NOK shop fetched nothing and was
  // then converted with whatever stale rates happened to be lying around.
  const inPlay = new Set([
    displayCurrency,
    ...shops.map((s) => s.currency),
    ...orders.map((o) => o.currency),
    ...expenses.map((e) => e.currency),
    ...(processingFee ? [processingFee.currency] : []),
  ])
  if (inPlay.size > 1) {
    await ensureRates(from, to, [...inPlay])
  }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/data/load.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/data/load.ts src/lib/data/load.integration.test.ts
git commit -m "fix: fetch exchange rates for order currencies too"
```

---

### Task 6: The Orders API tells B2B apart, and gets the same three fixes

**Files:**
- Modify: `src/app/api/orders/route.ts` - the `where` (`:59-85`), the `select` (`:94-122`), the figures (`:171-198`), the payload (`:200-225`)
- Test: `src/app/api/orders/route.test.ts`

**Interfaces:**
- Consumes: the schema from Task 1.
- Produces: each order in the JSON gains `source: 'webshop' | 'b2b'` and `customer: string | null` (the B2B customer's name, null for a webshop order). The `?source=` query parameter accepts `webshop` or `b2b`. `OrdersClient.tsx` (Task 12) consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/orders/route.test.ts`, following that file's existing auth and fixture helpers:

```ts
describe('B2B orders in the order list', () => {
  it('marks a hand-entered order as B2B and names its customer', async () => {
    await asAdmin()
    const res = await get(`?from=2026-07-01&to=2026-07-31&shops=${shopId}`)
    const body = await res.json()

    const b2b = body.orders.find((o: { number: string }) => o.number === 'B-0001')
    expect(b2b.source).toBe('b2b')
    expect(b2b.customer).toBe('Nordic Retail [orders-test]')

    const webshop = body.orders.find((o: { number: string }) => o.number === '9001')
    expect(webshop.source).toBe('webshop')
    expect(webshop.customer).toBeNull()
  })

  it('filters to one source or the other', async () => {
    await asAdmin()

    const onlyB2b = await (await get(`?from=2026-07-01&to=2026-07-31&shops=${shopId}&source=b2b`)).json()
    expect(onlyB2b.orders.map((o: { number: string }) => o.number)).toEqual(['B-0001'])

    const onlyWebshop = await (await get(`?from=2026-07-01&to=2026-07-31&shops=${shopId}&source=webshop`)).json()
    expect(onlyWebshop.orders.map((o: { number: string }) => o.number)).toEqual(['9001'])
  })

  it('charges a B2B order no gateway fee and its own shipping cost', async () => {
    await asAdmin()
    const body = await (await get(`?from=2026-07-01&to=2026-07-31&shops=${shopId}&source=b2b`)).json()

    expect(body.orders[0].figures.fee).toBe(0)
    expect(body.orders[0].figures.fulfillment).toBe(4200)
  })
})
```

Add to that file's `beforeEach`, after the existing shop fixture, a B2B customer and one order of each kind:

```ts
  const customer = await db.b2bCustomer.create({
    data: { shopId, name: 'Nordic Retail [orders-test]', currency: 'NOK', vatPercent: 0 },
  })
  await db.order.create({
    data: {
      shopId, externalId: 'b2b:B-0001', number: 'B-0001', placedAt: new Date('2026-07-05'),
      status: 'completed', currency: 'NOK', grossSales: 10000, discountTotal: 0,
      netSales: 10000, shippingCharged: 0, taxTotal: 0, total: 10000,
      customerName: 'Nordic Retail [orders-test]', customerEmail: '',
      b2bCustomerId: customer.id, fulfillmentCost: 4200,
    },
  })
  await db.order.create({
    data: {
      shopId, externalId: '9001', number: '9001', placedAt: new Date('2026-07-06'),
      status: 'completed', currency: 'NOK', grossSales: 10000, discountTotal: 0,
      netSales: 10000, shippingCharged: 0, taxTotal: 0, total: 12500,
    },
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/app/api/orders/route.test.ts`
Expected: FAIL - `source` is undefined and `?source=` is ignored.

- [ ] **Step 3: Accept the filter**

In `src/app/api/orders/route.ts`, beside the other query parameters (`:50-52`):

```ts
    // 'webshop' or 'b2b'; anything else means "both", the default.
    const source = params.get('source') ?? ''
```

and inside the `where` object, after the status clause:

```ts
      ...(source === 'b2b'
        ? { b2bCustomerId: { not: null } }
        : source === 'webshop'
          ? { b2bCustomerId: null }
          : {}),
```

- [ ] **Step 4: Select what the figures and the payload need**

In the `select` block, after `ambassadorId: true,`:

```ts
          b2bCustomerId: true,
          fulfillmentCost: true,
          b2bCustomer: { select: { name: true } },
```

and change `shop: { select: { name: true } },` to:

```ts
          shop: { select: { name: true, currency: true } },
```

- [ ] **Step 5: Apply the three figure fixes**

In the `orders = rows.map(...)` block, replace the body of `if (!earnsNothing) { ... }`:

```ts
        // Costs are held in the SHOP's currency, which a B2B order invoiced in
        // another currency does not share. Same correction as engine.ts.
        const costCurrency = o.shop.currency
        const toOrder = (amount: number) =>
          crossConvert(amount, costCurrency, o.currency, o.placedAt, rates)

        const cogs = toOrder(
          o.items.reduce((sum, i) => {
            const cost = costOn(costs.get(i.productId) ?? [], o.placedAt)
            return sum + i.quantity * (cost.costPerItem + cost.handlingCost)
          }, 0),
        )
        // A hand-entered order carries what shipping actually cost; a webshop
        // order is charged the shop's rate on its day.
        const fulfillment = toOrder(
          o.fulfillmentCost ?? fulfillmentOn(fulfillmentRates.get(o.shopId) ?? [], o.placedAt),
        )
        // An invoiced order never went through the gateway.
        const fee =
          feeRow && o.b2bCustomerId === null
            ? Math.round((o.total * feeRow.percent) / 100) +
              crossConvert(feeRow.fixedMinor, feeRow.currency, o.currency, o.placedAt, rates)
            : 0
        const commission = o.ambassadorId
          ? pct(o.netSales, rateByAmbassador.get(o.ambassadorId) ?? 0)
          : 0
        const netRevenue = o.netSales + o.shippingCharged
        const profit = netRevenue - cogs - fulfillment - fee - commission
        figures = {
          cogs,
          fulfillment,
          fee,
          commission,
          profit,
          margin: netRevenue === 0 ? 0 : profit / netRevenue,
        }
```

- [ ] **Step 6: Always build the rate table**

`crossConvert` is now used for costs, not only for the fee's fixed part, so the old `needsRates` shortcut would leave the table empty whenever a shop and an order share a currency but another order does not. Replace `:167-169`:

```ts
    // Costs cross from the shop's currency into the order's, so a page holding
    // any order whose currency differs from its shop's needs the table. Cheap:
    // loadRates() is one indexed read and crossConvert short-circuits when the
    // two currencies match.
    const needsRates = rows.some(
      (o) => o.currency !== o.shop.currency || (!!feeRow && o.currency !== feeRow.currency),
    )
    const rates: RateTable = needsRates ? buildRateTable(await loadRates()) : new Map()
```

- [ ] **Step 7: Add the two payload fields**

In the returned object, after `customerEmail: o.customerEmail,`:

```ts
        source: o.b2bCustomerId === null ? ('webshop' as const) : ('b2b' as const),
        customer: o.b2bCustomer?.name ?? null,
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/app/api/orders/route.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/app/api/orders/route.ts src/app/api/orders/route.test.ts
git commit -m "feat: the order list tells a B2B order from a webshop one"
```

---

### Task 7: The customer routes

**Files:**
- Create: `src/app/api/b2b/customers/route.ts`, `src/app/api/b2b/customers/[id]/route.ts`
- Test: `src/app/api/b2b/customers/route.test.ts`, `src/app/api/b2b/customers/[id]/route.test.ts`

**Interfaces:**
- Consumes: `db`, `assertAdmin`, `AuthError`, `currentUser`, `toMinor`, `costOn`, `EXCLUDED_STATUSES`.
- Produces:
  - `GET /api/b2b/customers?shopId=` → `{ customers: CustomerRow[] }`,
    `CustomerRow = { id, name, shopId, shopName, currency, vatPercent, email, note, active, priceCount, orderCount, revenue }`. `revenue` is minor units in the customer's **own** currency.
  - `POST /api/b2b/customers` body `{ shopId, name, currency, vatPercent?, email?, note?, prices?: { productId, unitPrice }[] }` - `unitPrice` in **major** units as typed → `{ customer: { id } }`; 409 on a duplicate name.
  - `GET /api/b2b/customers/[id]` → `{ customer: CustomerRow & { shopCurrency, canChangeShop, prices: PriceRow[] } }`,
    `PriceRow = { productId, sku, name, imageUrl, unitPrice, costPerItem, handlingCost }` - `unitPrice` in the customer's currency, both costs in the **shop's**.
  - `PATCH /api/b2b/customers/[id]` - POST's body plus `active`, `shopId` optional; `prices` replaces the list wholesale.
  - `DELETE /api/b2b/customers/[id]` → 409 `{ error: 'This customer has orders. Deactivate them instead.' }` when orders exist.
  - Exported helpers Task 8 imports: `Price` (the Zod object) and `assertProductsBelongToShop(shopId, productIds)`.

- [ ] **Step 1: Write the failing tests for the collection route**

Create `src/app/api/b2b/customers/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, POST } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/b2b/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

const get = (qs = '') => GET(new Request(`http://localhost/api/b2b/customers${qs}`))

const TAG = '[b2b-cust-test]'
let shopId = ''
let otherShopId = ''
let productId = ''
let otherProductId = ''

// Shops cascade to their products, customers and orders, so one delete is enough.
async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `A ${TAG}`, currency: 'NOK' } })).id
  otherShopId = (await db.shop.create({ data: { name: `B ${TAG}`, currency: 'SEK' } })).id
  productId = (await db.product.create({
    data: { shopId, externalId: '1', sku: 'SKU-1', name: 'Massage gun' },
  })).id
  otherProductId = (await db.product.create({
    data: { shopId: otherShopId, externalId: '2', sku: 'SKU-2', name: 'Chair' },
  })).id
})
afterEach(cleanup)

describe('GET /api/b2b/customers', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await get()).status).toBe(403)
  })

  it('reports the price count, order count and revenue', async () => {
    await asAdmin()
    await post({
      shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 0,
      prices: [{ productId, unitPrice: 89 }],
    })
    const created = await db.b2bCustomer.findFirstOrThrow({ where: { shopId } })

    // One earning order and one refunded: only the first counts, exactly as
    // the engine counts them.
    await db.order.createMany({
      data: [
        { shopId, externalId: 'b2b:B-0001', number: 'B-0001', placedAt: new Date('2026-07-01'),
          status: 'completed', currency: 'EUR', grossSales: 89000, discountTotal: 0,
          netSales: 89000, shippingCharged: 1000, taxTotal: 0, total: 90000,
          b2bCustomerId: created.id },
        { shopId, externalId: 'b2b:B-0002', number: 'B-0002', placedAt: new Date('2026-07-02'),
          status: 'refunded', currency: 'EUR', grossSales: 5000, discountTotal: 0,
          netSales: 5000, shippingCharged: 0, taxTotal: 0, total: 5000,
          b2bCustomerId: created.id },
      ],
    })

    const body = await (await get(`?shopId=${shopId}`)).json()
    const row = body.customers.find((c: { name: string }) => c.name === `Nordic ${TAG}`)
    expect(row.priceCount).toBe(1)
    expect(row.orderCount).toBe(1)
    expect(row.revenue).toBe(90000) // net sales + shipping; the refund earned nothing
    expect(row.shopName).toBe(`A ${TAG}`)
  })
})

describe('POST /api/b2b/customers', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({ shopId, name: 'X', currency: 'EUR' })).status).toBe(403)
  })

  it('stores the agreed prices in minor units', async () => {
    await asAdmin()
    expect((await post({
      shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 25,
      prices: [{ productId, unitPrice: 89.5 }],
    })).status).toBe(200)

    const saved = await db.b2bCustomer.findFirstOrThrow({
      where: { shopId }, include: { prices: true },
    })
    expect(saved.currency).toBe('EUR')
    expect(saved.vatPercent).toBe(25)
    expect(saved.prices[0].unitPrice).toBe(8950)
  })

  it('refuses a price for a product from another shop', async () => {
    // Otherwise a customer of shop A could be priced on shop B's catalogue,
    // and the order form would sell it without blinking.
    await asAdmin()
    const res = await post({
      shopId, name: `Wrong ${TAG}`, currency: 'EUR',
      prices: [{ productId: otherProductId, unitPrice: 10 }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That product does not belong to this shop')
    expect(await db.b2bCustomer.count({ where: { shopId } })).toBe(0)
  })

  it('rejects a VAT rate above 100', async () => {
    await asAdmin()
    expect((await post({ shopId, name: `Bad ${TAG}`, currency: 'EUR', vatPercent: 120 })).status).toBe(400)
  })

  it('rejects a duplicate name on the same shop with 409', async () => {
    await asAdmin()
    await post({ shopId, name: `Dupe ${TAG}`, currency: 'EUR' })
    expect((await post({ shopId, name: `Dupe ${TAG}`, currency: 'EUR' })).status).toBe(409)
  })

  it('allows the same name on a different shop', async () => {
    await asAdmin()
    expect((await post({ shopId, name: `Same ${TAG}`, currency: 'EUR' })).status).toBe(200)
    expect((await post({ shopId: otherShopId, name: `Same ${TAG}`, currency: 'SEK' })).status).toBe(200)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/app/api/b2b/customers/route.test.ts`
Expected: FAIL - "Failed to resolve import './route'".

- [ ] **Step 3: Write the collection route**

Create `src/app/api/b2b/customers/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const Price = z.object({
  productId: z.string().min(1),
  unitPrice: z.number().min(0), // MAJOR units, as typed on the form
})

const Body = z.object({
  shopId: z.string().min(1),
  name: z.string().min(1),
  currency: z.string().length(3),
  vatPercent: z.number().min(0).max(100).default(0),
  email: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  prices: z.array(Price).default([]),
})

/**
 * Every product priced for a customer must belong to that customer's shop.
 * Without this a customer of the Norwegian store could be priced on the
 * Swedish catalogue, and the order form would sell it. The [id] route and the
 * order routes enforce the same rule through this one function.
 */
export async function assertProductsBelongToShop(
  shopId: string,
  productIds: string[],
): Promise<void> {
  const wanted = new Set(productIds)
  if (wanted.size === 0) return

  const found = await db.product.count({ where: { shopId, id: { in: [...wanted] } } })
  if (found !== wanted.size) {
    throw new RangeError('That product does not belong to this shop')
  }
}

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')

    const rows = await db.b2bCustomer.findMany({
      where: shopId ? { shopId } : {},
      orderBy: { name: 'asc' },
      include: {
        shop: { select: { name: true } },
        _count: { select: { prices: true } },
      },
    })

    // Revenue and order count in one grouped read, not one query per customer.
    // Voided and unpaid orders are left out for the reason the engine leaves
    // them out: they earned nothing.
    const totals = await db.order.groupBy({
      by: ['b2bCustomerId'],
      where: {
        b2bCustomerId: { in: rows.map((r) => r.id) },
        status: { notIn: [...EXCLUDED_STATUSES] },
      },
      _count: { _all: true },
      _sum: { netSales: true, shippingCharged: true },
    })
    const byCustomer = new Map(totals.map((t) => [t.b2bCustomerId, t]))

    return NextResponse.json(
      {
        customers: rows.map((c) => {
          const t = byCustomer.get(c.id)
          return {
            id: c.id,
            name: c.name,
            shopId: c.shopId,
            shopName: c.shop.name,
            currency: c.currency,
            vatPercent: c.vatPercent,
            email: c.email,
            note: c.note,
            active: c.active,
            priceCount: c._count.prices,
            orderCount: t?._count._all ?? 0,
            // Net revenue in the customer's OWN currency - every one of their
            // orders is in it, so nothing here needs converting.
            revenue: (t?._sum.netSales ?? 0) + (t?._sum.shippingCharged ?? 0),
          }
        }),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load customers' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid customer' }, { status: 400, headers: NO_STORE })
    const d = parsed.data

    await assertProductsBelongToShop(d.shopId, d.prices.map((p) => p.productId))

    // The customer and their price list land together or not at all.
    const customer = await db.b2bCustomer.create({
      data: {
        shopId: d.shopId,
        name: d.name.trim(),
        currency: d.currency.toUpperCase(),
        vatPercent: d.vatPercent,
        email: d.email?.trim() || null,
        note: d.note?.trim() || null,
        prices: {
          create: d.prices.map((p) => ({ productId: p.productId, unitPrice: toMinor(p.unitPrice) })),
        },
      },
      select: { id: true },
    })

    return NextResponse.json({ customer }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof RangeError)
      return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      return NextResponse.json(
        { error: 'That shop already has a customer with this name' },
        { status: 409, headers: NO_STORE },
      )
    console.error(e)
    return NextResponse.json({ error: 'Could not save the customer' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: Run the collection tests**

Run: `npx vitest run src/app/api/b2b/customers/route.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing tests for the item route**

Create `src/app/api/b2b/customers/[id]/route.test.ts`. Copy the mock, `asAdmin`, `TAG` (change to `[b2b-cust-id-test]`), fixtures and `cleanup` from Step 1 verbatim - repeated deliberately, because these files are read independently - then replace the import and helpers with:

```ts
const { GET, PATCH, DELETE } = await import('./route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/b2b/customers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id),
  )

const b2bOrder = (customerId: string) =>
  db.order.create({
    data: {
      shopId, externalId: 'b2b:B-0001', number: 'B-0001', placedAt: new Date('2026-07-01'),
      status: 'completed', currency: 'EUR', grossSales: 1000, discountTotal: 0,
      netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
      customerName: 'x', customerEmail: '', b2bCustomerId: customerId,
    },
  })
```

and these cases:

```ts
describe('GET /api/b2b/customers/[id]', () => {
  it('returns the price list with our own cost beside the agreed price', async () => {
    await asAdmin()
    const c = await db.b2bCustomer.create({
      data: {
        shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 0,
        prices: { create: [{ productId, unitPrice: 8900 }] },
      },
    })
    await db.productCost.create({
      data: { productId, costPerItem: 4000, handlingCost: 500, effectiveFrom: new Date('2026-01-01') },
    })

    const body = await (await GET(new Request('http://localhost/x'), params(c.id))).json()
    expect(body.customer.prices[0]).toMatchObject({
      productId, sku: 'SKU-1', name: 'Massage gun',
      unitPrice: 8900,   // EUR - the customer's currency
      costPerItem: 4000, // NOK - the shop's
      handlingCost: 500,
    })
    expect(body.customer.shopCurrency).toBe('NOK')
    expect(body.customer.canChangeShop).toBe(true) // no orders yet
  })

  it('404s for a customer that does not exist', async () => {
    await asAdmin()
    expect((await GET(new Request('http://localhost/x'), params('nope'))).status).toBe(404)
  })
})

describe('PATCH /api/b2b/customers/[id]', () => {
  it('replaces the whole price list rather than merging into it', async () => {
    await asAdmin()
    const second = await db.product.create({
      data: { shopId, externalId: '3', sku: 'SKU-3', name: 'Belt' },
    })
    const c = await db.b2bCustomer.create({
      data: {
        shopId, name: `Nordic ${TAG}`, currency: 'EUR',
        prices: { create: [{ productId, unitPrice: 8900 }] },
      },
    })

    expect((await patch(c.id, {
      name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 0,
      prices: [{ productId: second.id, unitPrice: 12 }],
    })).status).toBe(200)

    const after = await db.b2bPrice.findMany({ where: { customerId: c.id } })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ productId: second.id, unitPrice: 1200 })
  })

  it('refuses to move a customer who already has orders to another shop', async () => {
    // Their price list points at this shop's products and their revenue has
    // already been reported under it. Moving them would rewrite both.
    await asAdmin()
    const c = await db.b2bCustomer.create({
      data: { shopId, name: `Settled ${TAG}`, currency: 'EUR' },
    })
    await b2bOrder(c.id)

    expect((await patch(c.id, {
      shopId: otherShopId, name: `Settled ${TAG}`, currency: 'EUR', vatPercent: 0, prices: [],
    })).status).toBe(400)
    expect((await db.b2bCustomer.findUniqueOrThrow({ where: { id: c.id } })).shopId).toBe(shopId)
  })

  it('deactivates without touching anything they bought', async () => {
    await asAdmin()
    const c = await db.b2bCustomer.create({ data: { shopId, name: `Gone ${TAG}`, currency: 'EUR' } })
    await b2bOrder(c.id)

    expect((await patch(c.id, {
      name: `Gone ${TAG}`, currency: 'EUR', vatPercent: 0, active: false, prices: [],
    })).status).toBe(200)
    expect((await db.b2bCustomer.findUniqueOrThrow({ where: { id: c.id } })).active).toBe(false)
    expect(await db.order.count({ where: { b2bCustomerId: c.id } })).toBe(1)
  })
})

describe('DELETE /api/b2b/customers/[id]', () => {
  it('deletes a customer who never ordered', async () => {
    await asAdmin()
    const c = await db.b2bCustomer.create({ data: { shopId, name: `Unused ${TAG}`, currency: 'EUR' } })
    expect((await DELETE(new Request('http://localhost/x'), params(c.id))).status).toBe(200)
    expect(await db.b2bCustomer.findUnique({ where: { id: c.id } })).toBeNull()
  })

  it('refuses to delete one who has orders, and says what to do instead', async () => {
    await asAdmin()
    const c = await db.b2bCustomer.create({ data: { shopId, name: `Busy ${TAG}`, currency: 'EUR' } })
    await b2bOrder(c.id)

    const res = await DELETE(new Request('http://localhost/x'), params(c.id))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This customer has orders. Deactivate them instead.')
    expect(await db.order.count({ where: { b2bCustomerId: c.id } })).toBe(1)
  })
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run "src/app/api/b2b/customers/[id]/route.test.ts"`
Expected: FAIL - "Failed to resolve import './route'".

- [ ] **Step 7: Write the item route**

Create `src/app/api/b2b/customers/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { costOn } from '@/lib/metrics/costs'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'
import { assertProductsBelongToShop, Price } from '../route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const Body = z.object({
  // Only honoured while the customer has no orders; see below.
  shopId: z.string().min(1).optional(),
  name: z.string().min(1),
  currency: z.string().length(3),
  vatPercent: z.number().min(0).max(100).default(0),
  email: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  active: z.boolean().default(true),
  prices: z.array(Price).default([]),
})

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const c = await db.b2bCustomer.findUnique({
      where: { id },
      include: {
        shop: { select: { name: true, currency: true } },
        prices: {
          include: {
            product: {
              select: {
                sku: true, name: true, imageUrl: true,
                costs: { orderBy: { effectiveFrom: 'desc' } },
              },
            },
          },
        },
      },
    })
    if (!c)
      return NextResponse.json({ error: 'No such customer' }, { status: 404, headers: NO_STORE })

    const totals = await db.order.aggregate({
      where: { b2bCustomerId: id, status: { notIn: [...EXCLUDED_STATUSES] } },
      _count: { _all: true },
      _sum: { netSales: true, shippingCharged: true },
    })
    // Any order at all locks the shop, not just an earning one - a refunded
    // order is still history reported under this store.
    const everOrdered = await db.order.count({ where: { b2bCustomerId: id } })
    const today = new Date()

    return NextResponse.json(
      {
        customer: {
          id: c.id,
          name: c.name,
          shopId: c.shopId,
          shopName: c.shop.name,
          shopCurrency: c.shop.currency,
          currency: c.currency,
          vatPercent: c.vatPercent,
          email: c.email,
          note: c.note,
          active: c.active,
          priceCount: c.prices.length,
          orderCount: totals._count._all,
          revenue: (totals._sum.netSales ?? 0) + (totals._sum.shippingCharged ?? 0),
          canChangeShop: everOrdered === 0,
          prices: c.prices.map((p) => {
            const cost = costOn(p.product.costs, today)
            return {
              productId: p.productId,
              sku: p.product.sku,
              name: p.product.name,
              imageUrl: p.product.imageUrl,
              // The agreed price is in the CUSTOMER's currency…
              unitPrice: p.unitPrice,
              // …and these two are in the SHOP's. The UI labels both columns.
              costPerItem: cost.costPerItem,
              handlingCost: cost.handlingCost,
            }
          }),
        },
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the customer' }, { status: 500, headers: NO_STORE })
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid customer' }, { status: 400, headers: NO_STORE })
    const d = parsed.data

    const existing = await db.b2bCustomer.findUnique({ where: { id } })
    if (!existing)
      return NextResponse.json({ error: 'No such customer' }, { status: 404, headers: NO_STORE })

    const movingShop = d.shopId !== undefined && d.shopId !== existing.shopId
    if (movingShop && (await db.order.count({ where: { b2bCustomerId: id } })) > 0) {
      return NextResponse.json(
        { error: 'This customer already has orders, so their shop cannot be changed.' },
        { status: 400, headers: NO_STORE },
      )
    }
    const shopId = movingShop ? d.shopId! : existing.shopId

    await assertProductsBelongToShop(shopId, d.prices.map((p) => p.productId))

    // Rewrite the price list rather than diff it - storeOrder()'s rule for
    // order lines, for the same reason: simpler and always right. Replacing a
    // price never touches an order already placed, because the price actually
    // charged is frozen on the OrderItem.
    await db.$transaction([
      db.b2bPrice.deleteMany({ where: { customerId: id } }),
      db.b2bCustomer.update({
        where: { id },
        data: {
          shopId,
          name: d.name.trim(),
          currency: d.currency.toUpperCase(),
          vatPercent: d.vatPercent,
          email: d.email?.trim() || null,
          note: d.note?.trim() || null,
          active: d.active,
          prices: {
            create: d.prices.map((p) => ({ productId: p.productId, unitPrice: toMinor(p.unitPrice) })),
          },
        },
      }),
    ])

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof RangeError)
      return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      return NextResponse.json(
        { error: 'That shop already has a customer with this name' },
        { status: 409, headers: NO_STORE },
      )
    console.error(e)
    return NextResponse.json({ error: 'Could not save the customer' }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    // Deleting a customer must never take their orders with them. Deactivating
    // keeps every figure they contributed exactly where it is.
    if (await db.order.count({ where: { b2bCustomerId: id } })) {
      return NextResponse.json(
        { error: 'This customer has orders. Deactivate them instead.' },
        { status: 409, headers: NO_STORE },
      )
    }

    await db.b2bCustomer.delete({ where: { id } })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not delete the customer' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 8: Run the item tests**

Run: `npx vitest run "src/app/api/b2b/customers/[id]/route.test.ts"`
Expected: PASS, 7 tests.

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/app/api/b2b/customers
git commit -m "feat: register a B2B customer and their agreed prices"
```

---

### Task 8: Entering, editing and deleting a B2B order

**Files:**
- Create: `src/app/api/b2b/orders/route.ts` (POST only), `src/app/api/b2b/orders/[id]/route.ts` (PATCH, DELETE)
- Test: `src/app/api/b2b/orders/route.test.ts`, `src/app/api/b2b/orders/[id]/route.test.ts`
- Modify: `src/app/api/portal/security.test.ts`

**Interfaces:**
- Consumes: `orderTotals`, `lineTotals`, `B2bLine` (Task 2); `nextB2bNumber`, `b2bExternalId` (Task 3); `assertProductsBelongToShop` (Task 7).
- Produces:
  - `POST /api/b2b/orders` body `{ customerId, placedAt: 'YYYY-MM-DD', shippingCharged?, fulfillmentCost?, lines: Line[] }` where `Line = { productId, quantity, unitPrice, discountValue?, discountKind?, savePrice? }`. `unitPrice`, `shippingCharged` and an `AMOUNT` `discountValue` are **major** units in the **customer's** currency; `fulfillmentCost` is **major** units in the **shop's**. → `{ order: { id, number } }`.
  - `PATCH /api/b2b/orders/[id]` - the same body plus `status: 'completed' | 'refunded' | 'cancelled'`.
  - `DELETE /api/b2b/orders/[id]`.
  - Exported for the item route: `OrderBody` (Zod), `buildOrderWrite(input)`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/b2b/orders/route.test.ts`. Copy the mock, `asAdmin`, fixtures and `cleanup` from Task 7 Step 1 with `TAG = '[b2b-order-test]'` and `const { POST } = await import('./route')`, plus a `post` helper pointing at `/api/b2b/orders`. Add a customer to `beforeEach`, after the product fixtures:

```ts
let customerId = ''
// …
customerId = (await db.b2bCustomer.create({
  data: {
    shopId, name: `Nordic ${TAG}`, currency: 'EUR', vatPercent: 25,
    email: 'buyer@nordic.test',
    prices: { create: [{ productId, unitPrice: 8900 }] },
  },
})).id
```

```ts
describe('POST /api/b2b/orders', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(403)
  })

  it('computes every total itself and ignores anything the browser sends', async () => {
    await asAdmin()
    expect((await post({
      customerId, placedAt: '2026-07-01', shippingCharged: 50, fulfillmentCost: 420,
      lines: [{ productId, quantity: 10, unitPrice: 89, discountValue: 10, discountKind: 'PERCENT' }],
      // A stale or hostile client. None of these may reach the database.
      grossSales: 1, netSales: 1, total: 1, taxTotal: 0,
    })).status).toBe(200)

    const saved = await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })
    expect(saved.grossSales).toBe(89000)
    expect(saved.discountTotal).toBe(8900)
    expect(saved.netSales).toBe(80100)
    expect(saved.shippingCharged).toBe(5000)
    expect(saved.taxTotal).toBe(21275) // 25% of (801.00 + 50.00)
    expect(saved.total).toBe(106375)
    expect(saved.fulfillmentCost).toBe(42000) // minor units, SHOP currency
  })

  it('stores the order in the CUSTOMER’S currency, not the shop’s', async () => {
    await asAdmin()
    await post({ customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }] })
    expect((await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })).currency).toBe('EUR')
  })

  it('numbers B2B orders in their own sequence and namespaces the external id', async () => {
    await asAdmin()
    const one = await post({ customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }] })
    const two = await post({ customerId, placedAt: '2026-07-02', lines: [{ productId, quantity: 1, unitPrice: 89 }] })

    expect((await one.json()).order.number).toBe('B-0001')
    expect((await two.json()).order.number).toBe('B-0002')
    expect((await db.order.findFirstOrThrow({ where: { number: 'B-0002' } })).externalId).toBe('b2b:B-0002')
  })

  it('fills in the customer name so the WooCommerce backfill never chases it', async () => {
    // backfillCustomers() hunts every order with customerName null and asks
    // WooCommerce who it was. For a b2b: id it would ask forever.
    await asAdmin()
    await post({ customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }] })

    const saved = await db.order.findFirstOrThrow({ where: { b2bCustomerId: customerId } })
    expect(saved.customerName).toBe(`Nordic ${TAG}`)
    expect(saved.customerEmail).toBe('buyer@nordic.test')
    expect(saved.status).toBe('completed')
    expect(saved.couponCode).toBeNull()
    expect(saved.ambassadorId).toBeNull()
  })

  it('keeps what was typed, so re-opening the order still says "10%"', async () => {
    await asAdmin()
    await post({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 10, unitPrice: 89, discountValue: 10, discountKind: 'PERCENT' }],
    })

    const item = await db.orderItem.findFirstOrThrow({ where: { productId } })
    expect(item.discountValue).toBe(10)
    expect(item.discountKind).toBe('PERCENT')
    expect(item.unitPrice).toBe(8900)     // BEFORE discount, as mapOrder() stores it
    expect(item.lineNetTotal).toBe(80100) // after
    expect(item.sku).toBe('SKU-1')        // snapshot, from the product
  })

  it('saves a new agreed price only when asked to', async () => {
    await asAdmin()
    const belt = await db.product.create({
      data: { shopId, externalId: '9', sku: 'SKU-9', name: 'Belt' },
    })

    await post({
      customerId, placedAt: '2026-07-01',
      lines: [
        { productId: belt.id, quantity: 1, unitPrice: 12, savePrice: true },
        { productId, quantity: 1, unitPrice: 999 }, // a one-off; must not stick
      ],
    })

    const prices = await db.b2bPrice.findMany({ where: { customerId } })
    expect(prices).toHaveLength(2)
    expect(prices.find((p) => p.productId === belt.id)!.unitPrice).toBe(1200)
    expect(prices.find((p) => p.productId === productId)!.unitPrice).toBe(8900)
  })

  it('refuses a product from another shop', async () => {
    await asAdmin()
    expect((await post({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId: otherProductId, quantity: 1, unitPrice: 10 }],
    })).status).toBe(400)
    expect(await db.order.count({ where: { b2bCustomerId: customerId } })).toBe(0)
  })

  it('refuses the impossible, and writes nothing when it does', async () => {
    await asAdmin()
    const bad = async (over: object) =>
      (await post({
        customerId, placedAt: '2026-07-01',
        lines: [{ productId, quantity: 1, unitPrice: 89, ...over }],
      })).status

    expect((await post({ customerId, placedAt: '2026-07-01', lines: [] })).status).toBe(400)
    expect(await bad({ quantity: 0 })).toBe(400)
    expect(await bad({ discountValue: 101, discountKind: 'PERCENT' })).toBe(400)
    expect(await bad({ discountValue: 90, discountKind: 'AMOUNT' })).toBe(400) // above 89.00
    expect((await post({
      customerId, placedAt: 'the other tuesday',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(400)

    expect(await db.order.count({ where: { b2bCustomerId: customerId } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/app/api/b2b/orders/route.test.ts`
Expected: FAIL - "Failed to resolve import './route'".

- [ ] **Step 3: Write the create route**

Create `src/app/api/b2b/orders/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { utcDay } from '@/lib/dates'
import { lineTotals, orderTotals, type B2bLine } from '@/lib/b2b/pricing'
import { b2bExternalId, nextB2bNumber } from '@/lib/b2b/numbering'
import { assertProductsBelongToShop } from '../customers/route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const Line = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1),
  /** MAJOR units, customer currency, ex VAT, before discount. */
  unitPrice: z.number().min(0),
  /** 10 for "10%", or 20 for "20.00 off each one". */
  discountValue: z.number().min(0).default(0),
  discountKind: z.enum(['PERCENT', 'AMOUNT']).default('PERCENT'),
  /** Tick to make this the customer's standing price from now on. */
  savePrice: z.boolean().default(false),
})

export const OrderBody = z.object({
  customerId: z.string().min(1),
  placedAt: z.string(),
  /** MAJOR units, customer currency, ex VAT. */
  shippingCharged: z.number().min(0).default(0),
  /** MAJOR units, SHOP currency - it is a cost, and costs live there. */
  fulfillmentCost: z.number().min(0).default(0),
  lines: z.array(Line).min(1),
})

export type OrderInput = z.infer<typeof OrderBody>

/**
 * Everything the database needs, derived here from what was typed.
 *
 * The browser's own totals are never trusted: they exist to show the user what
 * they are about to save, and nothing more. Throws RangeError carrying a
 * sentence worth showing when the input cannot make a real order.
 */
export async function buildOrderWrite(d: OrderInput) {
  const customer = await db.b2bCustomer.findUnique({ where: { id: d.customerId } })
  if (!customer) throw new RangeError('No such customer')

  const placedAt = utcDay(new Date(d.placedAt))
  if (Number.isNaN(placedAt.getTime())) throw new RangeError('That is not a date we can read')

  await assertProductsBelongToShop(customer.shopId, d.lines.map((l) => l.productId))

  for (const l of d.lines) {
    if (l.discountKind === 'PERCENT' && l.discountValue > 100)
      throw new RangeError('A percentage discount cannot be more than 100%')
    if (l.discountKind === 'AMOUNT' && l.discountValue > l.unitPrice)
      throw new RangeError('A discount cannot be more than the price of the item')
  }

  const products = await db.product.findMany({
    where: { id: { in: d.lines.map((l) => l.productId) } },
    select: { id: true, sku: true, name: true },
  })
  const byId = new Map(products.map((p) => [p.id, p]))

  const lines: B2bLine[] = d.lines.map((l) => ({
    quantity: l.quantity,
    unitPrice: toMinor(l.unitPrice),
    // A percentage is a plain number; an amount is money and becomes minor units.
    discountValue: l.discountKind === 'PERCENT' ? l.discountValue : toMinor(l.discountValue),
    discountKind: l.discountKind,
  }))

  return {
    customer,
    placedAt,
    totals: orderTotals(lines, toMinor(d.shippingCharged), customer.vatPercent),
    // As OrderItem holds a line: unitPrice BEFORE discount and lineNetTotal
    // after, exactly as mapOrder() stores a WooCommerce line.
    items: d.lines.map((l, i) => ({
      productId: l.productId,
      sku: byId.get(l.productId)?.sku ?? '',
      name: byId.get(l.productId)?.name ?? '',
      quantity: l.quantity,
      unitPrice: lines[i].unitPrice,
      lineNetTotal: lineTotals(lines[i]).net,
      discountValue: lines[i].discountValue,
      discountKind: l.discountKind,
    })),
    // Only the ticked ones become standing prices; editing a prefilled price
    // without ticking is a one-off for this order.
    pricesToSave: d.lines
      .map((l, i) => ({ save: l.savePrice, productId: l.productId, unitPrice: lines[i].unitPrice }))
      .filter((p) => p.save),
  }
}

/** Write the ticked prices. Shared with PATCH, which does the same on edit. */
export async function saveStandingPrices(
  tx: Prisma.TransactionClient,
  customerId: string,
  prices: { productId: string; unitPrice: number }[],
): Promise<void> {
  for (const p of prices) {
    await tx.b2bPrice.upsert({
      where: { customerId_productId: { customerId, productId: p.productId } },
      create: { customerId, productId: p.productId, unitPrice: p.unitPrice },
      update: { unitPrice: p.unitPrice },
    })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = OrderBody.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid order' }, { status: 400, headers: NO_STORE })

    const w = await buildOrderWrite(parsed.data)

    // Two saves racing collide on @@unique([shopId, externalId]). One retry is
    // enough for a double-click, which is the only way this happens here.
    for (let attempt = 0; attempt < 2; attempt++) {
      const number = await nextB2bNumber(w.customer.shopId)
      try {
        const order = await db.$transaction(async (tx) => {
          const created = await tx.order.create({
            data: {
              shopId: w.customer.shopId,
              externalId: b2bExternalId(number),
              number,
              placedAt: w.placedAt,
              // It happened, so it earns from now. An edit can void it later
              // and EXCLUDED_STATUSES zeroes it with no special case.
              status: 'completed',
              currency: w.customer.currency,
              grossSales: w.totals.grossSales,
              discountTotal: w.totals.discountTotal,
              netSales: w.totals.netSales,
              shippingCharged: w.totals.shippingCharged,
              taxTotal: w.totals.taxTotal,
              total: w.totals.total,
              couponCode: null,
              ambassadorId: null,
              // Not null: it keeps this order out of backfillCustomers()' queue
              // and lets the Orders search find the customer by name.
              customerName: w.customer.name,
              customerEmail: w.customer.email ?? '',
              b2bCustomerId: w.customer.id,
              fulfillmentCost: toMinor(parsed.data.fulfillmentCost),
              items: { create: w.items },
            },
            select: { id: true, number: true },
          })

          await saveStandingPrices(tx, w.customer.id, w.pricesToSave)
          return created
        })

        return NextResponse.json({ order }, { headers: NO_STORE })
      } catch (e) {
        const raced =
          e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && attempt === 0
        if (!raced) throw e
      }
    }

    return NextResponse.json(
      { error: 'Could not pick an order number. Try again.' },
      { status: 409, headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof RangeError)
      return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the order' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: Run the create tests**

Run: `npx vitest run src/app/api/b2b/orders/route.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing tests for edit and delete**

Create `src/app/api/b2b/orders/[id]/route.test.ts` with the same scaffolding, `TAG = '[b2b-edit-test]'`, and:

```ts
const { PATCH, DELETE } = await import('./route')
const { POST } = await import('../route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/b2b/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id),
  )

/** 10 x 89.00 with 10% off, through the real create route. */
async function createOrder(): Promise<string> {
  const res = await POST(new Request('http://localhost/api/b2b/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 10, unitPrice: 89, discountValue: 10, discountKind: 'PERCENT' }],
    }),
  }))
  return (await res.json()).order.id
}
```

```ts
describe('PATCH /api/b2b/orders/[id]', () => {
  it('rewrites the lines and recomputes the totals', async () => {
    await asAdmin()
    const id = await createOrder()

    expect((await patch(id, {
      customerId, placedAt: '2026-07-01',
      lines: [{ productId, quantity: 2, unitPrice: 89 }],
    })).status).toBe(200)

    const after = await db.order.findUniqueOrThrow({ where: { id }, include: { items: true } })
    expect(after.items).toHaveLength(1)
    expect(after.items[0].quantity).toBe(2)
    expect(after.grossSales).toBe(17800)
    expect(after.netSales).toBe(17800)
    // Identity never moves: an edit is the same order, not a new one.
    expect(after.number).toBe('B-0001')
    expect(after.externalId).toBe('b2b:B-0001')
  })

  it('can void an order', async () => {
    await asAdmin()
    const id = await createOrder()
    expect((await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'refunded',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(200)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('refunded')
  })

  it('refuses a status it does not recognise', async () => {
    // Anything the engine does not know is in EXCLUDED_STATUSES counts as
    // earning, so free text here would quietly earn forever.
    await asAdmin()
    const id = await createOrder()
    expect((await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'invoiced-ish',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(400)
  })

  it('refuses to touch a webshop order', async () => {
    await asAdmin()
    const woo = await db.order.create({
      data: {
        shopId, externalId: '9001', number: '9001', placedAt: new Date('2026-07-01'),
        status: 'completed', currency: 'NOK', grossSales: 1000, discountTotal: 0,
        netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
      },
    })
    expect((await patch(woo.id, {
      customerId, placedAt: '2026-07-01', lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })).status).toBe(404)
  })
})

describe('DELETE /api/b2b/orders/[id]', () => {
  it('removes the order and its lines', async () => {
    await asAdmin()
    const id = await createOrder()
    expect((await DELETE(new Request('http://localhost/x'), params(id))).status).toBe(200)
    expect(await db.order.findUnique({ where: { id } })).toBeNull()
    expect(await db.orderItem.count({ where: { orderId: id } })).toBe(0)
  })

  it('refuses to delete a webshop order through this route', async () => {
    // This endpoint exists to fix a typo in something typed by hand. A synced
    // order deleted here would come back on the next sync - or worse, not.
    await asAdmin()
    const woo = await db.order.create({
      data: {
        shopId, externalId: '9002', number: '9002', placedAt: new Date('2026-07-01'),
        status: 'completed', currency: 'NOK', grossSales: 1000, discountTotal: 0,
        netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
      },
    })
    expect((await DELETE(new Request('http://localhost/x'), params(woo.id))).status).toBe(404)
    expect(await db.order.findUnique({ where: { id: woo.id } })).not.toBeNull()
  })
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run "src/app/api/b2b/orders/[id]/route.test.ts"`
Expected: FAIL - "Failed to resolve import './route'".

- [ ] **Step 7: Write the edit and delete route**

Create `src/app/api/b2b/orders/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { buildOrderWrite, OrderBody, saveStandingPrices } from '../route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * What a hand-entered order may be set to. 'completed' earns; the other two
 * are in EXCLUDED_STATUSES, so the engine drops them with no special case. A
 * free-text status would quietly earn forever, because anything the engine
 * does not recognise counts.
 */
const STATUSES = ['completed', 'refunded', 'cancelled'] as const

const Body = OrderBody.extend({ status: z.enum(STATUSES).default('completed') })

type Ctx = { params: Promise<{ id: string }> }

/** Only orders this app owns. A synced order is not ours to rewrite. */
const ownB2bOrder = (id: string) =>
  db.order.findFirst({ where: { id, b2bCustomerId: { not: null } }, select: { id: true } })

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    if (!(await ownB2bOrder(id)))
      return NextResponse.json({ error: 'No such B2B order' }, { status: 404, headers: NO_STORE })

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid order' }, { status: 400, headers: NO_STORE })

    const w = await buildOrderWrite(parsed.data)

    // Lines are rewritten, not diffed - storeOrder()'s rule. `number` and
    // `externalId` are deliberately untouched: an edit is the same order.
    await db.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: id } })
      await tx.order.update({
        where: { id },
        data: {
          placedAt: w.placedAt,
          status: parsed.data.status,
          currency: w.customer.currency,
          grossSales: w.totals.grossSales,
          discountTotal: w.totals.discountTotal,
          netSales: w.totals.netSales,
          shippingCharged: w.totals.shippingCharged,
          taxTotal: w.totals.taxTotal,
          total: w.totals.total,
          customerName: w.customer.name,
          customerEmail: w.customer.email ?? '',
          b2bCustomerId: w.customer.id,
          fulfillmentCost: toMinor(parsed.data.fulfillmentCost),
          items: { create: w.items },
        },
      })
      await saveStandingPrices(tx, w.customer.id, w.pricesToSave)
    })

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof RangeError)
      return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the order' }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    if (!(await ownB2bOrder(id)))
      return NextResponse.json({ error: 'No such B2B order' }, { status: 404, headers: NO_STORE })

    await db.order.delete({ where: { id } }) // OrderItem cascades
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not delete the order' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run "src/app/api/b2b/orders/[id]/route.test.ts"`
Expected: PASS, 6 tests.

- [ ] **Step 9: Pin that an ambassador can neither see this money nor earn on it**

Append to `src/app/api/portal/security.test.ts`, reusing that file's own fixtures and its ambassador-authenticated GET helper (read the file first and match its names):

```ts
it('never shows a B2B order to an ambassador, or pays commission on one', async () => {
  // A B2B order carries no coupon and no ambassadorId by construction. Pin it,
  // because "by construction" is exactly the kind of claim that quietly stops
  // being true.
  const customer = await db.b2bCustomer.create({
    data: { shopId, name: 'Nordic [portal-test]', currency: 'EUR', vatPercent: 0 },
  })
  await db.order.create({
    data: {
      shopId, externalId: 'b2b:B-0001', number: 'B-0001', placedAt: new Date('2026-07-01'),
      status: 'completed', currency: 'EUR', grossSales: 100000, discountTotal: 0,
      netSales: 100000, shippingCharged: 0, taxTotal: 0, total: 100000,
      customerName: 'Nordic [portal-test]', customerEmail: '', b2bCustomerId: customer.id,
    },
  })

  const body = await (await asAmbassador('?from=2026-07-01&to=2026-07-31')).json()
  expect(body.sales).toBe(0)
  expect(body.commission).toBe(0)
  expect(JSON.stringify(body)).not.toContain('B-0001')
})
```

- [ ] **Step 10: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/app/api/b2b/orders src/app/api/portal/security.test.ts
git commit -m "feat: enter, edit and delete an order from a business customer"
```

---

### Task 9: The B2B page and its place in the nav

**Deviation from the spec, deliberate:** the spec said "reusing `ShopFilter`". `ShopFilter` is the dashboard's multi-select; every admin CRUD screen (`ExpensesClient`, `CostsClient`) uses a plain single `<select>`, and a customer belongs to exactly one shop. Use the `<select>`, with an "All shops" option. Likewise there is **no date control here**: the orders card shows the last 90 days and links to `/orders?source=b2b` for the rest, because the Orders page is where date filtering already lives.

**Files:**
- Create: `src/app/b2b/page.tsx`, `src/app/b2b/B2bClient.tsx`, `src/app/b2b/B2bClient.test.tsx`
- Modify: `src/components/shell/AppShell.tsx`, `src/components/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: `GET /api/b2b/customers?shopId=`, `GET /api/orders?source=b2b&from=&to=&shops=` (Tasks 6, 7).
- Produces: `type Customer` exported from `B2bClient.tsx` for `CustomerModal` (Task 10) and `OrderModal` (Task 11):
  `{ id, name, shopId, shopName, currency, vatPercent, email, note, active, priceCount, orderCount, revenue }`.

- [ ] **Step 1: Write the failing test**

Create `src/app/b2b/B2bClient.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { B2bClient } from './B2bClient'

const shops = [{ id: 's1', name: 'Mazzetti.no', currency: 'NOK' }]

const customer = {
  id: 'c1', name: 'Nordic Retail AS', shopId: 's1', shopName: 'Mazzetti.no',
  currency: 'EUR', vatPercent: 25, email: null, note: null, active: true,
  priceCount: 4, orderCount: 12, revenue: 1422000,
}

function mockFetch(customers: unknown[], orders: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(
      JSON.stringify(url.includes('/api/b2b/customers') ? { customers } : { orders, total: orders.length }),
      { status: 200 },
    ),
  ))
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.unstubAllGlobals())

describe('B2bClient', () => {
  it('shows a customer’s revenue in THEIR currency, not the shop’s', async () => {
    mockFetch([customer])
    render(<B2bClient email="a@b.test" shops={shops} />)

    // 14 220.00 EUR - the shop is NOK, and converting here would be a guess.
    expect(await screen.findByText(/14,220\.00|14 220,00/)).toBeInTheDocument()
    expect(screen.getByText('Nordic Retail AS')).toBeInTheDocument()
    expect(screen.getByText('Mazzetti.no')).toBeInTheDocument()
  })

  it('teaches the next action when there are no customers yet', async () => {
    mockFetch([])
    render(<B2bClient email="a@b.test" shops={shops} />)
    expect(
      await screen.findByText(/add one and you can start entering their orders/i),
    ).toBeInTheDocument()
  })

  it('says so when the list could not be loaded, rather than showing an empty table', async () => {
    // An empty table reads as "you have no customers". That would be a lie.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Could not load customers' }), { status: 500 }),
    ))
    render(<B2bClient email="a@b.test" shops={shops} />)
    expect(await screen.findByText('Could not load customers')).toBeInTheDocument()
  })

  it('offers no "add customer" button when there is no shop to attach one to', async () => {
    mockFetch([])
    render(<B2bClient email="a@b.test" shops={[]} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /add customer/i })).toBeNull())
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/b2b/B2bClient.test.tsx`
Expected: FAIL - "Failed to resolve import './B2bClient'".

- [ ] **Step 3: Write the server page**

Create `src/app/b2b/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { B2bClient } from './B2bClient'

export default async function B2bPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  return <B2bClient email={user.email} shops={shops} />
}
```

- [ ] **Step 4: Write the client**

Create `src/app/b2b/B2bClient.tsx`. Leave the two modal mounts commented exactly as shown - Tasks 10 and 11 fill them in, and this task must compile and pass on its own.

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { formatMoney } from '@/lib/money'
import { useToast } from '@/components/toast/useToast'
import type { Shop } from '@/components/filters/ShopFilter'

export type Customer = {
  id: string
  name: string
  shopId: string
  shopName: string
  currency: string
  vatPercent: number
  email: string | null
  note: string | null
  active: boolean
  priceCount: number
  orderCount: number
  /** Minor units, in the customer's OWN currency. */
  revenue: number
}

type B2bOrder = {
  id: string
  number: string
  placedAt: string
  status: string
  currency: string
  netSales: number
  customer: string | null
  figures: { profit: number } | null
}

/** The orders card is a working surface, not an archive. */
const RECENT_DAYS = 90
const day = (d: Date) => d.toISOString().slice(0, 10)

export function B2bClient({ email, shops }: { email: string; shops: Shop[] }) {
  const toast = useToast()
  const [shopId, setShopId] = useState('') // '' = every shop
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orders, setOrders] = useState<B2bOrder[]>([])
  const [loading, setLoading] = useState(true)
  // A page-load failure is not an action: a toast fades and would leave an
  // empty table reading as "you have no customers" - a lie. Say it in place.
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)

    const to = new Date()
    const from = new Date(to.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000)
    const shopQuery = shopId ? `&shops=${shopId}` : ''

    Promise.all([
      fetch(`/api/b2b/customers${shopId ? `?shopId=${shopId}` : ''}`).then(async (r) => ({
        ok: r.ok,
        body: await r.json().catch(() => null),
      })),
      fetch(`/api/orders?source=b2b&from=${day(from)}&to=${day(to)}${shopQuery}`).then(async (r) => ({
        ok: r.ok,
        body: await r.json().catch(() => null),
      })),
    ])
      .then(([c, o]) => {
        if (!c.ok) {
          setLoadError(c.body?.error ?? 'Could not load customers')
          return
        }
        setCustomers(c.body?.customers ?? [])
        // The orders card failing is not worth blanking the customers card.
        setOrders(o.ok ? (o.body?.orders ?? []) : [])
      })
      .catch(() => setLoadError('Could not reach the server'))
      .finally(() => setLoading(false))
  }, [shopId])

  useEffect(load, [load])

  const noShops = shops.length === 0

  async function removeCustomer(c: Customer) {
    const res = await fetch(`/api/b2b/customers/${c.id}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) {
      toast.error((await res?.json().catch(() => null))?.error ?? 'Could not delete that customer')
      return
    }
    toast.success(`${c.name} removed`)
    load()
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="B2B"
        subtitle="Business customers who order by email. Their orders count in the same revenue, cost and profit figures as the webshop."
      >
        <select
          value={shopId}
          aria-label="Shop"
          onChange={(e) => setShopId(e.target.value)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
        >
          <option value="">All shops</option>
          {shops.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
          ))}
        </select>
      </PageHeader>

      <PageBody>
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <div className="text-sm text-ink">
              <span className="text-lg font-bold text-ink">{customers.length}</span> Business
              customers
            </div>
            {!noShops && (
              <button
                onClick={() => {}} // Tasks 10 and 11 wire these two up
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
              >
                + Add customer
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="bg-panel text-left text-muted">
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Shop</th>
                  <th className="px-3 py-2.5 font-medium">Currency</th>
                  <th className="px-3 py-2.5 text-right font-medium">VAT</th>
                  <th className="px-3 py-2.5 text-right font-medium">Prices</th>
                  <th className="px-3 py-2.5 text-right font-medium">Orders</th>
                  <th className="px-3 py-2.5 text-right font-medium">Revenue</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="text-ink">
                {loading ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-faint">Loading…</td></tr>
                ) : loadError ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-faint">{loadError}</td></tr>
                ) : noShops ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-faint">
                      <span className="font-semibold text-ink">No shops connected yet.</span>{' '}
                      A business customer buys from a shop -{' '}
                      <Link href="/settings/shops" className="text-accent hover:underline">
                        connect one first
                      </Link>.
                    </td>
                  </tr>
                ) : customers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-faint">
                      <span className="font-semibold text-ink">No business customers yet</span> - add
                      one and you can start entering their orders.
                    </td>
                  </tr>
                ) : (
                  customers.map((c) => (
                    <tr key={c.id} className="border-t border-line">
                      <td className="px-3 py-3">
                        <Link href={`/b2b/${c.id}`} className="font-semibold text-ink hover:underline">
                          {c.name}
                        </Link>
                        {!c.active && <span className="ml-2 text-[11px] text-muted">(inactive)</span>}
                      </td>
                      <td className="px-3 py-3 text-muted">{c.shopName}</td>
                      <td className="px-3 py-3 text-muted">{c.currency}</td>
                      <td className="num px-3 py-3 text-right text-muted">{c.vatPercent}%</td>
                      <td className="num px-3 py-3 text-right text-muted">{c.priceCount}</td>
                      <td className="num px-3 py-3 text-right text-muted">{c.orderCount}</td>
                      {/* Their own currency. No total row: adding EUR to NOK
                          down a column would be a confident wrong number. */}
                      <td className="num px-3 py-3 text-right font-medium text-ink">
                        {formatMoney(c.revenue, c.currency)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {c.orderCount === 0 && (
                          <button
                            onClick={() => removeCustomer(c)}
                            className="rounded px-2 py-1 text-[11px] text-loss hover:bg-warn-soft"
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <div className="text-sm text-ink">
              B2B orders <span className="text-[11px] text-muted">· last {RECENT_DAYS} days</span>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/orders?source=b2b"
                className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-ink hover:bg-panel"
              >
                See all
              </Link>
              {customers.length > 0 && (
                <button
                  onClick={() => {}} // Tasks 10 and 11 wire these two up
                  className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
                >
                  + Add order
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="bg-panel text-left text-muted">
                  <th className="px-3 py-2.5 font-medium">Order</th>
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium">Net sales</th>
                  <th className="px-3 py-2.5 text-right font-medium">Profit</th>
                </tr>
              </thead>
              <tbody className="text-ink">
                {loading ? (
                  <tr><td colSpan={6} className="px-3 py-10 text-center text-faint">Loading…</td></tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-faint">
                      No B2B orders in the last {RECENT_DAYS} days.
                    </td>
                  </tr>
                ) : (
                  orders.map((o) => (
                    <tr key={o.id} className="border-t border-line">
                      <td className="px-3 py-3 font-semibold text-ink">{o.number}</td>
                      <td className="px-3 py-3 text-muted">{o.customer ?? '-'}</td>
                      <td className="px-3 py-3 text-muted">{o.placedAt.slice(0, 10)}</td>
                      <td className="px-3 py-3 text-muted">{o.status}</td>
                      <td className="num px-3 py-3 text-right text-ink">
                        {formatMoney(o.netSales, o.currency)}
                      </td>
                      {/* A voided order earns nothing and says so, rather than
                          showing a confident zero. */}
                      <td
                        className={`num px-3 py-3 text-right font-medium ${
                          !o.figures ? 'text-faint' : o.figures.profit < 0 ? 'text-loss' : 'text-gain'
                        }`}
                      >
                        {o.figures ? formatMoney(o.figures.profit, o.currency) : '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </PageBody>

      {/* Task 10 mounts CustomerModal here; Task 11 mounts OrderModal. */}
    </AppShell>
  )
}
```

- [ ] **Step 5: Run the client tests**

Run: `npx vitest run src/app/b2b/B2bClient.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Add the nav item**

In `src/components/shell/AppShell.tsx`, inside the `Analytics` section of `NAV`, after `AMBASSADORS_ITEM`:

```tsx
      {
        href: '/b2b',
        label: 'B2B',
        icon: icon(
          <>
            <path d="M3 21h18" />
            <path d="M5 21V8l7-5 7 5v13" />
            <path d="M10 21v-6h4v6" />
          </>,
        ),
      },
```

- [ ] **Step 7: Cover the nav item**

Append to `src/components/shell/AppShell.test.tsx`, matching that file's existing render helpers:

```tsx
it('offers B2B to an admin and never to marketing', () => {
  const { unmount } = render(<AppShell email="a@b.test">x</AppShell>)
  expect(screen.getByRole('link', { name: 'B2B' })).toHaveAttribute('href', '/b2b')
  unmount()

  render(<AppShell email="a@b.test" role="MARKETING">x</AppShell>)
  expect(screen.queryByRole('link', { name: 'B2B' })).toBeNull()
})
```

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/app/b2b src/components/shell/AppShell.tsx src/components/shell/AppShell.test.tsx
git commit -m "feat: a B2B page listing business customers and their orders"
```

---

### Task 10: Adding and editing a customer

**Files:**
- Create: `src/app/b2b/CustomerModal.tsx`
- Modify: `src/app/b2b/B2bClient.tsx` (mount it, and give the `+ Add customer` button its real `onClick`)
- Modify: `src/app/b2b/B2bClient.test.tsx` (one case)

**Interfaces:**
- Consumes: `Customer` from `B2bClient.tsx`; `POST /api/b2b/customers`, `PATCH /api/b2b/customers/[id]`, `GET /api/products?shopId=` (which already returns `{ currency, products: [{ id, sku, name, sellingPrice, … }] }`).
- Produces: `<CustomerModal shops customer onClose onSaved />` where `customer` is `Customer | null` (null = creating).

- [ ] **Step 1: Write the failing test**

Append to `src/app/b2b/B2bClient.test.tsx`:

```tsx
it('opens the add-customer form and warns about a currency we hold no rate for', async () => {
  const user = userEvent.setup()
  mockFetch([])
  render(<B2bClient email="a@b.test" shops={shops} />)

  await user.click(await screen.findByRole('button', { name: /add customer/i }))
  expect(screen.getByRole('heading', { name: /add business customer/i })).toBeInTheDocument()

  // The shop's own currency is the sensible default and IS convertible.
  expect(screen.queryByText(/we have no exchange rate/i)).toBeNull()
})
```

Add `import userEvent from '@testing-library/user-event'` at the top of that file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/b2b/B2bClient.test.tsx`
Expected: FAIL - no "Add business customer" heading; the button toasts instead.

- [ ] **Step 3: Write the modal**

Create `src/app/b2b/CustomerModal.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { SearchableSelect, type SelectOption } from '@/components/SearchableSelect'
import { allCurrencies, isConvertible } from '@/lib/currencies'
import { toMajor } from '@/lib/money'
import { useToast } from '@/components/toast/useToast'
import type { Shop } from '@/components/filters/ShopFilter'
import type { Customer } from './B2bClient'

/** Every currency, once - the list never changes. */
const CURRENCY_OPTIONS: SelectOption[] = allCurrencies().map((c) => ({ value: c.code, label: c.label }))

type Product = { id: string; sku: string; name: string }
/** A row in the price list being edited. `price` is major units, as typed. */
type PriceRow = { productId: string; price: string }

export function CustomerModal({
  shops,
  customer,
  onClose,
  onSaved,
}: {
  shops: Shop[]
  customer: Customer | null // null = creating a new one
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const editing = customer !== null

  const [shopId, setShopId] = useState(customer?.shopId ?? shops[0]?.id ?? '')
  const [name, setName] = useState(customer?.name ?? '')
  const [currency, setCurrency] = useState(
    customer?.currency ?? shops.find((s) => s.id === shopId)?.currency ?? 'EUR',
  )
  const [vatPercent, setVatPercent] = useState(String(customer?.vatPercent ?? 0))
  const [email, setEmail] = useState(customer?.email ?? '')
  const [note, setNote] = useState(customer?.note ?? '')
  const [rows, setRows] = useState<PriceRow[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [canChangeShop, setCanChangeShop] = useState(true)
  const [busy, setBusy] = useState(false)

  // The catalogue follows the chosen shop; a price must point at a product the
  // shop actually has, and the route refuses anything else.
  useEffect(() => {
    if (!shopId) return
    fetch(`/api/products?shopId=${shopId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProducts(d?.products ?? []))
      .catch(() => setProducts([]))
  }, [shopId])

  // Editing: load their agreed prices and whether the shop is still movable.
  useEffect(() => {
    if (!customer) return
    fetch(`/api/b2b/customers/${customer.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.customer) return
        setCanChangeShop(d.customer.canChangeShop)
        setRows(
          d.customer.prices.map((p: { productId: string; unitPrice: number }) => ({
            productId: p.productId,
            price: String(toMajor(p.unitPrice)),
          })),
        )
      })
      .catch(() => toast.error('Could not load their agreed prices'))
  }, [customer, toast])

  const productOptions: SelectOption[] = products.map((p) => ({
    value: p.id,
    label: `${p.name} (${p.sku})`,
  }))

  async function save() {
    setBusy(true)
    try {
      const body = {
        ...(canChangeShop ? { shopId } : {}),
        name,
        currency,
        vatPercent: parseFloat(vatPercent) || 0,
        email: email.trim() || null,
        note: note.trim() || null,
        ...(editing ? { active: customer!.active } : {}),
        prices: rows
          .filter((r) => r.productId && r.price !== '')
          .map((r) => ({ productId: r.productId, unitPrice: parseFloat(r.price) || 0 })),
      }

      const res = await fetch(
        editing ? `/api/b2b/customers/${customer!.id}` : '/api/b2b/customers',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )

      if (!res.ok) {
        // Keep the form open: what they typed is still in it, and closing
        // would discard the entry while the list shows nothing added.
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the customer')
        return
      }
      toast.success(editing ? 'Customer saved' : `${name} added`)
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const shop = shops.find((s) => s.id === shopId)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-[var(--radius-card)] bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="border-b border-line pb-3 text-base font-bold text-ink">
          {editing ? 'Edit business customer' : 'Add business customer'}
        </h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label htmlFor="b2b-name" className="block text-xs font-medium text-ink">Customer name</label>
            <input
              id="b2b-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="E.g. Nordic Retail AS"
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint"
            />
          </div>

          <div>
            <label htmlFor="b2b-shop" className="block text-xs font-medium text-ink">Shop</label>
            <select
              id="b2b-shop" value={shopId} disabled={!canChangeShop}
              onChange={(e) => setShopId(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:bg-panel disabled:text-muted"
            >
              {shops.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
              ))}
            </select>
            {!canChangeShop && (
              <p className="mt-1 text-[11px] text-muted">
                They already have orders, so their shop is fixed.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="b2b-vat" className="block text-xs font-medium text-ink">VAT rate</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="b2b-vat" type="number" step="0.1" min="0" max="100"
                value={vatPercent} onChange={(e) => setVatPercent(e.target.value)}
                className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
              <span className="text-sm text-muted">%</span>
            </div>
            <p className="mt-1 text-[11px] text-muted">
              25 for a domestic business, 0 for reverse charge or export.
            </p>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-ink">Currency they pay in</label>
            <div className="mt-1 w-52">
              <SearchableSelect
                ariaLabel="Currency" value={currency} onChange={setCurrency} options={CURRENCY_OPTIONS}
              />
            </div>
            {/* Be honest: we only hold exchange rates for the ECB's list. */}
            {!isConvertible(currency) && (
              <p className="mt-1.5 rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-[11px] leading-relaxed text-warn">
                ⚠️ We have no exchange rate for <strong>{currency}</strong>, so their orders cannot be
                folded into the multi-shop USD totals. Their own figures stay exact.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="b2b-email" className="block text-xs font-medium text-ink">Email (optional)</label>
            <input
              id="b2b-email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>

          <div>
            <label htmlFor="b2b-note" className="block text-xs font-medium text-ink">Note (optional)</label>
            <input
              id="b2b-note" value={note} onChange={(e) => setNote(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs font-medium text-ink">Agreed prices</p>
          <p className="text-[11px] text-muted">
            Per unit, excluding VAT, in {currency}. These fill themselves in when you enter an order.
          </p>

          {products.length === 0 && (
            <p className="mt-2 rounded-[var(--radius-control)] bg-panel px-3 py-2 text-[11px] text-muted">
              This shop has no products yet. A product appears once it has sold through the webshop.
            </p>
          )}

          <div className="mt-2 space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SearchableSelect
                    ariaLabel={`Product ${i + 1}`}
                    value={row.productId}
                    onChange={(v) =>
                      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, productId: v } : r)))
                    }
                    options={productOptions}
                  />
                </div>
                <input
                  type="number" step="0.01" min="0" value={row.price}
                  aria-label={`Price ${i + 1}`}
                  onChange={(e) =>
                    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))
                  }
                  className="w-32 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
                <button
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove price ${i + 1}`}
                  className="rounded px-2 py-1 text-faint hover:bg-panel hover:text-ink"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={() => setRows((prev) => [...prev, { productId: '', price: '' }])}
            disabled={products.length === 0}
            className="mt-2 rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-panel disabled:opacity-60"
          >
            + Add a product price
          </button>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <button onClick={onClose} className="px-3 py-2 text-xs text-ink">Cancel</button>
          <button
            onClick={save}
            disabled={busy || !name.trim() || !shopId || !shop}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add customer'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Mount it in `B2bClient.tsx`**

Add the import and state:

```tsx
import { CustomerModal } from './CustomerModal'
// …inside the component:
const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
const [customerOpen, setCustomerOpen] = useState(false)
```

Replace the `+ Add customer` button's `onClick` with:

```tsx
                onClick={() => { setEditingCustomer(null); setCustomerOpen(true) }}
```

Add an Edit button beside Delete in the customer row:

```tsx
                        <button
                          onClick={() => { setEditingCustomer(c); setCustomerOpen(true) }}
                          className="rounded px-2 py-1 text-[11px] text-ink hover:bg-panel"
                        >
                          Edit
                        </button>
```

and replace the `{/* Task 10 mounts … */}` comment with:

```tsx
      {customerOpen && (
        <CustomerModal
          shops={shops}
          customer={editingCustomer}
          onClose={() => setCustomerOpen(false)}
          onSaved={() => { setCustomerOpen(false); load() }}
        />
      )}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/app/b2b/B2bClient.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/app/b2b
git commit -m "feat: add a business customer with their currency, VAT and prices"
```

---

### Task 11: The order form

**Files:**
- Create: `src/app/b2b/OrderModal.tsx`, `src/app/b2b/OrderModal.test.tsx`
- Modify: `src/app/b2b/B2bClient.tsx` (mount it, and give the `+ Add order` button its real `onClick`)

**Interfaces:**
- Consumes: `orderTotals`, `lineTotals`, `DiscountKind` from `src/lib/b2b/pricing.ts` - **the same module the server uses**, so what the form shows and what the route stores cannot drift; `POST /api/b2b/orders`; `GET /api/b2b/customers/[id]`; `GET /api/products?shopId=`.
- Produces: `<OrderModal customers onClose onSaved />`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/b2b/OrderModal.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { OrderModal } from './OrderModal'

const customers = [
  {
    id: 'c1', name: 'Nordic Retail AS', shopId: 's1', shopName: 'Mazzetti.no',
    currency: 'EUR', vatPercent: 25, email: null, note: null, active: true,
    priceCount: 1, orderCount: 0, revenue: 0,
  },
]

const detail = {
  customer: {
    id: 'c1', shopCurrency: 'NOK', currency: 'EUR', vatPercent: 25,
    prices: [{ productId: 'p1', sku: 'SKU-1', name: 'Massage gun', unitPrice: 8900, costPerItem: 4000, handlingCost: 0 }],
  },
}

const catalogue = { products: [{ id: 'p1', sku: 'SKU-1', name: 'Massage gun' }, { id: 'p2', sku: 'SKU-2', name: 'Belt' }] }

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(
      JSON.stringify(url.includes('/api/products') ? catalogue : detail),
      { status: 200 },
    ),
  ))
}

afterEach(() => vi.unstubAllGlobals())

describe('OrderModal', () => {
  it('fills in the agreed price and shows the line total as you type', async () => {
    const user = userEvent.setup()
    mockFetch()
    render(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1')
    await user.click(await screen.findByRole('button', { name: /add a line/i }))
    await user.selectOptions(await screen.findByLabelText('Product 1'), 'p1')

    // The agreed 89.00 arrives on its own - the whole point of the price book.
    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(89)

    await user.clear(screen.getByLabelText('Quantity 1'))
    await user.type(screen.getByLabelText('Quantity 1'), '10')
    expect(await screen.findByTestId('line-total-1')).toHaveTextContent('890.00')
  })

  it('takes a percentage discount and shows the VAT and total it produces', async () => {
    const user = userEvent.setup()
    mockFetch()
    render(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1')
    await user.click(await screen.findByRole('button', { name: /add a line/i }))
    await user.selectOptions(await screen.findByLabelText('Product 1'), 'p1')
    await user.clear(await screen.findByLabelText('Quantity 1'))
    await user.type(screen.getByLabelText('Quantity 1'), '10')
    await user.type(screen.getByLabelText('Discount 1'), '10')

    expect(await screen.findByTestId('total-net-sales')).toHaveTextContent('801.00')
    expect(screen.getByTestId('total-vat')).toHaveTextContent('200.25') // 25% of 801.00
    expect(screen.getByTestId('total-total')).toHaveTextContent('1,001.25')
  })

  it('labels the fixed discount per unit, and the shipping cost in the SHOP’s currency', async () => {
    const user = userEvent.setup()
    mockFetch()
    render(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1')
    await user.click(await screen.findByRole('button', { name: /add a line/i }))

    // The customer pays EUR; the shipping we paid is a cost, and costs are NOK.
    expect(await screen.findByText(/shipping we paid \(NOK\)/i)).toBeInTheDocument()
    expect(screen.getByText(/shipping charged \(EUR\)/i)).toBeInTheDocument()

    const kind = screen.getByLabelText('Discount kind 1')
    expect(kind).toHaveValue('PERCENT')
    await user.selectOptions(kind, 'AMOUNT')
    expect(screen.getByLabelText('Discount kind 1')).toHaveValue('AMOUNT')
  })

  it('highlights a product with no agreed price and offers to remember it', async () => {
    const user = userEvent.setup()
    mockFetch()
    render(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1')
    await user.click(await screen.findByRole('button', { name: /add a line/i }))
    await user.selectOptions(await screen.findByLabelText('Product 1'), 'p2') // no agreed price

    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(null)
    expect(screen.getByLabelText('Save price 1')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/app/b2b/OrderModal.test.tsx`
Expected: FAIL - "Failed to resolve import './OrderModal'".

- [ ] **Step 3: Write the modal**

Create `src/app/b2b/OrderModal.tsx`:

```tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatMoney, toMajor, toMinor } from '@/lib/money'
import { lineTotals, orderTotals, type B2bLine, type DiscountKind } from '@/lib/b2b/pricing'
import { useToast } from '@/components/toast/useToast'
import type { Customer } from './B2bClient'

type Product = { id: string; sku: string; name: string }
type AgreedPrice = { productId: string; unitPrice: number }

/** One row of the form. Everything is a string - it is what was typed. */
type Row = {
  productId: string
  quantity: string
  unitPrice: string
  discountValue: string
  discountKind: DiscountKind
  savePrice: boolean
}

const emptyRow = (): Row => ({
  productId: '',
  quantity: '1',
  unitPrice: '',
  discountValue: '',
  discountKind: 'PERCENT',
  savePrice: false,
})

const today = () => new Date().toISOString().slice(0, 10)

export function OrderModal({
  customers,
  onClose,
  onSaved,
}: {
  customers: Customer[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()

  const [customerId, setCustomerId] = useState('')
  const [placedAt, setPlacedAt] = useState(today())
  const [rows, setRows] = useState<Row[]>([])
  const [shippingCharged, setShippingCharged] = useState('')
  const [fulfillmentCost, setFulfillmentCost] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [agreed, setAgreed] = useState<AgreedPrice[]>([])
  const [shopCurrency, setShopCurrency] = useState('')
  const [busy, setBusy] = useState(false)

  const customer = customers.find((c) => c.id === customerId) ?? null

  // Picking the customer decides everything else: which catalogue, which
  // currency, which VAT rate, and which prices fill themselves in.
  useEffect(() => {
    if (!customer) return
    fetch(`/api/b2b/customers/${customer.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setAgreed(d?.customer?.prices ?? [])
        setShopCurrency(d?.customer?.shopCurrency ?? '')
      })
      .catch(() => toast.error('Could not load their agreed prices'))

    fetch(`/api/products?shopId=${customer.shopId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProducts(d?.products ?? []))
      .catch(() => setProducts([]))
  }, [customer, toast])

  /** What the pure module works on. The server derives the same from the same input. */
  const engineLines: B2bLine[] = useMemo(
    () =>
      rows.map((r) => ({
        quantity: parseInt(r.quantity, 10) || 0,
        unitPrice: toMinor(parseFloat(r.unitPrice) || 0),
        discountValue:
          r.discountKind === 'PERCENT'
            ? parseFloat(r.discountValue) || 0
            : toMinor(parseFloat(r.discountValue) || 0),
        discountKind: r.discountKind,
      })),
    [rows],
  )

  const totals = useMemo(
    () =>
      orderTotals(
        engineLines,
        toMinor(parseFloat(shippingCharged) || 0),
        customer?.vatPercent ?? 0,
      ),
    [engineLines, shippingCharged, customer],
  )

  const currency = customer?.currency ?? ''

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  /** Picking a product pulls their agreed price in, when there is one. */
  function pickProduct(i: number, productId: string) {
    const price = agreed.find((p) => p.productId === productId)
    setRow(i, {
      productId,
      unitPrice: price ? String(toMajor(price.unitPrice)) : '',
      // Nothing is agreed yet, so offer to remember what gets typed.
      savePrice: !price,
    })
  }

  async function save() {
    if (!customer) return
    setBusy(true)
    try {
      const res = await fetch('/api/b2b/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customer.id,
          placedAt,
          shippingCharged: parseFloat(shippingCharged) || 0,
          fulfillmentCost: parseFloat(fulfillmentCost) || 0,
          lines: rows
            .filter((r) => r.productId)
            .map((r) => ({
              productId: r.productId,
              quantity: parseInt(r.quantity, 10) || 0,
              unitPrice: parseFloat(r.unitPrice) || 0,
              discountValue: parseFloat(r.discountValue) || 0,
              discountKind: r.discountKind,
              savePrice: r.savePrice,
            })),
        }),
      })

      if (!res.ok) {
        // Keep the form open - closing would discard everything typed while
        // the list shows nothing added.
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the order')
        return
      }
      toast.success(`Order ${(await res.json()).order.number} added`)
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const usable = rows.filter((r) => r.productId && r.unitPrice !== '')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-[var(--radius-card)] bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="border-b border-line pb-3 text-base font-bold text-ink">Add other revenue</h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="b2b-customer" className="block text-xs font-medium text-ink">Customer</label>
            <select
              id="b2b-customer" aria-label="Customer" value={customerId}
              onChange={(e) => { setCustomerId(e.target.value); setRows([]) }}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">Choose a customer…</option>
              {customers.filter((c) => c.active).map((c) => (
                <option key={c.id} value={c.id}>{c.name} - {c.shopName} ({c.currency})</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="b2b-date" className="block text-xs font-medium text-ink">Order date</label>
            <input
              id="b2b-date" type="date" value={placedAt} onChange={(e) => setPlacedAt(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>
        </div>

        {customer && (
          <p className="mt-2 rounded-[var(--radius-control)] bg-panel px-3 py-2 text-[11px] text-muted">
            {customer.shopName} · invoiced in {customer.currency} · VAT {customer.vatPercent}% · no
            card fee
          </p>
        )}

        {customer && (
          <>
            <div className="mt-4 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-ink">What they bought</p>
                <button
                  onClick={() => setRows((prev) => [...prev, emptyRow()])}
                  className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-panel"
                >
                  + Add a line
                </button>
              </div>

              {products.length === 0 && (
                <p className="mt-2 rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-[11px] text-warn">
                  Only products that have sold through this shop can be added. Sync the shop, or check
                  the name.
                </p>
              )}

              <div className="mt-2 space-y-2">
                {rows.map((r, i) => {
                  const t = lineTotals(engineLines[i])
                  const noAgreedPrice = !!r.productId && !agreed.some((p) => p.productId === r.productId)
                  return (
                    <div key={i} className="grid grid-cols-12 items-center gap-2">
                      <select
                        aria-label={`Product ${i + 1}`} value={r.productId}
                        onChange={(e) => pickProduct(i, e.target.value)}
                        className="col-span-4 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-sm text-ink"
                      >
                        <option value="">Choose…</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
                        ))}
                      </select>

                      <input
                        aria-label={`Quantity ${i + 1}`} type="number" min="1" value={r.quantity}
                        onChange={(e) => setRow(i, { quantity: e.target.value })}
                        className="col-span-1 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-sm text-ink"
                      />

                      <input
                        aria-label={`Unit price ${i + 1}`} type="number" step="0.01" min="0"
                        value={r.unitPrice} placeholder="Price"
                        onChange={(e) => setRow(i, { unitPrice: e.target.value })}
                        className={`col-span-2 rounded-[var(--radius-control)] border bg-surface px-2 py-2 text-sm text-ink ${
                          noAgreedPrice && r.unitPrice === '' ? 'border-warn bg-warn-soft' : 'border-line'
                        }`}
                      />

                      <input
                        aria-label={`Discount ${i + 1}`} type="number" step="0.01" min="0"
                        value={r.discountValue} placeholder="0"
                        onChange={(e) => setRow(i, { discountValue: e.target.value })}
                        className="col-span-1 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-sm text-ink"
                      />

                      <select
                        aria-label={`Discount kind ${i + 1}`} value={r.discountKind}
                        onChange={(e) => setRow(i, { discountKind: e.target.value as DiscountKind })}
                        className="col-span-2 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-sm text-ink"
                      >
                        <option value="PERCENT">%</option>
                        {/* Per unit, not per line - the same frame as the price beside it. */}
                        <option value="AMOUNT">{currency} / unit</option>
                      </select>

                      <span
                        data-testid={`line-total-${i + 1}`}
                        className="num col-span-1 text-right text-sm text-ink"
                      >
                        {formatMoney(t.net, currency)}
                      </span>

                      <button
                        onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove line ${i + 1}`}
                        className="col-span-1 rounded px-2 py-1 text-faint hover:bg-panel hover:text-ink"
                      >
                        ×
                      </button>

                      {noAgreedPrice && (
                        <label className="col-span-12 flex items-center gap-2 pl-1 text-[11px] text-muted">
                          <input
                            type="checkbox" aria-label={`Save price ${i + 1}`} checked={r.savePrice}
                            onChange={(e) => setRow(i, { savePrice: e.target.checked })}
                            className="accent-[var(--color-accent)]"
                          />
                          Save this as {customer.name}&apos;s standing price
                        </label>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4">
              <div>
                <label htmlFor="b2b-shipping" className="block text-xs font-medium text-ink">
                  Shipping charged ({currency})
                </label>
                <p className="text-[11px] text-muted">What they paid you for delivery, ex VAT.</p>
                <input
                  id="b2b-shipping" type="number" step="0.01" min="0" value={shippingCharged}
                  onChange={(e) => setShippingCharged(e.target.value)}
                  className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
              </div>

              <div>
                <label htmlFor="b2b-fulfil" className="block text-xs font-medium text-ink">
                  Shipping we paid ({shopCurrency || customer.currency})
                </label>
                <p className="text-[11px] text-muted">
                  A cost, so it is in the shop&apos;s currency like every other cost.
                </p>
                <input
                  id="b2b-fulfil" type="number" step="0.01" min="0" value={fulfillmentCost}
                  onChange={(e) => setFulfillmentCost(e.target.value)}
                  className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
              </div>
            </div>

            <dl className="mt-4 space-y-1 border-t border-line pt-4 text-sm">
              {[
                ['Gross sales', totals.grossSales, 'gross-sales'],
                ['Discount', -totals.discountTotal, 'discount'],
                ['Net sales', totals.netSales, 'net-sales'],
                ['Shipping', totals.shippingCharged, 'shipping'],
                [`VAT (${customer.vatPercent}%)`, totals.taxTotal, 'vat'],
              ].map(([label, value, key]) => (
                <div key={key as string} className="flex justify-between text-muted">
                  <dt>{label as string}</dt>
                  <dd data-testid={`total-${key as string}`} className="num text-ink">
                    {formatMoney(value as number, currency)}
                  </dd>
                </div>
              ))}
              <div className="flex justify-between border-t border-line pt-1 font-semibold text-ink">
                <dt>Total</dt>
                <dd data-testid="total-total" className="num">{formatMoney(totals.total, currency)}</dd>
              </div>
            </dl>
          </>
        )}

        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <button onClick={onClose} className="px-3 py-2 text-xs text-ink">Cancel</button>
          <button
            onClick={save}
            disabled={busy || !customer || usable.length === 0}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save order'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Mount it in `B2bClient.tsx`**

```tsx
import { OrderModal } from './OrderModal'
// …
const [orderOpen, setOrderOpen] = useState(false)
```

Replace the `+ Add order` button's `onClick` with `() => setOrderOpen(true)`, and add beside the customer modal:

```tsx
      {orderOpen && (
        <OrderModal
          customers={customers}
          onClose={() => setOrderOpen(false)}
          onSaved={() => { setOrderOpen(false); load() }}
        />
      )}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/app/b2b/OrderModal.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/app/b2b
git commit -m "feat: enter what a business customer bought, discounts and all"
```

---

### Task 12: One customer's page

**Deviation from the spec, deliberate:** the spec said prices are "editable inline" here. `CustomerModal` (Task 10) already edits them, and two editors for one list is two places to get it wrong. This page shows the price list **read-only with our own cost beside the agreed price** - which the modal deliberately does not show, because two currencies in an editing grid invite mistakes - plus a summary and a way through to their orders. Editing opens the same modal.

**Files:**
- Create: `src/app/b2b/[id]/page.tsx`, `src/app/b2b/[id]/CustomerClient.tsx`

**Interfaces:**
- Consumes: `GET /api/b2b/customers/[id]` (Task 7), `CustomerModal` (Task 10).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the server page**

Create `src/app/b2b/[id]/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { CustomerClient } from './CustomerClient'

export default async function B2bCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const { id } = await params
  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  return <CustomerClient email={user.email} customerId={id} shops={shops} />
}
```

- [ ] **Step 2: Write the client**

Create `src/app/b2b/[id]/CustomerClient.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { formatMoney, toMajor } from '@/lib/money'
import { useToast } from '@/components/toast/useToast'
import { CustomerModal } from '../CustomerModal'
import type { Customer } from '../B2bClient'
import type { Shop } from '@/components/filters/ShopFilter'

type PriceRow = {
  productId: string
  sku: string
  name: string
  imageUrl: string | null
  /** Customer currency. */
  unitPrice: number
  /** Both in the SHOP's currency. */
  costPerItem: number
  handlingCost: number
}

type Detail = Customer & { shopCurrency: string; canChangeShop: boolean; prices: PriceRow[] }

export function CustomerClient({
  email,
  customerId,
  shops,
}: {
  email: string
  customerId: string
  shops: Shop[]
}) {
  const toast = useToast()
  const [customer, setCustomer] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    fetch(`/api/b2b/customers/${customerId}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        if (!r.ok) {
          setLoadError(d?.error ?? 'Could not load the customer')
          return
        }
        setCustomer(d.customer)
      })
      .catch(() => setLoadError('Could not reach the server'))
      .finally(() => setLoading(false))
  }, [customerId])

  useEffect(load, [load])

  async function setActive(active: boolean) {
    if (!customer) return
    const res = await fetch(`/api/b2b/customers/${customer.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: customer.name, currency: customer.currency, vatPercent: customer.vatPercent,
        email: customer.email, note: customer.note, active,
        // Back to major units - the shape the route takes.
        prices: customer.prices.map((p) => ({
          productId: p.productId,
          unitPrice: toMajor(p.unitPrice),
        })),
      }),
    }).catch(() => null)

    if (!res?.ok) {
      toast.error('Could not change that')
      return
    }
    toast.success(active ? 'Customer reactivated' : 'Customer deactivated')
    load()
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title={customer?.name ?? 'Business customer'}
        subtitle={
          customer
            ? `${customer.shopName} · invoiced in ${customer.currency} · VAT ${customer.vatPercent}%`
            : undefined
        }
      >
        <Link
          href="/b2b"
          className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] text-ink hover:bg-panel"
        >
          Back to B2B
        </Link>
        {customer && (
          <>
            <Link
              href={`/orders?source=b2b&q=${encodeURIComponent(customer.name)}`}
              className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] text-ink hover:bg-panel"
            >
              Their orders
            </Link>
            <button
              onClick={() => setEditing(true)}
              className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
            >
              Edit
            </button>
            <button
              onClick={() => setActive(!customer.active)}
              className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] text-ink hover:bg-panel"
            >
              {customer.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </>
        )}
      </PageHeader>

      <PageBody>
        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : loadError ? (
          <p className="text-sm text-faint">{loadError}</p>
        ) : !customer ? null : (
          <>
            <div className="flex divide-x divide-line rounded-[var(--radius-card)] border border-line bg-surface">
              {[
                ['Orders', String(customer.orderCount)],
                ['Revenue', formatMoney(customer.revenue, customer.currency)],
                ['Agreed prices', String(customer.priceCount)],
              ].map(([label, value]) => (
                <div key={label} className="flex-1 px-5 py-4">
                  <p className="text-[11px] font-medium text-muted">{label}</p>
                  <p className="num mt-1 text-lg font-semibold text-ink">{value}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface p-4">
              <p className="pb-3 text-sm text-ink">Agreed prices</p>

              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-xs">
                  <thead>
                    <tr className="bg-panel text-left text-muted">
                      <th className="px-3 py-2.5 font-medium">Product</th>
                      <th className="px-3 py-2.5 font-medium">SKU</th>
                      {/* Two currencies, so both columns name theirs. They are
                          not comparable at a glance and must not pretend to be. */}
                      <th className="px-3 py-2.5 text-right font-medium">
                        Our cost ({customer.shopCurrency})
                      </th>
                      <th className="px-3 py-2.5 text-right font-medium">
                        Agreed price ({customer.currency})
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-ink">
                    {customer.prices.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-3 py-10 text-center text-faint">
                          <span className="font-semibold text-ink">No agreed prices yet</span> - add
                          some with Edit, or type a price when you enter their first order.
                        </td>
                      </tr>
                    ) : (
                      customer.prices.map((p) => (
                        <tr key={p.productId} className="border-t border-line">
                          <td className="px-3 py-3 font-medium text-ink">{p.name}</td>
                          <td className="px-3 py-3 text-muted">{p.sku}</td>
                          <td className="num px-3 py-3 text-right text-muted">
                            {p.costPerItem === 0 ? (
                              <span className="text-warn" title="No cost entered for this product">
                                not set
                              </span>
                            ) : (
                              formatMoney(p.costPerItem + p.handlingCost, customer.shopCurrency)
                            )}
                          </td>
                          <td className="num px-3 py-3 text-right font-medium text-ink">
                            {formatMoney(p.unitPrice, customer.currency)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </PageBody>

      {editing && customer && (
        <CustomerModal
          shops={shops}
          customer={customer}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load() }}
        />
      )}
    </AppShell>
  )
}
```

- [ ] **Step 3: See it in the browser**

Start the dev server **bare and in the background** - piping it wedges the port:

```bash
npm run dev
```

Open `http://localhost:3000/b2b`, add a customer with one price, then open them. Confirm the two currency-labelled columns and the summary.

- [ ] **Step 4: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/app/b2b
git commit -m "feat: one business customer, their prices and what they have bought"
```

---

### Task 13: The Orders page tells them apart

**Files:**
- Modify: `src/app/orders/OrdersClient.tsx` - `OrderRow` (`:27-45`), state (`:115-130`), query (`:140-154`), header (`:229-252`), the number cell
- Test: `src/app/orders/OrdersClient.test.tsx`

**Interfaces:**
- Consumes: `source` and `customer` on each order, and the `?source=` parameter (Task 6).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `src/app/orders/OrdersClient.test.tsx`, matching that file's existing fetch-mock helper:

```tsx
it('badges a B2B order and can narrow to one source', async () => {
  const user = userEvent.setup()
  const calls: string[] = []
  mockOrders(
    [
      { ...baseOrder, id: 'o1', number: 'B-0001', source: 'b2b', customer: 'Nordic Retail AS' },
      { ...baseOrder, id: 'o2', number: '9001', source: 'webshop', customer: null },
    ],
    calls,
  )

  render(<OrdersClient email="a@b.test" shops={shops} />)

  expect(await screen.findByText('B2B')).toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('Source'), 'b2b')
  await waitFor(() => expect(calls.some((u) => u.includes('source=b2b'))).toBe(true))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/orders/OrdersClient.test.tsx`
Expected: FAIL - no "B2B" text and no "Source" control.

- [ ] **Step 3: Extend `OrderRow`**

In `src/app/orders/OrdersClient.tsx`, add to the `OrderRow` type after `customerEmail`:

```tsx
  source: 'webshop' | 'b2b'
  customer: string | null // the B2B customer's name; null on a webshop order
```

- [ ] **Step 4: Add the state, seeded from the URL**

Beside the other filter state (after `const [status, setStatus] = useState('')`):

```tsx
  // /b2b links here with ?source=b2b. Read it once, from window rather than
  // useSearchParams, so this client component needs no Suspense boundary.
  const [source, setSource] = useState(() =>
    typeof window === 'undefined'
      ? ''
      : new URLSearchParams(window.location.search).get('source') ?? '',
  )
```

Add `source` to the dependency array of the effect that refetches when a filter changes (the one already listing `preset, from, to, selected, status, query, refresh`).

- [ ] **Step 5: Send it**

In the query builder, after `if (query) p.set('q', query)`:

```tsx
    if (source) p.set('source', source)
```

- [ ] **Step 6: Add the control**

In `PageHeader`, beside the existing status `<select>`:

```tsx
        <select
          value={source}
          aria-label="Source"
          onChange={(e) => setSource(e.target.value)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
        >
          <option value="">All orders</option>
          <option value="webshop">Webshop</option>
          <option value="b2b">B2B</option>
        </select>
```

- [ ] **Step 7: Badge the row**

In the cell rendering `o.number`, wrap it:

```tsx
                    <span className="inline-flex items-center gap-1.5">
                      {o.number}
                      {o.source === 'b2b' && (
                        <span
                          title={o.customer ? `Entered by hand for ${o.customer}` : 'Entered by hand'}
                          className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-ink"
                        >
                          B2B
                        </span>
                      )}
                    </span>
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/app/orders/OrdersClient.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/app/orders
git commit -m "feat: badge and filter B2B orders on the Orders page"
```

---

### Task 14: End to end

**Files:**
- Create: `e2e/b2b.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the spec**

Create `e2e/b2b.spec.ts`. Read `e2e/orders.spec.ts` first and reuse its admin sign-in helper and its conventions verbatim.

```ts
import { test, expect } from '@playwright/test'

// One journey, end to end: register a business customer with an agreed price,
// enter an order for them, and watch the money arrive in the same Dashboard
// figure the webshop feeds. That last assertion is the whole feature.
test('a B2B order reaches the Dashboard', async ({ page }) => {
  await signInAsAdmin(page) // from e2e/orders.spec.ts's helper

  await page.goto('/b2b')
  await expect(page.getByRole('heading', { name: 'B2B' })).toBeVisible()

  // 1. The customer.
  const name = `E2E Nordic ${Date.now()}`
  await page.getByRole('button', { name: '+ Add customer' }).click()
  await page.getByLabel('Customer name').fill(name)
  await page.getByLabel('VAT rate').fill('0')
  await page.getByRole('button', { name: 'Add customer' }).click()
  await expect(page.getByText(name)).toBeVisible()

  // 2. What the Dashboard says before the order.
  await page.goto('/dashboard?preset=this_month')
  const before = await page.getByTestId('stat-net-revenue').innerText()

  // 3. The order: 2 x 100.00, 10% off.
  await page.goto('/b2b')
  await page.getByRole('button', { name: '+ Add order' }).click()
  await page.getByLabel('Customer').selectOption({ label: new RegExp(name) })
  await page.getByRole('button', { name: '+ Add a line' }).click()
  await page.getByLabel('Product 1').selectOption({ index: 1 })
  await page.getByLabel('Quantity 1').fill('2')
  await page.getByLabel('Unit price 1').fill('100')
  await page.getByLabel('Discount 1').fill('10')

  // The form does the arithmetic in front of you: 200.00 less 10% = 180.00.
  await expect(page.getByTestId('total-net-sales')).toContainText('180.00')
  await page.getByRole('button', { name: 'Save order' }).click()

  // 4. It is in the list, marked, with its own number.
  await expect(page.getByText('B-0001')).toBeVisible()

  await page.goto('/orders?source=b2b')
  await expect(page.getByText('B2B').first()).toBeVisible()

  // 5. And the Dashboard moved. Not "a number is shown" - a DIFFERENT number.
  await page.goto('/dashboard?preset=this_month')
  await expect(page.getByTestId('stat-net-revenue')).not.toHaveText(before)
})
```

If `stat-net-revenue` is not the test id `StatStrip` actually renders, read `src/components/dashboard/StatStrip.tsx` and use the one that is there; add the `data-testid` if none exists.

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/b2b.spec.ts`
Expected: PASS. If the product dropdown is empty, the seeded shop has no products - run `npm run db:seed` first.

- [ ] **Step 3: Run everything and commit**

Run: `npm test && npm run lint && npx tsc --noEmit`
Expected: all three PASS.

```bash
git add e2e/b2b.spec.ts
git commit -m "test: a B2B customer's order reaches the Dashboard"
```

- [ ] **Step 4: Update the README**

`README.md` documents how the money is calculated. Add to that section, after the `net profit` block:

```markdown
Orders from business customers are entered by hand under **B2B**. They are
ordinary orders - same revenue, same COGS, same profit - with three
differences: they are invoiced, so they pay no payment-gateway fee; they carry
the shipping cost you type rather than the shop's per-order rate; and they are
priced and invoiced in the customer's own currency, which need not be the
shop's. Their order numbers are their own sequence (B-0001), so nothing can
collide with WooCommerce.
```

```bash
git add README.md
git commit -m "docs: how B2B orders differ from webshop orders"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: data model → 1; money math → 2; numbering and identity → 3; engine changes → 4; loader changes → 5; Orders page API → 6; customer routes and deletion rule → 7; order routes, server recompute, validation, ambassador isolation → 8; `/b2b` and nav → 9; add/edit customer and the currency warning → 10; the order form, per-unit discount and the product-picker limit → 11; `/b2b/[id]` → 12; badge and Source filter → 13; tests and docs → 14.

**Two deliberate deviations**, both flagged in place: Task 9 uses a plain shop `<select>` rather than `ShopFilter` (every admin CRUD screen does, and a customer belongs to one shop), and Task 12 shows the price list read-only rather than inline-editable (one editor, in `CustomerModal`, instead of two).

**One simplification against the spec's route list:** `/api/b2b/orders` has no `GET`. `/api/orders?source=b2b` already lists orders with per-order profit, and a second endpoint would be a second copy of that arithmetic.

**Riskiest task is 4**, the only one that edits live money code. Its gate is that no existing assertion changes - only four test factories gain one field each.

