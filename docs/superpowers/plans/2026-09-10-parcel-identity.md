# Parcel Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parcels the warehouse file names are shown with the carrier that actually has them, everything we could not attach to an order sits in one list with its reason, candidate orders and a Link button, and repeat customers stop being refused when the answer is deterministic.

**Architecture:** The importer stops assuming every 373/473 number is Bring and stores what Bring did not resolve as carrier `UNKNOWN`; the poller identifies such rows (Bring first, DHL second, under DHL's budget) and writes the facts a person needs. Refused parcels become `Shipment` rows with a reason instead of JSON lines. The Delivery API computes candidate orders per unlinked parcel; a PATCH route links or dismisses by hand; the page shows one "Parcels without an order" section and a per-order note under "No tracking yet".

**Tech Stack:** Next.js 15 app routes, Prisma on PostgreSQL, vitest (projects `app` and `delivery`), Testing Library + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-parcel-identity-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/parcel-identity` on branch `feat/parcel-identity`. Never `git stash`, `git checkout --`, `git reset --hard` or `git clean`: other agents share this repository and those commands have silently reverted work before.
- Edit files with the Edit/Write tools only. Never rewrite a file through PowerShell `Get-Content`/`Set-Content` (it corrupts UTF-8).
- Test data convention: every integration test tags what it creates with a string unique to that file (for example `[parcel-identity-match-test]`) and deletes only what carries the tag, so files can run beside each other.
- Integration tests under `src/lib/{delivery,bring,dhl}/**/*.integration.test.ts` and `src/app/api/delivery/**` belong to the vitest `delivery` project and must be run with `npx vitest run --project delivery <path>`. Unit tests and `.test.tsx` files run in the `app` project: `npx vitest run --project app <path>`.
- The local Postgres must be running: `%LOCALAPPDATA%\panetti-pg\start-pg.cmd` (check with `pg_isready.exe`). Never point tests at a Neon URL.
- No em dashes anywhere, in code, comments, copy or commit messages. Use a plain hyphen.
- Customer emails are never sent to the browser on a parcel row. Recipient NAME may be shown; the email is server-side only.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75
  ```
- `Shipment.carrier` values: `BRING`, `DHL`, `UNKNOWN`. `Shipment.linkSource` gains `DHL_REF` (joined through a DHL Freight reference) beside `FILE | BRING_EMAIL | NYCE | WOO | MANUAL | DHL_FILE`.
- Copy on the page, verbatim from the spec: section heading **"Parcels without an order"**; "No tracking yet" sub-heading **"We hold no parcel for these orders. Some are simply not shipped yet. Where the warehouse file named a parcel we could not attach, the row says so and the parcel is listed below."**; per-order note **"A parcel for this customer was in the file of {date} but was not attached: {reason}"**; dismiss button **"Not a customer parcel"**; dismissal reason **"Not a customer parcel (dismissed by {email})"**; dead-number reason **"No carrier knew this number in 14 days"**; not-yet-identified text **"Not identified yet - the next check asks Bring, then DHL"**.

---

## File structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | Eight nullable columns on `Shipment`, comments on `carrier` and `linkSource`. |
| `src/lib/bring/consignments.ts` | Reads destination country, weight and booking time off Bring's answer, beside the email it already reads. |
| `src/lib/bring/match.ts` | The email match, with the two new candidate rules behind a `MatchScope`. |
| `src/lib/bring/import.ts` | Stores refused consignments as rows, stores unresolved numbers as `UNKNOWN`, loses its retry stage. |
| `src/lib/delivery/identify.ts` (new) | Pure: carrier facts from a raw Bring or DHL answer; the 14-day rule. DB: apply an identification (facts, events, link attempt) or an "unknown" outcome to a row. |
| `src/lib/delivery/sync.ts` | The poll loop asks the carriers for `UNKNOWN` rows, flips an unlinked `BRING` row Bring does not know to `UNKNOWN`, re-matches unlinked Bring rows by email. |
| `src/lib/delivery/tracking-url.ts` | No link for `UNKNOWN`; DHL's unified page for 18-digit numbers. |
| `src/lib/delivery/view.ts` | `Parcel.url` becomes nullable. |
| `src/lib/delivery/candidates.ts` (new) | Candidate orders for an unlinked parcel, by email or by country. |
| `src/app/api/delivery/parcels/[trackingNumber]/route.ts` (new) | PATCH: link by hand, or dismiss. |
| `src/app/api/delivery/route.ts` | Unlinked rows carry facts, reason and candidates; no-tracking rows carry the refused-parcel note. |
| `src/lib/delivery/load.ts` | Selects `customerEmail` (server-side only) so the note can be matched. |
| `src/app/delivery/DeliveryClient.tsx` | The "Parcels without an order" section with Link and dismiss; the note under "No tracking yet". |
| `e2e/delivery-link-by-hand.spec.ts` (new) | A parcel is linked by hand and both lists update. |

---

### Task 0: Worktree setup

**Files:** none changed.

- [ ] **Step 1: Give the worktree an environment and dependencies**

```bash
cd "C:/Users/Acer Philippines/OneDrive/Desktop/Philip project/panetti/.claude/worktrees/parcel-identity"
cp ../../../.env .env
npm ci
npx prisma generate
```

- [ ] **Step 2: Make sure the local database is up and matches the schema**

```bash
"$LOCALAPPDATA/panetti-pg/pgsql/bin/pg_isready.exe" || cmd //c "%LOCALAPPDATA%\panetti-pg\start-pg.cmd"
npx prisma db push
```

- [ ] **Step 3: Smoke-run one delivery test to prove the setup**

Run: `npx vitest run --project delivery src/lib/bring/match.integration.test.ts`
Expected: all tests pass.

---

### Task 1: Schema

**Files:**
- Modify: `prisma/schema.prisma:683-741` (model `Shipment`)

**Interfaces:**
- Produces: `Shipment.consignmentId`, `destinationCountry`, `weightKg`, `recipientEmail`, `recipientName`, `unlinkedReason`, `identifiedAt`, `dismissedAt`, all nullable. Every later task reads or writes these names exactly.

- [ ] **Step 1: Add the columns and update the comments**

In `prisma/schema.prisma`, replace

```prisma
  carrier        String  @default("BRING")
  orderId        String?
  /// Which strategy produced the link: FILE | BRING_EMAIL | NYCE | WOO | MANUAL.
  /// BRING_EMAIL is the warehouse-file path: the file gives only parcel numbers,
  /// Bring gives the recipient email, and that matches Order.customerEmail.
  linkSource     String?
```

with

```prisma
  /// BRING | DHL | UNKNOWN. UNKNOWN is a number from the warehouse file that
  /// Bring did not resolve at import time. The warehouse prints one label
  /// series for every carrier it ships with, so the number says who packed
  /// the parcel, not who carries it; the poller asks Bring, then DHL, and the
  /// first to answer owns the row (lib/delivery/identify.ts).
  carrier        String  @default("BRING")
  orderId        String?
  /// Which strategy produced the link: FILE | BRING_EMAIL | NYCE | WOO |
  /// MANUAL | DHL_FILE | DHL_REF.
  /// BRING_EMAIL is the warehouse-file path: the file gives only parcel numbers,
  /// Bring gives the recipient email, and that matches Order.customerEmail.
  /// DHL_REF joins a DHL Freight piece to the order its 10-digit consignment
  /// number (written by the DHL_FILE path) already belongs to.
  linkSource     String?

  /// The carrier's id for the whole consignment (Bring consignmentId, DHL
  /// shipment id). Two boxes of one order share it, and that is what lets the
  /// email match refuse an order that already holds ANOTHER consignment's
  /// parcel without refusing the second box of this one.
  consignmentId      String?
  /// ISO-2, upper case, from the carrier. Candidates are filtered by it.
  destinationCountry String?
  weightKg           Float?
  /// Lower-cased. Bring only; DHL returns no recipient. Server-side only:
  /// never sent to the browser on a parcel row.
  recipientEmail     String?
  recipientName      String?
  /// Why this parcel has no order, in words fit for the Delivery page. Null
  /// once linked.
  unlinkedReason     String?
  /// When a carrier first answered about this number. Null means no carrier
  /// has been asked yet, which is a different fact from "asked, nobody knows".
  identifiedAt       DateTime?
  /// Set by a person who declared this is not a customer parcel (pallet
  /// freight, inbound stock). Such rows leave the list but stay in the table.
  dismissedAt        DateTime?
```

- [ ] **Step 2: Push the schema and regenerate the client**

Run:
```bash
npx prisma db push
npx prisma generate
```
Expected: "Your database is now in sync with your Prisma schema" and a generated client.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(delivery): a parcel row remembers who carries it, where it goes and why it has no order

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 2: Bring's answer carries country, weight and booking time

**Files:**
- Modify: `src/lib/bring/consignments.ts`
- Test: `src/lib/bring/consignments.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ResolvedConsignment = {
    consignmentId: string
    packageNumbers: string[]
    recipientEmail: string | null
    recipientName: string | null
    destinationCountry: string | null // ISO-2 upper case
    weightKg: number | null
    bookedAt: Date | null // earliest event across the consignment's packages
  }
  ```
  Task 4 passes `bookedAt` and `consignmentId` to the matcher and writes all three new fields on rows.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/bring/consignments.test.ts`, inside `describe('resolveConsignments', ...)`:

```ts
  it('reads the destination country, the weight and the earliest event as the booking time', async () => {
    fetchTracking.mockResolvedValue([
      {
        consignmentId: '73325383681096808',
        recipientName: 'Test Person',
        packageSet: [
          {
            packageNumber: '473325380023135087',
            recipientEmailAddress: 'buyer@example.test',
            weightInKgs: 16,
            recipientAddress: { countryCode: 'dk', city: 'Rønne' },
            eventSet: [
              { status: 'IN_TRANSIT', dateIso: '2026-09-08T06:00:00+02:00' },
              { status: 'PRE_NOTIFIED', dateIso: '2026-09-07T10:17:14+02:00' },
            ],
          },
          {
            packageNumber: '473325380023135094',
            weightInKgs: 0.7,
            eventSet: [{ status: 'PRE_NOTIFIED', dateIso: '2026-09-07T10:17:20+02:00' }],
          },
        ],
      },
    ])
    const { consignments } = await resolveConsignments(CREDS, ['473325380023135087'])
    expect(consignments[0]).toMatchObject({
      destinationCountry: 'DK',
      weightKg: 16,
      bookedAt: new Date('2026-09-07T08:17:14.000Z'),
    })
  })

  it('leaves country, weight and booking time null when Bring gives none', async () => {
    fetchTracking.mockResolvedValue([reply('7332538366', [{ packageNumber: '373325386490923366' }])])
    const { consignments } = await resolveConsignments(CREDS, ['373325386490923366'])
    expect(consignments[0]).toMatchObject({ destinationCountry: null, weightKg: null, bookedAt: null })
  })
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project app src/lib/bring/consignments.test.ts`
Expected: FAIL, the first new test reports `destinationCountry: undefined`.

- [ ] **Step 3: Extend the resolver**

In `src/lib/bring/consignments.ts`, replace the `ResolvedConsignment` type with:

```ts
export type ResolvedConsignment = {
  consignmentId: string
  /** Every package in this consignment. One Shipment row will be written per entry. */
  packageNumbers: string[]
  /** Lower-cased. Null when Bring holds no email for the parcel. */
  recipientEmail: string | null
  recipientName: string | null
  /** ISO-2, upper case, off the first package that carries an address. */
  destinationCountry: string | null
  /** The first package's weight. Two boxes report separately; the first is enough to tell a chair from a whisk. */
  weightKg: number | null
  /**
   * The earliest event across every package, whatever its status. That is the
   * moment the label existed, and an order placed after it cannot be the one
   * the label is for - the upper bound match.ts uses.
   */
  bookedAt: Date | null
}
```

Then replace the package loop and the push:

```ts
    const packageNumbers: string[] = []
    let recipientEmail: string | null = null
    let destinationCountry: string | null = null
    let weightKg: number | null = null
    let bookedAt: Date | null = null

    for (const pkg of packages) {
      const p = pkg as {
        packageNumber?: unknown
        recipientEmailAddress?: unknown
        weightInKgs?: unknown
        recipientAddress?: { countryCode?: unknown }
        eventSet?: unknown
      }
      const n = str(p?.packageNumber)
      if (n) packageNumbers.push(n)
      if (!recipientEmail) {
        const e = str(p?.recipientEmailAddress)
        if (e) recipientEmail = e.toLowerCase()
      }
      if (!destinationCountry) {
        const c = str(p?.recipientAddress?.countryCode)
        if (c) destinationCountry = c.toUpperCase()
      }
      if (weightKg === null && typeof p?.weightInKgs === 'number' && Number.isFinite(p.weightInKgs)) {
        weightKg = p.weightInKgs
      }
      for (const ev of Array.isArray(p?.eventSet) ? p.eventSet : []) {
        const iso = str((ev as { dateIso?: unknown })?.dateIso)
        if (!iso) continue
        const when = new Date(iso)
        if (Number.isNaN(when.getTime())) continue
        if (!bookedAt || when < bookedAt) bookedAt = when
      }
    }
```

and

```ts
    consignments.push({
      consignmentId,
      packageNumbers,
      recipientEmail,
      recipientName: str(first?.recipientName),
      destinationCountry,
      weightKg,
      bookedAt,
    })
```

- [ ] **Step 4: Run the file's tests**

Run: `npx vitest run --project app src/lib/bring/consignments.test.ts`
Expected: PASS. The existing `toEqual` test on the recipient email now fails because the object has three more keys: change that assertion's expected object to include `destinationCountry: null, weightKg: null, bookedAt: null`.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` (the import test in Task 4 will be updated then; `import-email.integration.test.ts` mocks return partial objects and compiles because the mock is `vi.fn()`).

```bash
git add src/lib/bring/consignments.ts src/lib/bring/consignments.test.ts
git commit -m "feat(delivery): read where a Bring parcel goes, what it weighs and when its label was made

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 3: Two new rules in the email match

**Files:**
- Modify: `src/lib/bring/match.ts`
- Test: `src/lib/bring/match.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MatchScope = { bookedAt?: Date | null; consignmentId?: string | null }
  export async function matchByEmail(email: string | null, receivedAt: Date, scope?: MatchScope): Promise<MatchOutcome>
  ```
  Existing callers pass two arguments and keep working.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/bring/match.integration.test.ts`, inside `describe('matchByEmail', ...)`. Note the file's `order()` helper and `RECEIVED` constant.

```ts
  it('does not offer an order that already holds another consignment\'s parcel', async () => {
    const held = await order(trackedShopId, 'PM-HELD', 'twice@example.test', '2026-08-01T10:00:00Z')
    await order(trackedShopId, 'PM-OPEN', 'twice@example.test', '2026-08-02T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: 'PMATCH-HELD-1', orderId: held.id, consignmentId: 'CONS-OLD', carrier: 'BRING' },
    })
    try {
      const r = await matchByEmail('twice@example.test', RECEIVED, { consignmentId: 'CONS-NEW' })
      expect(r.orderId).not.toBeNull()
      const linked = await db.order.findUnique({ where: { id: r.orderId! }, select: { number: true } })
      expect(linked?.number).toBe('PM-OPEN')
    } finally {
      await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'PMATCH-' } } })
    }
  })

  it('still offers the order when the parcel it holds is this same consignment - the second box', async () => {
    const same = await order(trackedShopId, 'PM-SAME', 'box@example.test', '2026-08-01T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: 'PMATCH-SAME-1', orderId: same.id, consignmentId: 'CONS-SAME', carrier: 'BRING' },
    })
    try {
      const r = await matchByEmail('box@example.test', RECEIVED, { consignmentId: 'CONS-SAME' })
      expect(r.orderId).toBe(same.id)
    } finally {
      await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'PMATCH-' } } })
    }
  })

  it('treats a held parcel with no consignment id as another consignment, so it can only refuse', async () => {
    const held = await order(trackedShopId, 'PM-NOID', 'noid@example.test', '2026-08-01T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: 'PMATCH-NOID-1', orderId: held.id, carrier: 'BRING' },
    })
    try {
      const r = await matchByEmail('noid@example.test', RECEIVED, { consignmentId: 'CONS-X' })
      expect(r.orderId).toBeNull()
      expect((r as { reason: string }).reason).toBe('No order for noid@example.test')
    } finally {
      await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'PMATCH-' } } })
    }
  })

  it('uses the booking time, not the file time, as the upper bound', async () => {
    await order(trackedShopId, 'PM-EARLY', 'twins@example.test', '2026-08-10T08:00:00Z')
    await order(trackedShopId, 'PM-LATE', 'twins@example.test', '2026-08-10T20:00:00Z')
    // Booked at noon: only the morning order existed then.
    const r = await matchByEmail('twins@example.test', RECEIVED, { bookedAt: new Date('2026-08-10T12:00:00Z') })
    expect(r.orderId).not.toBeNull()
    const linked = await db.order.findUnique({ where: { id: r.orderId! }, select: { number: true } })
    expect(linked?.number).toBe('PM-EARLY')
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project delivery src/lib/bring/match.integration.test.ts`
Expected: the four new tests FAIL (two candidates refused where one was expected; wrong twin).

- [ ] **Step 3: Implement the scope**

In `src/lib/bring/match.ts`, replace the signature and the query:

```ts
/**
 * What the caller knows about the parcel beyond its email.
 *
 * `bookedAt` is when the label was made. An order placed after that cannot be
 * the one the label is for, so it replaces the file's arrival time as the
 * upper bound when known. `consignmentId` is the carrier's id for the whole
 * consignment: an order already holding a parcel from ANOTHER consignment is
 * not a candidate, while one holding this consignment's first box still is.
 */
export type MatchScope = { bookedAt?: Date | null; consignmentId?: string | null }

export async function matchByEmail(
  email: string | null,
  receivedAt: Date,
  scope: MatchScope = {},
): Promise<MatchOutcome> {
  if (!email) return { orderId: null, reason: 'Bring holds no email for this parcel' }

  const upper = scope.bookedAt ?? receivedAt

  /**
   * "Holds a parcel from another consignment". A held parcel with no
   * consignment id recorded (rows written before the column existed) counts
   * as another consignment: the rule can then only refuse, never wrongly
   * accept, which is the side a wrong link must always land on.
   */
  const heldByAnother = scope.consignmentId
    ? { OR: [{ consignmentId: null }, { consignmentId: { not: scope.consignmentId } }] }
    : {}

  const orders = await db.order.findMany({
    where: {
      customerEmail: { equals: email, mode: 'insensitive' },
      shop: { deliveryTrackingFrom: { not: null } },
      placedAt: {
        gte: new Date(upper.getTime() - MATCH_WINDOW_DAYS * DAY),
        lte: upper,
      },
      voidedAt: null,
      NOT: { shipments: { some: heldByAnother } },
    },
    select: { id: true, number: true },
    take: CANDIDATES_NAMED + 1,
    orderBy: { placedAt: 'asc' },
  })
```

Keep the rest of the function as it is. Update the docstring above the function: after the paragraph about `receivedAt`, add "When the caller knows the booking time it is used instead - see MatchScope."

- [ ] **Step 4: Run the file**

Run: `npx vitest run --project delivery src/lib/bring/match.integration.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bring/match.ts src/lib/bring/match.integration.test.ts
git commit -m "feat(delivery): a repeat customer's second order is matched, not refused, when the answer is certain

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 4: The importer stores what it refused and marks what it could not identify

**Files:**
- Modify: `src/lib/bring/import.ts` (function `importWarehouseFile`)
- Test: `src/lib/bring/import-email.integration.test.ts`

**Interfaces:**
- Consumes: `ResolvedConsignment` (Task 2), `matchByEmail(email, receivedAt, scope)` (Task 3).
- Produces: rows with `carrier: 'UNKNOWN'` for unresolved Bring-shaped numbers; refused consignments as unlinked `BRING` rows carrying `recipientEmail`, `recipientName`, `destinationCountry`, `weightKg`, `consignmentId`, `bookedAt`, `unlinkedReason`, `nextPollAt` = receivedAt + 24 h. The retry stage is gone.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/bring/import-email.integration.test.ts` inside `describe('importWarehouseFile', ...)`. The file's `PREFIX` is `IMIMP`, its cleanup deletes shipments by that prefix and by `373999999`/`473999999`, and its one order has email `buyer@example.test`.

```ts
  it('stores a refused consignment as unlinked rows that say why', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C-REF`,
          packageNumbers: [`${PREFIX}0301`, `${PREFIX}0302`],
          recipientEmail: 'nobody@example.test',
          recipientName: 'No Body',
          destinationCountry: 'NO',
          weightKg: 16.5,
          bookedAt: new Date('2026-08-11T08:19:24Z'),
        },
      ],
      unresolved: [],
    })
    const r = await importWarehouseFile(book([`${PREFIX}0301`]), 'eod.xlsx', 'EMAIL')
    expect(r.linked).toBe(0)
    expect(r.unmatched).toHaveLength(1)

    const rows = await db.shipment.findMany({
      where: { trackingNumber: { in: [`${PREFIX}0301`, `${PREFIX}0302`] } },
      orderBy: { trackingNumber: 'asc' },
    })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.orderId).toBeNull()
      expect(row.carrier).toBe('BRING')
      expect(row.recipientEmail).toBe('nobody@example.test')
      expect(row.recipientName).toBe('No Body')
      expect(row.destinationCountry).toBe('NO')
      expect(row.weightKg).toBe(16.5)
      expect(row.consignmentId).toBe(`${PREFIX}C-REF`)
      expect(row.unlinkedReason).toBe('No order for nobody@example.test')
      expect(row.identifiedAt).not.toBeNull()
      expect(row.nextPollAt).not.toBeNull()
    }
  })

  it('writes the carrier facts on a linked row too', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C-OK`,
          packageNumbers: [`${PREFIX}0401`],
          recipientEmail: 'buyer@example.test',
          recipientName: 'Buyer',
          destinationCountry: 'NO',
          weightKg: 2,
          bookedAt: new Date('2026-08-11T08:19:24Z'),
        },
      ],
      unresolved: [],
    })
    await importWarehouseFile(book([`${PREFIX}0401`]), 'eod.xlsx', 'EMAIL')
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${PREFIX}0401` } })
    expect(row?.orderId).not.toBeNull()
    expect(row?.consignmentId).toBe(`${PREFIX}C-OK`)
    expect(row?.destinationCountry).toBe('NO')
    expect(row?.unlinkedReason).toBeNull()
  })

  it('stores a number Bring does not know as carrier UNKNOWN, for the poller to identify', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [{ number: '473999999000000001', reason: 'Bring has no parcel with this number' }],
    })
    const r = await importWarehouseFile(book(['473999999000000001']), 'eod.xlsx', 'EMAIL')
    expect(r.unmatched[0].reason).toMatch(/not heard of this parcel yet/)
    const row = await db.shipment.findUnique({ where: { trackingNumber: '473999999000000001' } })
    expect(row?.carrier).toBe('UNKNOWN')
    expect(row?.orderId).toBeNull()
    expect(row?.identifiedAt).toBeNull()
    expect(row?.nextPollAt).not.toBeNull()
  })

  it('no longer retries stored numbers itself - that is the poller\'s job now', async () => {
    await db.shipment.create({
      data: { trackingNumber: '473999999000000002', carrier: 'UNKNOWN', nextPollAt: new Date() },
    })
    resolveConsignments.mockResolvedValue({ consignments: [], unresolved: [] })
    // A real-shaped number: the reader keeps only runs of 15 or more digits.
    await importWarehouseFile(book(['473999999000000003']), 'eod.xlsx', 'EMAIL')
    // One call, for the file's own numbers. A second call would be the old retry stage.
    expect(resolveConsignments).toHaveBeenCalledTimes(1)
    expect(resolveConsignments.mock.calls[0][1]).toEqual(['473999999000000003'])
  })
```

Add `beforeEach(() => resolveConsignments.mockReset())` next to the existing `beforeAll` if the file does not already reset the mock per test (check the top of the file; add it if absent).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project delivery src/lib/bring/import-email.integration.test.ts`
Expected: the four new tests FAIL (no rows for the refused consignment; carrier `BRING` instead of `UNKNOWN`; two resolver calls).

- [ ] **Step 3: Rewrite the middle of `importWarehouseFile`**

In `src/lib/bring/import.ts`, inside the big `try` of `importWarehouseFile`, delete the whole "Yesterday's too-early parcels, retried tonight" block (from the comment `/** Yesterday's too-early parcels ...` through its closing `catch {}`), then replace the consignment loop and the unresolved loop with:

```ts
    ;({ consignments, unresolved } = await resolveConsignments(creds, numbers, opts))

    for (const c of consignments) {
      const facts = {
        carrier: 'BRING',
        consignmentId: c.consignmentId,
        destinationCountry: c.destinationCountry,
        weightKg: c.weightKg,
        recipientEmail: c.recipientEmail,
        recipientName: c.recipientName,
        bookedAt: c.bookedAt,
        identifiedAt: receivedAt,
      }
      const outcome = await matchByEmail(c.recipientEmail, receivedAt, {
        bookedAt: c.bookedAt,
        consignmentId: c.consignmentId,
      })
      if (outcome.orderId === null) {
        unmatched.push({
          orderNumber: c.recipientName ?? c.consignmentId,
          trackingNumber: c.packageNumbers[0],
          reason: outcome.reason,
        })
        // Stored, not dropped. A refusal used to survive only as a line of
        // JSON on the import; as a row it is listed on the Delivery page with
        // its reason and candidates, and the poller re-runs the match nightly
        // so a refusal the rules later resolve (the twin order gets its own
        // parcel) resolves itself. Due tomorrow: the parcel is not moving yet
        // and a person may link it first.
        for (const trackingNumber of c.packageNumbers) {
          await db.shipment.upsert({
            where: { trackingNumber },
            create: {
              trackingNumber,
              ...facts,
              unlinkedReason: outcome.reason,
              nextPollAt: new Date(receivedAt.getTime() + 24 * 60 * 60 * 1000),
            },
            // Never unlinks: a row a person or an earlier night already
            // attached keeps its order, and only learns the facts.
            update: { ...facts },
          })
        }
        continue
      }
      for (const trackingNumber of c.packageNumbers) {
        await db.shipment.upsert({
          where: { trackingNumber },
          // Due immediately, so the next cron run picks it up.
          create: {
            trackingNumber,
            ...facts,
            orderId: outcome.orderId,
            linkSource: 'BRING_EMAIL',
            unlinkedReason: null,
            nextPollAt: new Date(),
          },
          // Only the link and the facts. Milestones, events and poll state are
          // the sync's to own, and a re-import must not undo a week of tracking.
          update: { ...facts, orderId: outcome.orderId, linkSource: 'BRING_EMAIL', unlinkedReason: null },
        })
      }
      // Once per CONSIGNMENT, not per package: a two-package consignment
      // that matches still counts once here, so `linked` stays in the same
      // unit as `parsed` below and the two totals actually add up.
      linked++
    }

    for (const u of unresolved) {
      // A Bring-shaped number Bring does not know is not a verdict: the
      // warehouse prints one label series for every carrier it ships with, so
      // the number says who packed the parcel, not who carries it (17 of 17
      // such numbers checked on 2026-09-10 were DHL's). Stored with carrier
      // UNKNOWN and due now; the poller asks Bring again, then DHL, and the
      // first to answer owns the row - see lib/delivery/identify.ts.
      if (BRING_SHAPED.test(u.number)) {
        await db.shipment.upsert({
          where: { trackingNumber: u.number },
          create: { trackingNumber: u.number, carrier: 'UNKNOWN', nextPollAt: new Date() },
          // Adopt, never reset: it may already be identified, or mid-way.
          update: {},
        })
        unmatched.push({
          orderNumber: '(not identified)',
          trackingNumber: u.number,
          reason:
            u.reason === 'Bring has no parcel with this number'
              ? 'Bring has not heard of this parcel yet - stored, the next check asks Bring again, then DHL'
              : `${u.reason} - stored, it will be retried by the next check`,
        })
        continue
      }
      unmatched.push({
        orderNumber: '(not identified)',
        trackingNumber: u.number,
        reason: u.reason,
      })
    }
```

Also delete the now-unused `import { matchByEmail } from './match'`? No: it is still used. Delete nothing else. Update the `BRING_SHAPED` docstring's last sentence to: "A 473 or 373 number Bring does not know is stored as carrier UNKNOWN for the poller to identify; see the loop below."

- [ ] **Step 4: Run the file, then the whole bring folder**

Run: `npx vitest run --project delivery src/lib/bring/`
Expected: PASS. If an existing test asserted the retry stage (search the file for "retried" or a second `resolveConsignments` call), delete that test: the behaviour moved to the poller by design (spec section 1).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bring/import.ts src/lib/bring/import-email.integration.test.ts
git commit -m "feat(delivery): the importer keeps what it refused and stops calling every unknown number a Bring parcel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 5: Carrier facts from a raw answer (pure)

**Files:**
- Create: `src/lib/delivery/identify.ts`
- Create: `src/lib/delivery/__fixtures__/dhl-ecommerce.json`, `src/lib/delivery/__fixtures__/dhl-freight.json`, `src/lib/delivery/__fixtures__/bring-consignment.json`
- Test: `src/lib/delivery/identify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CarrierFacts = {
    carrier: 'BRING' | 'DHL'
    consignmentId: string | null
    destinationCountry: string | null
    weightKg: number | null
    recipientEmail: string | null
    recipientName: string | null
    /** DHL Freight's 10-digit consignment numbers; [] for Bring and for DHL eCommerce. */
    references: string[]
    /** Events and milestones for the tracking number asked about. */
    package: MappedPackage | null
  }
  export function bringFacts(raw: unknown[], trackingNumber: string): CarrierFacts | null
  export function dhlFacts(raw: unknown, trackingNumber: string): CarrierFacts | null
  export const UNKNOWN_GRACE_DAYS = 14
  export function unknownNext(createdAt: Date, now: Date): { terminal: boolean; nextPollAt: Date | null; lastError: string; unlinkedReason: string | null }
  ```

- [ ] **Step 1: Save the fixtures**

Create `src/lib/delivery/__fixtures__/dhl-ecommerce.json` (captured 2026-09-10 from api-eu.dhl.com, city masked):

```json
{
  "shipments": [
    {
      "id": "00473325380023179098",
      "service": "ecommerce-europe",
      "division": "DHL eCommerce",
      "origin": { "address": { "countryCode": "SE" } },
      "destination": { "address": { "countryCode": "DE" } },
      "status": {
        "timestamp": "2026-09-10T08:47:22+02:00",
        "location": { "address": { "addressLocality": "Ot", "countryCode": "DE" } },
        "statusCode": "transit",
        "status": "42",
        "description": "The shipment has been loaded to the van"
      },
      "returnFlag": false,
      "details": {
        "product": { "deliveryMethodRemark": "doorstep", "productName": "DHL Parcel Connect" },
        "provider": { "destinationProvider": "parcel-de" },
        "proofOfDeliverySignedAvailable": false,
        "totalNumberOfPieces": 1,
        "pieceIds": ["00473325380023179098"],
        "weight": { "unitText": "KG", "value": 18.2 }
      },
      "events": [
        {
          "timestamp": "2026-09-10T08:47:22+02:00",
          "location": { "address": { "addressLocality": "Ot", "countryCode": "DE" } },
          "statusCode": "transit",
          "status": "42",
          "description": "The shipment has been loaded to the van"
        },
        {
          "timestamp": "2026-09-08T16:16:34+02:00",
          "location": { "address": { "addressLocality": "Ne", "countryCode": "DE" } },
          "statusCode": "transit",
          "status": "33",
          "description": "The shipment has arrived in destination country"
        },
        {
          "timestamp": "2026-09-07T19:30:00+02:00",
          "location": { "address": { "countryCode": "SE" } },
          "statusCode": "pre-transit",
          "status": "0",
          "description": "The shipment has been announced"
        }
      ]
    }
  ]
}
```

Create `src/lib/delivery/__fixtures__/dhl-freight.json`:

```json
{
  "shipments": [
    {
      "id": "JKG-HI-0001643",
      "service": "freight",
      "origin": { "address": { "countryCode": "SE" } },
      "destination": { "address": { "countryCode": "FI" } },
      "status": {
        "timestamp": "2026-09-10T04:23:00",
        "location": { "address": { "addressLocality": "ST", "countryCode": "SE" } },
        "statusCode": "transit",
        "status": "1-0",
        "description": "Received at terminal"
      },
      "returnFlag": false,
      "details": {
        "product": { "productCode": "HD", "productName": "DHL Home Delivery" },
        "proofOfDeliverySignedAvailable": false,
        "totalNumberOfPieces": 1,
        "pieceIds": ["00473325380028549070"],
        "weight": { "unitText": "KGM", "value": 154 },
        "volume": { "unitText": "MTQ", "value": 1.344 },
        "loadingMeters": 0.4,
        "references": [
          { "number": "JKG-HI-0001643", "type": "shipment-id" },
          { "number": "6109278751", "type": "domestic-consignment-id" },
          { "number": "00063491697", "type": "domestic-consignment-id" }
        ]
      },
      "events": [
        {
          "timestamp": "2026-09-10T04:23:00",
          "location": { "address": { "addressLocality": "ST", "countryCode": "SE" } },
          "statusCode": "transit",
          "status": "1-0",
          "description": "Received at terminal"
        },
        {
          "timestamp": "2026-09-09T13:05:00",
          "location": { "address": { "addressLocality": "GO", "countryCode": "SE" } },
          "statusCode": "pre-transit",
          "status": "ACT-2",
          "description": "Consignment created"
        }
      ]
    }
  ]
}
```

Create `src/lib/delivery/__fixtures__/bring-consignment.json` (shape of a live answer for parcel 473325380023135087 on 2026-09-10, personal fields replaced):

```json
[
  {
    "consignmentId": "73325383681096808",
    "recipientName": "Test Person",
    "senderReference": "028221",
    "packageSet": [
      {
        "packageNumber": "473325380023135094",
        "productName": "PickUp Parcel Bulk",
        "weightInKgs": 0.7,
        "recipientName": "Test Person",
        "recipientEmailAddress": "Buyer@Example.TEST",
        "recipientAddress": { "city": "Ronne", "country": "Denmark", "countryCode": "DK", "postalCode": "3700" },
        "eventSet": [
          { "status": "READY_FOR_PICKUP", "dateIso": "2026-09-09T09:12:00+02:00", "description": "Ready for pickup", "city": "Ronne", "countryCode": "DK" },
          { "status": "PRE_NOTIFIED", "dateIso": "2026-09-07T10:17:20+02:00", "description": "Pre-notified", "city": "Jonkoping", "countryCode": "SE" }
        ]
      },
      {
        "packageNumber": "473325380023135087",
        "productName": "PickUp Parcel Bulk",
        "weightInKgs": 16,
        "recipientName": "Test Person",
        "recipientEmailAddress": "Buyer@Example.TEST",
        "recipientAddress": { "city": "Ronne", "country": "Denmark", "countryCode": "DK", "postalCode": "3700" },
        "eventSet": [
          { "status": "READY_FOR_PICKUP", "dateIso": "2026-09-09T09:12:00+02:00", "description": "Ready for pickup", "city": "Ronne", "countryCode": "DK" },
          { "status": "PRE_NOTIFIED", "dateIso": "2026-09-07T10:17:14+02:00", "description": "Pre-notified", "city": "Jonkoping", "countryCode": "SE" }
        ]
      }
    ]
  }
]
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/delivery/identify.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import ecommerce from './__fixtures__/dhl-ecommerce.json'
import freight from './__fixtures__/dhl-freight.json'
import bring from './__fixtures__/bring-consignment.json'
import { bringFacts, dhlFacts, unknownNext, UNKNOWN_GRACE_DAYS } from './identify'

const DAY = 24 * 60 * 60 * 1000

describe('dhlFacts', () => {
  it('reads a DHL eCommerce parcel: country, weight, no references, events mapped', () => {
    const f = dhlFacts(ecommerce, '473325380023179098')!
    expect(f.carrier).toBe('DHL')
    expect(f.consignmentId).toBe('00473325380023179098')
    expect(f.destinationCountry).toBe('DE')
    expect(f.weightKg).toBe(18.2)
    expect(f.references).toEqual([])
    expect(f.recipientEmail).toBeNull()
    expect(f.package?.events).toHaveLength(3)
    expect(f.package?.milestones.handedInAt).not.toBeNull()
  })

  it('reads a DHL Freight shipment: the 10-digit consignment numbers are its references', () => {
    const f = dhlFacts(freight, '473325380028549070')!
    expect(f.destinationCountry).toBe('FI')
    expect(f.weightKg).toBe(154)
    expect(f.consignmentId).toBe('JKG-HI-0001643')
    expect(f.references).toEqual(['6109278751', '00063491697'])
    expect(f.package?.trackingNumber).toBe('473325380028549070')
  })

  it('is null when DHL returned no shipment', () => {
    expect(dhlFacts({ shipments: [] }, '1')).toBeNull()
    expect(dhlFacts(null, '1')).toBeNull()
  })
})

describe('bringFacts', () => {
  it('reads the consignment and the events of the package asked about', () => {
    const f = bringFacts(bring, '473325380023135087')!
    expect(f.carrier).toBe('BRING')
    expect(f.consignmentId).toBe('73325383681096808')
    expect(f.recipientEmail).toBe('buyer@example.test')
    expect(f.recipientName).toBe('Test Person')
    expect(f.destinationCountry).toBe('DK')
    expect(f.weightKg).toBe(16)
    expect(f.references).toEqual([])
    expect(f.package?.trackingNumber).toBe('473325380023135087')
    expect(f.package?.milestones.bookedAt).toEqual(new Date('2026-09-07T08:17:14.000Z'))
  })

  it('is null for an error entry or an empty answer', () => {
    expect(bringFacts([{ error: { code: 404, message: 'No shipments found' } }], '1')).toBeNull()
    expect(bringFacts([], '1')).toBeNull()
  })
})

describe('unknownNext', () => {
  const now = new Date('2026-09-10T12:00:00Z')

  it('asks again tomorrow while the number is young', () => {
    const r = unknownNext(new Date(now.getTime() - 2 * DAY), now)
    expect(r.terminal).toBe(false)
    expect(r.nextPollAt).toEqual(new Date(now.getTime() + DAY))
    expect(r.lastError).toBe('Neither Bring nor DHL knows this number')
    expect(r.unlinkedReason).toBeNull()
  })

  it('gives up after the grace period and says so in the reason', () => {
    const r = unknownNext(new Date(now.getTime() - (UNKNOWN_GRACE_DAYS + 1) * DAY), now)
    expect(r.terminal).toBe(true)
    expect(r.nextPollAt).toBeNull()
    expect(r.unlinkedReason).toBe('No carrier knew this number in 14 days')
  })
})
```

- [ ] **Step 3: Run to see it fail**

Run: `npx vitest run --project app src/lib/delivery/identify.test.ts`
Expected: FAIL, module `./identify` not found.

- [ ] **Step 4: Write the pure module**

Create `src/lib/delivery/identify.ts`:

```ts
import { mapConsignments } from '../bring/map'
import { mapShipments } from '../dhl/map'
import { str, type MappedPackage } from './milestones'

/**
 * Who has a parcel, and what they said about it.
 *
 * The warehouse prints one label series for every carrier it ships with, so
 * a number from its file says who packed the parcel, not who carries it. On
 * 2026-09-10, 17 of 17 "Bring" numbers Bring had never heard of were DHL's.
 * So an unlinked number is asked of Bring, then DHL, and the first to answer
 * owns the row. This file turns each carrier's raw answer into the same
 * facts; the database side (applyIdentification, applyUnknown) lives below.
 */

export type CarrierFacts = {
  carrier: 'BRING' | 'DHL'
  consignmentId: string | null
  destinationCountry: string | null
  weightKg: number | null
  recipientEmail: string | null
  recipientName: string | null
  /** DHL Freight's 10-digit consignment numbers; [] for Bring and for DHL eCommerce. */
  references: string[]
  /** Events and milestones for the tracking number asked about. */
  package: MappedPackage | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Bring's answer for one number: the consignment it belongs to, or null. */
export function bringFacts(raw: unknown[], trackingNumber: string): CarrierFacts | null {
  const first = raw[0] as
    | { consignmentId?: unknown; recipientName?: unknown; packageSet?: unknown }
    | undefined
  const consignmentId = str(first?.consignmentId)
  const packages = Array.isArray(first?.packageSet) ? first.packageSet : []
  if (!consignmentId || packages.length === 0) return null

  let recipientEmail: string | null = null
  let destinationCountry: string | null = null
  let weightKg: number | null = null
  for (const pkg of packages) {
    const p = pkg as {
      packageNumber?: unknown
      recipientEmailAddress?: unknown
      weightInKgs?: unknown
      recipientAddress?: { countryCode?: unknown }
    }
    if (!recipientEmail) recipientEmail = str(p?.recipientEmailAddress)?.toLowerCase() ?? null
    if (!destinationCountry) destinationCountry = str(p?.recipientAddress?.countryCode)?.toUpperCase() ?? null
    // The weight of THIS package when it is the one asked about; else the first.
    if (str(p?.packageNumber) === trackingNumber || weightKg === null) {
      const w = num(p?.weightInKgs)
      if (w !== null) weightKg = w
    }
  }

  const mapped = mapConsignments(raw)
  const pkg = mapped.find((m) => m.trackingNumber === trackingNumber) ?? mapped[0] ?? null

  return {
    carrier: 'BRING',
    consignmentId,
    destinationCountry,
    weightKg,
    recipientEmail,
    recipientName: str(first?.recipientName),
    references: [],
    package: pkg,
  }
}

/** DHL's answer for one number: the first shipment, or null. */
export function dhlFacts(raw: unknown, trackingNumber: string): CarrierFacts | null {
  const shipments = (raw as { shipments?: unknown })?.shipments
  if (!Array.isArray(shipments) || shipments.length === 0) return null
  const s = shipments[0] as {
    id?: unknown
    destination?: { address?: { countryCode?: unknown } }
    details?: {
      weight?: { value?: unknown }
      references?: { number?: unknown; type?: unknown }[]
    }
  }
  const refs = Array.isArray(s.details?.references) ? s.details.references : []
  const references = refs
    .filter((r) => str(r?.type) === 'domestic-consignment-id')
    .map((r) => str(r?.number))
    .filter((n): n is string => n !== null)

  // mapShipments names the package by DHL's shipment id ("JKG-HI-0001643",
  // "00473325380023179098"), which is not the number on our row. The events
  // are the row's regardless; the name is put back so callers never compare
  // it and wonder.
  const mapped = mapShipments(raw)[0] ?? null
  const pkg = mapped ? { ...mapped, trackingNumber } : null

  return {
    carrier: 'DHL',
    consignmentId: str(s?.id),
    destinationCountry: str(s?.destination?.address?.countryCode)?.toUpperCase() ?? null,
    weightKg: num(s?.details?.weight?.value),
    recipientEmail: null,
    recipientName: null,
    references,
    package: pkg,
  }
}

/** How long a number nobody knows is asked about before it is given up on. */
export const UNKNOWN_GRACE_DAYS = 14

const DAY = 24 * 60 * 60 * 1000

/**
 * What happens to a row neither carrier knows.
 *
 * Asked again tomorrow, not in six hours: a label whose parcel has not been
 * handed to any carrier will not appear within the hour, and the DHL half of
 * the question is metered. After the grace period the row stops asking and
 * says why, but stays listed - a person can still link or dismiss it.
 */
export function unknownNext(
  createdAt: Date,
  now: Date,
): { terminal: boolean; nextPollAt: Date | null; lastError: string; unlinkedReason: string | null } {
  const lastError = 'Neither Bring nor DHL knows this number'
  if (now.getTime() - createdAt.getTime() > UNKNOWN_GRACE_DAYS * DAY) {
    return { terminal: true, nextPollAt: null, lastError, unlinkedReason: `No carrier knew this number in ${UNKNOWN_GRACE_DAYS} days` }
  }
  return { terminal: false, nextPollAt: new Date(now.getTime() + DAY), lastError, unlinkedReason: null }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project app src/lib/delivery/identify.test.ts`
Expected: PASS. If `tsconfig` refuses the JSON imports, check `resolveJsonModule` is on (the DHL fixture is already imported by `src/lib/dhl/map.test.ts`, so it is).

- [ ] **Step 6: Commit**

```bash
git add src/lib/delivery/identify.ts src/lib/delivery/identify.test.ts src/lib/delivery/__fixtures__/
git commit -m "feat(delivery): read who carries a parcel, and what they know, off either carrier's answer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 6: Applying an identification to a row (database side)

**Files:**
- Modify: `src/lib/delivery/identify.ts`
- Test: `src/lib/delivery/identify.integration.test.ts`

**Interfaces:**
- Consumes: `matchByEmail` (Task 3), `CarrierFacts` (Task 5).
- Produces:
  ```ts
  export type IdentifyRow = { id: string; trackingNumber: string; orderId: string | null; createdAt: Date }
  export async function applyIdentification(row: IdentifyRow, facts: CarrierFacts, now: Date): Promise<{ linked: boolean }>
  export async function applyUnknown(row: IdentifyRow, now: Date): Promise<void>
  export async function rematchByEmail(row: { id: string; recipientEmail: string | null; bookedAt: Date | null; consignmentId: string | null }, now: Date): Promise<{ linked: boolean }>
  ```
  Task 7's poll loop calls all three.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/delivery/identify.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { applyIdentification, applyUnknown, rematchByEmail, type CarrierFacts } from './identify'
import { milestonesFrom } from './milestones'

const TAG = '[parcel-identify-test]'
const TRACK = 'TIDENT'
const scoped = { shop: { name: { contains: TAG } } }
const now = new Date('2026-09-10T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

let shopId: string

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: TRACK } } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({
    data: { name: `Shop ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') },
  })).id
})

const order = (number: string, email: string, placedAt: string) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerEmail: email, shippingCountry: 'NO',
    },
  })

const unknownRow = (trackingNumber: string, createdAt = now) =>
  db.shipment.create({ data: { trackingNumber, carrier: 'UNKNOWN', nextPollAt: now, createdAt } })

const events = [
  { status: 'PRE_NOTIFIED', occurredAt: new Date('2026-09-07T08:17:14Z'), description: 'Pre-notified', location: null },
  { status: 'IN_TRANSIT', occurredAt: new Date('2026-09-08T06:00:00Z'), description: 'On its way', location: 'Oslo, NO' },
]

const bringFacts = (over: Partial<CarrierFacts> = {}): CarrierFacts => ({
  carrier: 'BRING', consignmentId: 'CONS-1', destinationCountry: 'NO', weightKg: 16,
  recipientEmail: 'one@example.test', recipientName: 'One Person', references: [],
  package: { trackingNumber: `${TRACK}1`, events, milestones: milestonesFrom(events) },
  ...over,
})

describe('applyIdentification', () => {
  it('writes the facts and the events, sets the carrier, and links by email when one order fits', async () => {
    const o = await order('ID-1', 'one@example.test', '2026-09-06T10:00:00Z')
    const row = await unknownRow(`${TRACK}1`)

    const r = await applyIdentification(row, bringFacts(), now)

    expect(r.linked).toBe(true)
    const after = await db.shipment.findUnique({ where: { id: row.id }, include: { events: true } })
    expect(after).toMatchObject({
      carrier: 'BRING', orderId: o.id, linkSource: 'BRING_EMAIL', consignmentId: 'CONS-1',
      destinationCountry: 'NO', weightKg: 16, recipientEmail: 'one@example.test', recipientName: 'One Person',
      unlinkedReason: null, lastError: null,
    })
    expect(after?.identifiedAt).toEqual(now)
    expect(after?.bookedAt).toEqual(new Date('2026-09-07T08:17:14Z'))
    expect(after?.events).toHaveLength(2)
    expect(after?.nextPollAt).not.toBeNull()
  })

  it('keeps the row unlinked with the refusal as its reason when the email fits nobody', async () => {
    const row = await unknownRow(`${TRACK}2`)
    const r = await applyIdentification(row, bringFacts({ recipientEmail: 'nobody@example.test' }), now)
    expect(r.linked).toBe(false)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.carrier).toBe('BRING')
    expect(after?.orderId).toBeNull()
    expect(after?.unlinkedReason).toBe('No order for nobody@example.test')
  })

  it('links a DHL Freight piece to the order its consignment number already belongs to', async () => {
    const o = await order('ID-3', 'three@example.test', '2026-09-06T10:00:00Z')
    await db.shipment.create({
      data: { trackingNumber: `${TRACK}6109278751`, carrier: 'DHL', orderId: o.id, linkSource: 'DHL_FILE' },
    })
    const row = await unknownRow(`${TRACK}3`)
    const r = await applyIdentification(
      row,
      bringFacts({
        carrier: 'DHL', consignmentId: 'JKG-HI-0001643', destinationCountry: 'FI', weightKg: 154,
        recipientEmail: null, recipientName: null, references: [`${TRACK}6109278751`],
      }),
      now,
    )
    expect(r.linked).toBe(true)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after).toMatchObject({ carrier: 'DHL', orderId: o.id, linkSource: 'DHL_REF', unlinkedReason: null })
  })

  it('says plainly why a DHL parcel with no reference cannot be matched by itself', async () => {
    const row = await unknownRow(`${TRACK}4`)
    const r = await applyIdentification(
      row,
      bringFacts({ carrier: 'DHL', consignmentId: '00473', destinationCountry: 'DE', weightKg: 18.2, recipientEmail: null, recipientName: null }),
      now,
    )
    expect(r.linked).toBe(false)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.carrier).toBe('DHL')
    expect(after?.unlinkedReason).toBe('DHL parcel to DE: DHL gives no name or email, so no order could be matched by itself')
  })

  it('never touches the link of a row that already has an order', async () => {
    const o = await order('ID-5', 'five@example.test', '2026-09-06T10:00:00Z')
    const row = await db.shipment.create({
      data: { trackingNumber: `${TRACK}5`, carrier: 'UNKNOWN', orderId: o.id, linkSource: 'MANUAL', nextPollAt: now },
    })
    await applyIdentification({ ...row, orderId: o.id }, bringFacts({ recipientEmail: 'nobody@example.test' }), now)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.orderId).toBe(o.id)
    expect(after?.linkSource).toBe('MANUAL')
    expect(after?.carrier).toBe('BRING')
  })
})

describe('applyUnknown', () => {
  it('asks again tomorrow', async () => {
    const row = await unknownRow(`${TRACK}7`)
    await applyUnknown(row, now)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.terminal).toBe(false)
    expect(after?.nextPollAt).toEqual(new Date(now.getTime() + DAY))
    expect(after?.lastError).toBe('Neither Bring nor DHL knows this number')
  })

  it('gives up after 14 days but leaves the row listed with its reason', async () => {
    const row = await unknownRow(`${TRACK}8`, new Date(now.getTime() - 15 * DAY))
    await applyUnknown(row, now)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.terminal).toBe(true)
    expect(after?.unlinkedReason).toBe('No carrier knew this number in 14 days')
    expect(after?.dismissedAt).toBeNull()
  })
})

describe('rematchByEmail', () => {
  it('links a refused Bring row once the rules resolve it', async () => {
    const o = await order('ID-9', 'late@example.test', '2026-09-06T10:00:00Z')
    const row = await db.shipment.create({
      data: {
        trackingNumber: `${TRACK}9`, carrier: 'BRING', recipientEmail: 'late@example.test',
        consignmentId: 'CONS-9', bookedAt: new Date('2026-09-07T08:00:00Z'),
        unlinkedReason: 'late@example.test matched 2 orders in the last 30 days: ID-8, ID-9', nextPollAt: now,
      },
    })
    const r = await rematchByEmail(row, now)
    expect(r.linked).toBe(true)
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after).toMatchObject({ orderId: o.id, linkSource: 'BRING_EMAIL', unlinkedReason: null })
  })

  it('updates the reason when still refused', async () => {
    const row = await db.shipment.create({
      data: { trackingNumber: `${TRACK}10`, carrier: 'BRING', recipientEmail: 'gone@example.test', nextPollAt: now, unlinkedReason: 'old words' },
    })
    const r = await rematchByEmail(row, now)
    expect(r.linked).toBe(false)
    expect((await db.shipment.findUnique({ where: { id: row.id } }))?.unlinkedReason).toBe('No order for gone@example.test')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project delivery src/lib/delivery/identify.integration.test.ts`
Expected: FAIL, `applyIdentification` is not exported.

- [ ] **Step 3: Add the database side to `identify.ts`**

Append to `src/lib/delivery/identify.ts` (add `import { db } from '../db'` and `import { matchByEmail } from '../bring/match'` at the top):

```ts
export type IdentifyRow = { id: string; trackingNumber: string; orderId: string | null; createdAt: Date }

/**
 * A carrier answered. Write what it said, and try to attach the order.
 *
 * The link is attempted only for a row that has none: a row a person
 * attached, or an earlier night did, keeps its order whatever the carrier
 * now says about the email. Events are written the way the poller writes
 * them, so the next poll is an ordinary poll of a known parcel.
 */
export async function applyIdentification(
  row: IdentifyRow,
  facts: CarrierFacts,
  now: Date,
): Promise<{ linked: boolean }> {
  const m = facts.package?.milestones
  const base = {
    carrier: facts.carrier,
    consignmentId: facts.consignmentId,
    destinationCountry: facts.destinationCountry,
    weightKg: facts.weightKg,
    recipientEmail: facts.recipientEmail,
    recipientName: facts.recipientName,
    identifiedAt: now,
    lastError: null,
    ...(m
      ? {
          bookedAt: m.bookedAt, handedInAt: m.handedInAt, availableAt: m.availableAt,
          collectedAt: m.collectedAt, outcome: m.outcome, lastStatus: m.lastStatus,
        }
      : {}),
    // Due now: the poller's ordinary tiers take over from the next run.
    nextPollAt: now,
  }

  let link: { orderId: string; linkSource: string } | null = null
  let unlinkedReason: string | null = null

  if (row.orderId === null) {
    if (facts.carrier === 'BRING') {
      const outcome = await matchByEmail(facts.recipientEmail, now, {
        bookedAt: m?.bookedAt ?? null,
        consignmentId: facts.consignmentId,
      })
      if (outcome.orderId) link = { orderId: outcome.orderId, linkSource: 'BRING_EMAIL' }
      else unlinkedReason = outcome.reason
    } else {
      // DHL Freight: the export path stored the 10-digit number with its
      // order; this piece is the same physical shipment.
      const known = facts.references.length
        ? await db.shipment.findFirst({
            where: { trackingNumber: { in: facts.references }, orderId: { not: null } },
            select: { orderId: true },
          })
        : null
      if (known?.orderId) link = { orderId: known.orderId, linkSource: 'DHL_REF' }
      else
        unlinkedReason = `DHL parcel to ${facts.destinationCountry ?? 'an unknown country'}: DHL gives no name or email, so no order could be matched by itself`
    }
  }

  await db.$transaction(async (tx) => {
    if (facts.package) {
      await tx.shipmentEvent.createMany({
        data: facts.package.events.map((e) => ({
          shipmentId: row.id, status: e.status, occurredAt: e.occurredAt,
          description: e.description, location: e.location,
        })),
        skipDuplicates: true,
      })
    }
    await tx.shipment.update({
      where: { id: row.id },
      data: {
        ...base,
        ...(link ? { ...link, unlinkedReason: null } : {}),
        ...(row.orderId === null && !link ? { unlinkedReason } : {}),
      },
    })
  })

  return { linked: link !== null }
}

/** Neither carrier knows the number. Ask again tomorrow, or give up after the grace period. */
export async function applyUnknown(row: IdentifyRow, now: Date): Promise<void> {
  const next = unknownNext(row.createdAt, now)
  await db.shipment.update({
    where: { id: row.id },
    data: {
      terminal: next.terminal,
      nextPollAt: next.nextPollAt,
      lastError: next.lastError,
      ...(next.unlinkedReason ? { unlinkedReason: next.unlinkedReason } : {}),
    },
  })
}

/**
 * A refused Bring row, matched again under today's rules. The twin order may
 * have received its own parcel since, which is what resolves the common case.
 */
export async function rematchByEmail(
  row: { id: string; recipientEmail: string | null; bookedAt: Date | null; consignmentId: string | null },
  now: Date,
): Promise<{ linked: boolean }> {
  const outcome = await matchByEmail(row.recipientEmail, now, {
    bookedAt: row.bookedAt,
    consignmentId: row.consignmentId,
  })
  if (outcome.orderId) {
    await db.shipment.update({
      where: { id: row.id },
      data: { orderId: outcome.orderId, linkSource: 'BRING_EMAIL', unlinkedReason: null },
    })
    return { linked: true }
  }
  await db.shipment.update({ where: { id: row.id }, data: { unlinkedReason: outcome.reason } })
  return { linked: false }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project delivery src/lib/delivery/identify.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/delivery/identify.ts src/lib/delivery/identify.integration.test.ts
git commit -m "feat(delivery): an identified parcel writes its facts, its events and, when certain, its order

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 7: The poller identifies, flips and re-matches

**Files:**
- Modify: `src/lib/delivery/sync.ts` (function `syncShipments`, the loop from `for (const s of due)`)
- Test: `src/lib/delivery/sync.integration.test.ts`

**Interfaces:**
- Consumes: `bringFacts`, `dhlFacts`, `applyIdentification`, `applyUnknown`, `rematchByEmail` (Tasks 5 and 6).
- Produces: `ShipmentSyncResult.identified?: number` (rows whose carrier was found this run).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/delivery/sync.integration.test.ts` inside `describe('syncShipments', ...)`. The file's helpers: `stubBring(consignments)`, `consignment(n, events)`, `noSleep`, `DUE`, `T1`..`T3`, `TRACK`, and inside the DHL block `stubDhl(status, body)`. The DHL key is stubbed empty in `beforeEach`; set it where needed.

```ts
  describe('identifying an UNKNOWN parcel', () => {
    const DHL_BODY = (id: string, country: string) => ({
      shipments: [{
        id, service: 'ecommerce-europe',
        destination: { address: { countryCode: country } },
        details: { weight: { unitText: 'KG', value: 18.2 } },
        events: [{ timestamp: '2026-08-05T09:00:00', statusCode: 'transit', description: 'On the way' }],
      }],
    })

    it('asks Bring first and, when Bring knows it, needs no DHL call', async () => {
      await db.shipment.create({ data: { trackingNumber: T1, carrier: 'UNKNOWN', nextPollAt: new Date('2026-01-01') } })
      const fetchMock = vi.fn(async (url: string) =>
        url.includes('bring.com')
          ? new Response(JSON.stringify({ consignmentSet: [{ consignmentId: 'C1', packageSet: [{ packageNumber: T1, recipientEmailAddress: 'x@example.test', eventSet: [{ status: 'PRE_NOTIFIED', dateIso: '2026-08-04T10:00:00Z' }] }] }] }), { status: 200 })
          : new Response(JSON.stringify({ shipments: [] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubEnv('DHL_API_KEY', 'k')

      const r = await syncShipments({ now, sleep: noSleep })

      expect(r.identified).toBe(1)
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('dhl.com'))).toBe(false)
      const row = await db.shipment.findUnique({ where: { trackingNumber: T1 } })
      expect(row?.carrier).toBe('BRING')
      expect(row?.recipientEmail).toBe('x@example.test')
      expect(row?.identifiedAt).toEqual(now)
    })

    it('asks DHL when Bring has nothing, within the run budget, and the row becomes a DHL parcel', async () => {
      await db.shipment.create({ data: { trackingNumber: T2, carrier: 'UNKNOWN', nextPollAt: new Date('2026-01-01') } })
      const fetchMock = vi.fn(async (url: string) =>
        url.includes('bring.com')
          ? new Response(JSON.stringify({ consignmentSet: [{ error: { code: 404, message: 'No shipments found' } }] }), { status: 200 })
          : new Response(JSON.stringify(DHL_BODY(`00${T2}`, 'DE')), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubEnv('DHL_API_KEY', 'k')

      const r = await syncShipments({ now, sleep: noSleep })

      expect(r.identified).toBe(1)
      expect(r.dhlCalls).toBe(1)
      const row = await db.shipment.findUnique({ where: { trackingNumber: T2 }, include: { events: true } })
      expect(row?.carrier).toBe('DHL')
      expect(row?.destinationCountry).toBe('DE')
      expect(row?.weightKg).toBe(18.2)
      expect(row?.events).toHaveLength(1)
      expect(row?.unlinkedReason).toMatch(/^DHL parcel to DE/)
    })

    it('leaves the DHL half for the next run when the budget is spent, and keeps the row UNKNOWN', async () => {
      for (let i = 0; i < DHL_CALLS_PER_RUN + 1; i++) {
        await db.shipment.create({ data: { trackingNumber: `${TRACK}U${i}`, carrier: 'UNKNOWN', nextPollAt: new Date(`2026-01-0${i + 1}`) } })
      }
      const fetchMock = vi.fn(async (url: string) =>
        url.includes('bring.com')
          ? new Response(JSON.stringify({ consignmentSet: [] }), { status: 200 })
          : new Response(JSON.stringify({ shipments: [] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubEnv('DHL_API_KEY', 'k')

      const r = await syncShipments({ now, sleep: noSleep })

      expect(r.dhlCalls).toBe(DHL_CALLS_PER_RUN)
      const rows = await db.shipment.findMany({ where: { trackingNumber: { startsWith: `${TRACK}U` } }, orderBy: { trackingNumber: 'asc' } })
      // The two asked of DHL were unknown to it: asked again tomorrow.
      // The third was never asked of DHL this run: still due, untouched.
      expect(rows.filter((x) => x.lastError === 'Neither Bring nor DHL knows this number')).toHaveLength(DHL_CALLS_PER_RUN)
      expect(rows.every((x) => x.carrier === 'UNKNOWN')).toBe(true)
      expect(rows[DHL_CALLS_PER_RUN].nextPollAt).toEqual(new Date('2026-01-03'))
    })

    it('flips an unlinked BRING row Bring does not know to UNKNOWN', async () => {
      await db.shipment.create({ data: { trackingNumber: T3, carrier: 'BRING', nextPollAt: new Date('2026-01-01') } })
      stubBring([{ error: { code: 404, message: 'No shipments found' } }])

      await syncShipments({ now, sleep: noSleep })

      const row = await db.shipment.findUnique({ where: { trackingNumber: T3 } })
      expect(row?.carrier).toBe('UNKNOWN')
      expect(row?.nextPollAt).toEqual(now)
    })

    it('leaves a LINKED Bring row Bring does not know alone - it belongs to an order and is simply early', async () => {
      const shop = await db.shop.create({ data: { name: 'Sync flip [sync-flip-test]', currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') } })
      const order = await db.order.create({
        data: { shopId: shop.id, externalId: 'SF1', number: 'SF1', placedAt: now, status: 'completed', currency: 'NOK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0 },
      })
      try {
        await db.shipment.create({ data: { trackingNumber: `${TRACK}L1`, carrier: 'BRING', orderId: order.id, nextPollAt: new Date('2026-01-01') } })
        stubBring([])
        await syncShipments({ now, sleep: noSleep })
        const row = await db.shipment.findUnique({ where: { trackingNumber: `${TRACK}L1` } })
        expect(row?.carrier).toBe('BRING')
        expect(row?.lastError).toBe('BRING does not know this number yet')
      } finally {
        await db.shipment.deleteMany({ where: { trackingNumber: `${TRACK}L1` } })
        await db.order.deleteMany({ where: { shopId: shop.id } })
        await db.shop.delete({ where: { id: shop.id } })
      }
    })

    it('re-matches a refused Bring row after polling it', async () => {
      const shop = await db.shop.create({ data: { name: 'Sync rematch [sync-rematch-test]', currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') } })
      const order = await db.order.create({
        data: { shopId: shop.id, externalId: 'SR1', number: 'SR1', placedAt: new Date(now.getTime() - 2 * 24 * HOUR), status: 'completed', currency: 'NOK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0, customerEmail: 're@example.test' },
      })
      try {
        await db.shipment.create({
          data: { trackingNumber: `${TRACK}R1`, carrier: 'BRING', recipientEmail: 're@example.test', consignmentId: 'CR1', unlinkedReason: 'old', nextPollAt: new Date('2026-01-01') },
        })
        stubBring([consignment(`${TRACK}R1`, [{ status: 'PRE_NOTIFIED', dateIso: '2026-08-04T10:00:00Z' }])])
        await syncShipments({ now, sleep: noSleep })
        const row = await db.shipment.findUnique({ where: { trackingNumber: `${TRACK}R1` } })
        expect(row?.orderId).toBe(order.id)
        expect(row?.linkSource).toBe('BRING_EMAIL')
        expect(row?.unlinkedReason).toBeNull()
      } finally {
        await db.shipment.deleteMany({ where: { trackingNumber: `${TRACK}R1` } })
        await db.order.deleteMany({ where: { shopId: shop.id } })
        await db.shop.delete({ where: { id: shop.id } })
      }
    })
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project delivery src/lib/delivery/sync.integration.test.ts`
Expected: the new tests FAIL (`identified` undefined; `UNKNOWN` carrier has no tracker and is skipped).

- [ ] **Step 3: Change the loop**

In `src/lib/delivery/sync.ts`:

1. Add to the imports:
   ```ts
   import { applyIdentification, applyUnknown, bringFacts, dhlFacts, rematchByEmail } from './identify'
   ```
2. Add to `ShipmentSyncResult`:
   ```ts
     /** Rows that were UNKNOWN and got a carrier this run. */
     identified?: number
   ```
3. Add `let identified = 0` beside `let dhlCalls = 0`.
4. Add `recipientEmail: true, bookedAt: true, consignmentId: true, createdAt: true` to the `select` of the `due` query (the loop needs them for re-matching and the grace rule).
5. Replace the block that starts with `const track = trackers[s.carrier]` and ends just before `let found: MappedPackage | null` with:

```ts
    /**
     * A row nobody has claimed yet. Bring first (unmetered), then DHL under
     * the same per-run budget and spacing as any DHL poll. Whoever answers
     * owns the row from here; the next run polls it as an ordinary parcel.
     * If DHL's share is spent, the row keeps its due date and is first in
     * line next run, exactly like a DHL parcel that missed its turn.
     */
    if (s.carrier === 'UNKNOWN') {
      const idRow = { id: s.id, trackingNumber: s.trackingNumber, orderId: s.orderId, createdAt: s.createdAt }
      try {
        if (creds) {
          const raw = await fetchBring(creds, [s.trackingNumber], { deadline: opts.deadline })
          const facts = bringFacts(raw, s.trackingNumber)
          if (facts) {
            await applyIdentification(idRow, facts, now)
            identified++
            polled++
            continue
          }
        }
        if (!dhlKey) {
          // Bring does not know it and DHL cannot be asked. Tomorrow, or the
          // grace period runs out - same as a number nobody knows.
          await applyUnknown(idRow, now)
          continue
        }
        if (dhlCalls >= DHL_CALLS_PER_RUN) continue
        if (dhlCalls > 0) {
          if (opts.deadline !== undefined && Date.now() + RATE_LIMIT_GAP_MS >= opts.deadline) break
          await sleep(RATE_LIMIT_GAP_MS)
        }
        dhlCalls++
        const raw = await fetchDhl(dhlKey, s.trackingNumber, { deadline: opts.deadline })
        const facts = raw === null ? null : dhlFacts(raw, s.trackingNumber)
        if (facts) {
          await applyIdentification(idRow, facts, now)
          identified++
        } else {
          await applyUnknown(idRow, now)
        }
        polled++
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Tracking lookup failed'
        failed++
        await db.shipment
          .update({ where: { id: s.id }, data: { lastError: error, nextPollAt: new Date(now.getTime() + HOUR) } })
          .catch(() => {})
      }
      continue
    }

    const track = trackers[s.carrier]
```

6. In the `if (!found)` branch, replace its body with:

```ts
    if (!found) {
      // An UNLINKED Bring row Bring does not know is not "early": the
      // warehouse prints one label series for every carrier, and 17 of 17
      // such numbers checked on 2026-09-10 were DHL's. It becomes UNKNOWN,
      // due now, and the identification above asks DHL on the next run. A
      // LINKED one belongs to an order and is simply not handed over yet.
      const flip = s.carrier === 'BRING' && s.orderId === null
      await db.shipment
        .update({
          where: { id: s.id },
          data: flip
            ? { carrier: 'UNKNOWN', nextPollAt: now, lastError: 'Bring does not know this number; asking DHL next' }
            : { lastError: `${s.carrier} does not know this number yet`, nextPollAt: new Date(now.getTime() + 6 * HOUR) },
        })
        .catch(() => {})
      continue
    }
```

7. After the `updated++` that follows the successful `$transaction`, add:

```ts
      // A refused Bring row, matched again under today's rules: the twin
      // order may have received its own parcel since. Best-effort, and only
      // while the row is young enough for the answer to change.
      if (s.orderId === null && s.carrier === 'BRING' && s.recipientEmail) {
        await rematchByEmail(
          { id: s.id, recipientEmail: s.recipientEmail, bookedAt: m.bookedAt ?? s.bookedAt, consignmentId: s.consignmentId },
          now,
        ).catch(() => {})
      }
```

8. Add `identified` to the returned result object (where `dhlCalls` is returned).

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run --project delivery src/lib/delivery/sync.integration.test.ts`
Expected: PASS. If the pre-existing "does not know this number yet" test created an UNLINKED Bring row, it now sees the flip: change that test's row to carry an `orderId` (create a tagged shop and order as in the "leaves a LINKED Bring row alone" test), because the old expectation is exactly the behaviour this task removes for unlinked rows.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/lib/delivery/sync.ts src/lib/delivery/sync.integration.test.ts
git commit -m "feat(delivery): the poller finds out who carries an unclaimed parcel, Bring first and DHL second

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 8: Tracking links that open

**Files:**
- Modify: `src/lib/delivery/tracking-url.ts`
- Modify: `src/lib/delivery/view.ts` (`Parcel.url`)
- Modify: `src/app/delivery/DeliveryClient.tsx` (every `<a href={p.url}>` on a parcel)
- Test: `src/lib/delivery/tracking-url.test.ts`, `src/app/delivery/DeliveryClient.test.tsx`

**Interfaces:**
- Produces: `trackingUrl(trackingNumber: string, carrier: string): string | null`; `Parcel.url: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/delivery/tracking-url.test.ts`:

```ts
  it('gives an UNKNOWN carrier no link at all, rather than a Bring page that finds nothing', () => {
    expect(trackingUrl('473325380028549070', 'UNKNOWN')).toBeNull()
    expect(carrierName('UNKNOWN')).toBe('Unknown')
  })

  it('sends an 18-digit DHL number to DHL\'s unified page and a 10-digit one to the freight page', () => {
    expect(trackingUrl('473325380023179098', 'DHL')).toBe(
      'https://www.dhl.com/se-en/home/tracking.html?tracking-id=473325380023179098',
    )
    expect(trackingUrl('9599036010', 'DHL')).toBe(
      'https://www.dhl.com/se-en/home/tracking/tracking-freight.html?tracking-id=9599036010&submit=1',
    )
  })
```

Check the top of that test file imports `carrierName`; add it if not.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project app src/lib/delivery/tracking-url.test.ts`
Expected: FAIL (a Bring URL for UNKNOWN; the freight page for the 18-digit number).

- [ ] **Step 3: Implement**

In `src/lib/delivery/tracking-url.ts` replace the `SITES` map and `trackingUrl`:

```ts
const SITES: Record<string, (escaped: string, raw: string) => string> = {
  BRING: (n) => `https://tracking.bring.com/tracking/${n}`,
  /**
   * Two DHL pages. The freight page knows the 10-digit consignment numbers
   * the DHL export carries. An 18-digit number is a piece id, which the
   * unified page resolves for both DHL Freight and DHL eCommerce parcels
   * (both divisions carry the warehouse's parcels; measured 2026-09-10).
   */
  DHL: (n, raw) =>
    /^\d{18}$/.test(raw)
      ? `https://www.dhl.com/se-en/home/tracking.html?tracking-id=${n}`
      : `https://www.dhl.com/se-en/home/tracking/tracking-freight.html?tracking-id=${n}&submit=1`,
}

/**
 * Null for a carrier we have no page for - including UNKNOWN, a parcel no
 * carrier has claimed yet. A link that opens the wrong carrier's page and
 * finds nothing is what the Delivery page showed for 41 parcels; no link is
 * the honest state.
 */
export function trackingUrl(trackingNumber: string, carrier: string): string | null {
  const site = SITES[carrier.toUpperCase()]
  if (!site) return null
  return site(encodeURIComponent(trackingNumber), trackingNumber)
}
```

Keep `carrierName` as it is (its generic branch already turns `UNKNOWN` into `Unknown`).

In `src/lib/delivery/view.ts`, change `Parcel`'s `url: string` to `url: string | null` (find `export type Parcel`).

In `src/app/delivery/DeliveryClient.tsx`, every place a parcel number is an anchor on `p.url` (search `href={p.url}`): render

```tsx
{p.url ? (
  <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{p.number}</a>
) : (
  <span className="num text-ink">{p.number}</span>
)}
```

(For the unlinked section the property is `p.trackingNumber`; Task 12 rewrites that section, so only fix the late/no-tracking lists here.)

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project app src/lib/delivery/tracking-url.test.ts src/app/delivery/DeliveryClient.test.tsx src/lib/delivery/view.test.ts` and `npx tsc --noEmit`.
Expected: PASS, no type errors. Fix any place the compiler names where `url` was assumed a string (the API route builds it for the unlinked list and for `view.ts` parcels; both accept null).

- [ ] **Step 5: Commit**

```bash
git add src/lib/delivery/tracking-url.ts src/lib/delivery/tracking-url.test.ts src/lib/delivery/view.ts src/app/delivery/DeliveryClient.tsx
git commit -m "fix(delivery): a parcel links to the carrier that has it, or to nothing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 9: Candidate orders for an unlinked parcel

**Files:**
- Create: `src/lib/delivery/candidates.ts`
- Test: `src/lib/delivery/candidates.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Candidate = { orderId: string; number: string; shop: string; customerName: string | null; placedAt: string; items: string; holdsParcel: boolean }
  export type CandidateRow = { recipientEmail: string | null; destinationCountry: string | null; bookedAt: Date | null; createdAt: Date; consignmentId: string | null }
  export const CANDIDATE_LIMIT = 6
  export async function candidatesFor(row: CandidateRow): Promise<{ candidates: Candidate[]; total: number }>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/delivery/candidates.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { candidatesFor, CANDIDATE_LIMIT } from './candidates'

const TAG = '[parcel-candidates-test]'
const TRACK = 'TCAND'
const scoped = { shop: { name: { contains: TAG } } }
const DAY = 24 * 60 * 60 * 1000
const booked = new Date('2026-09-09T13:05:00Z')

let trackedId: string
let untrackedId: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.product.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  trackedId = (await db.shop.create({ data: { name: `Panetti Germany ${TAG}`, currency: 'EUR', deliveryTrackingFrom: new Date('2026-01-01') } })).id
  untrackedId = (await db.shop.create({ data: { name: `Untracked ${TAG}`, currency: 'EUR' } })).id
})

async function order(shopId: string, number: string, over: Record<string, unknown> = {}, items: { name: string; quantity: number }[] = []) {
  const o = await db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(booked.getTime() - 2 * DAY), status: 'completed', currency: 'EUR',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      shippingCountry: 'DE', customerName: 'Tobias K', customerEmail: `${number.toLowerCase()}@example.test`,
      ...over,
    },
  })
  for (const it of items) {
    const p = await db.product.create({ data: { shopId, externalId: `${number}-${it.name}`, sku: it.name, name: it.name } })
    await db.orderItem.create({ data: { orderId: o.id, productId: p.id, sku: it.name, name: it.name, quantity: it.quantity, unitPrice: 0, lineNetTotal: 0 } })
  }
  return o
}

describe('candidatesFor', () => {
  it('lists orders with the parcel\'s email, flagging one that already holds another consignment\'s parcel', async () => {
    const held = await order(trackedId, 'C-HELD', { customerEmail: 'same@example.test' })
    const open = await order(trackedId, 'C-OPEN', { customerEmail: 'same@example.test', placedAt: new Date(booked.getTime() - DAY) }, [{ name: 'Panetti ProMix', quantity: 1 }])
    await db.shipment.create({ data: { trackingNumber: `${TRACK}1`, orderId: held.id, consignmentId: 'OTHER' } })

    const r = await candidatesFor({ recipientEmail: 'same@example.test', destinationCountry: 'DE', bookedAt: booked, createdAt: booked, consignmentId: 'THIS' })

    expect(r.total).toBe(2)
    expect(r.candidates.map((c) => c.number)).toEqual(['C-OPEN', 'C-HELD']) // newest first
    expect(r.candidates[0]).toMatchObject({ orderId: open.id, items: '1 x Panetti ProMix', holdsParcel: false, shop: `Panetti Germany ${TAG}` })
    expect(r.candidates[1]).toMatchObject({ orderId: held.id, holdsParcel: true })
  })

  it('falls back to the destination country when there is no email, and skips orders that hold any parcel', async () => {
    const free = await order(trackedId, 'C-DE1', {}, [{ name: 'Pizza oven', quantity: 1 }, { name: 'Peel', quantity: 2 }])
    const taken = await order(trackedId, 'C-DE2')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}2`, orderId: taken.id } })
    await order(trackedId, 'C-NO', { shippingCountry: 'NO' })
    await order(untrackedId, 'C-UNTRACKED')
    await order(trackedId, 'C-AFTER', { placedAt: new Date(booked.getTime() + DAY) })
    await order(trackedId, 'C-OLD', { placedAt: new Date(booked.getTime() - 40 * DAY) })

    const r = await candidatesFor({ recipientEmail: null, destinationCountry: 'de', bookedAt: booked, createdAt: booked, consignmentId: null })

    expect(r.total).toBe(1)
    expect(r.candidates[0]).toMatchObject({ orderId: free.id, items: '1 x Pizza oven, 2 x Peel' })
  })

  it('caps the list and reports the true total', async () => {
    for (let i = 0; i < CANDIDATE_LIMIT + 3; i++) await order(trackedId, `C-MANY${i}`, { placedAt: new Date(booked.getTime() - i * 60_000) })
    const r = await candidatesFor({ recipientEmail: null, destinationCountry: 'DE', bookedAt: booked, createdAt: booked, consignmentId: null })
    expect(r.candidates).toHaveLength(CANDIDATE_LIMIT)
    expect(r.total).toBe(CANDIDATE_LIMIT + 3)
  })

  it('offers nothing when it knows neither email nor country', async () => {
    await order(trackedId, 'C-ANY')
    const r = await candidatesFor({ recipientEmail: null, destinationCountry: null, bookedAt: null, createdAt: booked, consignmentId: null })
    expect(r).toEqual({ candidates: [], total: 0 })
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project delivery src/lib/delivery/candidates.integration.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/lib/delivery/candidates.ts`:

```ts
import { db } from '../db'
import { MATCH_WINDOW_DAYS } from '../bring/match'

/**
 * The orders a person may attach an unlinked parcel to.
 *
 * Computed, never stored: the answer changes as other parcels link. By email
 * when the carrier gave one (Bring), else by destination country (DHL gives
 * no name and no email), else nothing and the person types an order number.
 * The items are what lets a person tell a 154 kg chair from a 1.6 kg whisk.
 */

export type Candidate = {
  orderId: string
  number: string
  shop: string
  customerName: string | null
  placedAt: string
  /** "1 x Panetti ProMix, 2 x Peel". */
  items: string
  /** Holds a parcel from another consignment, which is why the machine did not choose it. */
  holdsParcel: boolean
}

export type CandidateRow = {
  recipientEmail: string | null
  destinationCountry: string | null
  bookedAt: Date | null
  createdAt: Date
  consignmentId: string | null
}

export const CANDIDATE_LIMIT = 6

/** More than anyone will read; the count above it is what is reported. */
const READ_CEILING = 50

const DAY = 24 * 60 * 60 * 1000

export async function candidatesFor(row: CandidateRow): Promise<{ candidates: Candidate[]; total: number }> {
  if (!row.recipientEmail && !row.destinationCountry) return { candidates: [], total: 0 }

  const upper = row.bookedAt ?? row.createdAt
  const window = { gte: new Date(upper.getTime() - MATCH_WINDOW_DAYS * DAY), lte: upper }

  const orders = await db.order.findMany({
    where: {
      shop: { deliveryTrackingFrom: { not: null } },
      placedAt: window,
      voidedAt: null,
      ...(row.recipientEmail
        ? { customerEmail: { equals: row.recipientEmail, mode: 'insensitive' } }
        : {
            shippingCountry: { equals: row.destinationCountry!, mode: 'insensitive' },
            shipments: { none: {} },
          }),
    },
    orderBy: { placedAt: 'desc' },
    take: READ_CEILING,
    select: {
      id: true, number: true, placedAt: true, customerName: true,
      shop: { select: { name: true } },
      items: { select: { name: true, quantity: true } },
      shipments: { select: { consignmentId: true } },
    },
  })

  const candidates = orders.slice(0, CANDIDATE_LIMIT).map((o) => ({
    orderId: o.id,
    number: o.number,
    shop: o.shop.name,
    customerName: o.customerName,
    placedAt: o.placedAt.toISOString(),
    items: o.items.map((i) => `${i.quantity} x ${i.name}`).join(', '),
    holdsParcel: o.shipments.some((s) => s.consignmentId === null || s.consignmentId !== row.consignmentId),
  }))

  return { candidates, total: orders.length }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project delivery src/lib/delivery/candidates.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/delivery/candidates.ts src/lib/delivery/candidates.integration.test.ts
git commit -m "feat(delivery): the orders a parcel could belong to, with what they bought

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 10: Link by hand, or dismiss

**Files:**
- Create: `src/app/api/delivery/parcels/[trackingNumber]/route.ts`
- Test: `src/app/api/delivery/parcels/[trackingNumber]/route.integration.test.ts`

**Interfaces:**
- Produces: `PATCH /api/delivery/parcels/:trackingNumber` with body `{ orderId: string }` or `{ dismiss: true }`; answers `{ ok: true }`, or `{ error }` with 400/403/404.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/delivery/parcels/[trackingNumber]/route.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'ops@example.test', role: 'OPERATIONS' })),
}))

const { PATCH } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')

const TAG = '[parcel-link-route-test]'
const TRACK = 'TLINK'
const scoped = { shop: { name: { contains: TAG } } }

let trackedId: string
let untrackedId: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  trackedId = (await db.shop.create({ data: { name: `Tracked ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') } })).id
  untrackedId = (await db.shop.create({ data: { name: `Untracked ${TAG}`, currency: 'NOK' } })).id
})

const order = (shopId: string, number: string) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    },
  })

const call = (trackingNumber: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/delivery/parcels/${trackingNumber}`, { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ trackingNumber }),
  })

describe('PATCH /api/delivery/parcels/[trackingNumber]', () => {
  it('links an unlinked parcel to an order and puts it in the poller\'s queue', async () => {
    const o = await order(trackedId, 'L1')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}1`, carrier: 'DHL', unlinkedReason: 'DHL parcel to DE: ...', nextPollAt: null } })

    const res = await call(`${TRACK}1`, { orderId: o.id })

    expect(res.status).toBe(200)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${TRACK}1` } })
    expect(row).toMatchObject({ orderId: o.id, linkSource: 'MANUAL', unlinkedReason: null, terminal: false })
    expect(row?.nextPollAt).not.toBeNull()
  })

  it('dismisses a parcel that is not a customer delivery, naming who did it', async () => {
    await db.shipment.create({ data: { trackingNumber: `${TRACK}2`, carrier: 'DHL' } })
    const res = await call(`${TRACK}2`, { dismiss: true })
    expect(res.status).toBe(200)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${TRACK}2` } })
    expect(row?.terminal).toBe(true)
    expect(row?.dismissedAt).not.toBeNull()
    expect(row?.unlinkedReason).toBe('Not a customer parcel (dismissed by ops@example.test)')
  })

  it('refuses a parcel that already has an order', async () => {
    const o = await order(trackedId, 'L3')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}3`, orderId: o.id } })
    const res = await call(`${TRACK}3`, { orderId: o.id })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This parcel is already linked to an order')
  })

  it('refuses an order in a shop that is not delivery-tracked', async () => {
    const o = await order(untrackedId, 'L4')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}4` } })
    const res = await call(`${TRACK}4`, { orderId: o.id })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That order belongs to a shop that is not delivery-tracked')
  })

  it('answers 404 for a parcel we do not hold and 400 for an order that does not exist', async () => {
    expect((await call(`${TRACK}none`, { dismiss: true })).status).toBe(404)
    await db.shipment.create({ data: { trackingNumber: `${TRACK}5` } })
    const res = await call(`${TRACK}5`, { orderId: 'no-such-order' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That order does not exist')
  })

  it('refuses a body that is neither a link nor a dismissal', async () => {
    await db.shipment.create({ data: { trackingNumber: `${TRACK}6` } })
    expect((await call(`${TRACK}6`, { hello: 1 })).status).toBe(400)
  })

  it('refuses anyone below operations', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'm@example.test', role: 'MARKETING' } as never)
    await db.shipment.create({ data: { trackingNumber: `${TRACK}7` } })
    expect((await call(`${TRACK}7`, { dismiss: true })).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project delivery "src/app/api/delivery/parcels/[trackingNumber]/route.integration.test.ts"`
Expected: FAIL, module `./route` not found.

- [ ] **Step 3: Write the route**

Create `src/app/api/delivery/parcels/[trackingNumber]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * A person attaches a parcel to an order, or declares it is not a customer
 * parcel at all. The machine refuses whenever two orders could be right; this
 * is the person choosing. Operations and admin both may: it is their queue.
 */
const Body = z.union([
  z.object({ orderId: z.string().trim().min(1) }),
  z.object({ dismiss: z.literal(true) }),
])

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: NO_STORE })

export async function PATCH(req: Request, { params }: { params: Promise<{ trackingNumber: string }> }) {
  try {
    const user = await currentUser()
    assertOperations(user)
    const { trackingNumber } = await params

    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return bad('Send an order to link to, or dismiss: true')

    const parcel = await db.shipment.findUnique({
      where: { trackingNumber },
      select: { id: true, orderId: true },
    })
    if (!parcel) return bad('We hold no parcel with that number', 404)
    if (parcel.orderId) return bad('This parcel is already linked to an order')

    if ('dismiss' in parsed.data) {
      await db.shipment.update({
        where: { id: parcel.id },
        data: {
          terminal: true,
          nextPollAt: null,
          dismissedAt: new Date(),
          unlinkedReason: `Not a customer parcel (dismissed by ${user.email})`,
        },
      })
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }

    const order = await db.order.findUnique({
      where: { id: parsed.data.orderId },
      select: { id: true, shop: { select: { deliveryTrackingFrom: true } } },
    })
    if (!order) return bad('That order does not exist')
    if (!order.shop.deliveryTrackingFrom) return bad('That order belongs to a shop that is not delivery-tracked')

    await db.shipment.update({
      where: { id: parcel.id },
      data: {
        orderId: order.id,
        linkSource: 'MANUAL',
        unlinkedReason: null,
        dismissedAt: null,
        terminal: false,
        // Due now, so the next poll reads the parcel as the order's.
        nextPollAt: new Date(),
      },
    })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return bad(e.message, 403)
    console.error(e)
    return bad('Could not update this parcel', 500)
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project delivery "src/app/api/delivery/parcels/[trackingNumber]/route.integration.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/delivery/parcels/[trackingNumber]/"
git commit -m "feat(delivery): a person can attach a parcel to its order, or say it is not a customer parcel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 11: The Delivery API carries facts, reasons, candidates and the per-order note

**Files:**
- Modify: `src/app/api/delivery/route.ts`
- Modify: `src/lib/delivery/load.ts` (select `customerEmail`)
- Test: `src/app/api/delivery/route.integration.test.ts`

**Interfaces:**
- Consumes: `candidatesFor` (Task 9), `trackingUrl` returning `string | null` (Task 8).
- Produces, in the GET payload:
  ```ts
  unlinked: Array<{
    trackingNumber: string; carrier: string; url: string | null; lastStatus: string | null
    destinationCountry: string | null; bookedAt: string | null; weightKg: number | null
    recipientName: string | null; reason: string | null; identifiedAt: string | null; createdAt: string
    candidates: Candidate[]; candidatesTotal: number
  }>
  noTracking[i].refusedParcel: { trackingNumber: string; reason: string; createdAt: string } | null
  shops: { id: string; name: string }[]  // for the manual link form
  ```
  `LoadedDelivery` gains `customerEmail: string | null` (never sent to the browser).

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/delivery/route.integration.test.ts` inside `describe('GET /api/delivery', ...)`. Reuse the file's `shopId`, `TRACK`, `scoped`, `url`.

```ts
  it('describes an unlinked parcel: carrier, country, weight, reason, and the orders it could belong to', async () => {
    const o = await db.order.create({
      data: {
        shopId, externalId: 'U1', number: 'U1', placedAt: new Date('2026-08-10T10:00:00Z'), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        shippingCountry: 'DE', customerName: 'Tobias K',
      },
    })
    await db.shipment.create({
      data: {
        trackingNumber: `${TRACK}D1`, carrier: 'DHL', destinationCountry: 'DE', weightKg: 18.2,
        bookedAt: new Date('2026-08-11T09:00:00Z'), identifiedAt: new Date('2026-08-11T12:00:00Z'),
        unlinkedReason: 'DHL parcel to DE: DHL gives no name or email, so no order could be matched by itself',
        lastStatus: 'HANDED_IN',
      },
    })

    const body = await (await GET(new Request(url))).json()
    const p = body.unlinked.find((x: { trackingNumber: string }) => x.trackingNumber === `${TRACK}D1`)
    expect(p).toMatchObject({
      carrier: 'DHL', destinationCountry: 'DE', weightKg: 18.2, lastStatus: 'HANDED_IN',
      reason: 'DHL parcel to DE: DHL gives no name or email, so no order could be matched by itself',
      candidatesTotal: 1,
    })
    expect(p.url).toContain('dhl.com')
    expect(p.candidates[0]).toMatchObject({ orderId: o.id, number: 'U1', customerName: 'Tobias K', holdsParcel: false })
    expect(body.shops.some((s: { id: string }) => s.id === shopId)).toBe(true)
  })

  it('never sends a recipient email to the browser, and leaves out dismissed parcels', async () => {
    await db.shipment.create({ data: { trackingNumber: `${TRACK}E1`, carrier: 'BRING', recipientEmail: 'secret@example.test', recipientName: 'Some One' } })
    await db.shipment.create({ data: { trackingNumber: `${TRACK}E2`, carrier: 'DHL', terminal: true, dismissedAt: new Date(), unlinkedReason: 'Not a customer parcel (dismissed by a@b.c)' } })
    const text = await (await GET(new Request(url))).text()
    expect(text).not.toContain('secret@example.test')
    expect(text).toContain('Some One')
    expect(text).not.toContain(`${TRACK}E2`)
    expect(JSON.parse(text).unlinkedTotal).toBe(1)
  })

  it('tells a no-tracking order that a parcel for its customer was refused, and why', async () => {
    await db.order.create({
      data: {
        shopId, externalId: 'N1', number: 'N1', placedAt: new Date('2026-08-10T10:00:00Z'), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        customerEmail: 'Twice@Example.test',
      },
    })
    await db.shipment.create({
      data: {
        trackingNumber: `${TRACK}R1`, carrier: 'BRING', recipientEmail: 'twice@example.test',
        unlinkedReason: 'twice@example.test matched 2 orders in the last 30 days: N0, N1', createdAt: new Date('2026-08-11T18:00:00Z'),
      },
    })
    const body = await (await GET(new Request(url))).json()
    const row = body.noTracking.find((r: { number: string }) => r.number === 'N1')
    expect(row.refusedParcel).toEqual({
      trackingNumber: `${TRACK}R1`,
      reason: 'twice@example.test matched 2 orders in the last 30 days: N0, N1',
      createdAt: '2026-08-11T18:00:00.000Z',
    })
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project delivery src/app/api/delivery/route.integration.test.ts`
Expected: the three new tests FAIL.

- [ ] **Step 3: Select the email in the loader**

In `src/lib/delivery/load.ts`: add `customerEmail: string | null` to `LoadedDelivery`, add `customerEmail: true` to the `select`, and `customerEmail: o.customerEmail,` beside `customerName` in the returned row. Add this comment above the type field: `/** Server-side only: matched against unlinked parcels, never sent to the browser. */`.

- [ ] **Step 4: Change the route**

In `src/app/api/delivery/route.ts`:

1. Add imports: `import { candidatesFor } from '@/lib/delivery/candidates'`.
2. Change the `unlinked` query to:

```ts
      db.shipment.findMany({
        where: { orderId: null, dismissedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          trackingNumber: true, carrier: true, lastStatus: true,
          destinationCountry: true, weightKg: true, bookedAt: true, recipientName: true,
          unlinkedReason: true, identifiedAt: true, createdAt: true,
          // Server-side only, for candidates and the note below. Stripped before the response.
          recipientEmail: true, consignmentId: true,
        },
      }),
      db.shipment.count({ where: { orderId: null, dismissedAt: null } }),
```

3. After the `Promise.all`, compute candidates and the note:

```ts
    // Candidates are computed live, one query per listed parcel: the answer
    // changes as other parcels link, and fifty small reads on a page load is
    // cheaper than a stored answer that is wrong by the next morning.
    const withCandidates = await Promise.all(
      unlinked.map(async (s) => ({ ...s, ...(await candidatesFor(s)) })),
    )

    /**
     * The one thing a no-tracking order can be told in this phase: a parcel
     * for the same customer was in a file and refused. Keyed on the email
     * both sides hold; DHL parcels carry none, which is what phase 2 is for.
     */
    const refusedByEmail = new Map<string, { trackingNumber: string; reason: string; createdAt: string }>()
    for (const s of [...unlinked].reverse()) {
      if (s.recipientEmail && s.unlinkedReason) {
        refusedByEmail.set(s.recipientEmail.toLowerCase(), {
          trackingNumber: s.trackingNumber, reason: s.unlinkedReason, createdAt: s.createdAt.toISOString(),
        })
      }
    }
    const noteFor = (r: LoadedDelivery) =>
      (r.customerEmail && refusedByEmail.get(r.customerEmail.toLowerCase())) ?? null
```

4. Change `const noTracking = unfiled.sort(byWaiting).slice(0, LATE_LIMIT).map(toRow)` to `.map((r) => ({ ...toRow(r), refusedParcel: noteFor(r) }))`.

5. Replace the `unlinked:` entry of the response with:

```ts
        unlinked: withCandidates.map((s) => ({
          trackingNumber: s.trackingNumber,
          carrier: carrierName(s.carrier),
          url: trackingUrl(s.trackingNumber, s.carrier),
          lastStatus: s.lastStatus,
          destinationCountry: s.destinationCountry,
          bookedAt: s.bookedAt?.toISOString() ?? null,
          weightKg: s.weightKg,
          recipientName: s.recipientName,
          reason: s.unlinkedReason,
          identifiedAt: s.identifiedAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
          candidates: s.candidates,
          candidatesTotal: s.total,
        })),
        unlinkedTotal,
        // For the manual link form: an order number means nothing without its shop.
        shops: shopRows,
```

6. The `shops` query at the top selects `{ id, deliveryTrackingFrom }`; add `name: true` and define `const shopRows = shops.map((s) => ({ id: s.id, name: s.name }))` after it.

- [ ] **Step 5: Run the route tests and typecheck**

Run: `npx vitest run --project delivery src/app/api/delivery/route.integration.test.ts` and `npx tsc --noEmit`.
Expected: PASS, no errors. The test that asserts on `unlinked` rows from before (search the file for `UNLINKED`) still passes because the new fields are additive.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/delivery/route.ts src/app/api/delivery/route.integration.test.ts src/lib/delivery/load.ts
git commit -m "feat(delivery): the page is told why a parcel has no order, and which orders it could be

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 12: The page: "Parcels without an order", and the note under "No tracking yet"

**Files:**
- Modify: `src/app/delivery/DeliveryClient.tsx` (types near line 61; `NoTracking` near line 676; `UnlinkedParcels` near line 979; the mount near line 1451)
- Test: `src/app/delivery/DeliveryClient.test.tsx`

**Interfaces:**
- Consumes: the payload of Task 11.
- Produces: exported components `UnattachedParcels({ items, total, shops, onChanged })` and the existing `NoTracking` with `refusedParcel` on its rows.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/delivery/DeliveryClient.test.tsx`. Add to the imports: `UnattachedParcels, type UnlinkedParcel` from `./DeliveryClient`, `ToastProvider` from `@/components/toast/ToastProvider`, `waitFor` from `@testing-library/react`, and `afterEach, vi` from vitest (if not already imported).

```ts
const parcel = (over: Partial<UnlinkedParcel> = {}): UnlinkedParcel => ({
  trackingNumber: '473325380023179098', carrier: 'DHL',
  url: 'https://www.dhl.com/se-en/home/tracking.html?tracking-id=473325380023179098',
  lastStatus: 'DELIVERED', destinationCountry: 'DE', bookedAt: '2026-09-07T17:30:00.000Z', weightKg: 18.2,
  recipientName: null, reason: 'DHL parcel to DE: DHL gives no name or email, so no order could be matched by itself',
  identifiedAt: '2026-09-08T00:15:00.000Z', createdAt: '2026-09-07T16:00:00.000Z',
  candidates: [
    { orderId: 'o-15864', number: '15864', shop: 'Panetti Germany', customerName: 'Tobias Kohlmeyer', placedAt: '2026-09-07T15:49:00.000Z', items: '1 x Panetti ProMix', holdsParcel: false },
    { orderId: 'o-15865', number: '15865', shop: 'Panetti Germany', customerName: 'Martin Röthke', placedAt: '2026-09-07T16:29:00.000Z', items: '1 x Pizza oven', holdsParcel: true },
  ],
  candidatesTotal: 2,
  ...over,
})

const SHOPS = [{ id: 's-de', name: 'Panetti Germany' }]

afterEach(() => vi.unstubAllGlobals())

describe('UnattachedParcels', () => {
  it('shows the carrier, where it goes, the weight, the status and the reason', () => {
    const { container } = render(
      <ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Parcels without an order/ }))
    expect(container.textContent).toContain('DHL')
    expect(container.textContent).toContain('DE')
    expect(container.textContent).toContain('18.2 kg')
    expect(container.textContent).toContain('DELIVERED')
    expect(container.textContent).toContain('DHL gives no name or email')
  })

  it('offers each candidate as a button naming the order, the customer and what they bought, flagging one that holds a parcel', () => {
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels without an order/ }))
    expect(screen.getByRole('button', { name: /Link to 15864/ }).textContent).toContain('Tobias Kohlmeyer')
    expect(screen.getByRole('button', { name: /Link to 15864/ }).textContent).toContain('1 x Panetti ProMix')
    expect(screen.getByRole('button', { name: /Link to 15865/ }).textContent).toContain('(has a parcel)')
  })

  it('sends the chosen order to the parcel route and asks the page to reload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onChanged = vi.fn()
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={onChanged} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels without an order/ }))

    fireEvent.click(screen.getByRole('button', { name: /Link to 15864/ }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/delivery/parcels/473325380023179098')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ orderId: 'o-15864' })
  })

  it('shows the route\'s own words when a link is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This parcel is already linked to an order' }), { status: 400 })))
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels without an order/ }))
    fireEvent.click(screen.getByRole('button', { name: /Link to 15864/ }))
    expect(await screen.findByText('This parcel is already linked to an order')).toBeInTheDocument()
  })

  it('dismisses a parcel that is not a customer delivery', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onChanged = vi.fn()
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={onChanged} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels without an order/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Not a customer parcel' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ dismiss: true })
  })

  it('links by typed order number and shop when no candidate fits', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/api/orders/lookup')
        ? new Response(JSON.stringify({ orderId: 'o-typed' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ToastProvider><UnattachedParcels items={[parcel({ candidates: [], candidatesTotal: 0 })]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels without an order/ }))
    fireEvent.change(screen.getByLabelText('Order number'), { target: { value: '15866' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/orders/lookup?shop=s-de&number=15866')
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ orderId: 'o-typed' })
  })

  it('says a parcel nobody has been asked about yet is simply not identified yet', () => {
    const { container } = render(
      <ToastProvider><UnattachedParcels items={[parcel({ carrier: 'Unknown', url: null, reason: null, identifiedAt: null, candidates: [], candidatesTotal: 0 })]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Parcels without an order/ }))
    expect(container.textContent).toContain('Not identified yet - the next check asks Bring, then DHL')
    expect(container.querySelector('a[href]')).toBeNull()
  })
})

describe('NoTracking, when a parcel was refused for that customer', () => {
  it('says so on the row, with the reason and a link down to the parcel', () => {
    const { container } = render(
      <NoTracking
        rows={[order({ state: 'NO_TRACKING', refusedParcel: { trackingNumber: '373325386490923366', reason: 'a@b.c matched 2 orders in the last 30 days: 14582, 14692', createdAt: '2026-09-07T16:00:00.000Z' } })]}
        total={1} open onToggle={() => {}}
      />,
    )
    expect(container.textContent).toContain('A parcel for this customer was in the file of 7 Sept 2026 but was not attached: a@b.c matched 2 orders in the last 30 days: 14582, 14692')
    expect(container.querySelector('a[href="#unattached"]')?.textContent).toBe('373325386490923366')
    expect(container.textContent).toContain('Where the warehouse file named a parcel we could not attach')
  })
})
```

The typed-number test needs a small lookup route, `GET /api/orders/lookup?shop=<id>&number=<n>` answering `{ orderId }` or 404. Create it in this task (below).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project app src/app/delivery/DeliveryClient.test.tsx`
Expected: FAIL, `UnattachedParcels` is not exported.

- [ ] **Step 3: The lookup route**

Create `src/app/api/orders/lookup/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/** An order number means nothing without its shop; this turns the pair into an id. */
export async function GET(req: Request) {
  try {
    assertOperations(await currentUser())
    const params = new URL(req.url).searchParams
    const shopId = params.get('shop')?.trim() ?? ''
    const number = params.get('number')?.trim() ?? ''
    if (!shopId || !number) return NextResponse.json({ error: 'A shop and an order number' }, { status: 400, headers: NO_STORE })
    const order = await db.order.findFirst({ where: { shopId, number }, select: { id: true } })
    if (!order) return NextResponse.json({ error: `No order ${number} in that shop` }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ orderId: order.id }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not look that order up' }, { status: 500, headers: NO_STORE })
  }
}
```

Add a test `src/app/api/orders/lookup/route.test.ts` (project `app`, mocks `@/lib/db`):

```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'ops@example.test', role: 'OPERATIONS' })),
}))
const findFirst = vi.fn()
vi.mock('@/lib/db', () => ({ db: { order: { findFirst: (...a: unknown[]) => findFirst(...a) } } }))

const { GET } = await import('./route')

describe('GET /api/orders/lookup', () => {
  it('turns a shop and a number into an order id', async () => {
    findFirst.mockResolvedValueOnce({ id: 'o1' })
    const res = await GET(new Request('http://localhost/api/orders/lookup?shop=s1&number=15866'))
    expect(await res.json()).toEqual({ orderId: 'o1' })
    expect(findFirst).toHaveBeenCalledWith({ where: { shopId: 's1', number: '15866' }, select: { id: true } })
  })

  it('says when there is no such order', async () => {
    findFirst.mockResolvedValueOnce(null)
    const res = await GET(new Request('http://localhost/api/orders/lookup?shop=s1&number=9'))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('No order 9 in that shop')
  })
})
```

- [ ] **Step 4: Types and the note in `DeliveryClient.tsx`**

Replace the `UnlinkedParcel` type with:

```ts
export type Candidate = {
  orderId: string
  number: string
  shop: string
  customerName: string | null
  placedAt: string
  items: string
  holdsParcel: boolean
}

export type UnlinkedParcel = {
  trackingNumber: string
  carrier: string
  url: string | null
  lastStatus: string | null
  destinationCountry: string | null
  bookedAt: string | null
  weightKg: number | null
  recipientName: string | null
  reason: string | null
  identifiedAt: string | null
  createdAt: string
  candidates: Candidate[]
  candidatesTotal: number
}
```

Add to `LateOrder`:

```ts
  /** A parcel for this customer was in a file and refused. Null when none. */
  refusedParcel?: { trackingNumber: string; reason: string; createdAt: string } | null
```

Add `shops: { id: string; name: string }[]` to `Payload`.

In `NoTracking`, replace the sub-heading text with:

```tsx
          <span className="mt-0.5 block text-[12px] text-muted">
            We hold no parcel for these orders. Some are simply not shipped yet. Where the warehouse
            file named a parcel we could not attach, the row says so and the parcel is listed below.
          </span>
```

and, in the row, under the customer/order cell (inside the `<td>` that renders `r.number`), add after the `Link`:

```tsx
                    {r.refusedParcel && (
                      <span className="mt-0.5 block text-[12px] font-normal text-warn">
                        A parcel for this customer was in the file of {orderedOn(r.refusedParcel.createdAt.slice(0, 10))} but
                        was not attached: {r.refusedParcel.reason}{' '}
                        <a href="#unattached" className="num text-accent hover:underline">
                          {r.refusedParcel.trackingNumber}
                        </a>
                      </span>
                    )}
```

(`orderedOn` takes a `YYYY-MM-DD…` local string and prints "7 Sept 2026"; the ISO date's first ten characters are enough for it.)

- [ ] **Step 5: The new section**

Replace the whole `UnlinkedParcels` component with:

```tsx
/**
 * Every parcel we hold that belongs to no order, with the facts a person
 * needs to attach it and the buttons to do so. The machine refuses whenever
 * two orders could be right; this is where a person decides. Collapsed by
 * default, but the count in the heading is always the true total.
 */
export function UnattachedParcels({
  items,
  total,
  shops,
  onChanged,
}: {
  items: UnlinkedParcel[]
  total: number
  shops: { id: string; name: string }[]
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const toast = useToast()
  const capped = total > items.length

  async function patch(trackingNumber: string, body: { orderId: string } | { dismiss: true }) {
    setBusy(trackingNumber)
    try {
      const res = await fetch(`/api/delivery/parcels/${encodeURIComponent(trackingNumber)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => ({}))).error ?? 'Could not update this parcel')
        return
      }
      toast.success('dismiss' in body ? 'Parcel dismissed' : 'Parcel linked')
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  async function linkTyped(trackingNumber: string, shopId: string, number: string) {
    if (!shopId || !number.trim()) {
      toast.error('Choose the shop and type the order number')
      return
    }
    const res = await fetch(`/api/orders/lookup?shop=${encodeURIComponent(shopId)}&number=${encodeURIComponent(number.trim())}`)
    if (!res.ok) {
      toast.error((await res.json().catch(() => ({}))).error ?? 'Could not find that order')
      return
    }
    const { orderId } = (await res.json()) as { orderId: string }
    await patch(trackingNumber, { orderId })
  }

  return (
    <section id="unattached" className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left"
      >
        <span>
          <span className="text-[13px] font-semibold text-ink">
            Parcels without an order{' '}
            <span className="num font-normal text-muted">
              ({capped ? `${items.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}` : items.length.toLocaleString('en-US')})
            </span>
          </span>
          <span className="mt-0.5 block text-[12px] text-muted">
            Parcels a warehouse file named that we could not attach to an order, with the reason. Pick the
            order, or type its number. Nothing here is guessed.
          </span>
        </span>
        <span aria-hidden="true" className="text-faint">{open ? '▾' : '▸'}</span>
      </button>

      {open &&
        (items.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-[13px] text-muted">
            None right now - every parcel the carriers have told us about is linked to an order.
          </p>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line bg-panel text-[11px] font-semibold text-faint">
                  <th className="px-5 py-2 text-left">Parcel</th>
                  <th className="px-3 py-2 text-left">Carrier</th>
                  <th className="px-3 py-2 text-left">To</th>
                  <th className="px-3 py-2 text-left">Booked</th>
                  <th className="px-3 py-2 text-right">Weight</th>
                  <th className="px-3 py-2 text-left">Last status</th>
                  <th className="px-5 py-2 text-left">Why</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <ParcelRow key={p.trackingNumber} p={p} shops={shops} busy={busy === p.trackingNumber} onLink={patch} onLinkTyped={linkTyped} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  )
}

const bookedOn = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : DASH

function ParcelRow({
  p,
  shops,
  busy,
  onLink,
  onLinkTyped,
}: {
  p: UnlinkedParcel
  shops: { id: string; name: string }[]
  busy: boolean
  onLink: (trackingNumber: string, body: { orderId: string } | { dismiss: true }) => Promise<void>
  onLinkTyped: (trackingNumber: string, shopId: string, number: string) => Promise<void>
}) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [number, setNumber] = useState('')
  const why = p.reason ?? (p.identifiedAt ? DASH : 'Not identified yet - the next check asks Bring, then DHL')
  const more = p.candidatesTotal - p.candidates.length

  return (
    <>
      <tr className="hover:bg-panel">
        <td className="px-5 py-2.5">
          {p.url ? (
            <a href={p.url} target="_blank" rel="noopener noreferrer" className="num text-accent hover:underline">{p.trackingNumber}</a>
          ) : (
            <span className="num text-ink">{p.trackingNumber}</span>
          )}
          {p.recipientName && <span className="block text-[12px] text-muted">{p.recipientName}</span>}
        </td>
        <td className="px-3 py-2.5 text-muted">{p.carrier}</td>
        <td className="px-3 py-2.5 text-ink">{p.destinationCountry ?? DASH}</td>
        <td className="px-3 py-2.5 text-ink">{bookedOn(p.bookedAt)}</td>
        <td className="num px-3 py-2.5 text-right text-ink">{p.weightKg !== null ? `${p.weightKg} kg` : DASH}</td>
        <td className="px-3 py-2.5 text-ink">{p.lastStatus ?? DASH}</td>
        <td className="max-w-[320px] px-5 py-2.5 text-[12px] text-warn">{why}</td>
      </tr>
      <tr className="border-b border-line last:border-b-0">
        <td colSpan={7} className="px-5 pb-3 pt-0">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {p.candidates.map((c) => (
              <button
                key={c.orderId}
                type="button"
                disabled={busy}
                onClick={() => void onLink(p.trackingNumber, { orderId: c.orderId })}
                className="rounded-[var(--radius-control)] border border-line px-2 py-1 text-accent hover:bg-panel disabled:opacity-50"
              >
                Link to {c.number} · {c.customerName || 'name unknown'} · {orderedOn(c.placedAt.slice(0, 10))}
                {c.items ? ` · ${c.items}` : ''}
                {c.holdsParcel ? ' (has a parcel)' : ''}
              </button>
            ))}
            {more > 0 && <span className="text-muted">and {more} more</span>}
            <label className="ml-auto flex items-center gap-1 text-muted">
              Shop
              <select aria-label="Shop" value={shopId} onChange={(e) => setShopId(e.target.value)} className="rounded-[var(--radius-control)] border border-line bg-surface px-1.5 py-1 text-ink">
                {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1 text-muted">
              Order number
              <input aria-label="Order number" value={number} onChange={(e) => setNumber(e.target.value)} className="w-24 rounded-[var(--radius-control)] border border-line bg-surface px-1.5 py-1 text-ink" />
            </label>
            <button type="button" disabled={busy} onClick={() => void onLinkTyped(p.trackingNumber, shopId, number)} className="rounded-[var(--radius-control)] border border-line px-2 py-1 text-accent hover:bg-panel disabled:opacity-50">
              Link
            </button>
            <button type="button" disabled={busy} onClick={() => void onLink(p.trackingNumber, { dismiss: true })} className="rounded-[var(--radius-control)] border border-line px-2 py-1 text-muted hover:bg-panel disabled:opacity-50">
              Not a customer parcel
            </button>
          </div>
        </td>
      </tr>
    </>
  )
}
```

Add `import { useToast } from '@/components/toast/useToast'` at the top. At the mount (`<UnlinkedParcels items={data.unlinked} total={data.unlinkedTotal} />`), use `<UnattachedParcels items={data.unlinked} total={data.unlinkedTotal} shops={data.shops} onChanged={reload} />`. Check `src/app/delivery/page.tsx` wraps the page in `ToastProvider` through `AppShell` (grep `ToastProvider` in `src/components/shell/AppShell.tsx` or the root layout); if it does not, wrap the rendered tree in `page.tsx` with `<ToastProvider>`.

- [ ] **Step 6: Run the page tests and typecheck**

Run: `npx vitest run --project app src/app/delivery/DeliveryClient.test.tsx src/app/api/orders/lookup/route.test.ts` and `npx tsc --noEmit` and `npx eslint src/app/delivery src/app/api/orders/lookup src/app/api/delivery`.
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/delivery/DeliveryClient.tsx src/app/delivery/DeliveryClient.test.tsx src/app/api/orders/lookup/
git commit -m "feat(delivery): one list of parcels without an order, with the reason and a way to attach them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 13: End to end: a parcel is attached by hand

**Files:**
- Create: `e2e/delivery-link-by-hand.spec.ts`

This spec needs a running dev server (`npm run dev` in a checkout where it starts; the worktree may not, see the memory note "dev server will not start in a worktree"). If it cannot run here, run it from the primary checkout after merge, and say so in the PR.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const TAG = '[e2e-link-by-hand]'
const TRACK = 'E2ELINK'
const PARCEL = `${TRACK}473325380023179098`
const ORDER = 'E2ELINK-15864'
const EMAIL = 'e2e-link@ecom.test'
const PASSWORD = 'password123'

const db = new PrismaClient()

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: TRACK } } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.user.deleteMany({ where: { email: EMAIL } })
}

async function seed() {
  await cleanup()
  await db.user.create({ data: { email: EMAIL, passwordHash: await bcrypt.hash(PASSWORD, 10), role: 'OPERATIONS' } })
  const shop = await db.shop.create({
    data: { name: `Panetti Germany ${TAG}`, currency: 'EUR', active: true, timezone: 'Europe/Berlin', deliveryTrackingFrom: new Date('2024-01-01') },
  })
  await db.order.create({
    data: {
      shopId: shop.id, externalId: ORDER, number: ORDER, placedAt: new Date(Date.now() - 3 * 24 * 3600_000), status: 'completed', currency: 'EUR',
      shippingCountry: 'DE', customerName: 'Tobias Kohlmeyer',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    },
  })
  await db.shipment.create({
    data: {
      trackingNumber: PARCEL, carrier: 'DHL', destinationCountry: 'DE', weightKg: 18.2,
      bookedAt: new Date(Date.now() - 2 * 24 * 3600_000), identifiedAt: new Date(),
      unlinkedReason: 'DHL parcel to DE: DHL gives no name or email, so no order could be matched by itself',
    },
  })
}

test.beforeAll(seed)
test.afterAll(async () => {
  await cleanup()
  await db.$disconnect()
})

test('the operations manager attaches a DHL parcel to its order and both lists update', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)

  await page.goto('/delivery')
  await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible()
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()

  const section = page.locator('#unattached')
  await section.getByRole('button', { name: /Parcels without an order/ }).click()
  await expect(section.getByText(PARCEL)).toBeVisible({ timeout: 15_000 })
  await expect(section.getByText('18.2 kg')).toBeVisible()

  await section.getByRole('button', { name: new RegExp(`Link to ${ORDER}`) }).click()
  await expect(page.getByText('Parcel linked')).toBeVisible()

  await expect(section.getByText(PARCEL)).toHaveCount(0, { timeout: 15_000 })
  const noTracking = page.locator('#no-tracking')
  await expect(noTracking.getByText(ORDER)).toHaveCount(0)

  const row = await db.shipment.findUnique({ where: { trackingNumber: PARCEL } })
  expect(row?.linkSource).toBe('MANUAL')
  expect(row?.orderId).not.toBeNull()
})
```

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/delivery-link-by-hand.spec.ts --reporter=line`
Expected: 1 passed. If the dev server cannot start in this worktree, record that in the PR and run it after merge from the primary checkout.

- [ ] **Step 3: Commit**

```bash
git add e2e/delivery-link-by-hand.spec.ts
git commit -m "test(delivery): a parcel attached by hand leaves both lists

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 14: Whole suite, review, PR

- [ ] **Step 1: Run everything**

```bash
npx tsc --noEmit
npx eslint src e2e
npx vitest run --project app
npx vitest run --project delivery --testTimeout=20000
```

Expected: no type errors; eslint reports only the eight pre-existing errors in B2bClient/CustomerClient/CostsClient/ExpensesClient (none in files this branch touched); every test passes except the pre-existing `src/lib/inbox/ingest.integration.test.ts` failure (fails identically on `origin/main`). Two or three red `sync.test.ts` cases on a full run are contention: re-run that file alone.

- [ ] **Step 2: Merge main and re-run the delivery project**

```bash
git fetch origin && git merge origin/main
npx prisma generate && npx vitest run --project delivery --testTimeout=20000
```

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/parcel-identity
gh pr create --title "Parcels that wear the wrong carrier are identified, listed with their reason, and attachable by hand" --body-file - <<'EOF'
## What

- The importer no longer calls every unknown number a Bring parcel: it stores it as carrier UNKNOWN. The poller asks Bring, then DHL (under DHL's budget), and the first to answer owns the row. 17 of 17 "Bring" numbers checked on 2026-09-10 were DHL's.
- Refused parcels are stored as rows with their reason, re-matched nightly, and listed.
- Two new match rules for repeat customers: an order holding another consignment's parcel is out; an order placed after the label was made is out.
- The Delivery page: one section "Parcels without an order" with carrier, country, booked date, weight, status, reason, candidate orders (with items) and Link / Not a customer parcel buttons. "No tracking yet" tells an order when a parcel for its customer was refused, and why.
- Tracking links open the carrier that has the parcel, or nothing.

## Spec and plan

docs/superpowers/specs/2026-09-10-parcel-identity-design.md
docs/superpowers/plans/2026-09-10-parcel-identity.md

## Checks

- typecheck, eslint (no new findings), vitest app + delivery projects, Playwright `delivery-link-by-hand`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75
EOF
```

- [ ] **Step 4: Watch the checks, merge, verify the deploy**

```bash
gh pr checks --watch
gh pr merge --merge --delete-branch=false
```

Then poll `https://panetti.vercel.app/api/version` until it reports the merge commit, open `https://panetti.vercel.app/delivery`, and confirm the "Parcels without an order" section lists the parcels with carrier DHL and a status once the poller has run (about five hours for the whole backlog at two DHL calls per run).
