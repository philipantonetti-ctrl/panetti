# Refund Reversal and Twelve Months - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show twelve months of B2B orders instead of ninety days, and make a refund subtract the whole order from the day the refund happened rather than silently rewriting the day it was placed.

**Architecture:** One nullable column, `Order.voidedAt`, stamped only on a live→voided transition so an order that arrives already refunded is never given a guessed date. The metrics engine stops discarding voided orders and instead expands each order into signed entries: `+1` at `placedAt`, `-1` at `voidedAt`. Every existing figure is multiplied by that sign, so the reversal is the same arithmetic with its sign flipped rather than a second set of rules.

**Tech Stack:** Next.js 16, React 19, Prisma 6 + PostgreSQL, Zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-refund-reversal-design.md`

## Global Constraints

- **All money is INTEGER minor units.** `toMinor`/`toMajor` from `src/lib/money.ts`; never `/100` by hand.
- **Schema changes must be additive.** `npm run build` runs `scripts/db-push.mjs`, which refuses destructive changes. `voidedAt` is nullable.
- **`VOIDED_STATUSES` reverse; `UNPAID_STATUSES` do not.** They mean different things: unpaid is "the money has not arrived", voided is "it arrived and went back". Both stay in `EXCLUDED_STATUSES`; only the engine's use of them splits.
- **A voided order with no `voidedAt` contributes nothing, anywhere.** That is exactly today's behaviour and it is what keeps every existing figure untouched.
- **The negative entry adds 0 to the order count, not −1.**
- Admin-only endpoints keep `assertAdmin` first inside the `try`, `AuthError` → 403, `Cache-Control: private, no-store` on every response.
- Tests use `fireEvent`; `@testing-library/user-event` is **not** a dependency of this project.
- **Edit files with the Edit/Write tools only** - PowerShell `Get-Content`/`Set-Content` corrupts the UTF-8 here.
- **Never run `git stash`, `git checkout --`, `git restore`, `git reset --hard`, `git clean`.**
- **Re-check the branch before every commit** (`git branch --show-current`). A background process in this repo merges branches into `main` and moves the checkout underneath you. Expected branch: `feat/refund-reversal-and-12-months`.
- Never pipe `npm run dev` into anything; do not redirect test output into the repo.
- Fixtures clean up FK-safely (**orders → customers → shops**) under a marker verified unique by grep.
- Leave `next-env.d.ts` alone; never stage it.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` after a blank line.
- Baseline: **923 tests passing**, `tsc` clean, lint at 8 pre-existing errors (do not fix, do not add a ninth).

## File Structure

| file | change |
|---|---|
| `src/app/b2b/B2bClient.tsx` | `RECENT_DAYS` 90 → 365 and its two labels |
| `src/app/b2b/B2bClient.test.tsx` | pin the window |
| `prisma/schema.prisma` | `Order.voidedAt DateTime?` |
| `src/lib/woo/sync.ts` | stamp on live→voided in `storeOrder` |
| `src/lib/woo/sync.test.ts` | stamping tests |
| `src/app/api/b2b/orders/[id]/route.ts` | stamp on void, clear on un-void |
| `src/app/api/b2b/orders/[id]/route.test.ts` | its tests |
| `src/lib/metrics/types.ts` | `EngineOrder.voidedAt` |
| `src/lib/metrics/engine.ts` | signed entries replace the filter |
| `src/lib/metrics/engine.test.ts` | reversal tests |
| `src/lib/data/load.ts` | select and map `voidedAt` |

---

### Task 1: Twelve months on the B2B card

**Files:**
- Modify: `src/app/b2b/B2bClient.tsx`
- Test: `src/app/b2b/B2bClient.test.tsx`

**Interfaces:** none consumed or produced.

- [ ] **Step 1: Write the failing test**

Append to `src/app/b2b/B2bClient.test.tsx`, following its existing `renderWithToast` and fetch-mock conventions:

```tsx
it('asks for twelve months of B2B orders, not ninety days', async () => {
  // The card is a working surface, but a business customer may order twice a
  // year - ninety days hid orders the client knew they had placed.
  const calls: string[] = []
  mockFetchCapturing(calls, [customer], [])
  renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

  await waitFor(() => expect(calls.some((u) => u.includes('/api/orders?source=b2b'))).toBe(true))

  const url = new URL(calls.find((u) => u.includes('source=b2b'))!, 'http://localhost')
  const from = new Date(url.searchParams.get('from')!)
  const to = new Date(url.searchParams.get('to')!)
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000)

  expect(days).toBe(365)
})

it('says twelve months on the card', async () => {
  mockFetch([customer], [])
  renderWithToast(<B2bClient email="a@b.test" shops={shops} />)
  expect(await screen.findByText(/last 12 months/i)).toBeInTheDocument()
})
```

If the file's existing capture helper is named differently, use whatever it already has rather than adding a second one.

- [ ] **Step 2: Run to verify they fail**

`npx vitest run src/app/b2b/B2bClient.test.tsx` - expect 90 where 365 is asserted, and no "last 12 months" text.

- [ ] **Step 3: Implement**

In `src/app/b2b/B2bClient.tsx`, replace the constant and its comment:

```tsx
/**
 * The orders card is a working surface, not an archive - but a business
 * customer may order only twice a year, and ninety days hid orders the client
 * knew they had placed. A year covers the real rhythm; "See all" still leads
 * to the Orders page for anything older.
 */
const RECENT_DAYS = 365
```

Then change both label sites from `last {RECENT_DAYS} days` to `last 12 months`, and the empty state from `No B2B orders in the last {RECENT_DAYS} days.` to `No B2B orders in the last 12 months.`

- [ ] **Step 4: Tests pass, full suite, commit**

`npx vitest run src/app/b2b/B2bClient.test.tsx`, then `npm test` (925), then - after `git branch --show-current` confirms the branch:

```bash
git add src/app/b2b/B2bClient.tsx src/app/b2b/B2bClient.test.tsx
git commit -m "feat: the B2B card shows twelve months, not ninety days"
```

---

### Task 2: `voidedAt`, stamped only on a transition

**Files:**
- Modify: `prisma/schema.prisma`, `src/lib/woo/sync.ts`, `src/app/api/b2b/orders/[id]/route.ts`
- Test: `src/lib/woo/sync.test.ts`, `src/app/api/b2b/orders/[id]/route.test.ts`

**Interfaces:**
- Produces: `Order.voidedAt: Date | null`. Task 3 reads it.

- [ ] **Step 1: Add the column**

In `prisma/schema.prisma`, in `model Order` after `fulfillmentCost`:

```prisma
  // When this order entered a refunded or cancelled state, so the reversal can
  // land on the day the money actually went back rather than silently rewriting
  // the day it was placed. Stamped ONLY on a live -> voided transition: an
  // order that arrives already refunded gets null, because we genuinely do not
  // know when it happened and a guessed date in a profit figure is worse than
  // an honest gap. Null therefore means "never voided, or voided before we
  // started recording" - and such an order contributes nothing, anywhere.
  voidedAt DateTime?
```

Run `npx prisma db push && npx prisma generate`. If it prompts about data loss, STOP and report BLOCKED - this must be additive.

- [ ] **Step 2: Write the failing sync tests**

Append to `src/lib/woo/sync.test.ts`, following its existing fixture and cleanup conventions:

```ts
describe('voidedAt', () => {
  it('stamps when an order we already hold becomes refunded', async () => {
    await storeOrder(shopId, wooOrder({ id: 7001, status: 'completed' }), new Map())
    expect((await db.order.findFirstOrThrow({ where: { externalId: '7001' } })).voidedAt).toBeNull()

    await storeOrder(shopId, wooOrder({ id: 7001, status: 'refunded' }), new Map())
    const after = await db.order.findFirstOrThrow({ where: { externalId: '7001' } })
    expect(after.voidedAt).toBeInstanceOf(Date)
  })

  it('does NOT stamp an order that arrives already refunded', async () => {
    // A first sync, a backfill, a newly connected store. We do not know when
    // it was refunded, and a guessed date would put a reversal on a wrong day.
    await storeOrder(shopId, wooOrder({ id: 7002, status: 'refunded' }), new Map())
    expect((await db.order.findFirstOrThrow({ where: { externalId: '7002' } })).voidedAt).toBeNull()
  })

  it('does not move the stamp when a refunded order is seen again', async () => {
    await storeOrder(shopId, wooOrder({ id: 7003, status: 'completed' }), new Map())
    await storeOrder(shopId, wooOrder({ id: 7003, status: 'refunded' }), new Map())
    const first = (await db.order.findFirstOrThrow({ where: { externalId: '7003' } })).voidedAt

    await storeOrder(shopId, wooOrder({ id: 7003, status: 'refunded' }), new Map())
    const second = (await db.order.findFirstOrThrow({ where: { externalId: '7003' } })).voidedAt
    expect(second?.getTime()).toBe(first?.getTime())
  })

  it('clears the stamp if the store un-refunds an order', async () => {
    await storeOrder(shopId, wooOrder({ id: 7004, status: 'completed' }), new Map())
    await storeOrder(shopId, wooOrder({ id: 7004, status: 'refunded' }), new Map())
    await storeOrder(shopId, wooOrder({ id: 7004, status: 'completed' }), new Map())
    expect((await db.order.findFirstOrThrow({ where: { externalId: '7004' } })).voidedAt).toBeNull()
  })

  it('does not stamp an unpaid order - pending is not a refund', async () => {
    await storeOrder(shopId, wooOrder({ id: 7005, status: 'completed' }), new Map())
    await storeOrder(shopId, wooOrder({ id: 7005, status: 'on-hold' }), new Map())
    expect((await db.order.findFirstOrThrow({ where: { externalId: '7005' } })).voidedAt).toBeNull()
  })
})
```

Use the file's own WooCommerce-order fixture builder; if it has none, write a small local `wooOrder({ id, status })` returning the minimal `WooOrder` shape (`line_items: []`, `coupon_lines: []`, the date and money strings) and say so in your report.

- [ ] **Step 3: Run to verify they fail**

`npx vitest run src/lib/woo/sync.test.ts` - `voidedAt` is never set.

- [ ] **Step 4: Implement the stamp in `storeOrder`**

In `src/lib/woo/sync.ts`, inside `storeOrder`, before the `db.$transaction` that writes the order:

```ts
  // Was this order already voided in our own records? The stamp marks a
  // TRANSITION, so an order that arrives already refunded keeps a null date -
  // we do not know when it happened, and the engine leaves such an order out
  // entirely rather than reversing it on a guessed day.
  const held = await db.order.findUnique({
    where: { shopId_externalId: { shopId, externalId: o.externalId } },
    select: { status: true, voidedAt: true },
  })
  const wasVoided = held ? VOIDED_STATUSES.includes(held.status.toLowerCase() as never) : false
  const isVoided = VOIDED_STATUSES.includes(o.status.toLowerCase() as never)

  const voidedAt = isVoided
    // Newly voided by a store we were already watching: now is the moment.
    // Already voided: keep whatever stamp we had, so a re-sync cannot move it.
    ? (wasVoided ? held!.voidedAt : held ? new Date() : null)
    // Back to life. The reversal must disappear with the status.
    : null
```

Add `voidedAt` to the `data` object built just below, and import `VOIDED_STATUSES` from `../metrics/types`.

- [ ] **Step 5: Sync tests pass**

`npx vitest run src/lib/woo/sync.test.ts`

- [ ] **Step 6: Write the failing B2B route tests**

Append to `src/app/api/b2b/orders/[id]/route.test.ts`:

```ts
describe('voidedAt on a hand-entered order', () => {
  it('stamps when the status is set to refunded', async () => {
    await asAdmin()
    const id = await createOrder()
    expect((await db.order.findUniqueOrThrow({ where: { id } })).voidedAt).toBeNull()

    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'refunded',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).voidedAt).toBeInstanceOf(Date)
  })

  it('clears the stamp when the order is set back to completed', async () => {
    // The edit form can un-void, so the reversal must be able to disappear.
    await asAdmin()
    const id = await createOrder()
    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'cancelled',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })
    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'completed',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).voidedAt).toBeNull()
  })

  it('does not move the stamp when a refunded order is edited again', async () => {
    await asAdmin()
    const id = await createOrder()
    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'refunded',
      lines: [{ productId, quantity: 1, unitPrice: 89 }],
    })
    const first = (await db.order.findUniqueOrThrow({ where: { id } })).voidedAt

    await patch(id, {
      customerId, placedAt: '2026-07-01', status: 'refunded',
      lines: [{ productId, quantity: 2, unitPrice: 89 }],
    })
    const second = (await db.order.findUniqueOrThrow({ where: { id } })).voidedAt
    expect(second?.getTime()).toBe(first?.getTime())
  })
})
```

- [ ] **Step 7: Implement in the B2B route**

In `src/app/api/b2b/orders/[id]/route.ts`'s `PATCH`, widen the `ownB2bOrder` select to include `status` and `voidedAt`, then before the transaction:

```ts
    // Same transition rule as the WooCommerce path: stamp when it becomes
    // voided, keep the stamp while it stays voided so an edit cannot move it,
    // and clear it when the order comes back to life.
    const wasVoided = VOIDED_STATUSES.includes(existing.status.toLowerCase() as never)
    const isVoided = VOIDED_STATUSES.includes(parsed.data.status)
    const voidedAt = isVoided ? (wasVoided ? existing.voidedAt : new Date()) : null
```

Add `voidedAt` to the `tx.order.update` data, and import `VOIDED_STATUSES` from `@/lib/metrics/types`.

- [ ] **Step 8: Tests pass, full suite, commit**

`npx vitest run src/lib/woo/sync.test.ts "src/app/api/b2b/orders/[id]/route.test.ts"`, then `npm test` (933), then check the branch and:

```bash
git add prisma/schema.prisma src/lib/woo/sync.ts src/lib/woo/sync.test.ts "src/app/api/b2b/orders/[id]"
git commit -m "feat: record when an order was voided, only when we saw it happen"
```

---

### Task 3: The engine reverses on the void date

**Files:**
- Modify: `src/lib/metrics/types.ts`, `src/lib/metrics/engine.ts`, `src/lib/data/load.ts`
- Test: `src/lib/metrics/engine.test.ts`

**Interfaces:**
- Consumes: `Order.voidedAt` (Task 2).
- Produces: `EngineOrder.voidedAt?: Date | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/metrics/engine.test.ts`, inside `describe('computeMetrics', ...)`:

```ts
  // Placed 1 July, refunded 8 July. Look at each day and at both together.
  const refunded = () =>
    order({ status: 'refunded', voidedAt: new Date('2026-07-08') })

  it('still counts a refunded order on the day it was placed', () => {
    // The sale really happened that day. Today's engine erases it, which
    // rewrites a figure the client has already read.
    const res = computeMetrics({
      shops: [shops[0]], orders: [refunded()], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.netSales).toBe(90000)
    expect(res.total.orders).toBe(1)
  })

  it('subtracts the whole order on the day it was refunded', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [refunded()], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-08'), to: new Date('2026-07-08'),
    })
    expect(res.total.netSales).toBe(-90000)
    expect(res.total.cogs).toBe(-22000)
    expect(res.total.netRevenue).toBe(-95000)
    // You did not un-place an order.
    expect(res.total.orders).toBe(0)
  })

  it('nets to exactly zero across a period covering both', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [refunded()], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-31'),
    })
    expect(res.total.netSales).toBe(0)
    expect(res.total.cogs).toBe(0)
    expect(res.total.netRevenue).toBe(0)
    expect(res.total.netProfit).toBe(0)
    expect(res.total.orders).toBe(1)
  })

  it('reverses the ambassador commission too', () => {
    const attributed = order({
      status: 'refunded', voidedAt: new Date('2026-07-08'),
      ambassadorId: 'a1', commissionRate: 0.1,
    })
    const on8th = computeMetrics({
      shops: [shops[0]], orders: [attributed], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-08'), to: new Date('2026-07-08'),
    })
    expect(on8th.total.commission).toBe(-9000)
  })

  it('leaves an order refunded before we recorded dates out entirely', () => {
    // voidedAt null: we do not know when. It counts nowhere, which is exactly
    // what the engine did before this change - no existing figure moves.
    const old = order({ status: 'refunded' })
    for (const [from, to] of [['2026-07-01', '2026-07-01'], ['2026-07-08', '2026-07-08'], ['2026-07-01', '2026-07-31']]) {
      const res = computeMetrics({
        shops: [shops[0]], orders: [old], expenses: [], costs, rates,
        displayCurrency: 'NOK', from: new Date(from), to: new Date(to),
      })
      expect(res.total.netSales).toBe(0)
      expect(res.total.orders).toBe(0)
    }
  })

  it('does not reverse an unpaid order - pending is not a refund', () => {
    const pending = order({ status: 'pending', voidedAt: new Date('2026-07-08') })
    const res = computeMetrics({
      shops: [shops[0]], orders: [pending], expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-31'),
    })
    expect(res.total.netSales).toBe(0)
    expect(res.total.orders).toBe(0)
  })
```

- [ ] **Step 2: Run to verify they fail**

`npx vitest run src/lib/metrics/engine.test.ts` - the refunded order currently contributes nothing anywhere, so the first four fail.

- [ ] **Step 3: Add the field**

In `src/lib/metrics/types.ts`, in `EngineOrder` after `status`:

```ts
  /**
   * When this order was voided, if we saw it happen. The order then counts
   * positively on `placedAt` and negatively here. Absent on a voided order
   * means we never learned the date, and it counts nowhere at all.
   */
  voidedAt?: Date | null
```

- [ ] **Step 4: Replace the filter with signed entries**

In `src/lib/metrics/engine.ts`, replace `counts()` and the `live` line. Keep `inRange` but make it take a date:

```ts
/** Membership by CALENDAR DAY in the workspace timezone (from/to name calendar days). */
function inRange(when: Date, from: Date, to: Date, tz: string): boolean {
  const day = zonedDayStr(when, tz)
  return day >= utcDay(from).toISOString().slice(0, 10) && day <= utcDay(to).toISOString().slice(0, 10)
}

/**
 * An order as the period sees it. A sale is one entry at +1. A refund is TWO:
 * the original sale still stands on the day it happened, and the whole order
 * comes back off on the day the money did. Every figure below is multiplied by
 * `sign`, so the reversal is the same arithmetic rather than a second set of
 * rules that could drift from it.
 */
type Entry = { order: EngineOrder; sign: 1 | -1 }

function entriesIn(orders: EngineOrder[], from: Date, to: Date, tzFor: (id: string) => string): Entry[] {
  const out: Entry[] = []

  for (const order of orders) {
    const status = order.status.toLowerCase()
    // Not paid yet is not the same as paid and given back: an unpaid order
    // simply does not count until it is paid, and never reverses.
    if (UNPAID_STATUSES.includes(status as never)) continue

    const tz = tzFor(order.shopId)

    if (!VOIDED_STATUSES.includes(status as never)) {
      if (inRange(order.placedAt, from, to, tz)) out.push({ order, sign: 1 })
      continue
    }

    // Voided but we never learned when - leave every existing figure alone.
    if (!order.voidedAt) continue

    if (inRange(order.placedAt, from, to, tz)) out.push({ order, sign: 1 })
    if (inRange(order.voidedAt, from, to, tz)) out.push({ order, sign: -1 })
  }

  return out
}
```

and in `computeMetrics`:

```ts
  const live = entriesIn(orders, from, to, tzFor)
```

Import `UNPAID_STATUSES` and `VOIDED_STATUSES` from `./types`; `EXCLUDED_STATUSES` may become unused here - remove it from this file's imports if so, but **do not** delete it from `types.ts`, where other files use it.

- [ ] **Step 5: Multiply every figure by the sign**

In the `byShop` map, `shopOrders` becomes entries:

```ts
    const shopOrders = live.filter((e) => e.order.shopId === shop.id)
```

Then each sum takes the entry. The two converters keep taking an order:

```ts
    const grossSales = sum(shopOrders.map((e) => e.sign * conv(e.order.grossSales, e.order)))
    const discounts = sum(shopOrders.map((e) => e.sign * conv(e.order.discountTotal, e.order)))
    const netSales = sum(shopOrders.map((e) => e.sign * conv(e.order.netSales, e.order)))
    const shippingCharged = sum(shopOrders.map((e) => e.sign * conv(e.order.shippingCharged, e.order)))
    const taxes = sum(shopOrders.map((e) => e.sign * conv(e.order.taxTotal, e.order)))

    const fulfillment = sum(
      shopOrders.map((e) =>
        e.sign * convCost(e.order.fulfillmentCost ?? fulfillmentOn(ratesForShop, e.order.placedAt), e.order),
      ),
    )

    const transactionFees = !fee
      ? 0
      : sum(
          shopOrders
            .filter((e) => e.order.chargesGatewayFee !== false)
            .map((e) => {
              const pctPart = Math.round((e.order.total * fee.percent) / 100)
              const fixedPart = crossConvert(fee.fixedMinor, fee.currency, e.order.currency, e.order.placedAt, rates)
              return e.sign * conv(pctPart + fixedPart, e.order)
            }),
        )

    const cogs = sum(
      shopOrders.map((e) =>
        e.sign *
        sum(
          e.order.items.map((item) => {
            const cost = costOn(costs.get(item.productId) ?? [], e.order.placedAt)
            return convCost(item.quantity * (cost.costPerItem + cost.handlingCost), e.order)
          }),
        ),
      ),
    )

    const commission = sum(
      shopOrders.map((e) =>
        e.order.ambassadorId ? e.sign * conv(pct(e.order.netSales, e.order.commissionRate), e.order) : 0,
      ),
    )
    const ambassadorSales = sum(
      shopOrders.map((e) => (e.order.ambassadorId ? e.sign * conv(e.order.netSales, e.order) : 0)),
    )
```

and the count keeps only the positive entries:

```ts
      // A reversal is not an un-placed order, so only the sale side counts.
      orders: shopOrders.filter((e) => e.sign === 1).length,
```

`netRevenue`, `grossRevenue`, `netProfit`, `netMargin` and `avgOrderValue` are all derived from the above and need no change.

- [ ] **Step 6: Tests pass**

`npx vitest run src/lib/metrics/engine.test.ts` - the six new cases **and** every pre-existing one, with no assertion edited. A pre-existing failure means a sign was applied where it should not have been.

- [ ] **Step 7: Carry `voidedAt` through the loader**

In `src/lib/data/load.ts`, add `voidedAt: true` to the order `select`, and `voidedAt: o.voidedAt,` to the mapped `EngineOrder`.

- [ ] **Step 8: Full suite, tsc, lint, commit**

`npm test` (939), `npx tsc --noEmit`, `npm run lint` (must stay at 8 errors). Check the branch, then:

```bash
git add src/lib/metrics/types.ts src/lib/metrics/engine.ts src/lib/metrics/engine.test.ts src/lib/data/load.ts
git commit -m "feat: a refund comes off the day it happened, not the day it was placed"
```

---

## Self-Review

**Spec coverage:** twelve months → Task 1; the column and both stamping paths → Task 2; the three-way engine split, the sign multiplication, the order count and the unpaid exclusion → Task 3. Every spec section maps.

**Riskiest:** Task 3 Step 5. Every figure must take the sign, and `transactionFees`'s existing `chargesGatewayFee` filter must survive alongside it. A pre-existing engine test failing is the signal that something was signed which should not have been.

**Type consistency:** `Entry` is local to `engine.ts`. `EngineOrder.voidedAt?: Date | null` in Task 3 is what Task 2's column feeds through `load.ts`. `VOIDED_STATUSES`/`UNPAID_STATUSES` are the existing exports in `types.ts`, unchanged.
