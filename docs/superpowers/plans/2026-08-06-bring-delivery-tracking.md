# Bring Delivery Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show how many days each order took to reach the customer, and post one batched Slack message when orders run past the company's per-country delivery promise.

**Architecture:** The warehouse ships under its own Bring customer number, so we cannot subscribe to Bring's push feed or search by our own reference. Instead, a file from the warehouse pairs order number with tracking number, and the existing 15-minute cron polls Bring's Tracking API for each parcel that has not finished moving. Milestone timestamps are derived from stored events, so re-ingesting is always a no-op. The order-to-shipment link is a recorded strategy (`FILE` today, `NYCE` later), not an assumption.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.4, Prisma 6 + PostgreSQL, Vitest 4, Playwright, Tailwind v4, zod 4.

**Spec:** `docs/superpowers/specs/2026-08-06-bring-delivery-tracking-design.md`

## Global Constraints

- **Schema changes use `npm run db:push`, not migrations.** The repo has no `prisma/migrations/`; `package.json` build runs `scripts/db-push.mjs`. Never hand-write a migration file.
- **Never point tests at the live Neon database.** Tests use the local Postgres from `.env` (`vitest.config.ts` falls back to `postgresql://postgres@127.0.0.1:5432/ecom_analytics`).
- **If hundreds of DB tests suddenly fail with no code change, another checkout ran `prisma db push` against the shared local Postgres.** Introspect the database before debugging your own code.
- **Never run `git stash`, `git checkout <path>`, `git restore`, `git reset --hard`, or `git clean`.** Work in this repo has been silently reverted this way. If you think you need one, stop and report instead.
- **Re-check the branch immediately before every commit** (`git rev-parse --abbrev-ref HEAD`). A background sync worktree merges branches into `main` and moves the checkout mid-session. Expected branch: `feat/bring-delivery-tracking`.
- **Edit files with the Edit/Write tools only.** PowerShell `Get-Content`/`Set-Content` corrupts UTF-8 in this environment.
- **Every new API route is admin-only:** `assertAdmin(await currentUser())` and `Cache-Control: private, no-store`, matching `src/app/api/orders/route.ts`.
- **Money is integer minor units.** Nothing in this feature stores money, and nothing here may start.
- **Tests are colocated** next to their subject as `<name>.test.ts`. Tests that touch the database are named `<name>.integration.test.ts`.
- **Test data convention — this one will bite you.** Vitest runs test **files in parallel** (this repo sets no `fileParallelism`/`poolOptions`), and every file shares one local Postgres. So a test may never delete a row it did not create. Three rules, all of which the repo already follows:

  1. **Every fixture carries a tag unique to its own file**, never a tag shared between files. Existing examples: `[load-test]` in `load.integration.test.ts`, `[pf-test]` in `processing-fee/route.test.ts`. This plan's tags are `[delivery-schema-test]`, `[delivery-link-test]`, `[delivery-import-test]`, `[delivery-route-test]`, `[delivery-alerts-test]` — one per file, and no two files may share one.
  2. **Every `deleteMany` is scoped to that tag.** A bare `db.shop.deleteMany()` or `db.order.deleteMany()` destroys the **11 seeded shops** that `src/lib/data/load.integration.test.ts:29` asserts (`toBe(11)`, excluding names matching `/\[[\w-]*test\]/`) — for every checkout sharing that database. Copy `load.integration.test.ts:86-88`, which deletes only `{ name: { contains: '[load-test]' } }`. An untagged fixture name breaks that count on the next run.
  3. **Rows with no shop to tag get their own per-file prefix.** A `Shipment` with `orderId: null` belongs to no shop, so scoping cleanup by `orderId: null` would delete another file's unlinked parcels. Each file therefore gives its tracking numbers a unique prefix and cleans by `{ trackingNumber: { startsWith: PREFIX } }`.

  **Singleton rows** (`DeliveryConfig`, always `id: 'singleton'`) are the one thing no tag can isolate. Never `deleteMany()` then `create()` — use `upsert`, the way `src/app/api/ads/oauth.test.ts:47` does for `AdPlatformApp`. A test needing "not connected" upserts the credential fields to `null` rather than deleting the row, so two racing files cannot make each other's row vanish mid-assertion.

- **The delivery integration suites must not run concurrently with each other.** Tagging cannot save them: `DeliveryConfig` is a fixed-id singleton, and `PUT /api/delivery/settings` **deletes every `DeliveryPromise` row** as its real production behaviour (promises are rewritten wholesale, not diffed), so Task 14's suite will wipe Tasks 11 and 13's promises whenever they overlap. Scoping the fixtures is still worth doing and is specified per file above, but the sequencing is what actually makes them deterministic.

  **Task 9 Step 7 owns this change.** It was originally assigned to Task 8, but Task 8 is blocked on an external credential and Tasks 11 and 13 cannot be correct without it. Add a second Vitest project to `vitest.config.ts` so only these files lose parallelism and the rest keep it:

  ```ts
  // in the returned config's `test` block, alongside the existing options
  projects: [
    {
      extends: true,
      test: {
        name: 'app',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
        exclude: ['src/lib/{delivery,bring}/**/*.integration.test.ts'],
      },
    },
    {
      extends: true,
      test: {
        name: 'delivery',
        include: ['src/lib/{delivery,bring}/**/*.integration.test.ts'],
        // DeliveryConfig is a fixed-id singleton and the settings route rewrites
        // every DeliveryPromise row. These files share state no tag can separate.
        fileParallelism: false,
      },
    },
  ],
  ```

  `extends: true` inherits the root `plugins`, `env` and `environment`, so `DATABASE_URL` and `AUTH_SECRET` keep resolving exactly as they do today. Verify with `npm run test` that the file count still totals what it did before the split — a bad glob silently runs fewer tests, which looks like success.
- **Test command:** `npm run test` (Vitest, `globals: true`, node environment). Single file: `npx vitest run src/lib/bring/map.test.ts`.
- **Design tokens only.** OKLCH variables (`--ink`, `--ink-muted`, `--border`, `--accent`, `--gain`, `--loss`, `--warn`), Geist Sans, `font-variant-numeric: tabular-nums` on every number, cards are 1px border + 12px radius + no shadow. No new colours, no shadows.
- **Say when you don't know.** A confident wrong number is the worst thing this product can ship. Unknown delivery state renders as an honest label, never as zero days.

---

## Phase 0 probe — gates *validation*, not implementation

**Every one of the fourteen tasks can be built and made green without it.** Task 3's tests stub `fetch` outright, Task 8's do the same, Task 14 mocks auth, and Task 4 is synthetic apart from a single test that is skipped until the recording exists. Nothing here waits on the client.

What the probe gates is whether the built thing will *work against the real Bring account*. Until it runs, two things stay unproven and must not be described as working:

1. That Bring's Tracking API returns parcels booked under **another company's** customer number — the assumption the entire design rests on.
2. That the field selectors in `mapConsignments` match what Bring actually sends, rather than what its documentation says.

Treat a fully green suite as "the logic is correct", never as "the integration is verified". The skipped test in Task 4 is the honest marker of the gap.

The whole design rests on one unverified assumption: that Bring's Tracking API returns parcels booked under **another company's** customer number. Confirm it with one call, using a real tracking number supplied by the client:

```bash
curl -s -H "X-Mybring-API-Uid: <client email>" \
     -H "X-Mybring-API-Key: <api key>" \
     -H "X-Bring-Client-URL: https://panetti.vercel.app" \
     "https://api.bring.com/tracking/api/v2/tracking.json?q=<tracking number>" \
     | tee src/lib/bring/__fixtures__/real-package.json
```

**Save the response verbatim as a fixture.** Task 4's mapper is written against this file, not against remembered field names. Do not guess the JSON shape — record it.

While there, answer the second question at no extra cost: repeat `q` twice (`?q=A&q=B`) and see whether both come back. If they do, Task 9's batching can send several numbers per request.

If the probe returns nothing for a warehouse-booked parcel, **stop and report.** The fallback is asking the warehouse to grant customer-number access in Mybring, or waiting for NYCE, and neither is a code change.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/lib/bring/client.ts` | HTTP to Bring's Tracking API. Timeouts, deadline clamping, error truncation. No parsing. |
| `src/lib/bring/map.ts` | Bring's JSON into our events, and events into milestone timestamps. Pure. |
| `src/lib/bring/parse.ts` | Warehouse file into `{orderNumber, trackingNumber}` pairs. PDF is the real path; CSV rides the same extractor. Pure. |
| `src/lib/bring/pdf.ts` | PDF bytes into plain text. Isolated so the dependency has one caller. |
| `src/lib/bring/link.ts` | Pairs into `Shipment` rows. Owns the ambiguity refusal. |
| `src/lib/bring/sync.ts` | Polling orchestration: who is due, batching, milestone writes, next tier. |
| `src/lib/delivery/days.ts` | Business-day arithmetic in a named timezone. Pure. |
| `src/lib/delivery/promise.ts` | The per-country promise timeline lookup. Pure. |
| `src/lib/delivery/stats.ts` | Median, on-time rate, split, distribution, per-country. Pure. |
| `src/lib/delivery/alerts.ts` | Who newly broke their promise, and the message text. |
| `src/lib/slack/notify.ts` | POST to an incoming webhook. One function. |
| `src/app/api/delivery/import/route.ts` | Upload endpoint. |
| `src/app/api/delivery/route.ts` | Delivery page data. |
| `src/app/delivery/page.tsx`, `DeliveryClient.tsx`, `LateList.tsx`, `UploadBox.tsx` | The Delivery page. |
| `src/app/settings/delivery/page.tsx`, `DeliverySettingsClient.tsx` | Credentials, promises, test buttons. |

**Modified:**

| File | Change |
| --- | --- |
| `prisma/schema.prisma` | Four new models, three new fields on existing models. |
| `src/lib/woo/map.ts` | Extract `shipping.country`. |
| `src/lib/woo/sync.ts` | Write `shippingCountry`; backfill it. |
| `src/app/api/cron/sync/route.ts` | Call `syncShipments()` then `flushDeliveryAlerts()`. |
| `src/app/api/orders/route.ts` | Bulk-load shipments, return a `delivery` block per order. |
| `src/app/orders/OrdersTable.tsx` | One new column. |
| `src/components/shell/AppShell.tsx` | Nav entry. |

---

### Task 1: Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `src/lib/bring/schema.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `Shipment`, `ShipmentEvent`, `DeliveryPromise`, `DeliveryConfig`, `TrackingImport`. Fields `Order.shippingCountry`, `Order.deliveryAlertedAt`, `Shop.deliveryTrackingFrom`. Every later task depends on these names.

- [ ] **Step 1: Add the models to `prisma/schema.prisma`**

Append at the end of the file:

```prisma
/// One parcel. Bring calls it a package; we only ever hold its number and what
/// happened to it. `orderId` is nullable on purpose: a parcel can be known
/// before its link is, and an unlinked parcel is counted on screen rather than
/// silently dropped.
model Shipment {
  id             String  @id @default(cuid())
  trackingNumber String  @unique
  carrier        String  @default("BRING")
  orderId        String?
  /// Which strategy produced the link: FILE | NYCE | WOO | MANUAL.
  linkSource     String?

  /// Milestones, derived from ShipmentEvent and rewritten on every ingest.
  /// Denormalised for query speed; the events remain the source of truth.
  bookedAt    DateTime? // PRE_NOTIFIED — label made, nothing has moved
  handedInAt  DateTime? // HANDED_IN — the warehouse let go of it
  availableAt DateTime? // READY_FOR_PICKUP or DELIVERED — the clock stop
  collectedAt DateTime? // COLLECTED / DELIVERED — recorded, never judged
  /// DELIVERED | RETURNED | CANCELLED. Null while still moving.
  outcome     String?

  lastStatus String?
  nextPollAt DateTime?
  terminal   Boolean   @default(false)
  /// Why the last poll failed. Stored, never thrown: one dead parcel must not
  /// stop the rest.
  lastError  String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  order  Order?          @relation(fields: [orderId], references: [id], onDelete: SetNull)
  events ShipmentEvent[]

  @@index([terminal, nextPollAt])
  @@index([orderId])
}

/// Bring restates events. The unique constraint is what makes re-ingestion a
/// no-op rather than a duplicate, and that is what lets the sync run as often
/// as it likes.
model ShipmentEvent {
  id          String   @id @default(cuid())
  shipmentId  String
  status      String
  occurredAt  DateTime
  description String?
  location    String?

  shipment Shipment @relation(fields: [shipmentId], references: [id], onDelete: Cascade)

  @@unique([shipmentId, status, occurredAt])
  @@index([shipmentId, occurredAt])
}

/// What we promise, per destination country, on a timeline. The row with the
/// latest effectiveFrom <= Order.placedAt wins — the same rule ProductCost and
/// FulfillmentRate already use. A promise changed today never rewrites last
/// month's on-time rate.
model DeliveryPromise {
  id            String   @id @default(cuid())
  /// ISO-2 country code, or '*' for the fallback.
  country       String
  days          Int
  businessDays  Boolean  @default(true)
  effectiveFrom DateTime

  @@unique([country, effectiveFrom])
  @@index([country, effectiveFrom])
}

/// Bring and Slack credentials. Its own singleton rather than crowding Setting,
/// which is purely formats. Follows the AdPlatformApp precedent.
model DeliveryConfig {
  id              String    @id @default("singleton")
  bringApiUid     String? // Mybring account email
  bringApiKey     String? // encrypted
  bringClientUrl  String? // sent as X-Bring-Client-URL
  slackWebhookUrl String? // encrypted
  lastSyncAt      DateTime?
  lastError       String?
}

/// Every warehouse file we ingested, so "did yesterday's file land, and did all
/// of it match?" is a question with an answer on screen.
model TrackingImport {
  id            String   @id @default(cuid())
  filename      String
  source        String // UPLOAD | EMAIL
  receivedAt    DateTime @default(now())
  rowsParsed    Int
  rowsLinked    Int
  rowsUnmatched Int
  /// Rows we refused to link, with the reason, as JSON text.
  unmatched     String?
  error         String?

  @@index([receivedAt])
}
```

- [ ] **Step 2: Add the fields to existing models**

In `model Order`, immediately after the `customerEmail` line:

```prisma
  /// ISO-2 destination country, from Woo's shipping address. Null = not yet
  /// checked (backfill pending); '' = checked, the store has none on file.
  /// Same convention as customerName.
  shippingCountry String?
  /// When we posted this order to Slack as late. Set only after Slack accepts,
  /// so nothing can ever alert twice and a Slack outage retries next run.
  deliveryAlertedAt DateTime?
```

And in the relations block of `model Order`, alongside `items`:

```prisma
  shipments Shipment[]
```

In `model Shop`, immediately after `lastError`:

```prisma
  /// Null = this shop is not delivery-tracked at all, so its orders never read
  /// "not shipped yet" and never alert. Set = tracked, and orders placed before
  /// this date read "Before tracking started". Backdate it after importing
  /// historical warehouse files to get real history on day one.
  deliveryTrackingFrom DateTime?
```

- [ ] **Step 3: Push the schema**

Run: `npm run db:push`
Expected: `Your database is now in sync with your Prisma schema.` followed by a Prisma Client regeneration.

If it reports data loss on an unrelated table, **stop** — another checkout has diverged the shared local database. Do not accept the prompt.

- [ ] **Step 4: Write the integration test**

Create `src/lib/bring/schema.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { db } from '@/lib/db'

// See "Test data convention" in the Global Constraints. Both of these are
// unique to THIS file: test files run in parallel against one database, so a
// tag shared with another delivery suite would have them deleting each other's
// fixtures mid-assertion.
const TAG = '[delivery-schema-test]'
const TRACK = 'TSCHEMA' // every tracking number this suite creates starts with it

let seq = 0
const trackingNumber = () => `${TRACK}${Date.now()}${seq++}`

async function makeShop() {
  return db.shop.create({ data: { name: `Schema ${TAG}`, currency: 'NOK' } })
}

async function cleanup() {
  // Events first: they hang off shipments, and the tag reaches them only
  // through a shipment that still exists.
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: TRACK } } } })
  // By prefix, not by `orderId: null` — an unlinked parcel belongs to no shop,
  // so `orderId: null` would delete another file's parcels too.
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.orderItem.deleteMany({ where: { order: { shop: { name: { contains: TAG } } } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

describe('delivery schema', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  it('holds a shipment with no order, so a parcel can arrive before its link', async () => {
    const s = await db.shipment.create({ data: { trackingNumber: trackingNumber() } })
    expect(s.orderId).toBeNull()
    expect(s.terminal).toBe(false)
    expect(s.carrier).toBe('BRING')
  })

  it('refuses two shipments with the same tracking number', async () => {
    const n = trackingNumber()
    await db.shipment.create({ data: { trackingNumber: n } })
    await expect(db.shipment.create({ data: { trackingNumber: n } })).rejects.toThrow()
  })

  it('refuses a duplicate event, which is what makes re-ingest a no-op', async () => {
    const s = await db.shipment.create({ data: { trackingNumber: trackingNumber() } })
    const at = new Date('2026-08-01T10:00:00Z')
    await db.shipmentEvent.create({ data: { shipmentId: s.id, status: 'HANDED_IN', occurredAt: at } })
    await expect(
      db.shipmentEvent.create({ data: { shipmentId: s.id, status: 'HANDED_IN', occurredAt: at } }),
    ).rejects.toThrow()
  })

  it('keeps the parcel when its order is deleted, rather than losing the record', async () => {
    const shop = await makeShop()
    const order = await db.order.create({
      data: {
        shopId: shop.id, externalId: `E${Date.now()}`, number: '1001',
        placedAt: new Date(), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })
    const s = await db.shipment.create({
      data: { trackingNumber: trackingNumber(), orderId: order.id, linkSource: 'FILE' },
    })
    await db.order.delete({ where: { id: order.id } })
    expect((await db.shipment.findUnique({ where: { id: s.id } }))?.orderId).toBeNull()
  })

  it('defaults a shop to untracked', async () => {
    expect((await makeShop()).deliveryTrackingFrom).toBeNull()
  })
})
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/lib/bring/schema.integration.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/bring-delivery-tracking
git add prisma/schema.prisma src/lib/bring/schema.integration.test.ts
git commit -m "feat: schema for shipments, delivery promises and tracking imports"
```

---

### Task 2: Destination country on orders

**Files:**
- Modify: `src/lib/woo/map.ts`
- Modify: `src/lib/woo/sync.ts` (`storeOrder` data block; `backfillCustomers` at ~line 337)
- Test: `src/lib/woo/map.test.ts` (existing file, add cases)

**Interfaces:**
- Consumes: `Order.shippingCountry` from Task 1.
- Produces: `MappedOrder.shippingCountry: string` — `''` when the store has none, never null. `backfillDelivery(shopId, creds): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/woo/map.test.ts`:

```ts
it('takes the destination country from the shipping address', () => {
  const o = mapOrder({
    ...baseOrder,
    shipping: { country: 'SE' },
  } as never)
  expect(o.shippingCountry).toBe('SE')
})

it('falls back to the billing country when there is no shipping address', () => {
  const o = mapOrder({ ...baseOrder, billing: { country: 'DK' } } as never)
  expect(o.shippingCountry).toBe('DK')
})

it('reports an empty string, never null, when the store has no country at all', () => {
  const o = mapOrder(baseOrder as never)
  expect(o.shippingCountry).toBe('')
})

it('uppercases the country so DE and de never split a report in two', () => {
  const o = mapOrder({ ...baseOrder, shipping: { country: 'de' } } as never)
  expect(o.shippingCountry).toBe('DE')
})
```

If `baseOrder` does not already exist in that file, define it from the existing tests' fixture object.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/woo/map.test.ts`
Expected: FAIL, `shippingCountry` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/woo/map.ts`, extend the `WooOrder` type:

```ts
  billing?: { first_name?: string; last_name?: string; email?: string; country?: string }
  shipping?: { country?: string }
```

Add to `MappedOrder`, next to `customerEmail`:

```ts
  // ISO-2, uppercased. '' when the store has none on file — never null, so a
  // synced order counts as "country checked" and the backfill knows it is done.
  shippingCountry: string
```

And in the returned object of `mapOrder`, after `customerEmail`:

```ts
    // Shipping first: it is where the parcel actually goes, which is what the
    // delivery promise is about. Billing is the fallback for stores that only
    // collect one address.
    shippingCountry: (woo.shipping?.country || woo.billing?.country || '').trim().toUpperCase(),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/woo/map.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Store it**

In `src/lib/woo/sync.ts`, inside `storeOrder`, add to the `data` object after `customerEmail`:

```ts
    shippingCountry: o.shippingCountry,
```

- [ ] **Step 6: Add the backfill**

In `src/lib/woo/sync.ts`, directly below `backfillCustomers`, add its sibling. It is a separate function rather than a widened `backfillCustomers` because the two queues drain independently — history already has its customers filled, and reusing that queue would backfill nothing.

```ts
/**
 * Fill in the destination country on orders synced before it was stored. Same
 * shape as backfillCustomers: targets exactly the orders where the field is
 * still null, newest first, asks Woo for those ids only, and writes nothing
 * else. An order Woo no longer has is marked '' — checked, nothing there — so
 * the queue only ever shrinks and this costs zero once history is filled.
 */
export async function backfillDelivery(shopId: string, creds: WooCredentials): Promise<number> {
  const missing = await db.order.findMany({
    where: { shopId, shippingCountry: null },
    orderBy: { placedAt: 'desc' },
    take: CUSTOMER_BACKFILL_BATCH,
    select: { id: true, externalId: true },
  })
  if (missing.length === 0) return 0

  const fetched = new Map<string, WooOrder>()
  for (const raw of await fetchOrdersByIds(creds, missing.map((m) => m.externalId))) {
    fetched.set(String(raw.id), raw)
  }

  for (const m of missing) {
    const raw = fetched.get(m.externalId)
    await db.order.update({
      where: { id: m.id },
      data: { shippingCountry: raw ? mapOrder(raw).shippingCountry : '' },
    })
  }
  return missing.length
}
```

Then call it inside `syncShop`, in the best-effort block, immediately after the existing `backfillCustomers` try/catch:

```ts
      // Best-effort: orders from before the country was stored get theirs filled.
      try {
        await backfillDelivery(shop.id, creds)
      } catch {
        // The queue is durable — whatever is left fills on the next sync.
      }
```

- [ ] **Step 7: Run the full suite**

Run: `npm run test`
Expected: all pass. `src/lib/woo/sync.test.ts` must be green without edits — this change adds a field, it does not alter behaviour.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/woo/map.ts src/lib/woo/map.test.ts src/lib/woo/sync.ts
git commit -m "feat: store the destination country on orders, and backfill history"
```

---

### Task 3: Bring HTTP client

**Files:**
- Create: `src/lib/bring/client.ts`
- Test: `src/lib/bring/client.test.ts`

**Interfaces:**
- Consumes: nothing. Every test here stubs `fetch`, so this task needs no credentials and no recorded response.
- Produces:
  ```ts
  export type BringCredentials = { uid: string; key: string; clientUrl: string }
  export function fetchTracking(
    creds: BringCredentials,
    numbers: string[],
    opts?: { deadline?: number; requestTimeoutMs?: number },
  ): Promise<unknown[]>   // one raw consignmentSet entry per number that came back
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/bring/client.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchTracking, requestBudgetMs } from './client'

const creds = { uid: 'ops@example.com', key: 'secret-key', clientUrl: 'https://panetti.vercel.app' }

afterEach(() => vi.unstubAllGlobals())

function stub(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('fetchTracking', () => {
  it('sends the three Mybring headers', async () => {
    const fn = stub(200, { consignmentSet: [] })
    await fetchTracking(creds, ['123'])
    const headers = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['X-Mybring-API-Uid']).toBe('ops@example.com')
    expect(headers['X-Mybring-API-Key']).toBe('secret-key')
    expect(headers['X-Bring-Client-URL']).toBe('https://panetti.vercel.app')
  })

  it('asks for every number in one request', async () => {
    const fn = stub(200, { consignmentSet: [] })
    await fetchTracking(creds, ['A', 'B'])
    expect(fn).toHaveBeenCalledTimes(1)
    expect(String(fn.mock.calls[0][0])).toContain('q=A&q=B')
  })

  it('returns the consignments Bring sent back', async () => {
    stub(200, { consignmentSet: [{ consignmentId: 'A' }, { consignmentId: 'B' }] })
    expect(await fetchTracking(creds, ['A', 'B'])).toHaveLength(2)
  })

  it('treats no consignmentSet as nothing found, not as a crash', async () => {
    stub(200, {})
    expect(await fetchTracking(creds, ['A'])).toEqual([])
  })

  it('truncates a huge error body, so no HTML page reaches a log or a toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5000), { status: 500 })))
    await expect(fetchTracking(creds, ['A'])).rejects.toThrow(/Bring responded 500/)
    await expect(fetchTracking(creds, ['A'])).rejects.toSatisfy(
      (e: Error) => e.message.length < 400,
    )
  })

  it('never asks for longer than the deadline leaves', () => {
    const now = 1_000_000
    expect(requestBudgetMs({ deadline: now + 5_000 }, now)).toBe(5_000)
    expect(requestBudgetMs({ deadline: now + 90_000 }, now)).toBe(30_000)
    // An expired budget is still a valid timeout; the caller's loop is what stops.
    expect(requestBudgetMs({ deadline: now - 1 }, now)).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/bring/client.test.ts`
Expected: FAIL, cannot resolve `./client`.

- [ ] **Step 3: Implement**

Create `src/lib/bring/client.ts`:

```ts
/**
 * Bring's Tracking API, over HTTP.
 *
 * Deliberately the same shape as src/lib/woo/client.ts: a hard request ceiling,
 * a budget clamped to whatever is left of the caller's deadline, and error
 * bodies truncated so a gateway's HTML error page never reaches a log line.
 *
 * Parcels here are booked under the WAREHOUSE's Bring customer number, not the
 * client's. The credentials identify the caller; they do not scope which
 * parcels may be read. That is the assumption the Phase 0 probe exists to
 * confirm, and everything downstream depends on it.
 */

const BASE = 'https://api.bring.com/tracking/api/v2/tracking.json'

/** No poll gets longer than this for one request, deadline or not. */
const REQUEST_TIMEOUT_MS = 30_000

export type BringCredentials = {
  uid: string // Mybring account email
  key: string // Mybring API key
  clientUrl: string // sent as X-Bring-Client-URL, per Bring's terms
}

export type BringFilter = { deadline?: number; requestTimeoutMs?: number }

/**
 * What one request is allowed. The ceiling, or whatever is left of the run,
 * whichever is smaller. Never below 1ms: an expired budget still has to be a
 * valid timeout, and it is the caller's loop that stops, not this.
 */
export function requestBudgetMs(filter: BringFilter, now = Date.now()): number {
  const ceiling = filter.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const left = filter.deadline === undefined ? ceiling : filter.deadline - now
  return Math.max(1, Math.min(ceiling, left))
}

async function bringError(res: Response): Promise<Error> {
  const text = (await res.text()).slice(0, 300)
  return new Error(`Bring responded ${res.status}: ${text}`)
}

/**
 * Track several parcels in one request. Returns the raw consignment entries,
 * unparsed — mapping is map.ts's job, and keeping them apart is what lets the
 * mapper be tested against a recorded fixture with no network at all.
 *
 * A number Bring does not know simply does not come back. The caller decides
 * what that means; it is not an error.
 */
export async function fetchTracking(
  creds: BringCredentials,
  numbers: string[],
  opts: BringFilter = {},
): Promise<unknown[]> {
  if (numbers.length === 0) return []

  const params = new URLSearchParams()
  for (const n of numbers) params.append('q', n)

  const res = await fetch(`${BASE}?${params}`, {
    headers: {
      'X-Mybring-API-Uid': creds.uid,
      'X-Mybring-API-Key': creds.key,
      'X-Bring-Client-URL': creds.clientUrl,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(requestBudgetMs(opts)),
  })

  if (!res.ok) throw await bringError(res)

  const body = (await res.json()) as { consignmentSet?: unknown[] }
  return body.consignmentSet ?? []
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/bring/client.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/bring/client.ts src/lib/bring/client.test.ts
git commit -m "feat: Bring tracking API client"
```

---

### Task 4: Events and milestones

This is the task carrying the most judgement. Read the spec's "The clock" section before starting.

**Files:**
- Create: `src/lib/bring/map.ts`
- Test: `src/lib/bring/map.test.ts`
- Fixture: `src/lib/bring/__fixtures__/real-package.json` (from Phase 0)

**Interfaces:**
- Consumes: raw consignment entries from `fetchTracking`.
- Produces:
  ```ts
  export type MappedEvent = { status: string; occurredAt: Date; description: string | null; location: string | null }
  export type Milestones = {
    bookedAt: Date | null
    handedInAt: Date | null
    availableAt: Date | null
    collectedAt: Date | null
    outcome: 'DELIVERED' | 'RETURNED' | 'CANCELLED' | null
    lastStatus: string | null
  }
  export type MappedPackage = { trackingNumber: string; events: MappedEvent[]; milestones: Milestones }
  export function mapConsignments(raw: unknown[]): MappedPackage[]
  export function milestonesFrom(events: MappedEvent[]): Milestones
  ```

- [ ] **Step 1: Note which field names you are building against, and why they are provisional**

`src/bring/__fixtures__/real-package.json` **does not exist** — the Phase 0 probe has not run, because the client has not yet supplied a warehouse-booked tracking number. Build against Bring's *documented* shape: `consignmentSet[].packageSet[].eventSet[]`, with packages carrying `packageNumber` and events carrying `status`, `description`, `dateIso`, `city`, `countryCode`.

Every other test in this task is synthetic and proves the milestone logic properly, which is the part carrying real judgement. Only the last test needs the recording.

**Write that one as `it.skip(...)`**, with a comment naming the missing fixture and stating that it must be enabled — and its selectors re-checked against reality — the moment the probe runs. Do not invent a fixture and do not delete the test.

When the real response does arrive: **the recording wins over the documentation.** Adjust the selectors in `mapConsignments` to match what Bring actually sent, and say so in the commit message.

- [ ] **Step 2: Write the failing test**

Create `src/lib/bring/map.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mapConsignments, milestonesFrom, type MappedEvent } from './map'

const ev = (status: string, iso: string): MappedEvent => ({
  status, occurredAt: new Date(iso), description: null, location: null,
})

const consignment = (packageNumber: string, events: { status: string; dateIso: string }[]) => ({
  packageSet: [{ packageNumber, eventSet: events }],
})

describe('milestonesFrom', () => {
  it('reads a pickup-point parcel: available on READY_FOR_PICKUP, collected later', () => {
    const m = milestonesFrom([
      ev('PRE_NOTIFIED', '2026-08-01T08:00:00Z'),
      ev('HANDED_IN', '2026-08-01T16:00:00Z'),
      ev('IN_TRANSIT', '2026-08-02T06:00:00Z'),
      ev('READY_FOR_PICKUP', '2026-08-03T09:00:00Z'),
      ev('COLLECTED', '2026-08-07T17:00:00Z'),
    ])
    expect(m.bookedAt).toEqual(new Date('2026-08-01T08:00:00Z'))
    expect(m.handedInAt).toEqual(new Date('2026-08-01T16:00:00Z'))
    expect(m.availableAt).toEqual(new Date('2026-08-03T09:00:00Z'))
    expect(m.collectedAt).toEqual(new Date('2026-08-07T17:00:00Z'))
    expect(m.outcome).toBe('DELIVERED')
  })

  it('does not move availableAt when the customer finally collects', () => {
    const withoutCollection = milestonesFrom([ev('READY_FOR_PICKUP', '2026-08-03T09:00:00Z')])
    const withCollection = milestonesFrom([
      ev('READY_FOR_PICKUP', '2026-08-03T09:00:00Z'),
      ev('COLLECTED', '2026-08-09T12:00:00Z'),
    ])
    expect(withCollection.availableAt).toEqual(withoutCollection.availableAt)
  })

  it('reads a home delivery: DELIVERED sets both available and collected', () => {
    const m = milestonesFrom([
      ev('HANDED_IN', '2026-08-01T16:00:00Z'),
      ev('DELIVERED', '2026-08-04T11:00:00Z'),
    ])
    expect(m.availableAt).toEqual(new Date('2026-08-04T11:00:00Z'))
    expect(m.collectedAt).toEqual(new Date('2026-08-04T11:00:00Z'))
    expect(m.outcome).toBe('DELIVERED')
  })

  it('never marks a returned parcel available, so it cannot count as delivered', () => {
    const m = milestonesFrom([
      ev('HANDED_IN', '2026-08-01T16:00:00Z'),
      ev('RETURN', '2026-08-06T10:00:00Z'),
      ev('DELIVERED_SENDER', '2026-08-08T10:00:00Z'),
    ])
    expect(m.availableAt).toBeNull()
    expect(m.outcome).toBe('RETURNED')
  })

  it('marks a cancelled delivery cancelled, not returned', () => {
    expect(milestonesFrom([ev('DELIVERY_CANCELLED', '2026-08-06T10:00:00Z')]).outcome)
      .toBe('CANCELLED')
  })

  it('leaves outcome null while the parcel is still moving', () => {
    expect(milestonesFrom([ev('IN_TRANSIT', '2026-08-02T06:00:00Z')]).outcome).toBeNull()
  })

  it('takes the earliest of a repeated milestone, not the latest', () => {
    const m = milestonesFrom([
      ev('READY_FOR_PICKUP', '2026-08-05T09:00:00Z'),
      ev('READY_FOR_PICKUP', '2026-08-03T09:00:00Z'),
    ])
    expect(m.availableAt).toEqual(new Date('2026-08-03T09:00:00Z'))
  })

  it('reports the latest event as lastStatus whatever order they arrived in', () => {
    expect(milestonesFrom([
      ev('IN_TRANSIT', '2026-08-05T09:00:00Z'),
      ev('HANDED_IN', '2026-08-01T09:00:00Z'),
    ]).lastStatus).toBe('IN_TRANSIT')
  })

  it('has no milestones and no status at all when nothing has happened', () => {
    const m = milestonesFrom([])
    expect(m).toEqual({
      bookedAt: null, handedInAt: null, availableAt: null,
      collectedAt: null, outcome: null, lastStatus: null,
    })
  })
})

describe('mapConsignments', () => {
  it('pulls one package per parcel with its events', () => {
    const [p] = mapConsignments([
      consignment('370000000001', [
        { status: 'HANDED_IN', dateIso: '2026-08-01T18:00:00+02:00' },
        { status: 'DELIVERED', dateIso: '2026-08-04T13:00:00+02:00' },
      ]),
    ])
    expect(p.trackingNumber).toBe('370000000001')
    expect(p.events).toHaveLength(2)
    expect(p.milestones.availableAt).toEqual(new Date('2026-08-04T11:00:00Z'))
  })

  it('skips an event with no usable timestamp rather than storing an Invalid Date', () => {
    const [p] = mapConsignments([
      consignment('370000000002', [
        { status: 'HANDED_IN', dateIso: 'not a date' },
        { status: 'DELIVERED', dateIso: '2026-08-04T13:00:00+02:00' },
      ]),
    ])
    expect(p.events).toHaveLength(1)
    expect(p.milestones.handedInAt).toBeNull()
  })

  it('survives junk without throwing, because a malformed reply must not stop the run', () => {
    expect(mapConsignments([null, {}, { packageSet: null }, { packageSet: [{}] }])).toEqual([])
  })

  // SKIPPED: needs src/lib/bring/__fixtures__/real-package.json, which does not
  // exist yet — the Phase 0 probe is blocked on the client supplying a
  // warehouse-booked tracking number. Everything above is synthetic and proves
  // the milestone rules; this is the only test that would prove our field
  // SELECTORS match what Bring actually sends. Enable it the moment the probe
  // runs, and treat the recording as authoritative over Bring's documentation.
  it.skip('maps the recorded real response', async () => {
    const real = (await import('./__fixtures__/real-package.json')).default as unknown
    const mapped = mapConsignments([real].flat())
    expect(mapped.length).toBeGreaterThan(0)
    expect(mapped[0].trackingNumber).toBeTruthy()
    expect(mapped[0].events.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Implement**

Create `src/lib/bring/map.ts`:

```ts
/**
 * Bring's tracking JSON into our own shape, and events into milestones.
 *
 * Pure: no database, no network. Every rule about WHEN a parcel counts as
 * delivered lives here and nowhere else.
 */

export type MappedEvent = {
  status: string
  occurredAt: Date
  description: string | null
  location: string | null
}

export type Milestones = {
  bookedAt: Date | null
  handedInAt: Date | null
  availableAt: Date | null
  collectedAt: Date | null
  outcome: 'DELIVERED' | 'RETURNED' | 'CANCELLED' | null
  lastStatus: string | null
}

export type MappedPackage = {
  trackingNumber: string
  events: MappedEvent[]
  milestones: Milestones
}

/**
 * The parcel is with the customer's chosen collection point, or in their hands.
 * This is THE clock stop: the moment the company's obligation ends.
 *
 * READY_FOR_PICKUP counts because in the Nordics a large share of parcels wait
 * at a pickup point for days, and Bring only reports DELIVERED on collection.
 * Judging against collection would raise alerts about customers who took a week
 * to walk to the shop.
 */
const AVAILABLE = new Set(['READY_FOR_PICKUP', 'DELIVERED'])

/** In the customer's hands. Recorded and shown, never judged against a promise. */
const COLLECTED = new Set(['DELIVERED', 'COLLECTED'])

/** Going back. Such a parcel is never available, and never counts as delivered. */
const RETURNED = new Set(['RETURN', 'DELIVERED_SENDER'])

const CANCELLED = new Set(['DELIVERY_CANCELLED'])

const first = (events: MappedEvent[], match: (s: string) => boolean): Date | null => {
  const hits = events.filter((e) => match(e.status)).map((e) => e.occurredAt.getTime())
  // Earliest, not latest: a milestone restated later did not happen later.
  return hits.length ? new Date(Math.min(...hits)) : null
}

export function milestonesFrom(events: MappedEvent[]): Milestones {
  const returned = events.some((e) => RETURNED.has(e.status))
  const cancelled = events.some((e) => CANCELLED.has(e.status))

  // A returned or cancelled parcel never became available to the customer.
  // Without this, a return would sit past its promise forever and the late list
  // would only ever grow.
  const availableAt = returned || cancelled ? null : first(events, (s) => AVAILABLE.has(s))

  const latest = events.reduce<MappedEvent | null>(
    (best, e) => (!best || e.occurredAt > best.occurredAt ? e : best),
    null,
  )

  return {
    bookedAt: first(events, (s) => s === 'PRE_NOTIFIED'),
    handedInAt: first(events, (s) => s === 'HANDED_IN'),
    availableAt,
    collectedAt: returned || cancelled ? null : first(events, (s) => COLLECTED.has(s)),
    outcome: returned ? 'RETURNED' : cancelled ? 'CANCELLED' : availableAt ? 'DELIVERED' : null,
    lastStatus: latest?.status ?? null,
  }
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/** Defensive throughout: a malformed reply must degrade, never stop the run. */
export function mapConsignments(raw: unknown[]): MappedPackage[] {
  const out: MappedPackage[] = []

  for (const consignment of raw) {
    const packages = (consignment as { packageSet?: unknown })?.packageSet
    if (!Array.isArray(packages)) continue

    for (const pkg of packages) {
      const p = pkg as { packageNumber?: unknown; eventSet?: unknown }
      const trackingNumber = str(p?.packageNumber)
      if (!trackingNumber) continue

      const events: MappedEvent[] = []
      for (const e of Array.isArray(p.eventSet) ? p.eventSet : []) {
        const raw = e as {
          status?: unknown; dateIso?: unknown; description?: unknown
          city?: unknown; countryCode?: unknown
        }
        const status = str(raw?.status)
        const iso = str(raw?.dateIso)
        if (!status || !iso) continue

        const occurredAt = new Date(iso)
        // An Invalid Date is truthy and would reach Prisma as a null column or
        // a throw. Drop the event instead: a missing event is honest, a wrong
        // timestamp is not.
        if (Number.isNaN(occurredAt.getTime())) continue

        events.push({
          status,
          occurredAt,
          description: str(raw?.description),
          location: [str(raw?.city), str(raw?.countryCode)].filter(Boolean).join(', ') || null,
        })
      }

      out.push({ trackingNumber, events, milestones: milestonesFrom(events) })
    }
  }

  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/bring/map.test.ts`
Expected: 13 passed. If the fixture test fails on selectors, fix the selectors in `mapConsignments`, not the fixture.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/bring/map.ts src/lib/bring/map.test.ts src/lib/bring/__fixtures__/
git commit -m "feat: map Bring events to milestones, stopping the clock at availability"
```

---

### Task 5: Read the warehouse PDF

The client's warehouse sends a **PDF** containing order name and tracking number. That is the file this feature runs on, so it is built first and built properly.

The layout is unknown and will change without warning, so the extractor does not
parse a table. It finds the order numbers **we already hold in the database** and
pairs each with the nearest tracking-number-shaped token. That way we never have
to know their column order, their headings, or their order-number format.

**Files:**
- Create: `src/lib/bring/pdf.ts`
- Create: `src/lib/bring/parse.ts`
- Test: `src/lib/bring/parse.test.ts`
- Fixture: `src/lib/bring/__fixtures__/warehouse.pdf` (a real file from the client)
- Modify: `package.json`, `next.config.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type ParsedRow = { orderNumber: string; trackingNumber: string }
  export function extractPairs(text: string, knownOrderNumbers: Set<string>): ParsedRow[]
  export function looksLikeTracking(token: string): boolean
  export function pdfToText(buf: Buffer): Promise<string>          // pdf.ts
  export function parseTrackingFile(
    buf: Buffer, filename: string, knownOrderNumbers: Set<string>,
  ): Promise<ParsedRow[]>
  ```

- [ ] **Step 1: Install the PDF reader**

Run: `npm install unpdf`

`unpdf` is a serverless-targeted build of pdf.js with no native canvas dependency, which is what makes it work on Vercel. Do **not** use `pdf-parse`: its entry point reads a bundled test file at import time and breaks in a Next.js build.

Then add to `next.config.ts`, inside the config object:

```ts
  // unpdf ships its own pdf.js build; bundling it breaks the worker resolution.
  serverExternalPackages: ['unpdf'],
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/bring/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { extractPairs, looksLikeTracking, parseTrackingFile } from './parse'

const known = new Set(['1001', '1002', '1003', 'PAN-2201'])

describe('looksLikeTracking', () => {
  it('accepts a Bring package number', () => {
    expect(looksLikeTracking('370724403790000123')).toBe(true)
  })

  it('rejects a short order number, which is the whole point', () => {
    expect(looksLikeTracking('1001')).toBe(false)
  })

  it('rejects a date and a price, which appear on every one of these documents', () => {
    expect(looksLikeTracking('2026-08-04')).toBe(false)
    expect(looksLikeTracking('1.234,00')).toBe(false)
  })

  it('rejects a word', () => {
    expect(looksLikeTracking('Sendingsnummer')).toBe(false)
  })
})

describe('extractPairs', () => {
  it('pairs each known order number with the nearest tracking-shaped token', () => {
    const text = `
      Ordre   Sendingsnummer
      1001    370724403790000123
      1002    370724403790000124
    `
    expect(extractPairs(text, known)).toEqual([
      { orderNumber: '1001', trackingNumber: '370724403790000123' },
      { orderNumber: '1002', trackingNumber: '370724403790000124' },
    ])
  })

  it('reads the columns the other way round, because the layout is theirs not ours', () => {
    const text = `370724403790000123  1001\n370724403790000124  1002`
    expect(extractPairs(text, known)).toEqual([
      { orderNumber: '1001', trackingNumber: '370724403790000123' },
      { orderNumber: '1002', trackingNumber: '370724403790000124' },
    ])
  })

  it('survives extra columns of noise between the two', () => {
    const text = `1001  Oslo  2026-08-04  1.234,00  370724403790000123`
    expect(extractPairs(text, known)).toEqual([
      { orderNumber: '1001', trackingNumber: '370724403790000123' },
    ])
  })

  it('handles a non-numeric order number', () => {
    expect(extractPairs('PAN-2201 370724403790000199', known)).toEqual([
      { orderNumber: 'PAN-2201', trackingNumber: '370724403790000199' },
    ])
  })

  it('ignores an order number we do not hold, rather than inventing a link', () => {
    expect(extractPairs('9999 370724403790000123', known)).toEqual([])
  })

  it('ignores an order number with no tracking number anywhere near it', () => {
    expect(extractPairs('1001 Ordre mottatt', known)).toEqual([])
  })

  it('never gives one tracking number to two orders', () => {
    const rows = extractPairs('1001 1002 370724403790000123', known)
    expect(rows).toHaveLength(1)
    expect(rows[0].orderNumber).toBe('1002')
  })

  it('returns nothing at all for an empty document, and does not throw', () => {
    expect(extractPairs('', known)).toEqual([])
  })
})

describe('parseTrackingFile', () => {
  it('reads the real warehouse PDF', async () => {
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(new URL('./__fixtures__/warehouse.pdf', import.meta.url))
    // Widen the known set to whatever that document actually contains, then
    // narrow this assertion to the real order numbers once you have seen them.
    const rows = await parseTrackingFile(buf, 'warehouse.pdf', known)
    expect(Array.isArray(rows)).toBe(true)
  })

  it('refuses a file type it cannot read, with a message a human can act on', async () => {
    await expect(parseTrackingFile(Buffer.from('x'), 'notes.docx', known)).rejects.toThrow(
      /Only PDF and CSV/,
    )
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/bring/parse.test.ts`
Expected: FAIL, cannot resolve `./parse`.

- [ ] **Step 4: Implement the PDF reader**

Create `src/lib/bring/pdf.ts`:

```ts
/**
 * PDF bytes into plain text.
 *
 * Its own file so the dependency has exactly one caller: if unpdf ever has to
 * be swapped, nothing but this function changes.
 */
import { extractText, getDocumentProxy } from 'unpdf'

export async function pdfToText(buf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(doc, { mergePages: true })
  return text
}
```

- [ ] **Step 5: Implement the extractor**

Create `src/lib/bring/parse.ts`:

```ts
import { pdfToText } from './pdf'

export type ParsedRow = { orderNumber: string; trackingNumber: string }

/**
 * How many tokens apart an order number and its tracking number may sit and
 * still be considered the same row. Generous enough to step over a date, a
 * city and a price; tight enough that the next row's number is out of reach.
 */
const MAX_TOKEN_DISTANCE = 12

/**
 * Does this token look like a carrier's parcel number?
 *
 * Deliberately loose on format and strict on shape. We do not know every
 * product Bring will ever use, but we do know a parcel number is long, mostly
 * digits, and carries no punctuation — which excludes the dates, prices and
 * postcodes that share a document with it.
 */
export function looksLikeTracking(token: string): boolean {
  if (!/^[A-Z0-9]{8,}$/i.test(token)) return false
  const digits = (token.match(/\d/g) ?? []).length
  return digits >= 8
}

/**
 * Find the order-number/tracking-number pairs in a document's text.
 *
 * The layout is the warehouse's and may change without warning, so this does
 * NOT parse a table. It looks for the order numbers WE ALREADY HOLD, then takes
 * the nearest tracking-shaped token to each. That removes every assumption
 * about column order, headings and order-number format — the things most
 * likely to change — and leaves only the one assumption that cannot: that the
 * two numbers appear near each other.
 *
 * A row that matches nothing is simply absent from the result. The caller
 * reports the shortfall; nothing is invented to fill it.
 */
export function extractPairs(text: string, knownOrderNumbers: Set<string>): ParsedRow[] {
  const tokens = text.split(/\s+/).filter(Boolean)

  const trackingAt = new Map<number, string>()
  tokens.forEach((t, i) => {
    // An order number we hold is never also a tracking number, whatever its shape.
    if (!knownOrderNumbers.has(t) && looksLikeTracking(t)) trackingAt.set(i, t)
  })

  const rows: ParsedRow[] = []
  const claimed = new Set<number>()

  tokens.forEach((token, i) => {
    if (!knownOrderNumbers.has(token)) return

    let bestIndex = -1
    let bestDistance = Infinity
    for (const [j] of trackingAt) {
      if (claimed.has(j)) continue
      const distance = Math.abs(j - i)
      // Ties go to the token that follows, which is the ordinary column layout.
      if (distance < bestDistance || (distance === bestDistance && j > i)) {
        bestDistance = distance
        bestIndex = j
      }
    }

    if (bestIndex === -1 || bestDistance > MAX_TOKEN_DISTANCE) return

    // One parcel belongs to one order. Claiming it stops a second order number
    // on the same line from inheriting the same tracking number.
    claimed.add(bestIndex)
    rows.push({ orderNumber: token, trackingNumber: trackingAt.get(bestIndex)! })
  })

  return rows
}

/**
 * Read whatever the warehouse sent. PDF is what they send today; CSV is
 * accepted too, because it costs nothing here and is far more robust if they
 * ever agree to switch.
 */
export async function parseTrackingFile(
  buf: Buffer,
  filename: string,
  knownOrderNumbers: Set<string>,
): Promise<ParsedRow[]> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''

  if (ext === 'pdf') return extractPairs(await pdfToText(buf), knownOrderNumbers)
  if (ext === 'csv' || ext === 'txt') {
    // The same extractor: commas and semicolons become token boundaries, and
    // everything the PDF path learned about noise applies unchanged.
    return extractPairs(buf.toString('utf8').replace(/[;,]/g, ' '), knownOrderNumbers)
  }

  throw new Error('Only PDF and CSV files can be read. This one is a .' + ext)
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/lib/bring/parse.test.ts`
Expected: 13 passed.

The real-PDF test only asserts that parsing returns an array, because the fixture's contents are unknown when this plan is written. **Once you have the real file, print the result, read it, and tighten that assertion to the actual order numbers.** Leaving it loose is acceptable only until then.

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add package.json package-lock.json next.config.ts src/lib/bring/pdf.ts src/lib/bring/parse.ts src/lib/bring/parse.test.ts src/lib/bring/__fixtures__/
git commit -m "feat: read order and tracking numbers out of the warehouse PDF"
```

#### As-built corrections (found in review, after `a6baedf`)

**The `extractPairs` above is wrong and was not shipped as written.** It iterates order numbers in *document* order and claims the nearest unclaimed token for each, which lets a farther-but-earlier order number steal a closer order's tracking number. It fails two of this task's own tests. The shipped implementation does **global nearest-distance-first** matching: build every (order, token) candidate pair, sort by distance with a deterministic tie-break, then claim greedily. Git is the source of truth for that code; this block is kept only to explain the change.

- [ ] **Step 8: Pin the Node version**

`unpdf` declares `"engines": { "node": ">=22" }`. This repo pins nothing — no `engines` field, no `.nvmrc`, and `vercel.json` sets no runtime — so production runs on whatever Vercel's project default happens to be. A mismatch surfaces as a module failure at request time rather than a failed build, which is the worst place to find it.

Add to `package.json`, as a sibling of `"scripts"`:

```json
  "engines": {
    "node": ">=22"
  },
```

Vercel reads this and selects a matching runtime, or fails the build loudly. Loudly is what we want.

- [ ] **Step 9: Refuse a tracking-shaped token that repeats**

`looksLikeTracking` accepts any 8+ character alphanumeric token carrying 8+ digits. On a real document that also matches an unpunctuated date (`20260804`), an 8-digit phone number, invoice and registration numbers — both verified in review. Because matching is distance-based, a false positive sitting *near* an order number produces a silently **wrong** pairing, not a missing one. A wrong pairing looks like success and poisons that order's delivery figure permanently.

The format cannot be tightened responsibly without a real warehouse PDF, and guessing at lengths would be worse. But one rule is structural rather than format-based and holds regardless of layout: **a parcel number is unique per shipment, while boilerplate repeats.** So a tracking-shaped token appearing more than once in a document is ambiguous, and ambiguity is refused rather than guessed — the same rule Task 6 applies to an order number two shops both hold.

Add the test:

```ts
it('refuses a tracking-shaped token that repeats, because a parcel number is unique', () => {
  // The support number in the footer is 8 digits, so it looks like a parcel
  // number and sits right beside order 1002. Refusing it costs one missing
  // pair, which shows up in the import's unmatched count. Accepting it would
  // silently attach the wrong parcel to 1002 and look like success.
  const text = `
    Kundeservice 21009000
    1001 370724403790000123
    1002 21009000
  `
  expect(extractPairs(text, known)).toEqual([
    { orderNumber: '1001', trackingNumber: '370724403790000123' },
  ])
})
```

Then, in `extractPairs`, after collecting the candidate tracking tokens and before matching, drop every token value that occurs more than once in the document. Keep the existing behaviour for everything else: a row that matches nothing stays absent rather than guessed.

---

### Task 6: Turn pairs into shipments

**Files:**
- Create: `src/lib/bring/link.ts`
- Test: `src/lib/bring/link.integration.test.ts`

**Interfaces:**
- Consumes: `ParsedRow` from Task 5, `Shipment` from Task 1.
- Produces:
  ```ts
  export type UnmatchedRow = ParsedRow & { reason: string }
  export type LinkResult = { linked: number; unmatched: UnmatchedRow[] }
  export function knownOrderNumbers(): Promise<Set<string>>
  export function linkRows(rows: ParsedRow[]): Promise<LinkResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/bring/link.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { db } from '@/lib/db'
import { linkRows } from './link'

let shopA: string
let shopB: string

async function order(shopId: string, number: string) {
  return db.order.create({
    data: {
      shopId, externalId: `${shopId}-${number}`, number,
      placedAt: new Date('2026-08-01T10:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    },
  })
}

// Both unique to THIS file — see "Test data convention" in the Global
// Constraints. Test files run in parallel against one database.
const TAG = '[delivery-link-test]'
const TRACK = 'TLINK' // every tracking number below starts with it
const scoped = { shop: { name: { contains: TAG } } }
const mine = { trackingNumber: { startsWith: TRACK } }

// IMPLEMENTER: the tests below are written with 'T1' and 'T2' for readability.
// Use these two constants instead of those string literals everywhere they
// appear — a bare 'T1' has no prefix, so cleanup() would leave it behind and
// the next run's unique-constraint check would fail against a stale row.
const T1 = `${TRACK}1`
const T2 = `${TRACK}2`

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: mine } })
  // By prefix, not by `orderId: null` — an unlinked parcel belongs to no shop,
  // so `orderId: null` would delete another file's parcels too.
  await db.shipment.deleteMany({ where: mine })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeEach(async () => {
  await cleanup()
  // deliveryTrackingFrom must be set: linkRows only ever matches orders in a
  // delivery-tracked shop, so an untracked fixture links nothing and every
  // assertion below reads zero.
  const tracked = { deliveryTrackingFrom: new Date('2026-01-01') }
  shopA = (await db.shop.create({ data: { name: `A ${TAG}`, currency: 'NOK', ...tracked } })).id
  shopB = (await db.shop.create({ data: { name: `B ${TAG}`, currency: 'SEK', ...tracked } })).id
})

afterAll(cleanup)

describe('linkRows', () => {
  it('links a row to its order and records where the link came from', async () => {
    const o = await order(shopA, '1001')
    const result = await linkRows([{ orderNumber: '1001', trackingNumber: 'T1' }])

    expect(result.linked).toBe(1)
    const s = await db.shipment.findUnique({ where: { trackingNumber: 'T1' } })
    expect(s?.orderId).toBe(o.id)
    expect(s?.linkSource).toBe('FILE')
    // Due for its first poll straight away, so the next cron picks it up.
    expect(s?.nextPollAt).not.toBeNull()
    expect(s?.terminal).toBe(false)
  })

  it('refuses an order number two shops both hold, rather than guessing', async () => {
    await order(shopA, '1001')
    await order(shopB, '1001')

    const result = await linkRows([{ orderNumber: '1001', trackingNumber: 'T1' }])
    expect(result.linked).toBe(0)
    expect(result.unmatched[0].reason).toMatch(/2 orders/)
    // Nothing is written: a wrong link would poison a delivery figure forever.
    expect(await db.shipment.findUnique({ where: { trackingNumber: 'T1' } })).toBeNull()
  })

  it('reports an order number we do not hold', async () => {
    const result = await linkRows([{ orderNumber: '9999', trackingNumber: 'T1' }])
    expect(result.linked).toBe(0)
    expect(result.unmatched[0].reason).toMatch(/No order/)
  })

  it('is idempotent, so re-importing yesterday duplicates nothing', async () => {
    await order(shopA, '1001')
    await linkRows([{ orderNumber: '1001', trackingNumber: 'T1' }])
    await linkRows([{ orderNumber: '1001', trackingNumber: 'T1' }])
    expect(await db.shipment.count({ where: { trackingNumber: 'T1' } })).toBe(1)
  })

  it('adopts a parcel that arrived before its link, without resetting its progress', async () => {
    const o = await order(shopA, '1001')
    await db.shipment.create({
      data: {
        trackingNumber: 'T1', lastStatus: 'IN_TRANSIT',
        handedInAt: new Date('2026-08-01T16:00:00Z'), terminal: false,
      },
    })

    await linkRows([{ orderNumber: '1001', trackingNumber: 'T1' }])

    const s = await db.shipment.findUnique({ where: { trackingNumber: 'T1' } })
    expect(s?.orderId).toBe(o.id)
    expect(s?.handedInAt).toEqual(new Date('2026-08-01T16:00:00Z'))
    expect(s?.lastStatus).toBe('IN_TRANSIT')
  })

  it('lets one order carry several parcels', async () => {
    const o = await order(shopA, '1001')
    await linkRows([
      { orderNumber: '1001', trackingNumber: 'T1' },
      { orderNumber: '1001', trackingNumber: 'T2' },
    ])
    expect(await db.shipment.count({ where: { orderId: o.id } })).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/bring/link.integration.test.ts`
Expected: FAIL, cannot resolve `./link`.

- [ ] **Step 3: Implement**

Create `src/lib/bring/link.ts`:

```ts
import { db } from '../db'
import type { ParsedRow } from './parse'

export type UnmatchedRow = ParsedRow & { reason: string }
export type LinkResult = { linked: number; unmatched: UnmatchedRow[] }

/**
 * Every order number we hold, for the extractor to match the document against.
 * Only shops that are delivery-tracked: a shop shipping from somewhere else has
 * no business claiming a parcel out of this warehouse's file.
 */
export async function knownOrderNumbers(): Promise<Set<string>> {
  const rows = await db.order.findMany({
    where: { shop: { deliveryTrackingFrom: { not: null } } },
    select: { number: true },
  })
  return new Set(rows.map((r) => r.number))
}

/**
 * Write one Shipment per pair.
 *
 * Order.number is NOT unique across shops — the only uniqueness on Order is
 * [shopId, externalId]. So a number two shops both hold is ambiguous, and we
 * refuse it rather than guess: a wrong link would poison that order's delivery
 * figure permanently, and unlike a missing link nobody would ever notice.
 *
 * An existing parcel is adopted, never rebuilt. A shipment that has been
 * tracked for days before its file arrives keeps every milestone it earned.
 */
export async function linkRows(rows: ParsedRow[]): Promise<LinkResult> {
  const unmatched: UnmatchedRow[] = []
  let linked = 0

  for (const row of rows) {
    const orders = await db.order.findMany({
      where: { number: row.orderNumber, shop: { deliveryTrackingFrom: { not: null } } },
      select: { id: true },
      take: 2, // one is enough to link, two is enough to refuse
    })

    if (orders.length === 0) {
      unmatched.push({ ...row, reason: `No order numbered ${row.orderNumber}` })
      continue
    }
    if (orders.length > 1) {
      unmatched.push({
        ...row,
        reason: `Order number ${row.orderNumber} matched 2 orders in different shops`,
      })
      continue
    }

    await db.shipment.upsert({
      where: { trackingNumber: row.trackingNumber },
      // Due immediately, so the next cron run picks it up.
      create: {
        trackingNumber: row.trackingNumber,
        orderId: orders[0].id,
        linkSource: 'FILE',
        nextPollAt: new Date(),
      },
      // Only the link. Milestones, events and poll state are the sync's to own,
      // and a re-import must not undo a week of tracking.
      update: { orderId: orders[0].id, linkSource: 'FILE' },
    })
    linked++
  }

  return { linked, unmatched }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/bring/link.integration.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/bring/link.ts src/lib/bring/link.integration.test.ts
git commit -m "feat: link warehouse file rows to orders, refusing ambiguous numbers"
```

---

### Task 7: Import endpoint and upload box

**Files:**
- Create: `src/lib/bring/import.ts`
- Create: `src/app/api/delivery/import/route.ts`
- Create: `src/app/delivery/UploadBox.tsx`
- Test: `src/lib/bring/import.integration.test.ts`

**Interfaces:**
- Consumes: `parseTrackingFile`, `knownOrderNumbers`, `linkRows`.
- Produces:
  ```ts
  export type ImportResult = {
    importId: string; parsed: number; linked: number; unmatched: UnmatchedRow[]
  }
  export function importTrackingFile(
    buf: Buffer, filename: string, source: 'UPLOAD' | 'EMAIL',
  ): Promise<ImportResult>
  ```
  `POST /api/delivery/import` accepts `multipart/form-data` with one `file` field and returns `ImportResult`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/bring/import.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { db } from '@/lib/db'
import { importTrackingFile } from './import'

let shopId: string

// Unique to THIS file — see "Test data convention" in the Global Constraints.
const TAG = '[delivery-import-test]'
const scoped = { shop: { name: { contains: TAG } } }

async function cleanup() {
  // Every parcel this suite creates is linked to one of its own tagged orders
  // (they come from the file being imported), so the order scope reaches them
  // all and no tracking-number prefix is needed here.
  await db.shipmentEvent.deleteMany({ where: { shipment: { order: scoped } } })
  await db.shipment.deleteMany({ where: { order: scoped } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  // TrackingImport has no shop to tag and no natural key. Scope by the
  // filenames this suite uses so a parallel file's imports survive.
  await db.trackingImport.deleteMany({ where: { filename: { in: ['today.csv', 'notes.docx'] } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  shopId = (
    await db.shop.create({
      data: { name: `A ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') },
    })
  ).id
  await db.order.create({
    data: {
      shopId, externalId: 'E1', number: '1001',
      placedAt: new Date('2026-08-01T10:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    },
  })
})

const csv = (body: string) => Buffer.from(body, 'utf8')

describe('importTrackingFile', () => {
  it('links what it can and records the run', async () => {
    const r = await importTrackingFile(
      csv('order,tracking\n1001,370724403790000123\n'), 'today.csv', 'UPLOAD',
    )
    expect(r.parsed).toBe(1)
    expect(r.linked).toBe(1)

    const row = await db.trackingImport.findUniqueOrThrow({ where: { id: r.importId } })
    expect(row.filename).toBe('today.csv')
    expect(row.source).toBe('UPLOAD')
    expect(row.rowsLinked).toBe(1)
    expect(row.rowsUnmatched).toBe(0)
  })

  it('records what it could not match, so a shortfall is visible rather than silent', async () => {
    const r = await importTrackingFile(
      csv('1001,370724403790000123\n9999,370724403790000124\n'), 'today.csv', 'UPLOAD',
    )
    expect(r.linked).toBe(1)
    expect(r.unmatched).toHaveLength(1)

    const row = await db.trackingImport.findUniqueOrThrow({ where: { id: r.importId } })
    expect(row.rowsUnmatched).toBe(1)
    expect(JSON.parse(row.unmatched!)[0].orderNumber).toBe('9999')
  })

  it('records a file it could not read at all, instead of losing the attempt', async () => {
    await expect(importTrackingFile(csv('x'), 'notes.docx', 'UPLOAD')).rejects.toThrow()
    const row = await db.trackingImport.findFirst({ orderBy: { receivedAt: 'desc' } })
    expect(row?.error).toMatch(/Only PDF and CSV/)
    expect(row?.rowsParsed).toBe(0)
  })

  it('ignores a shop that is not delivery-tracked', async () => {
    await db.shop.update({ where: { id: shopId }, data: { deliveryTrackingFrom: null } })
    const r = await importTrackingFile(csv('1001,370724403790000123\n'), 'today.csv', 'UPLOAD')
    expect(r.linked).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/bring/import.integration.test.ts`
Expected: FAIL, cannot resolve `./import`.

- [ ] **Step 3: Implement the importer**

Create `src/lib/bring/import.ts`:

```ts
import { db } from '../db'
import { parseTrackingFile } from './parse'
import { knownOrderNumbers, linkRows, type UnmatchedRow } from './link'

export type ImportResult = {
  importId: string
  parsed: number
  linked: number
  unmatched: UnmatchedRow[]
}

/**
 * Read one warehouse file and link what it contains.
 *
 * Every attempt is recorded, successes and failures alike. A file that arrived
 * and could not be read is exactly the event nobody would otherwise notice:
 * linking simply stops, the delivery figures quietly stop growing, and the page
 * looks the same as a quiet day.
 */
export async function importTrackingFile(
  buf: Buffer,
  filename: string,
  source: 'UPLOAD' | 'EMAIL',
): Promise<ImportResult> {
  let rows
  try {
    rows = await parseTrackingFile(buf, filename, await knownOrderNumbers())
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not read this file'
    await db.trackingImport.create({
      data: { filename, source, rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0, error },
    })
    throw e
  }

  const { linked, unmatched } = await linkRows(rows)

  const record = await db.trackingImport.create({
    data: {
      filename,
      source,
      rowsParsed: rows.length,
      rowsLinked: linked,
      rowsUnmatched: unmatched.length,
      unmatched: unmatched.length ? JSON.stringify(unmatched) : null,
    },
  })

  return { importId: record.id, parsed: rows.length, linked, unmatched }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/bring/import.integration.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Add the route**

Create `src/app/api/delivery/import/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { importTrackingFile } from '@/lib/bring/import'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Reading a PDF is not instant, and a big one must not be cut off half-parsed. */
export const maxDuration = 60

/** One warehouse file's worth of tracking numbers. Admin only. */
export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Choose a file first.' }, { status: 400, headers: NO_STORE })
    }

    const result = await importTrackingFile(
      Buffer.from(await file.arrayBuffer()),
      file.name,
      'UPLOAD',
    )
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    // The importer already recorded the failed attempt; this is the human's copy.
    const error = e instanceof Error ? e.message : 'Could not read this file'
    return NextResponse.json({ error }, { status: 400, headers: NO_STORE })
  }
}
```

- [ ] **Step 6: Add the upload box**

Create `src/app/delivery/UploadBox.tsx`:

```tsx
'use client'

import { useState } from 'react'

type Result = { parsed: number; linked: number; unmatched: { orderNumber: string; reason: string }[] }

/**
 * The manual way in. It exists permanently, not as a stopgap: when the
 * warehouse's email does not arrive, this is the fix, and it is the same code
 * path the automatic feed uses.
 */
export function UploadBox({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(file: File) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch('/api/delivery/import', { method: 'POST', body })
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Could not read this file.')
      else {
        setResult(json)
        onImported()
      }
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[12px] border border-line bg-surface p-4">
      <p className="text-[13px] font-semibold text-ink">Tracking file from the warehouse</p>
      <p className="mt-0.5 text-[12px] text-muted">
        PDF or CSV listing order numbers and tracking numbers.
      </p>

      <input
        type="file"
        accept=".pdf,.csv,.txt"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) send(file)
          e.target.value = ''
        }}
        className="mt-3 block text-[12px] text-muted file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-[12px] file:text-ink"
      />

      {busy && <p className="mt-2 text-[12px] text-muted">Reading the file…</p>}

      {result && (
        <p className="mt-2 text-[12px] text-ink">
          Read {result.parsed} rows, linked {result.linked}.
          {result.unmatched.length > 0 && (
            <span className="text-warn">
              {' '}
              {result.unmatched.length} could not be matched: {result.unmatched[0].reason}
              {result.unmatched.length > 1 && `, and ${result.unmatched.length - 1} more`}.
            </span>
          )}
        </p>
      )}

      {error && <p className="mt-2 text-[12px] text-loss">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/bring/import.ts src/lib/bring/import.integration.test.ts src/app/api/delivery/ src/app/delivery/
git commit -m "feat: import a warehouse tracking file, by upload, and record every attempt"
```

---

### Task 8: Polling sync, wired into the cron

**Files:**
- Create: `src/lib/delivery/config.ts`
- Create: `src/lib/bring/sync.ts`
- Modify: `src/app/api/cron/sync/route.ts`
- Test: `src/lib/bring/sync.integration.test.ts`

**Interfaces:**
- Consumes: `fetchTracking`, `mapConsignments`, `Shipment` from Task 1.
- Produces:
  ```ts
  export function getDeliveryConfig(): Promise<{ creds: BringCredentials | null; slackWebhookUrl: string | null }>
  export type ShipmentSyncResult = { polled: number; updated: number; failed: number; error?: string }
  export function syncShipments(opts?: { deadline?: number; now?: Date }): Promise<ShipmentSyncResult>
  export function nextPollFor(m: Milestones, deadline: Date | null, now: Date): { nextPollAt: Date | null; terminal: boolean }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/bring/sync.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { nextPollFor, syncShipments } from './sync'
import type { Milestones } from './map'

const NONE: Milestones = {
  bookedAt: null, handedInAt: null, availableAt: null,
  collectedAt: null, outcome: null, lastStatus: null,
}
const now = new Date('2026-08-05T12:00:00Z')
const HOUR = 60 * 60 * 1000

afterEach(() => vi.unstubAllGlobals())

beforeEach(async () => {
  await db.shipmentEvent.deleteMany()
  await db.shipment.deleteMany()
  await db.deliveryConfig.deleteMany()
  await db.deliveryConfig.create({
    data: {
      id: 'singleton',
      bringApiUid: 'ops@example.com',
      bringApiKey: encryptSecret('k'),
      bringClientUrl: 'https://panetti.vercel.app',
    },
  })
})

describe('nextPollFor', () => {
  it('checks a parcel that has not moved yet only every six hours', () => {
    const r = nextPollFor({ ...NONE, bookedAt: now }, null, now)
    expect(r.terminal).toBe(false)
    expect(r.nextPollAt!.getTime()).toBe(now.getTime() + 6 * HOUR)
  })

  it('checks a parcel in transit every two hours', () => {
    const r = nextPollFor({ ...NONE, handedInAt: now, lastStatus: 'IN_TRANSIT' }, null, now)
    expect(r.nextPollAt!.getTime()).toBe(now.getTime() + 2 * HOUR)
  })

  it('checks a parcel near or past its promise on every run', () => {
    const r = nextPollFor(
      { ...NONE, handedInAt: now, lastStatus: 'IN_TRANSIT' },
      new Date(now.getTime() + 6 * HOUR),
      now,
    )
    expect(r.nextPollAt!.getTime()).toBe(now.getTime())
  })

  it('checks a parcel waiting to be collected once a day', () => {
    const r = nextPollFor({ ...NONE, availableAt: now, lastStatus: 'READY_FOR_PICKUP' }, null, now)
    expect(r.nextPollAt!.getTime()).toBe(now.getTime() + 24 * HOUR)
  })

  it('stops polling a collected parcel', () => {
    const r = nextPollFor({ ...NONE, availableAt: now, collectedAt: now, outcome: 'DELIVERED' }, null, now)
    expect(r.terminal).toBe(true)
    expect(r.nextPollAt).toBeNull()
  })

  it('stops polling a returned parcel, which will never be collected', () => {
    expect(nextPollFor({ ...NONE, outcome: 'RETURNED' }, null, now).terminal).toBe(true)
  })

  it('gives up on a parcel nobody collected after 30 days', () => {
    const old = new Date(now.getTime() - 31 * 24 * HOUR)
    expect(nextPollFor({ ...NONE, availableAt: old }, null, now).terminal).toBe(true)
  })
})

describe('syncShipments', () => {
  function stubBring(consignments: unknown[]) {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ consignmentSet: consignments }), { status: 200 })))
  }

  const consignment = (n: string, events: { status: string; dateIso: string }[]) => ({
    packageSet: [{ packageNumber: n, eventSet: events }],
  })

  it('stores events and milestones for a due parcel', async () => {
    await db.shipment.create({ data: { trackingNumber: 'T1', nextPollAt: new Date('2026-01-01') } })
    stubBring([consignment('T1', [
      { status: 'HANDED_IN', dateIso: '2026-08-01T16:00:00Z' },
      { status: 'DELIVERED', dateIso: '2026-08-04T11:00:00Z' },
    ])])

    const r = await syncShipments({ now })
    expect(r.polled).toBe(1)
    expect(r.updated).toBe(1)

    const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: 'T1' } })
    expect(s.handedInAt).toEqual(new Date('2026-08-01T16:00:00Z'))
    expect(s.availableAt).toEqual(new Date('2026-08-04T11:00:00Z'))
    expect(s.terminal).toBe(true)
    expect(await db.shipmentEvent.count({ where: { shipmentId: s.id } })).toBe(2)
  })

  it('never duplicates an event when the same reply arrives twice', async () => {
    await db.shipment.create({ data: { trackingNumber: 'T1', nextPollAt: new Date('2026-01-01') } })
    const reply = [consignment('T1', [{ status: 'IN_TRANSIT', dateIso: '2026-08-02T06:00:00Z' }])]

    stubBring(reply)
    await syncShipments({ now })
    await db.shipment.update({ where: { trackingNumber: 'T1' }, data: { nextPollAt: new Date('2026-01-01') } })
    stubBring(reply)
    await syncShipments({ now })

    expect(await db.shipmentEvent.count()).toBe(1)
  })

  it('leaves a parcel that is not due yet alone', async () => {
    await db.shipment.create({
      data: { trackingNumber: 'T1', nextPollAt: new Date('2026-09-01') },
    })
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    expect((await syncShipments({ now })).polled).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })

  it('records a number Bring does not know, and stops asking forever', async () => {
    await db.shipment.create({ data: { trackingNumber: 'T1', nextPollAt: new Date('2026-01-01') } })
    stubBring([])
    await syncShipments({ now })
    const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: 'T1' } })
    expect(s.lastError).toMatch(/not know/i)
    // Still due later: the warehouse may not have handed it over yet.
    expect(s.terminal).toBe(false)
    expect(s.nextPollAt).not.toBeNull()
  })

  it('reports itself unconfigured rather than throwing', async () => {
    await db.deliveryConfig.deleteMany()
    await db.shipment.create({ data: { trackingNumber: 'T1', nextPollAt: new Date('2026-01-01') } })
    const r = await syncShipments({ now })
    expect(r.error).toMatch(/not connected/i)
    expect(r.polled).toBe(0)
  })

  it('stops when the deadline passes, leaving the rest for the next run', async () => {
    for (const n of ['T1', 'T2']) {
      await db.shipment.create({ data: { trackingNumber: n, nextPollAt: new Date('2026-01-01') } })
    }
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    const r = await syncShipments({ now, deadline: Date.now() - 1 })
    expect(r.polled).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/bring/sync.integration.test.ts`
Expected: FAIL, cannot resolve `./sync`.

- [ ] **Step 3: Implement the config reader**

Create `src/lib/delivery/config.ts`:

```ts
import { db } from '../db'
import { decryptSecret } from '../secrets'
import type { BringCredentials } from '../bring/client'

/**
 * The delivery integration's credentials, decrypted.
 *
 * Never throws. A missing or unreadable secret returns null, and the caller
 * reports "not connected" — the same visible-failure rule the shop sync uses
 * when AUTH_SECRET has changed under it.
 */
export async function getDeliveryConfig(): Promise<{
  creds: BringCredentials | null
  slackWebhookUrl: string | null
}> {
  const row = await db.deliveryConfig.findUnique({ where: { id: 'singleton' } })
  if (!row) return { creds: null, slackWebhookUrl: null }

  let creds: BringCredentials | null = null
  if (row.bringApiUid && row.bringApiKey && row.bringClientUrl) {
    try {
      creds = {
        uid: row.bringApiUid,
        key: decryptSecret(row.bringApiKey),
        clientUrl: row.bringClientUrl,
      }
    } catch {
      creds = null // AUTH_SECRET changed; the settings page says "reconnect".
    }
  }

  let slackWebhookUrl: string | null = null
  if (row.slackWebhookUrl) {
    try {
      slackWebhookUrl = decryptSecret(row.slackWebhookUrl)
    } catch {
      slackWebhookUrl = null
    }
  }

  return { creds, slackWebhookUrl }
}
```

- [ ] **Step 4: Implement the sync**

Create `src/lib/bring/sync.ts`:

```ts
import { db } from '../db'
import { getDeliveryConfig } from '../delivery/config'
import { fetchTracking } from './client'
import { mapConsignments, type Milestones } from './map'

export type ShipmentSyncResult = {
  polled: number
  updated: number
  failed: number
  error?: string
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** How many parcels go into one request. Bring accepts repeated `q` values. */
const BATCH = 10

/**
 * A parcel sitting at a pickup point this long is not going to be collected.
 * We stop asking rather than poll it forever.
 */
const ABANDONED_AFTER = 30 * DAY

/**
 * When to look at this parcel again.
 *
 * Delivery events happen a handful of times per parcel, so polling everything
 * every fifteen minutes would be tens of thousands of wasted calls a day. The
 * tiers spend the budget where something is actually likely to have changed,
 * and on the parcels somebody is actually waiting for.
 */
export function nextPollFor(
  m: Milestones,
  deadline: Date | null,
  now: Date,
): { nextPollAt: Date | null; terminal: boolean } {
  const stop = { nextPollAt: null, terminal: true }

  // Nothing more will ever happen to these.
  if (m.outcome === 'RETURNED' || m.outcome === 'CANCELLED') return stop
  if (m.collectedAt) return stop

  if (m.availableAt) {
    // Waiting to be collected. We already have the figure that matters; the
    // collection date is a nicety, so once a day, and not forever.
    if (now.getTime() - m.availableAt.getTime() > ABANDONED_AFTER) return stop
    return { nextPollAt: new Date(now.getTime() + DAY), terminal: false }
  }

  // Near or past its promise: this is the parcel someone will ask about, so it
  // gets checked on every run.
  if (deadline && now.getTime() >= deadline.getTime() - DAY) {
    return { nextPollAt: new Date(now.getTime()), terminal: false }
  }

  // Moving.
  if (m.handedInAt) return { nextPollAt: new Date(now.getTime() + 2 * HOUR), terminal: false }

  // Booked but still in the warehouse, or not yet known to Bring at all.
  return { nextPollAt: new Date(now.getTime() + 6 * HOUR), terminal: false }
}

/**
 * Poll every parcel that is due, oldest first.
 *
 * Oldest-first is the same fairness rule syncAllShops gets from ordering by
 * lastRunAt: without it, a run that cannot reach everything starves the same
 * parcels every time.
 *
 * A per-parcel failure is written to its own lastError and never thrown. One
 * dead parcel must not stop the rest — the same rule ads/sync.ts follows for
 * one broken ad account.
 */
export async function syncShipments(
  opts: { deadline?: number; now?: Date } = {},
): Promise<ShipmentSyncResult> {
  const now = opts.now ?? new Date()
  const { creds } = await getDeliveryConfig()
  if (!creds) return { polled: 0, updated: 0, failed: 0, error: 'Bring is not connected.' }

  const due = await db.shipment.findMany({
    where: { terminal: false, nextPollAt: { lte: now } },
    orderBy: { nextPollAt: { sort: 'asc', nulls: 'first' } },
    select: { id: true, trackingNumber: true, orderId: true },
    take: 200,
  })

  let polled = 0
  let updated = 0
  let failed = 0

  for (let i = 0; i < due.length; i += BATCH) {
    // Checked before the request, not after: starting a batch we have no time
    // to finish takes the budget from parcels already further behind.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break

    const batch = due.slice(i, i + BATCH)
    let byNumber: Map<string, ReturnType<typeof mapConsignments>[number]>
    try {
      const raw = await fetchTracking(creds, batch.map((s) => s.trackingNumber), {
        deadline: opts.deadline,
      })
      byNumber = new Map(mapConsignments(raw).map((p) => [p.trackingNumber, p]))
    } catch (e) {
      // The whole batch failed: a network error, a bad key, a rate limit. Record
      // it on each parcel and carry on — the next run retries.
      const error = e instanceof Error ? e.message : 'Tracking lookup failed'
      failed += batch.length
      for (const s of batch) {
        await db.shipment
          .update({
            where: { id: s.id },
            data: { lastError: error, nextPollAt: new Date(now.getTime() + HOUR) },
          })
          .catch(() => {})
      }
      continue
    }

    polled += batch.length

    for (const s of batch) {
      const found = byNumber.get(s.trackingNumber)

      if (!found) {
        // Not an error worth stopping for: the warehouse may have sent us the
        // number before handing the parcel over. Recorded so a number that is
        // simply wrong is visible rather than silently never tracked.
        await db.shipment
          .update({
            where: { id: s.id },
            data: {
              lastError: 'Bring does not know this number yet',
              nextPollAt: new Date(now.getTime() + 6 * HOUR),
            },
          })
          .catch(() => {})
        continue
      }

      const m = found.milestones
      // The deadline needs the order's promise, which Task 9 supplies. Until
      // then every parcel uses the ordinary tiers; wiring it is Task 9 Step 7.
      const { nextPollAt, terminal } = nextPollFor(m, null, now)

      await db.$transaction(async (tx) => {
        // One insert for the whole event set, not one per event: a parcel's
        // history is re-sent in full on every poll, so this runs constantly.
        // skipDuplicates leans on @@unique([shipmentId, status, occurredAt]) —
        // that constraint is what makes re-ingesting a restated history a no-op
        // rather than a pile of duplicates.
        await tx.shipmentEvent.createMany({
          data: found.events.map((e) => ({
            shipmentId: s.id,
            status: e.status,
            occurredAt: e.occurredAt,
            description: e.description,
            location: e.location,
          })),
          skipDuplicates: true,
        })
        await tx.shipment.update({
          where: { id: s.id },
          data: {
            bookedAt: m.bookedAt, handedInAt: m.handedInAt,
            availableAt: m.availableAt, collectedAt: m.collectedAt,
            outcome: m.outcome, lastStatus: m.lastStatus,
            nextPollAt, terminal, lastError: null,
          },
        })
      })
      updated++
    }
  }

  await db.deliveryConfig
    .update({ where: { id: 'singleton' }, data: { lastSyncAt: new Date(), lastError: null } })
    .catch(() => {})

  return { polled, updated, failed }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/bring/sync.integration.test.ts`
Expected: 13 passed.

- [ ] **Step 6: Wire it into the cron**

In `src/app/api/cron/sync/route.ts`, add the import:

```ts
import { syncShipments, type ShipmentSyncResult } from '@/lib/bring/sync'
```

Below `SHOPS_DEADLINE_MS`, add:

```ts
/**
 * Parcel polling gets whatever is left of the 300s ceiling, minus a margin for
 * the response itself. It is deliberately last of the data pulls: a parcel
 * checked twenty minutes late costs nobody anything, while a sale not synced
 * is a wrong number on the dashboard.
 */
const SHIPMENTS_DEADLINE_MS = 285_000
```

Then, after the ad-sync block and before the FX block:

```ts
  // Parcel tracking. Best-effort like the rest: Bring being down must never
  // fail the shop sync, and every parcel keeps its own lastError.
  let shipments: ShipmentSyncResult = { polled: 0, updated: 0, failed: 0 }
  try {
    shipments = await syncShipments({ deadline: runStartedAt + SHIPMENTS_DEADLINE_MS })
  } catch {
    // Each shipment keeps its own lastError; the delivery page tells the story.
  }
```

At the top of `GET`, immediately after the bearer-token check, add:

```ts
  // One clock for the whole run, so each stage's deadline is measured from the
  // invocation's start rather than from whenever the stage before it finished.
  const runStartedAt = Date.now()
```

and change the shops call to use it:

```ts
  const results = await syncAllShops({ deadline: runStartedAt + SHOPS_DEADLINE_MS })
```

Finally extend the response object:

```ts
    shipmentsPolled: shipments.polled,
    shipmentsUpdated: shipments.updated,
    shipmentsFailed: shipments.failed,
```

- [ ] **Step 7: Run the full suite**

Run: `npm run test`
Expected: all pass, including the existing cron route tests.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/delivery/config.ts src/lib/bring/sync.ts src/lib/bring/sync.integration.test.ts src/app/api/cron/sync/route.ts
git commit -m "feat: poll Bring for parcels in flight, on a tiered cadence, from the existing cron"
```

---

### Task 9: The promise, and business days

**Files:**
- Create: `src/lib/delivery/days.ts`
- Create: `src/lib/delivery/promise.ts`
- Test: `src/lib/delivery/days.test.ts`, `src/lib/delivery/promise.test.ts`
- Modify: `src/lib/bring/sync.ts` (Step 7)

**Interfaces:**
- Consumes: `zonedDayStr` from `src/lib/tz.ts`.
- Produces:
  ```ts
  export function isBusinessDay(day: string): boolean            // 'yyyy-mm-dd'
  export function addBusinessDays(day: string, n: number): string
  export function addCalendarDays(day: string, n: number): string
  export function deadlineFor(
    placedAt: Date, days: number, businessDays: boolean, tz: string,
  ): Date                                                        // last instant of the due day
  export function daysBetween(from: Date, to: Date, tz: string): number  // calendar days elapsed

  export type PromisePoint = { country: string; days: number; businessDays: boolean; effectiveFrom: Date }
  export function promiseOn(points: PromisePoint[], country: string | null, at: Date): PromisePoint | null
  ```

- [ ] **Step 1: Write the failing day tests**

Create `src/lib/delivery/days.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { addBusinessDays, addCalendarDays, daysBetween, deadlineFor, isBusinessDay } from './days'

describe('isBusinessDay', () => {
  it('counts Monday to Friday and no more', () => {
    expect(isBusinessDay('2026-08-03')).toBe(true) // Monday
    expect(isBusinessDay('2026-08-07')).toBe(true) // Friday
    expect(isBusinessDay('2026-08-08')).toBe(false) // Saturday
    expect(isBusinessDay('2026-08-09')).toBe(false) // Sunday
  })
})

describe('addBusinessDays', () => {
  it('steps over the weekend, which is the whole reason this exists', () => {
    // Friday + 3 business days = Wednesday, not Monday. Calendar days would
    // mark every Friday order late by Monday morning.
    expect(addBusinessDays('2026-08-07', 3)).toBe('2026-08-12')
  })

  it('starts counting from the next day, not the same one', () => {
    expect(addBusinessDays('2026-08-03', 1)).toBe('2026-08-04')
  })

  it('lands on Monday when a Saturday order gets one day', () => {
    expect(addBusinessDays('2026-08-08', 1)).toBe('2026-08-10')
  })

  it('returns the day itself for zero', () => {
    expect(addBusinessDays('2026-08-05', 0)).toBe('2026-08-05')
  })
})

describe('addCalendarDays', () => {
  it('does not skip the weekend', () => {
    expect(addCalendarDays('2026-08-07', 3)).toBe('2026-08-10')
  })

  it('crosses a month boundary', () => {
    expect(addCalendarDays('2026-08-30', 3)).toBe('2026-09-02')
  })
})

describe('deadlineFor', () => {
  const OSLO = 'Europe/Oslo'

  it('is the last instant of the due day in the shop timezone', () => {
    // Monday 3 Aug 10:00 Oslo + 3 business days = end of Thursday 6 Aug Oslo,
    // which is 21:59:59.999Z because Oslo is UTC+2 in August.
    const d = deadlineFor(new Date('2026-08-03T08:00:00Z'), 3, true, OSLO)
    expect(d.toISOString()).toBe('2026-08-06T21:59:59.999Z')
  })

  it('uses the order day as seen in the shop timezone, not in UTC', () => {
    // 23:30Z on Sunday is already Monday in Oslo, so the clock starts Monday.
    const d = deadlineFor(new Date('2026-08-02T23:30:00Z'), 1, true, OSLO)
    expect(d.toISOString()).toBe('2026-08-04T21:59:59.999Z')
  })

  it('honours a calendar-day promise', () => {
    const d = deadlineFor(new Date('2026-08-07T08:00:00Z'), 3, false, OSLO)
    expect(d.toISOString()).toBe('2026-08-10T21:59:59.999Z')
  })

  it('holds across the autumn DST change rather than drifting an hour', () => {
    // 25 Oct 2026 is the switch; Oslo is UTC+1 after it.
    const d = deadlineFor(new Date('2026-10-23T08:00:00Z'), 3, true, OSLO)
    expect(d.toISOString()).toBe('2026-10-28T22:59:59.999Z')
  })
})

describe('daysBetween', () => {
  it('counts calendar days elapsed in the shop timezone', () => {
    expect(daysBetween(
      new Date('2026-08-03T08:00:00Z'), new Date('2026-08-06T14:00:00Z'), 'Europe/Oslo',
    )).toBe(3)
  })

  it('is zero on the same day, however many hours apart', () => {
    expect(daysBetween(
      new Date('2026-08-03T06:00:00Z'), new Date('2026-08-03T20:00:00Z'), 'Europe/Oslo',
    )).toBe(0)
  })

  it('counts the day boundary as seen locally, not in UTC', () => {
    // 22:30Z on 3 Aug is already 4 Aug in Oslo.
    expect(daysBetween(
      new Date('2026-08-03T06:00:00Z'), new Date('2026-08-03T22:30:00Z'), 'Europe/Oslo',
    )).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/delivery/days.test.ts`
Expected: FAIL, cannot resolve `./days`.

- [ ] **Step 3: Implement the day maths**

Create `src/lib/delivery/days.ts`:

```ts
import { zoneDayEndUtc, zonedDayStr } from '../tz'

/**
 * Business-day arithmetic on plain 'yyyy-mm-dd' strings.
 *
 * Business days rather than calendar days because a Friday-afternoon order with
 * a three-day promise is not late on Monday. Counting calendar days would mark
 * every weekend order late and fill the Slack channel with noise nobody can act
 * on, which is exactly the failure that makes people mute an alert channel.
 *
 * PUBLIC HOLIDAYS ARE NOT MODELLED. Constitution Day and Christmas will produce
 * a handful of false lates. That is a stated limitation, not an oversight — see
 * the spec. If it proves to matter, a holiday table goes in here and nowhere
 * else.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Parse and re-emit as 'yyyy-mm-dd' via UTC, so no local zone can shift a date. */
const toUtc = (day: string) => new Date(`${day}T00:00:00Z`)
const toStr = (d: Date) => d.toISOString().slice(0, 10)

export function isBusinessDay(day: string): boolean {
  const dow = toUtc(day).getUTCDay()
  return dow !== 0 && dow !== 6
}

export function addCalendarDays(day: string, n: number): string {
  return toStr(new Date(toUtc(day).getTime() + n * DAY_MS))
}

/** `n` business days after `day`. Counting starts the day AFTER `day`. */
export function addBusinessDays(day: string, n: number): string {
  let current = day
  let left = n
  while (left > 0) {
    current = addCalendarDays(current, 1)
    if (isBusinessDay(current)) left--
  }
  return current
}

/**
 * When this order stops being on time: the LAST INSTANT of the due day in the
 * shop's timezone.
 *
 * End of day, not the same clock time: an order placed at 16:00 with a
 * three-day promise is not late at 16:01 three days later, and treating it that
 * way would alert on parcels being delivered that same afternoon.
 */
export function deadlineFor(
  placedAt: Date,
  days: number,
  businessDays: boolean,
  tz: string,
): Date {
  const placedDay = zonedDayStr(placedAt, tz)
  const dueDay = businessDays
    ? addBusinessDays(placedDay, days)
    : addCalendarDays(placedDay, days)
  return zoneDayEndUtc(dueDay, tz)
}

/**
 * Calendar days elapsed between two instants, counted by the DAY each falls on
 * in `tz` — not by dividing milliseconds. An order placed at 23:00 and
 * delivered at 01:00 two nights later took two days, not one and a bit.
 */
export function daysBetween(from: Date, to: Date, tz: string): number {
  const a = toUtc(zonedDayStr(from, tz)).getTime()
  const b = toUtc(zonedDayStr(to, tz)).getTime()
  return Math.round((b - a) / DAY_MS)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/delivery/days.test.ts`
Expected: 14 passed.

- [ ] **Step 5: Write and implement the promise lookup**

Create `src/lib/delivery/promise.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { promiseOn, type PromisePoint } from './promise'

const p = (country: string, days: number, from: string, businessDays = true): PromisePoint => ({
  country, days, businessDays, effectiveFrom: new Date(from),
})

const book = [
  p('*', 6, '2026-01-01'),
  p('NO', 3, '2026-01-01'),
  p('NO', 2, '2026-06-01'),
  p('SE', 4, '2026-01-01'),
]

describe('promiseOn', () => {
  it('takes the latest row effective on or before the order date', () => {
    expect(promiseOn(book, 'NO', new Date('2026-08-01'))?.days).toBe(2)
  })

  it('does not let a promise changed today rewrite last month', () => {
    expect(promiseOn(book, 'NO', new Date('2026-03-01'))?.days).toBe(3)
  })

  it('falls back to the star row for a country with none of its own', () => {
    expect(promiseOn(book, 'DE', new Date('2026-08-01'))?.days).toBe(6)
  })

  it('falls back to the star row when the country is unknown', () => {
    expect(promiseOn(book, null, new Date('2026-08-01'))?.days).toBe(6)
    expect(promiseOn(book, '', new Date('2026-08-01'))?.days).toBe(6)
  })

  it('is case-insensitive, so de and DE cannot mean different promises', () => {
    expect(promiseOn(book, 'no', new Date('2026-08-01'))?.days).toBe(2)
  })

  it('returns null when nothing is in force, rather than inventing zero days', () => {
    // Zero days would make every order instantly late. No promise means no
    // judgement — the page says so and the alert stays silent.
    expect(promiseOn(book, 'NO', new Date('2025-01-01'))).toBeNull()
    expect(promiseOn([], 'NO', new Date('2026-08-01'))).toBeNull()
  })
})
```

Create `src/lib/delivery/promise.ts`:

```ts
export type PromisePoint = {
  country: string // ISO-2, or '*' for the fallback
  days: number
  businessDays: boolean
  effectiveFrom: Date
}

/** The fallback country code, used when no row names the destination. */
export const ANY_COUNTRY = '*'

/**
 * What we promised this order, at the moment it was placed.
 *
 * The latest row whose effectiveFrom is on or before the order date wins —
 * exactly the rule costOn() and fulfillmentOn() already implement, so a promise
 * edited today never rewrites last month's on-time rate.
 *
 * Returns null when nothing is in force. Deliberately not "zero days": a zero
 * would make every order instantly late, which is the loudest possible way to
 * be wrong.
 */
export function promiseOn(
  points: PromisePoint[],
  country: string | null,
  at: Date,
): PromisePoint | null {
  const wanted = (country ?? '').trim().toUpperCase()

  const pick = (code: string) =>
    points
      .filter((p) => p.country.toUpperCase() === code && p.effectiveFrom <= at)
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null

  return (wanted ? pick(wanted) : null) ?? pick(ANY_COUNTRY)
}
```

- [ ] **Step 6: Run both**

Run: `npx vitest run src/lib/delivery/`
Expected: 20 passed.

- [ ] **Step 7: Stop the delivery integration suites running concurrently**

**Moved here from Task 8, deliberately.** Task 8 is blocked on an external credential, and Tasks 11 and 13 cannot be made correct without this. It is independent of everything else in this task.

Four collisions have already been found the hard way, each a variant of one thing: Vitest runs test **files** in parallel against one shared PostgreSQL, and the delivery suites share state that no naming convention can separate.

- `DeliveryConfig` is a fixed-id singleton (`id: 'singleton'`).
- `PUT /api/delivery/settings` **deletes every `DeliveryPromise` row** — real production behaviour, since promises are rewritten wholesale rather than diffed — so Task 14's suite wipes Tasks 11 and 13's promises.
- `flushDeliveryAlerts()` (Task 13) queries **every delivery-tracked shop** with no shop filter, because that is what it must do in production. Any other delivery suite's tracked fixture shop running concurrently lands in its results and corrupts its counts.
- Order numbers are matched **across all shops** by `linkRows`, which is why Tasks 6 and 7 collided on the literal `1001` until Task 7 renamed its fixtures.

Tagging fixtures is still worth doing and is specified per file, but sequencing is what actually makes these deterministic.

Add a second Vitest project to `vitest.config.ts` so only these files lose parallelism and the rest keep it.

**Two edits, and the second is not optional.** Add the `projects` array below, **and delete the root-level `test.include`**, relocating its comment onto the `app` project's own `include`. With `extends: true`, a root `include` **leak-merges into every project's include** — the `delivery` project then matches the entire suite, runs ~245 files instead of 3, and takes 158s instead of 28s. Verified empirically on Vitest 4.1.10; the run still reports green, which is exactly why the count check below is mandatory.

```ts
      projects: [
        {
          extends: true,
          test: {
            name: 'app',
            include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
            exclude: ['src/lib/{delivery,bring}/**/*.integration.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'delivery',
            include: ['src/lib/{delivery,bring}/**/*.integration.test.ts'],
            // These files share a fixed-id singleton, a table the settings route
            // rewrites wholesale, and a global alert query. No tag can separate
            // them; only running them one at a time can.
            fileParallelism: false,
          },
        },
      ],
```

`extends: true` inherits the root `plugins`, `env` and `environment`, so `DATABASE_URL` and `AUTH_SECRET` keep resolving exactly as they do today.

**Verify the split changed no counts, in either direction.** Record the file and test counts from `npm run test` *before* the change; after it they must be identical.

A bad glob fails in two ways and **both report green**: too narrow and it silently runs fewer tests; too wide (the `extends: true` leak above) and it runs the whole suite twice over. Check the per-project breakdown too — `delivery` should match exactly the `src/lib/{delivery,bring}/**/*.integration.test.ts` files and nothing else.

> ### ⛔ MOVED TO TASK 8 — DO NOT IMPLEMENT IN TASK 9
>
> Everything from here to the end of this task wires per-parcel deadlines into
> `src/lib/bring/sync.ts`, **a file Task 8 creates**. Attempting it in Task 9
> fails on a nonexistent file. Task 8 carries its own copy; this is reference only.

In `src/lib/bring/sync.ts`, add the imports:

```ts
import { deadlineFor } from '../delivery/days'
import { promiseOn } from '../delivery/promise'
import { getSetting } from '../settings'
```

Widen the `due` query's select to carry the order:

```ts
    select: {
      id: true, trackingNumber: true, orderId: true,
      order: {
        select: {
          placedAt: true, shippingCountry: true,
          shop: { select: { timezone: true } },
        },
      },
    },
```

Load the promise book and the workspace timezone once, above the batch loop:

```ts
  // Once for the run, never per parcel.
  const promises = await db.deliveryPromise.findMany()
  const { timezone: fallbackTz } = await getSetting()
```

And replace the `nextPollFor` call:

```ts
      // An unlinked parcel, or one whose country has no promise, simply uses
      // the ordinary tiers. No promise means no deadline, never a zero one.
      const promise = s.order
        ? promiseOn(promises, s.order.shippingCountry, s.order.placedAt)
        : null
      const deadline =
        s.order && promise
          ? deadlineFor(
              s.order.placedAt, promise.days, promise.businessDays,
              s.order.shop.timezone ?? fallbackTz,
            )
          : null

      const { nextPollAt, terminal } = nextPollFor(m, deadline, now)
```

⛔ **End of the Task 8 material. Task 9 resumes here.**

- [ ] **Step 8: Run the full suite**

Run: `npm run test`

Expected: every test that passed before the Vitest project split still passes, and the **file and test counts are unchanged**. The suite now reports two projects, `app` and `delivery`; the delivery one runs its files one at a time. `src/lib/bring/sync.ts` does not exist yet and is not part of this task.

- [ ] **Step 9: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/delivery/days.ts src/lib/delivery/days.test.ts src/lib/delivery/promise.ts src/lib/delivery/promise.test.ts src/lib/bring/sync.ts
git commit -m "feat: business-day delivery promises, per country, on a timeline"
```

---

### Task 10: One order's delivery, and the aggregates

`deliveryFor` is the single source of truth for what happened to an order. The Delivery page, the Orders column and the Slack alert all read it, so none of them can ever disagree about whether an order is late.

**Files:**
- Create: `src/lib/delivery/view.ts`
- Create: `src/lib/delivery/stats.ts`
- Test: `src/lib/delivery/view.test.ts`, `src/lib/delivery/stats.test.ts`

**Interfaces:**
- Consumes: `promiseOn`, `deadlineFor`, `daysBetween`.
- Produces:
  ```ts
  export type DeliveryState =
    | 'UNTRACKED' | 'BEFORE_TRACKING' | 'VOIDED' | 'NO_TRACKING'
    | 'BOOKED' | 'IN_TRANSIT' | 'AVAILABLE' | 'RETURNED' | 'CANCELLED'

  export type DeliveryOrder = {
    id: string; number: string; placedAt: Date; status: string
    shippingCountry: string | null
    shopName: string; shopTimezone: string | null; shopTrackingFrom: Date | null
    shipments: { handedInAt: Date | null; availableAt: Date | null; collectedAt: Date | null
                 bookedAt: Date | null; outcome: string | null; lastStatus: string | null
                 trackingNumber: string }[]
  }

  export type OrderDelivery = {
    state: DeliveryState
    totalDays: number | null; warehouseDays: number | null; transitDays: number | null
    availableAt: Date | null; collectedAt: Date | null
    deadline: Date | null; promiseDays: number | null
    late: boolean; daysOver: number | null
    trackingNumbers: string[]
  }

  export function deliveryFor(
    order: DeliveryOrder, promises: PromisePoint[], fallbackTz: string, now: Date,
  ): OrderDelivery

  export type DeliveryStats = {
    delivered: number; medianDays: number | null
    medianWarehouseDays: number | null; medianTransitDays: number | null
    onTimeRate: number | null; judged: number
    lateNow: number; noTracking: number; unjudged: number
    distribution: { days: number; count: number }[]
    byCountry: { country: string; delivered: number; medianDays: number | null; onTimeRate: number | null }[]
  }
  export function deliveryStats(views: OrderDelivery[], countries: (string | null)[]): DeliveryStats
  ```

- [ ] **Step 1: Write the failing view test**

Create `src/lib/delivery/view.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deliveryFor, type DeliveryOrder } from './view'
import type { PromisePoint } from './promise'

const OSLO = 'Europe/Oslo'
const NOW = new Date('2026-08-20T12:00:00Z')

const promises: PromisePoint[] = [
  { country: '*', days: 6, businessDays: true, effectiveFrom: new Date('2026-01-01') },
  { country: 'NO', days: 3, businessDays: true, effectiveFrom: new Date('2026-01-01') },
]

const order = (over: Partial<DeliveryOrder> = {}): DeliveryOrder => ({
  id: 'o1', number: '1001',
  placedAt: new Date('2026-08-03T08:00:00Z'), // Monday
  status: 'completed',
  shippingCountry: 'NO',
  shopName: 'Panetti', shopTimezone: OSLO,
  shopTrackingFrom: new Date('2026-01-01'),
  shipments: [],
  ...over,
})

const parcel = (over = {}) => ({
  trackingNumber: 'T1', bookedAt: null, handedInAt: null,
  availableAt: null, collectedAt: null, outcome: null, lastStatus: null,
  ...over,
})

describe('deliveryFor', () => {
  it('splits the wait into warehouse days and transit days', () => {
    const v = deliveryFor(order({
      shipments: [parcel({
        handedInAt: new Date('2026-08-04T16:00:00Z'),
        availableAt: new Date('2026-08-06T09:00:00Z'),
        outcome: 'DELIVERED',
      })],
    }), promises, OSLO, NOW)

    expect(v.state).toBe('AVAILABLE')
    expect(v.warehouseDays).toBe(1)
    expect(v.transitDays).toBe(2)
    expect(v.totalDays).toBe(3)
    expect(v.late).toBe(false)
  })

  it('judges the total against the promise, not the transit half', () => {
    // Handed over late, arrived quickly. The customer still waited 6 days.
    const v = deliveryFor(order({
      shipments: [parcel({
        handedInAt: new Date('2026-08-08T16:00:00Z'),
        availableAt: new Date('2026-08-09T09:00:00Z'),
        outcome: 'DELIVERED',
      })],
    }), promises, OSLO, NOW)
    expect(v.totalDays).toBe(6)
    expect(v.late).toBe(true)
  })

  it('is available when the LAST parcel is, for a multi-parcel order', () => {
    const v = deliveryFor(order({
      shipments: [
        parcel({ trackingNumber: 'T1', availableAt: new Date('2026-08-05T09:00:00Z'), outcome: 'DELIVERED' }),
        parcel({ trackingNumber: 'T2', availableAt: new Date('2026-08-07T09:00:00Z'), outcome: 'DELIVERED' }),
      ],
    }), promises, OSLO, NOW)
    expect(v.availableAt).toEqual(new Date('2026-08-07T09:00:00Z'))
    expect(v.trackingNumbers).toEqual(['T1', 'T2'])
  })

  it('is not available while one parcel of an order is still moving', () => {
    const v = deliveryFor(order({
      shipments: [
        parcel({ trackingNumber: 'T1', availableAt: new Date('2026-08-05T09:00:00Z') }),
        parcel({ trackingNumber: 'T2', handedInAt: new Date('2026-08-04T09:00:00Z') }),
      ],
    }), promises, OSLO, NOW)
    expect(v.availableAt).toBeNull()
    expect(v.state).toBe('IN_TRANSIT')
  })

  it('does not judge the customer for collecting late', () => {
    const v = deliveryFor(order({
      shipments: [parcel({
        handedInAt: new Date('2026-08-04T16:00:00Z'),
        availableAt: new Date('2026-08-05T09:00:00Z'),
        collectedAt: new Date('2026-08-19T09:00:00Z'),
        outcome: 'DELIVERED',
      })],
    }), promises, OSLO, NOW)
    expect(v.totalDays).toBe(2)
    expect(v.collectedAt).toEqual(new Date('2026-08-19T09:00:00Z'))
    expect(v.late).toBe(false)
  })

  it('marks an order past its promise with no parcel at all as late', () => {
    const v = deliveryFor(order(), promises, OSLO, NOW)
    expect(v.state).toBe('NO_TRACKING')
    expect(v.late).toBe(true)
    expect(v.daysOver).toBeGreaterThan(0)
  })

  it('does not judge a shop that is not tracked', () => {
    const v = deliveryFor(order({ shopTrackingFrom: null }), promises, OSLO, NOW)
    expect(v.state).toBe('UNTRACKED')
    expect(v.late).toBe(false)
  })

  it('does not judge an order placed before tracking started', () => {
    const v = deliveryFor(
      order({ shopTrackingFrom: new Date('2026-08-10') }), promises, OSLO, NOW,
    )
    expect(v.state).toBe('BEFORE_TRACKING')
    expect(v.late).toBe(false)
  })

  it('never marks a refunded order late, because it is never going to arrive', () => {
    for (const status of ['refunded', 'cancelled', 'failed', 'trash']) {
      const v = deliveryFor(order({ status }), promises, OSLO, NOW)
      expect(v.state).toBe('VOIDED')
      expect(v.late).toBe(false)
    }
  })

  it('reports a return as its own outcome, never as delivered', () => {
    const v = deliveryFor(order({
      shipments: [parcel({ handedInAt: new Date('2026-08-04T16:00:00Z'), outcome: 'RETURNED' })],
    }), promises, OSLO, NOW)
    expect(v.state).toBe('RETURNED')
    expect(v.totalDays).toBeNull()
    // Still late: the customer never got their order, and that is the thing
    // worth knowing.
    expect(v.late).toBe(true)
  })

  it('ignores availableAt on a parcel that was returned uncollected', () => {
    // NOT hypothetical. availableAt and outcome are separate denormalised
    // columns: a pickup-point parcel sets availableAt on READY_FOR_PICKUP, then
    // is returned when nobody collects it. Trusting availableAt alone would
    // count this as delivered in the median AND make `late` false, so it would
    // never alert — for an order the customer never received.
    const v = deliveryFor(order({
      shipments: [parcel({
        handedInAt: new Date('2026-08-04T16:00:00Z'),
        availableAt: new Date('2026-08-06T09:00:00Z'),
        outcome: 'RETURNED',
      })],
    }), promises, OSLO, NOW)
    expect(v.state).toBe('RETURNED')
    expect(v.availableAt).toBeNull()
    expect(v.totalDays).toBeNull()
    expect(v.late).toBe(true)
  })

  it('makes no judgement at all when no promise is in force', () => {
    const v = deliveryFor(order({ shippingCountry: 'NO' }), [], OSLO, NOW)
    expect(v.deadline).toBeNull()
    expect(v.promiseDays).toBeNull()
    expect(v.late).toBe(false)
  })

  it('falls back to the star promise for a country with none of its own', () => {
    const v = deliveryFor(order({ shippingCountry: 'DE' }), promises, OSLO, NOW)
    expect(v.promiseDays).toBe(6)
  })

  it('prefers the shop timezone over the workspace one', () => {
    const a = deliveryFor(order({ shopTimezone: 'Europe/Oslo' }), promises, 'UTC', NOW)
    const b = deliveryFor(order({ shopTimezone: null }), promises, 'Europe/Oslo', NOW)
    expect(a.deadline).toEqual(b.deadline)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/delivery/view.test.ts`
Expected: FAIL, cannot resolve `./view`.

- [ ] **Step 3: Implement the view**

Create `src/lib/delivery/view.ts`:

```ts
import { VOIDED_STATUSES } from '../metrics/types'
import { daysBetween, deadlineFor } from './days'
import { promiseOn, type PromisePoint } from './promise'

export type DeliveryState =
  | 'UNTRACKED' // this shop is not delivery-tracked at all
  | 'BEFORE_TRACKING' // placed before we started tracking this shop
  | 'VOIDED' // refunded or cancelled: never going to be delivered
  | 'NO_TRACKING' // expected a parcel, have none
  | 'BOOKED' // label made, still in the warehouse
  | 'IN_TRANSIT'
  | 'AVAILABLE' // with the customer, or waiting at their pickup point
  | 'RETURNED'
  | 'CANCELLED'

export type DeliveryShipment = {
  trackingNumber: string
  bookedAt: Date | null
  handedInAt: Date | null
  availableAt: Date | null
  collectedAt: Date | null
  outcome: string | null
  lastStatus: string | null
}

export type DeliveryOrder = {
  id: string
  number: string
  placedAt: Date
  status: string
  shippingCountry: string | null
  shopName: string
  shopTimezone: string | null
  shopTrackingFrom: Date | null
  shipments: DeliveryShipment[]
}

export type OrderDelivery = {
  state: DeliveryState
  totalDays: number | null
  warehouseDays: number | null
  transitDays: number | null
  availableAt: Date | null
  collectedAt: Date | null
  deadline: Date | null
  promiseDays: number | null
  late: boolean
  daysOver: number | null
  trackingNumbers: string[]
}

const VOIDED = new Set<string>(VOIDED_STATUSES)

const maxDate = (dates: (Date | null)[]): Date | null => {
  const real = dates.filter((d): d is Date => d !== null)
  return real.length ? new Date(Math.max(...real.map((d) => d.getTime()))) : null
}

const minDate = (dates: (Date | null)[]): Date | null => {
  const real = dates.filter((d): d is Date => d !== null)
  return real.length ? new Date(Math.min(...real.map((d) => d.getTime()))) : null
}

const EMPTY = {
  totalDays: null, warehouseDays: null, transitDays: null,
  availableAt: null, collectedAt: null, deadline: null, promiseDays: null,
  late: false, daysOver: null,
}

/**
 * What happened to one order's delivery.
 *
 * THE one place that decides whether an order is late. The Delivery page, the
 * Orders column and the Slack alert all read this, so they cannot drift apart
 * and tell three different stories about the same order.
 *
 * Pure. No database, no clock of its own — `now` is passed in so a test can
 * stand anywhere in time.
 */
export function deliveryFor(
  order: DeliveryOrder,
  promises: PromisePoint[],
  fallbackTz: string,
  now: Date,
): OrderDelivery {
  const trackingNumbers = order.shipments.map((s) => s.trackingNumber)
  const base = { ...EMPTY, trackingNumbers }

  // Three ways an order is simply not our business to judge. Each is separate
  // because each reads differently on screen, and "we are not tracking this"
  // must never look like "this has not shipped".
  if (!order.shopTrackingFrom) return { ...base, state: 'UNTRACKED' }
  if (order.placedAt < order.shopTrackingFrom) return { ...base, state: 'BEFORE_TRACKING' }
  // A refunded order is never going to be delivered. Without this, every refund
  // in the tracked window becomes a permanent late delivery.
  if (VOIDED.has(order.status.toLowerCase())) return { ...base, state: 'VOIDED' }

  const tz = order.shopTimezone ?? fallbackTz
  const promise = promiseOn(promises, order.shippingCountry, order.placedAt)
  // No promise in force means no judgement. Never a zero-day deadline, which
  // would make every order instantly late.
  const deadline = promise
    ? deadlineFor(order.placedAt, promise.days, promise.businessDays, tz)
    : null
  const promiseDays = promise?.days ?? null

  const returned = order.shipments.some((s) => s.outcome === 'RETURNED')
  const cancelled = order.shipments.some((s) => s.outcome === 'CANCELLED')

  // An order is available only when its LAST parcel is: a customer holding one
  // of two boxes has not received their order.
  //
  // The returned/cancelled guard is not belt-and-braces. `availableAt` and
  // `outcome` are separate denormalised columns, and a pickup-point parcel
  // genuinely sets availableAt (READY_FOR_PICKUP) BEFORE it is returned
  // uncollected. Without this guard such an order would report totalDays — so it
  // would count as delivered in the median — and `late` would be false, so it
  // would never alert. The customer never received it. Same rule milestonesFrom
  // applies in map.ts; the two must not drift.
  const allAvailable =
    !returned &&
    !cancelled &&
    order.shipments.length > 0 &&
    order.shipments.every((s) => s.availableAt !== null)
  const availableAt = allAvailable ? maxDate(order.shipments.map((s) => s.availableAt)) : null

  const allCollected =
    order.shipments.length > 0 && order.shipments.every((s) => s.collectedAt !== null)
  const collectedAt = allCollected ? maxDate(order.shipments.map((s) => s.collectedAt)) : null

  const handedInAt = minDate(order.shipments.map((s) => s.handedInAt))

  const state: DeliveryState = returned
    ? 'RETURNED'
    : cancelled
      ? 'CANCELLED'
      : availableAt
        ? 'AVAILABLE'
        : order.shipments.length === 0
          ? 'NO_TRACKING'
          : handedInAt
            ? 'IN_TRANSIT'
            : 'BOOKED'

  // Late = past the promise and not yet in the customer's hands. One rule, and
  // it covers both a parcel crawling through Bring and an order the warehouse
  // never booked at all — which is the worse of the two and which a
  // shipment-driven rule would miss entirely, there being no shipment.
  const late = deadline !== null && !availableAt && now > deadline
  const daysOver = late ? daysBetween(deadline!, now, tz) : null

  return {
    state,
    // The headline is the customer's whole wait, from placing the order to it
    // being available to them.
    totalDays: availableAt ? daysBetween(order.placedAt, availableAt, tz) : null,
    warehouseDays: handedInAt ? daysBetween(order.placedAt, handedInAt, tz) : null,
    transitDays: handedInAt && availableAt ? daysBetween(handedInAt, availableAt, tz) : null,
    availableAt,
    // Recorded and shown, never judged: a customer who takes a week to walk to
    // the pickup point has not been failed by anyone.
    collectedAt,
    deadline,
    promiseDays,
    late,
    daysOver,
    trackingNumbers,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/delivery/view.test.ts`
Expected: 13 passed.

- [ ] **Step 5: Write and implement the aggregates**

Create `src/lib/delivery/stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deliveryStats, median } from './stats'
import type { OrderDelivery } from './view'

const v = (over: Partial<OrderDelivery> = {}): OrderDelivery => ({
  state: 'AVAILABLE', totalDays: 3, warehouseDays: 1, transitDays: 2,
  availableAt: new Date(), collectedAt: null, deadline: new Date(),
  promiseDays: 3, late: false, daysOver: null, trackingNumbers: ['T1'],
  ...over,
})

describe('median', () => {
  it('is the middle value of an odd list', () => expect(median([5, 1, 3])).toBe(3))
  it('averages the two middle values of an even list', () => expect(median([1, 2, 3, 4])).toBe(2.5))
  it('is null for nothing, rather than zero', () => expect(median([])).toBeNull())
  it('is not dragged by an outlier the way a mean would be', () => {
    // A mean here is 25.75. Two parcels stuck in customs must not become the
    // headline figure.
    expect(median([2, 3, 3, 95])).toBe(3)
  })
})

describe('deliveryStats', () => {
  it('counts and medians only what was actually delivered', () => {
    const s = deliveryStats(
      [v({ totalDays: 2 }), v({ totalDays: 4 }), v({ state: 'IN_TRANSIT', totalDays: null })],
      ['NO', 'NO', 'NO'],
    )
    expect(s.delivered).toBe(2)
    expect(s.medianDays).toBe(3)
  })

  it('splits the median wait into warehouse and transit', () => {
    const s = deliveryStats(
      [v({ warehouseDays: 1, transitDays: 2 }), v({ warehouseDays: 3, transitDays: 2 })],
      ['NO', 'NO'],
    )
    expect(s.medianWarehouseDays).toBe(2)
    expect(s.medianTransitDays).toBe(2)
  })

  it('rates on time against the promise each order actually had', () => {
    const s = deliveryStats(
      [v({ totalDays: 2, promiseDays: 3 }), v({ totalDays: 5, promiseDays: 3 })],
      ['NO', 'NO'],
    )
    expect(s.judged).toBe(2)
    expect(s.onTimeRate).toBe(0.5)
  })

  it('leaves an unpromised order out of the rate and says how many', () => {
    const s = deliveryStats(
      [v({ totalDays: 2, promiseDays: 3 }), v({ totalDays: 9, promiseDays: null })],
      ['NO', 'DE'],
    )
    expect(s.judged).toBe(1)
    expect(s.onTimeRate).toBe(1)
    expect(s.unjudged).toBe(1)
  })

  it('counts what is late right now and what has no tracking at all', () => {
    const s = deliveryStats(
      [
        v({ state: 'IN_TRANSIT', totalDays: null, late: true }),
        v({ state: 'NO_TRACKING', totalDays: null, late: true }),
        v({ state: 'NO_TRACKING', totalDays: null, late: false }),
      ],
      ['NO', 'NO', 'NO'],
    )
    expect(s.lateNow).toBe(2)
    expect(s.noTracking).toBe(2)
  })

  it('builds a distribution that shows the tail a median hides', () => {
    const s = deliveryStats(
      [v({ totalDays: 2 }), v({ totalDays: 2 }), v({ totalDays: 9 })],
      ['NO', 'NO', 'NO'],
    )
    expect(s.distribution).toEqual([{ days: 2, count: 2 }, { days: 9, count: 1 }])
  })

  it('breaks down by destination country, busiest first', () => {
    const s = deliveryStats(
      [v({ totalDays: 2 }), v({ totalDays: 4 }), v({ totalDays: 7 })],
      ['NO', 'NO', 'SE'],
    )
    expect(s.byCountry[0]).toEqual({ country: 'NO', delivered: 2, medianDays: 3, onTimeRate: 0.5 })
    expect(s.byCountry[1].country).toBe('SE')
  })

  it('labels an order with no country rather than dropping it', () => {
    const s = deliveryStats([v({ totalDays: 2 })], [null])
    expect(s.byCountry[0].country).toBe('Unknown')
  })

  it('reports nothing rather than zero when there is nothing to report', () => {
    const s = deliveryStats([], [])
    expect(s.medianDays).toBeNull()
    expect(s.onTimeRate).toBeNull()
    expect(s.delivered).toBe(0)
  })
})
```

Create `src/lib/delivery/stats.ts`:

```ts
import type { OrderDelivery } from './view'

export type CountryStat = {
  country: string
  delivered: number
  medianDays: number | null
  onTimeRate: number | null
}

export type DeliveryStats = {
  delivered: number
  medianDays: number | null
  medianWarehouseDays: number | null
  medianTransitDays: number | null
  /** Share of judged orders that arrived within their promise. Null if none. */
  onTimeRate: number | null
  /** Delivered orders that HAD a promise to be judged against. */
  judged: number
  /** Delivered but with no promise in force, so deliberately not rated. */
  unjudged: number
  lateNow: number
  noTracking: number
  distribution: { days: number; count: number }[]
  byCountry: CountryStat[]
}

/**
 * The middle value. Null for nothing — never zero, which would read as
 * "delivered same day" on an empty page.
 *
 * Median rather than mean throughout: two parcels stuck in customs for a month
 * would drag a mean into fiction, and the headline figure has to describe the
 * ordinary order.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const rate = (delivered: OrderDelivery[]) => {
  const judged = delivered.filter((v) => v.promiseDays !== null)
  if (judged.length === 0) return null
  return judged.filter((v) => v.totalDays! <= v.promiseDays!).length / judged.length
}

/**
 * Roll up a page's worth of orders.
 *
 * `countries` is parallel to `views` rather than carried inside them: the view
 * is about one order's timeline, and pushing a reporting dimension into it
 * would make it the wrong shape for the Orders column, which needs no such
 * thing.
 */
export function deliveryStats(
  views: OrderDelivery[],
  countries: (string | null)[],
): DeliveryStats {
  const delivered = views.filter((v) => v.totalDays !== null)

  const counts = new Map<number, number>()
  for (const v of delivered) counts.set(v.totalDays!, (counts.get(v.totalDays!) ?? 0) + 1)

  const byCountry = new Map<string, OrderDelivery[]>()
  views.forEach((v, i) => {
    if (v.totalDays === null) return
    // Never dropped. An order whose country we failed to capture is still an
    // order that took some number of days, and hiding it would quietly shrink
    // every total on the page.
    const key = (countries[i] ?? '').trim().toUpperCase() || 'Unknown'
    byCountry.set(key, [...(byCountry.get(key) ?? []), v])
  })

  return {
    delivered: delivered.length,
    medianDays: median(delivered.map((v) => v.totalDays!)),
    medianWarehouseDays: median(
      delivered.filter((v) => v.warehouseDays !== null).map((v) => v.warehouseDays!),
    ),
    medianTransitDays: median(
      delivered.filter((v) => v.transitDays !== null).map((v) => v.transitDays!),
    ),
    onTimeRate: rate(delivered),
    judged: delivered.filter((v) => v.promiseDays !== null).length,
    unjudged: delivered.filter((v) => v.promiseDays === null).length,
    lateNow: views.filter((v) => v.late).length,
    noTracking: views.filter((v) => v.state === 'NO_TRACKING').length,
    distribution: [...counts.entries()]
      .map(([days, count]) => ({ days, count }))
      .sort((a, b) => a.days - b.days),
    byCountry: [...byCountry.entries()]
      .map(([country, list]) => ({
        country,
        delivered: list.length,
        medianDays: median(list.map((v) => v.totalDays!)),
        onTimeRate: rate(list),
      }))
      .sort((a, b) => b.delivered - a.delivered),
  }
}
```

- [ ] **Step 6: Run both**

Run: `npx vitest run src/lib/delivery/`
Expected: 33 passed.

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/delivery/view.ts src/lib/delivery/view.test.ts src/lib/delivery/stats.ts src/lib/delivery/stats.test.ts
git commit -m "feat: one definition of an order's delivery, and the aggregates over it"
```

---

### Task 11: The Delivery page

**Files:**
- Create: `src/lib/delivery/load.ts`
- Create: `src/app/api/delivery/route.ts`
- Create: `src/app/delivery/page.tsx`, `src/app/delivery/DeliveryClient.tsx`
- Modify: `src/components/shell/AppShell.tsx`
- Test: `src/app/api/delivery/route.integration.test.ts`

**Interfaces:**
- Consumes: `deliveryFor`, `deliveryStats`, `rangeFromQuery`, `shopIdsFromQuery`, `getSetting`.
- Produces: `GET /api/delivery?from&to&shops` returning
  ```ts
  {
    stats: DeliveryStats
    late: { id: string; number: string; shop: string; country: string | null
            daysOver: number; promiseDays: number | null; state: DeliveryState
            trackingNumbers: string[] }[]
    unlinked: { trackingNumber: string; lastStatus: string | null }[]
    imports: { id: string; filename: string; receivedAt: string
               rowsParsed: number; rowsLinked: number; rowsUnmatched: number; error: string | null }[]
    trackedShops: number
  }
  ```

- [ ] **Step 1: Write the loader**

Create `src/lib/delivery/load.ts`:

```ts
import { db } from '../db'
import { getSetting } from '../settings'
import { deliveryFor, type DeliveryOrder, type OrderDelivery } from './view'
import type { PromisePoint } from './promise'

export type LoadedDelivery = {
  order: DeliveryOrder
  view: OrderDelivery
}

/**
 * Every order in the window with its parcels, and what happened to each.
 *
 * Bulk-loaded in two queries, never per row — the same rule
 * api/orders/route.ts follows for costs and rates.
 */
export async function loadDelivery(
  shopIds: string[],
  from: Date,
  to: Date,
  now = new Date(),
): Promise<{ rows: LoadedDelivery[]; promises: PromisePoint[] }> {
  const [orders, promises, { timezone }] = await Promise.all([
    db.order.findMany({
      where: { shopId: { in: shopIds }, placedAt: { gte: from, lte: to } },
      orderBy: { placedAt: 'desc' },
      select: {
        id: true, number: true, placedAt: true, status: true, shippingCountry: true,
        shop: { select: { name: true, timezone: true, deliveryTrackingFrom: true } },
        shipments: {
          select: {
            trackingNumber: true, bookedAt: true, handedInAt: true,
            availableAt: true, collectedAt: true, outcome: true, lastStatus: true,
          },
        },
      },
    }),
    db.deliveryPromise.findMany(),
    getSetting(),
  ])

  const rows = orders.map((o) => {
    const order: DeliveryOrder = {
      id: o.id, number: o.number, placedAt: o.placedAt, status: o.status,
      shippingCountry: o.shippingCountry,
      shopName: o.shop.name,
      shopTimezone: o.shop.timezone,
      shopTrackingFrom: o.shop.deliveryTrackingFrom,
      shipments: o.shipments,
    }
    return { order, view: deliveryFor(order, promises, timezone, now) }
  })

  return { rows, promises }
}
```

- [ ] **Step 2: Write the failing route test**

Create `src/app/api/delivery/route.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))

const { GET } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')

let shopId: string

// Tagged and scoped — see "Test data convention" in the Global Constraints.
// The 11 seeded shops stay put: they have no deliveryTrackingFrom, so every
// order of theirs reads UNTRACKED and touches none of the assertions below.
// That makes this a stronger test than deleting them would.
const TAG = '[delivery-route-test]'
const TRACK = 'TROUTE' // the unlinked parcel below carries this prefix
const scoped = { shop: { name: { contains: TAG } } }

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } } })
  await db.shipment.deleteMany({ where: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  // DeliveryPromise has no shop to tag. Scope by the country codes this suite
  // writes so a parallel file's promises survive.
  await db.deliveryPromise.deleteMany({ where: { country: { in: ['*', 'NO'] } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({
    data: {
      name: `Panetti ${TAG}`, currency: 'NOK', active: true,
      deliveryTrackingFrom: new Date('2026-01-01'),
    },
  })).id
  await db.deliveryPromise.create({
    data: { country: '*', days: 3, businessDays: true, effectiveFrom: new Date('2026-01-01') },
  })
})

const url = 'http://localhost/api/delivery?from=2026-08-01&to=2026-08-31'

describe('GET /api/delivery', () => {
  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'x@y.z', role: 'AMBASSADOR' } as never)
    expect((await GET(new Request(url))).status).toBe(403)
  })

  it('never lets a proxy or CDN keep a copy', async () => {
    const res = await GET(new Request(url))
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('reports the orders that are late right now', async () => {
    await db.order.create({
      // Order numbers are matched ACROSS ALL SHOPS by linkRows, so a bare
      // '1001' collides with other delivery suites' fixtures. Prefix it.
      data: {
        shopId, externalId: 'E1', number: 'RTE1001',
        placedAt: new Date('2026-08-03T08:00:00Z'), status: 'completed', currency: 'NOK',
        shippingCountry: 'NO',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })
    const body = await (await GET(new Request(url))).json()
    expect(body.stats.noTracking).toBe(1)
    expect(body.late[0].number).toBe('RTE1001')
    expect(body.late[0].state).toBe('NO_TRACKING')
  })

  it('lists parcels no order claimed, so they are visible rather than lost', async () => {
    await db.shipment.create({ data: { trackingNumber: 'T9', lastStatus: 'IN_TRANSIT' } })
    const body = await (await GET(new Request(url))).json()
    expect(body.unlinked).toEqual([{ trackingNumber: 'T9', lastStatus: 'IN_TRANSIT' }])
  })
})
```

- [ ] **Step 3: Implement the route**

Create `src/app/api/delivery/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { loadDelivery } from '@/lib/delivery/load'
import { deliveryStats } from '@/lib/delivery/stats'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** How many late orders the page lists before it asks you to narrow the range. */
const LATE_LIMIT = 200

/**
 * The Delivery page's data: how long orders took, what is late right now, and
 * what we could not account for.
 *
 * The last part matters as much as the first. An unlinked parcel and a failed
 * import are both invisible by nature — the page simply shows fewer orders and
 * looks like a quiet week — so both are counted out loud.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const shops = await db.shop.findMany({
      where: { active: true, ...(shopIds?.length ? { id: { in: shopIds } } : {}) },
      select: { id: true, deliveryTrackingFrom: true },
    })

    const { rows } = await loadDelivery(
      shops.map((s) => s.id),
      zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
      zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
    )

    const stats = deliveryStats(
      rows.map((r) => r.view),
      rows.map((r) => r.order.shippingCountry),
    )

    const late = rows
      .filter((r) => r.view.late)
      .sort((a, b) => (b.view.daysOver ?? 0) - (a.view.daysOver ?? 0))
      .slice(0, LATE_LIMIT)
      .map((r) => ({
        id: r.order.id,
        number: r.order.number,
        shop: r.order.shopName,
        country: r.order.shippingCountry || null,
        daysOver: r.view.daysOver ?? 0,
        promiseDays: r.view.promiseDays,
        state: r.view.state,
        trackingNumbers: r.view.trackingNumbers,
      }))

    const [unlinked, imports] = await Promise.all([
      db.shipment.findMany({
        where: { orderId: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { trackingNumber: true, lastStatus: true },
      }),
      db.trackingImport.findMany({
        orderBy: { receivedAt: 'desc' },
        take: 10,
        select: {
          id: true, filename: true, receivedAt: true,
          rowsParsed: true, rowsLinked: true, rowsUnmatched: true, error: true,
        },
      }),
    ])

    return NextResponse.json(
      {
        stats,
        late,
        unlinked,
        imports: imports.map((i) => ({ ...i, receivedAt: i.receivedAt.toISOString() })),
        trackedShops: shops.filter((s) => s.deliveryTrackingFrom !== null).length,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load delivery data' },
      { status: 500, headers: NO_STORE },
    )
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/api/delivery/route.integration.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Build the page**

Create `src/app/delivery/page.tsx`, copying the server half of `src/app/products/page.tsx` exactly (auth check, shop list, `AppShell` wrapper) and rendering `<DeliveryClient shops={shops} />`.

Create `src/app/delivery/DeliveryClient.tsx`, following `ProductsClient.tsx` for the fetch-and-filter shape. It renders, in this order:

1. **Four tiles** — median days to delivery, on-time rate, late right now, no tracking. Each shows `—` when its figure is null. Never `0`.
2. **A note when nothing is tracked at all**: if `trackedShops === 0`, the whole page is replaced by "No shop is set up for delivery tracking yet." with a link to `/settings/delivery`. Everything below would otherwise read as zeros and imply nothing was ever delivered.
3. **The split** — two labelled bars, warehouse days against transit days, sharing one scale so the longer half is obvious at a glance.
4. **The distribution** — one bar per day count, from `stats.distribution`. This is what shows the tail a median hides.
5. **Per-country table** — country, delivered, median days, on-time rate. `stats.byCountry` is already sorted busiest first.
6. **The late list** — number, shop, country, days over, promise, state, with a link to the order and one to `https://tracking.bring.com/tracking/<number>` per parcel. This is the only part anyone acts on, so it is the part with the most room.
7. **Unlinked parcels** — collapsed by default, with its count in the heading.
8. **`<UploadBox onImported={reload} />`** from Task 7, and the last few imports with their matched/unmatched counts.

Copy rules: figures use `font-variant-numeric: tabular-nums`; cards are `rounded-[12px] border border-line`, no shadow; late values use `text-loss`, at-risk `text-warn`. Add nothing to the token set.

**When a figure is unknown, write what is true.** `unjudged > 0` prints "N delivered orders had no promise in force and are not rated" under the on-time tile. A confident wrong number is the worst thing this product can ship.

- [ ] **Step 6: Add the nav entry**

In `src/components/shell/AppShell.tsx`, add to the `Analytics` section immediately after the `/orders` entry:

```tsx
      {
        href: '/delivery',
        label: 'Delivery',
        icon: icon(
          <>
            <path d="M3 7h11v10H3z" />
            <path d="M14 10h4l3 3v4h-7z" />
            <circle cx="7" cy="18" r="1.5" />
            <circle cx="17" cy="18" r="1.5" />
          </>,
        ),
      },
```

- [ ] **Step 7: See it in a browser**

Run the dev server in the background — **never pipe it to `head`**, which wedges it and holds the port:

```bash
npm run dev
```

Open `http://localhost:3000/delivery`. Confirm: the empty state reads honestly with no data, the tiles show `—` rather than `0`, and the page does not scroll sideways at 1280px or at 375px.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/lib/delivery/load.ts src/app/api/delivery/ src/app/delivery/ src/components/shell/AppShell.tsx
git commit -m "feat: the Delivery page, with the split, the tail and what we cannot account for"
```

---

### Task 12: The Delivery column on Orders

**Files:**
- Modify: `src/app/api/orders/route.ts`
- Modify: `src/app/orders/OrdersTable.tsx`
- Test: `src/app/api/orders/route.integration.test.ts` (add cases)

**Interfaces:**
- Consumes: `deliveryFor`.
- Produces: each order in the `/api/orders` response gains `delivery: { state, totalDays, warehouseDays, transitDays, late, daysOver, promiseDays, trackingNumbers }`.

- [ ] **Step 1: Write the failing test**

Add to the orders route test:

```ts
it('carries each order delivery state, so the column never guesses', async () => {
  // Order in a tracked shop, past its promise, with no parcel.
  const body = await (await GET(new Request(ordersUrl))).json()
  const row = body.orders.find((o: { number: string }) => o.number === '1001')
  expect(row.delivery.state).toBe('NO_TRACKING')
  expect(row.delivery.late).toBe(true)
})

it('says a shop is untracked rather than calling its orders unshipped', async () => {
  await db.shop.update({ where: { id: shopId }, data: { deliveryTrackingFrom: null } })
  const body = await (await GET(new Request(ordersUrl))).json()
  expect(body.orders[0].delivery.state).toBe('UNTRACKED')
  expect(body.orders[0].delivery.late).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/orders/route.integration.test.ts`
Expected: FAIL, `delivery` is undefined.

- [ ] **Step 3: Implement**

In `src/app/api/orders/route.ts`:

Add the imports:

```ts
import { deliveryFor } from '@/lib/delivery/view'
```

Widen the `db.order.findMany` select with:

```ts
          shippingCountry: true,
          shipments: {
            select: {
              trackingNumber: true, bookedAt: true, handedInAt: true,
              availableAt: true, collectedAt: true, outcome: true, lastStatus: true,
            },
          },
```

and extend the existing `shop` select to `{ name: true, currency: true, timezone: true, deliveryTrackingFrom: true }`.

Load the promise book once for the page, beside the existing bulk loads:

```ts
    // Once per page, never per row — the same rule the costs and rates above
    // follow.
    const promises = await db.deliveryPromise.findMany()
    const now = new Date()
```

And inside the `rows.map`, add to the returned object:

```ts
        delivery: deliveryFor(
          {
            id: o.id, number: o.number, placedAt: o.placedAt, status: o.status,
            shippingCountry: o.shippingCountry,
            shopName: o.shop.name,
            shopTimezone: o.shop.timezone,
            shopTrackingFrom: o.shop.deliveryTrackingFrom,
            shipments: o.shipments,
          },
          promises,
          timezone,
          now,
        ),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/api/orders/route.integration.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Add the column**

In `src/app/orders/OrdersTable.tsx`, add a `Delivery` header after `Status` and a cell rendering this map. Each state gets a sentence a human can act on, and none of them is a bare number:

| State | Cell |
| --- | --- |
| `AVAILABLE` | `3 days` (`text-loss` if `late`) |
| `IN_TRANSIT` | `In transit, day 4` |
| `BOOKED` | `At the warehouse, day 2` |
| `NO_TRACKING` | `Not shipped yet` (`text-loss` if `late`) |
| `RETURNED` | `Returned` |
| `CANCELLED` | `Cancelled` |
| `VOIDED` | `—` |
| `BEFORE_TRACKING` | `—`, with `title="Placed before delivery tracking started"` |
| `UNTRACKED` | `—`, with `title="This shop is not delivery-tracked"` |

The day count in `In transit, day N` is `daysBetween(placedAt, now)` computed client-side from `placedAt`; it is deliberately not stored, because it changes every day on its own.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run test
git rev-parse --abbrev-ref HEAD
git add src/app/api/orders/route.ts src/app/orders/OrdersTable.tsx src/app/api/orders/route.integration.test.ts
git commit -m "feat: a Delivery column on the Orders page"
```

**Phase 1 ends here.** The client can now answer "how many days did this order take" for real. Everything below adds the alerting.

---

### Task 13: Slack alerts

**Files:**
- Create: `src/lib/slack/notify.ts`
- Create: `src/lib/delivery/alerts.ts`
- Modify: `src/app/api/cron/sync/route.ts`
- Test: `src/lib/slack/notify.test.ts`, `src/lib/delivery/alerts.integration.test.ts`

**Interfaces:**
- Consumes: `deliveryFor`, `getDeliveryConfig`.
- Produces:
  ```ts
  export function postSlack(webhookUrl: string, text: string): Promise<void>
  export function alertMessage(late: LateAlert[], appUrl: string): string
  export function flushDeliveryAlerts(opts?: { now?: Date }): Promise<{ sent: number; skipped: string | null }>
  ```

- [ ] **Step 1: Write the failing Slack test**

Create `src/lib/slack/notify.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest'
import { postSlack } from './notify'

afterEach(() => vi.unstubAllGlobals())

describe('postSlack', () => {
  it('posts the text as JSON', async () => {
    const fn = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fn)
    await postSlack('https://hooks.slack.com/services/x', 'hello')
    const init = fn.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello' })
  })

  it('throws on a rejection, so the caller does not stamp the orders as alerted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid_token', { status: 403 })))
    await expect(postSlack('https://hooks.slack.com/services/x', 'hi')).rejects.toThrow(/403/)
  })
})
```

- [ ] **Step 2: Implement**

Create `src/lib/slack/notify.ts`:

```ts
const TIMEOUT_MS = 10_000

/**
 * Post to a Slack incoming webhook.
 *
 * An incoming webhook rather than a full Slack app: no OAuth, no scopes, no app
 * review, and the client can create the URL himself in two minutes. A full app
 * would only buy choosing the channel at runtime, which is not worth it.
 *
 * THROWS on failure, deliberately. The caller must not mark orders as alerted
 * for a message that never arrived.
 */
export async function postSlack(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    throw new Error(`Slack responded ${res.status}: ${body}`)
  }
}
```

- [ ] **Step 3: Write the failing alerts test**

Create `src/lib/delivery/alerts.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { alertMessage, flushDeliveryAlerts } from './alerts'

const NOW = new Date('2026-08-20T12:00:00Z')
let shopId: string

afterEach(() => vi.unstubAllGlobals())

// Tagged and scoped — see "Test data convention" in the Global Constraints.
const TAG = '[delivery-alerts-test]'
const TRACK = 'TALERT' // the parcels below carry this prefix
const scoped = { shop: { name: { contains: TAG } } }

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } } })
  await db.shipment.deleteMany({ where: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.deliveryPromise.deleteMany({ where: { country: { in: ['*'] } } })
  // Never deleteMany on the singleton — blank the fields instead, so a racing
  // file cannot find the row missing. See the Global Constraints.
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: { bringApiUid: null, bringApiKey: null, bringClientUrl: null, slackWebhookUrl: null },
  })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()

  shopId = (await db.shop.create({
    data: { name: `Panetti ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') },
  })).id
  await db.deliveryPromise.create({
    data: { country: '*', days: 3, businessDays: true, effectiveFrom: new Date('2026-01-01') },
  })
  await db.deliveryConfig.create({
    data: { id: 'singleton', slackWebhookUrl: encryptSecret('https://hooks.slack.com/services/x') },
  })
})

async function order(number: string, over: Record<string, unknown> = {}) {
  return db.order.create({
    // Order numbers are matched ACROSS ALL SHOPS by linkRows, and
    // flushDeliveryAlerts scans every tracked shop with no shop filter. Both
    // make a bare '1001' collide with other delivery suites. Prefix every one.
    data: {
      shopId, externalId: `E${number}`, number: `ALRT${number}`,
      placedAt: new Date('2026-08-03T08:00:00Z'), status: 'completed', currency: 'NOK',
      shippingCountry: 'NO',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      ...over,
    },
  })
}

const ok = () => {
  const fn = vi.fn(async () => new Response('ok', { status: 200 }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('flushDeliveryAlerts', () => {
  it('alerts an order past its promise with no parcel, once', async () => {
    const o = await order('1001')
    const fn = ok()

    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryAlertedAt).not.toBeNull()

    // Second run: nothing new, so nothing is posted at all.
    const again = ok()
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
    expect(again).not.toHaveBeenCalled()
  })

  it('leaves the order unstamped when Slack fails, so the next run retries', async () => {
    const o = await order('1001')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))

    const r = await flushDeliveryAlerts({ now: NOW })
    expect(r.sent).toBe(0)
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryAlertedAt).toBeNull()
  })

  it('never alerts a refunded order, which is never going to be delivered', async () => {
    await order('1001', { status: 'refunded' })
    const fn = ok()
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })

  it('never alerts a shop that is not delivery-tracked', async () => {
    await db.shop.update({ where: { id: shopId }, data: { deliveryTrackingFrom: null } })
    await order('1001')
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
  })

  it('never alerts an order placed before tracking started', async () => {
    await db.shop.update({ where: { id: shopId }, data: { deliveryTrackingFrom: new Date('2026-08-10') } })
    await order('1001')
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
  })

  it('does not alert an order that arrived in time', async () => {
    const o = await order('1001')
    await db.shipment.create({
      data: {
        trackingNumber: 'T1', orderId: o.id,
        availableAt: new Date('2026-08-05T09:00:00Z'), outcome: 'DELIVERED', terminal: true,
      },
    })
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
  })

  it('alerts a returned parcel, because the customer never got their order', async () => {
    const o = await order('1001')
    await db.shipment.create({
      data: { trackingNumber: 'T1', orderId: o.id, outcome: 'RETURNED', terminal: true },
    })
    ok()
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(1)
  })

  it('says it is not configured rather than failing, when there is no webhook', async () => {
    await db.deliveryConfig.deleteMany()
    await order('1001')
    const r = await flushDeliveryAlerts({ now: NOW })
    expect(r.sent).toBe(0)
    expect(r.skipped).toMatch(/Slack/)
  })

  it('sends one message for many orders, capped, and stamps every one of them', async () => {
    for (let i = 0; i < 30; i++) await order(`10${i}`)
    const fn = ok()

    const r = await flushDeliveryAlerts({ now: NOW })
    expect(r.sent).toBe(30)
    expect(fn).toHaveBeenCalledTimes(1)

    const text = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string).text
    expect(text).toMatch(/30 orders/)
    expect(text).toMatch(/and 5 more/)
    // Every one is stamped, capped message or not: a line we chose not to print
    // must not alert again tomorrow as if it were new.
    expect(await db.order.count({ where: { deliveryAlertedAt: null } })).toBe(0)
  })
})

describe('alertMessage', () => {
  it('names the order, the shortfall and what is actually happening', () => {
    const text = alertMessage(
      [{ id: 'o1', number: '1001', shop: 'Panetti', country: 'NO',
         daysOver: 2, promiseDays: 3, state: 'NO_TRACKING', trackingNumbers: [] }],
      'https://panetti.vercel.app',
    )
    expect(text).toContain('1001')
    expect(text).toContain('Panetti')
    expect(text).toContain('2 days over')
    expect(text).toContain('Not shipped')
    expect(text).toContain('https://panetti.vercel.app/orders')
  })

  it('links the parcel on Bring when there is one', () => {
    const text = alertMessage(
      [{ id: 'o1', number: '1001', shop: 'Panetti', country: 'NO',
         daysOver: 1, promiseDays: 3, state: 'IN_TRANSIT', trackingNumbers: ['T1'] }],
      'https://panetti.vercel.app',
    )
    expect(text).toContain('tracking.bring.com/tracking/T1')
  })
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run src/lib/delivery/alerts.integration.test.ts`
Expected: FAIL, cannot resolve `./alerts`.

- [ ] **Step 5: Implement**

Create `src/lib/delivery/alerts.ts`:

```ts
import { db } from '../db'
import { VOIDED_STATUSES } from '../metrics/types'
import { postSlack } from '../slack/notify'
import { getSetting } from '../settings'
import { getDeliveryConfig } from './config'
import { deliveryFor, type DeliveryState } from './view'

export type LateAlert = {
  id: string
  number: string
  shop: string
  country: string | null
  daysOver: number
  promiseDays: number | null
  state: DeliveryState
  trackingNumbers: string[]
}

/** Lines printed before the message summarises the rest. Slack limits payloads. */
const MAX_LINES = 25

/** How many candidates one run considers. Far above any real day's worth. */
const CANDIDATE_LIMIT = 500

const SAYS: Record<DeliveryState, string> = {
  NO_TRACKING: 'Not shipped',
  BOOKED: 'Still at the warehouse',
  IN_TRANSIT: 'In transit',
  RETURNED: 'Returned to sender',
  CANCELLED: 'Delivery cancelled',
  AVAILABLE: 'Delivered',
  VOIDED: 'Refunded',
  UNTRACKED: 'Not tracked',
  BEFORE_TRACKING: 'Before tracking started',
}

export function alertMessage(late: LateAlert[], appUrl: string): string {
  const head =
    late.length === 1
      ? '1 order is past its delivery promise'
      : `${late.length} orders are past their delivery promise`

  const lines = late.slice(0, MAX_LINES).map((l) => {
    const where = l.country ? ` to ${l.country}` : ''
    const promise = l.promiseDays === null ? '' : ` (promise ${l.promiseDays} days)`
    const track = l.trackingNumbers
      .map((n) => ` <https://tracking.bring.com/tracking/${n}|track>`)
      .join('')
    return (
      `• <${appUrl}/orders?q=${encodeURIComponent(l.number)}|${l.number}> ` +
      `${l.shop}${where} — ${l.daysOver} days over${promise}. ${SAYS[l.state]}.${track}`
    )
  })

  const rest = late.length - lines.length
  return [head, ...lines, ...(rest > 0 ? [`…and ${rest} more.`] : [])].join('\n')
}

/**
 * Post one message naming the orders that newly broke their promise, then mark
 * them so they never alert again.
 *
 * Runs at the end of the ordinary 15-minute cron, so there is no second
 * schedule to maintain. Most runs find nothing and post nothing.
 *
 * The order of the last two steps matters: Slack first, the stamp second. If
 * Slack is down the orders stay unstamped and the next run tries again, instead
 * of the alert vanishing into a 500.
 */
export async function flushDeliveryAlerts(
  opts: { now?: Date } = {},
): Promise<{ sent: number; skipped: string | null }> {
  const now = opts.now ?? new Date()
  const { slackWebhookUrl } = await getDeliveryConfig()
  if (!slackWebhookUrl) return { sent: 0, skipped: 'Slack is not connected.' }

  const [candidates, promises, { timezone }] = await Promise.all([
    db.order.findMany({
      where: {
        deliveryAlertedAt: null,
        // A refunded or cancelled order is never going to be delivered. Without
        // this every refund in the tracked window becomes a permanent late
        // delivery and the channel fills with orders nobody is waiting for.
        status: { notIn: [...VOIDED_STATUSES] },
        shop: { deliveryTrackingFrom: { not: null } },
      },
      orderBy: { placedAt: 'asc' },
      take: CANDIDATE_LIMIT,
      select: {
        id: true, number: true, placedAt: true, status: true, shippingCountry: true,
        shop: { select: { name: true, timezone: true, deliveryTrackingFrom: true } },
        shipments: {
          select: {
            trackingNumber: true, bookedAt: true, handedInAt: true,
            availableAt: true, collectedAt: true, outcome: true, lastStatus: true,
          },
        },
      },
    }),
    db.deliveryPromise.findMany(),
    getSetting(),
  ])

  const late: LateAlert[] = []
  for (const o of candidates) {
    const view = deliveryFor(
      {
        id: o.id, number: o.number, placedAt: o.placedAt, status: o.status,
        shippingCountry: o.shippingCountry,
        shopName: o.shop.name,
        shopTimezone: o.shop.timezone,
        shopTrackingFrom: o.shop.deliveryTrackingFrom,
        shipments: o.shipments,
      },
      promises,
      timezone,
      now,
    )
    if (!view.late) continue
    late.push({
      id: o.id, number: o.number, shop: o.shop.name,
      country: o.shippingCountry || null,
      daysOver: view.daysOver ?? 0,
      promiseDays: view.promiseDays,
      state: view.state,
      trackingNumbers: view.trackingNumbers,
    })
  }

  if (late.length === 0) return { sent: 0, skipped: null }

  // Worst first: if the message is capped, the lines that survive are the ones
  // that matter most.
  late.sort((a, b) => b.daysOver - a.daysOver)

  const appUrl = process.env.APP_URL ?? 'https://panetti.vercel.app'
  await postSlack(slackWebhookUrl, alertMessage(late, appUrl))

  // Every one of them, not only the printed lines: a line we chose not to print
  // is not new tomorrow.
  await db.order.updateMany({
    where: { id: { in: late.map((l) => l.id) } },
    data: { deliveryAlertedAt: now },
  })

  return { sent: late.length, skipped: null }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/lib/slack/notify.test.ts src/lib/delivery/alerts.integration.test.ts`
Expected: 13 passed.

- [ ] **Step 7: Wire it into the cron**

In `src/app/api/cron/sync/route.ts`, add the import:

```ts
import { flushDeliveryAlerts } from '@/lib/delivery/alerts'
```

Immediately after the `syncShipments` block:

```ts
  // Alerting last, so it judges the freshest tracking we have. Best-effort:
  // Slack being down must never fail the sync, and an unstamped order simply
  // alerts on the next run.
  let alertsSent = 0
  try {
    alertsSent = (await flushDeliveryAlerts()).sent
  } catch {
    // The orders stay unstamped, which is exactly the retry we want.
  }
```

And add `alertsSent,` to the response object.

- [ ] **Step 8: Run the full suite and commit**

```bash
npm run test
git rev-parse --abbrev-ref HEAD
git add src/lib/slack/ src/lib/delivery/alerts.ts src/lib/delivery/alerts.integration.test.ts src/app/api/cron/sync/route.ts
git commit -m "feat: one batched Slack message for orders past their delivery promise"
```

---

### Task 14: Delivery settings

**Files:**
- Create: `src/app/api/delivery/settings/route.ts` (GET, PUT)
- Create: `src/app/api/delivery/test/route.ts` (POST)
- Create: `src/app/settings/delivery/page.tsx`, `DeliverySettingsClient.tsx`
- Modify: `src/components/shell/AppShell.tsx`
- Test: `src/app/api/delivery/settings/route.integration.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`, `getDeliveryConfig`, `fetchTracking`, `postSlack`.
- Produces: `GET/PUT /api/delivery/settings`, and `POST /api/delivery/test` with `{ target: 'bring' | 'slack' }` returning `{ ok: boolean; message: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/delivery/settings/route.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))

const { GET, PUT } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')

const url = 'http://localhost/api/delivery/settings'
const put = (body: unknown) =>
  PUT(new Request(url, { method: 'PUT', body: JSON.stringify(body) }))

beforeEach(async () => {
  await db.deliveryConfig.deleteMany()
  await db.deliveryPromise.deleteMany()
})

describe('delivery settings', () => {
  it('refuses a non-admin on both verbs', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'u2', email: 'x@y.z', role: 'AMBASSADOR' } as never)
    expect((await GET(new Request(url))).status).toBe(403)
    expect((await put({})).status).toBe(403)
    vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
  })

  it('stores the Bring key and the Slack URL encrypted, never in the clear', async () => {
    await put({
      bringApiUid: 'ops@example.com',
      bringApiKey: 'super-secret',
      bringClientUrl: 'https://panetti.vercel.app',
      slackWebhookUrl: 'https://hooks.slack.com/services/x',
    })
    const row = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(row.bringApiKey).not.toContain('super-secret')
    expect(row.bringApiKey!.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(row.bringApiKey!)).toBe('super-secret')
    expect(decryptSecret(row.slackWebhookUrl!)).toBe('https://hooks.slack.com/services/x')
  })

  it('never returns a secret to the browser, only whether one is set', async () => {
    await put({ bringApiUid: 'ops@example.com', bringApiKey: 'super-secret' })
    const body = await (await GET(new Request(url))).json()
    expect(JSON.stringify(body)).not.toContain('super-secret')
    expect(body.hasBringKey).toBe(true)
    expect(body.bringApiUid).toBe('ops@example.com')
  })

  it('keeps the stored key when the field is left blank on a later save', async () => {
    await put({ bringApiUid: 'ops@example.com', bringApiKey: 'super-secret' })
    await put({ bringApiUid: 'ops2@example.com', bringApiKey: '' })
    const row = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(decryptSecret(row.bringApiKey!)).toBe('super-secret')
    expect(row.bringApiUid).toBe('ops2@example.com')
  })

  it('saves a promise per country on a timeline', async () => {
    await put({ promises: [
      { country: 'NO', days: 3, businessDays: true, effectiveFrom: '2026-01-01' },
      { country: '*', days: 6, businessDays: true, effectiveFrom: '2026-01-01' },
    ] })
    expect(await db.deliveryPromise.count()).toBe(2)
  })

  it('refuses a promise of zero days, which would make every order instantly late', async () => {
    const res = await put({ promises: [
      { country: 'NO', days: 0, businessDays: true, effectiveFrom: '2026-01-01' },
    ] })
    expect(res.status).toBe(400)
    expect(await db.deliveryPromise.count()).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/delivery/settings/route.integration.test.ts`
Expected: FAIL, cannot resolve `./route`.

- [ ] **Step 3: Implement the settings route**

Create `src/app/api/delivery/settings/route.ts`. Validate with zod, following the shape of the existing ad-platform-app settings route:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const Body = z.object({
  bringApiUid: z.string().trim().optional(),
  // Blank means "leave what is stored" — the browser never receives the secret,
  // so it cannot send it back, and requiring it would wipe the key on every
  // unrelated save.
  bringApiKey: z.string().optional(),
  bringClientUrl: z.string().trim().url().optional().or(z.literal('')),
  slackWebhookUrl: z.string().optional(),
  promises: z
    .array(
      z.object({
        country: z.string().trim().min(1).max(2).or(z.literal('*')),
        // At least one day. Zero would make every order late the moment it was
        // placed, which is the loudest possible way to be wrong.
        days: z.number().int().min(1).max(90),
        businessDays: z.boolean(),
        effectiveFrom: z.string(),
      }),
    )
    .optional(),
})

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const row = await db.deliveryConfig.findUnique({ where: { id: 'singleton' } })
    const promises = await db.deliveryPromise.findMany({
      orderBy: [{ country: 'asc' }, { effectiveFrom: 'desc' }],
    })
    return NextResponse.json(
      {
        bringApiUid: row?.bringApiUid ?? '',
        bringClientUrl: row?.bringClientUrl ?? '',
        // Never the secrets themselves, only whether they exist.
        hasBringKey: Boolean(row?.bringApiKey),
        hasSlackWebhook: Boolean(row?.slackWebhookUrl),
        lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        promises: promises.map((p) => ({
          ...p, effectiveFrom: p.effectiveFrom.toISOString().slice(0, 10),
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not load settings' }, { status: 500, headers: NO_STORE })
  }
}

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Check the values and try again.' },
        { status: 400, headers: NO_STORE },
      )
    }
    const b = parsed.data

    await db.deliveryConfig.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        bringApiUid: b.bringApiUid || null,
        bringApiKey: b.bringApiKey ? encryptSecret(b.bringApiKey) : null,
        bringClientUrl: b.bringClientUrl || null,
        slackWebhookUrl: b.slackWebhookUrl ? encryptSecret(b.slackWebhookUrl) : null,
      },
      update: {
        ...(b.bringApiUid !== undefined ? { bringApiUid: b.bringApiUid || null } : {}),
        ...(b.bringClientUrl !== undefined ? { bringClientUrl: b.bringClientUrl || null } : {}),
        // A blank secret leaves the stored one alone. Only a non-empty value replaces it.
        ...(b.bringApiKey ? { bringApiKey: encryptSecret(b.bringApiKey) } : {}),
        ...(b.slackWebhookUrl ? { slackWebhookUrl: encryptSecret(b.slackWebhookUrl) } : {}),
      },
    })

    if (b.promises) {
      // Rewritten wholesale rather than diffed: simpler and always correct, the
      // same choice storeOrder makes for order lines.
      await db.$transaction(async (tx) => {
        await tx.deliveryPromise.deleteMany()
        await tx.deliveryPromise.createMany({
          data: b.promises!.map((p) => ({
            country: p.country.toUpperCase(),
            days: p.days,
            businessDays: p.businessDays,
            effectiveFrom: new Date(`${p.effectiveFrom}T00:00:00Z`),
          })),
        })
      })
    }

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not save' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/api/delivery/settings/route.integration.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Add the test-connection route**

Create `src/app/api/delivery/test/route.ts`. Admin-only, `no-store`. `{ target: 'bring' }` calls `fetchTracking` with the stored credentials and one obviously-invalid number, treating **any non-error response as success** — the point is proving the credentials are accepted, not that the parcel exists. `{ target: 'slack' }` posts a real message reading `Delivery alerts are connected. This is a test.`

Both return `{ ok, message }` with a sentence a human can act on, never a raw stack.

An alerting feature nobody has seen fire is an alerting feature nobody trusts. These two buttons are the whole reason the client will believe the next silent week means "nothing is late" rather than "it broke".

- [ ] **Step 6: Build the settings page**

Create `src/app/settings/delivery/page.tsx` and `DeliverySettingsClient.tsx`, following the existing `settings/ad-accounts` pages for structure. Sections:

1. **Bring** — account email, API key (a password field, placeholder `Saved` when `hasBringKey`), client URL, and **Test connection**. Show `lastSyncAt` and `lastError`.
2. **Slack** — webhook URL (password field, placeholder `Saved`) and **Send test message**, with one line of help: create an incoming webhook at `https://api.slack.com/messaging/webhooks` and paste the URL.
3. **Delivery promises** — an editable table of country, days, business days, effective from, edited the way product costs are. A `*` row is labelled `All other countries`.
4. **Which shops are tracked** — one date field per shop, writing `Shop.deliveryTrackingFrom`. Blank means not tracked, and the help text says so in those words: "Leave blank if this shop does not ship from the Bring warehouse."
5. **Recent imports** — filename, when, parsed/linked/unmatched, and any error.

Add the nav entry to the `Setup` section of `AppShell.tsx`, after `Ad accounts`:

```tsx
      { href: '/settings/delivery', label: 'Delivery', icon: icon(<><path d="M3 7h11v10H3z" /><path d="M14 10h4l3 3v4h-7z" /><circle cx="7" cy="18" r="1.5" /><circle cx="17" cy="18" r="1.5" /></>) },
```

- [ ] **Step 7: Verify the whole thing in a browser**

Start the dev server bare in the background (never piped to `head`, which wedges it and holds the port):

```bash
npm run dev
```

Walk the real path end to end: save credentials, press both test buttons, add a promise, mark one shop tracked, upload the warehouse PDF on `/delivery`, and confirm the orders that matched now show a delivery state on `/orders`.

- [ ] **Step 8: Run everything and commit**

```bash
npm run test
npm run lint
npx tsc --noEmit
git rev-parse --abbrev-ref HEAD
git add src/app/api/delivery/ src/app/settings/delivery/ src/components/shell/AppShell.tsx
git commit -m "feat: delivery settings, promises per country, and test buttons for both integrations"
```

---

## Self-review

Run this against the spec before calling the plan done.

**Spec coverage.** Every section of the spec maps to a task: the data model to Task 1; `shippingCountry` to Task 2; polling and the tiered cadence to Task 8; the clock and the `READY_FOR_PICKUP` stop to Task 4; the per-country promise and business days to Task 9; the median, split and distribution to Tasks 10 and 11; the alert rule, the voided-order exclusion and the stamp-after-Slack ordering to Task 13; the settings page and its test buttons to Task 14. Phases 3 (inbound email) and 4 (NYCE) are deliberately absent — the spec defers both, and Task 7's `importTrackingFile(buf, filename, source)` already takes the `'EMAIL'` source that phase 3 will pass.

**Known soft spots, stated rather than hidden:**

- **Task 4 and Task 5 both depend on real files we do not have yet.** The mapper is written against Bring's documented field names and the parser against a guessed layout. Both tasks say plainly that the recorded fixture wins over the guess, and both end with an instruction to tighten the assertion once the real file exists. This is the honest state of it, not an oversight.
- **`nextPollFor` is written in Task 8 and re-wired in Task 9.** That is deliberate: Task 8 has to be independently testable before promises exist, and the alternative is one enormous task nobody can review.
- **The Delivery page and the settings page describe their sections rather than printing every line of JSX.** The data contracts above them are exact; the layout follows `ProductsClient.tsx` and `settings/ad-accounts`, which are in the repo. Copying two hundred lines of Tailwind into a plan would go stale faster than it would help.

**Type consistency.** `OrderDelivery`, `DeliveryState` and `DeliveryOrder` are defined once in Task 10 and consumed unchanged by Tasks 11, 12 and 13. `Milestones` is defined in Task 4 and consumed by Task 8. `ParsedRow` is defined in Task 5 and consumed by Tasks 6 and 7. `BringCredentials` is defined in Task 3 and consumed by Tasks 8 and 14.

