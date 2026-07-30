# Ambassador Products Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record which products each ambassador got from us, show them on the ambassadors tab and in the ambassador's own portal, and count how many ambassadors hold each product.

**Architecture:** One new table `AmbassadorProduct` keyed on `sku` (the product identity across shops, because `Product` is shop-scoped and the same chair is 66 rows). One pure function does the distinct-ambassador counting. Two new route files; the two read paths extend responses the pages already fetch. Two new focused components keep `AmbassadorsClient.tsx` (already 692 lines) from growing further.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 6 + PostgreSQL, Zod 4, Vitest, Playwright, Tailwind 4.

## Global Constraints

- Money and dates follow existing conventions: dates stored at UTC midnight via `utcDay` from `@/lib/dates`.
- Staff writes and staff reads use `assertStaff` from `@/lib/auth/guard` (ADMIN **or** MARKETING). Never `assertAdmin` — marketing runs the ambassador program.
- Portal reads take the ambassador id **from the session, never the request**.
- A route that changes nothing must not report success: `deleteMany` + `count === 0` → 404.
- Zod validation returns `parsed.error.issues[0]?.message` as `{ error }`.
- Comments explain **why**, not what. Match the surrounding voice.
- No em dashes in user-facing copy is NOT a rule here; the codebase uses them freely.
- Run `npm test` after each task. Baseline before this plan: **90 files, 645 tests, all passing.** Anything red is yours.
- Do NOT run `git stash`, `git checkout --`, `git reset`, or `git restore`. Five files in the working tree (`.env.example`, `docs/superpowers/plans/2026-07-30-platform-credentials-are-server-config.md`, `src/app/settings/ad-accounts/AdAccountsClient.test.tsx`, `src/lib/ads/platform-app.ts`, `src/lib/ads/platform-app.test.ts`) hold someone else's uncommitted work. Leave them alone and never `git add -A`. Stage only the exact paths each task names.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | The `AmbassadorProduct` model + relation on `Ambassador` |
| `src/lib/ambassador-products.ts` (create) | `summariseProducts` — the distinct-ambassador count. Pure, no Prisma |
| `src/lib/ambassador-products.test.ts` (create) | Its tests |
| `src/app/api/ambassador-products/route.ts` (create) | `GET` overview + catalogue, `POST` add a gift |
| `src/app/api/ambassador-products/route.test.ts` (create) | Route tests |
| `src/app/api/ambassador-products/[id]/route.ts` (create) | `DELETE` one gift |
| `src/app/api/ambassador-products/[id]/route.test.ts` (create) | Route tests |
| `src/app/api/ambassadors/route.ts` (modify) | Add `products[]` to each ambassador |
| `src/app/api/portal/route.ts` (modify) | Add `products[]` for the session's ambassador |
| `src/components/ambassadors/ProductOverview.tsx` (create) | The overview card |
| `src/components/ambassadors/ProductLedger.tsx` (create) | The Edit-modal section: list + add row |
| `src/components/ambassadors/ProductLedger.test.tsx` (create) | Its tests |
| `src/app/ambassadors/AmbassadorsClient.tsx` (modify) | Wire overview, roster chips, modal section |
| `src/app/portal/PortalClient.tsx` (modify) | Read-only "Products we sent you" card |
| `prisma/seed.ts` (modify) | Seed gifts so the page is never empty |
| `e2e/ambassador-products.spec.ts` (create) | The whole loop end to end |

---

### Task 1: Schema and the counting function

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/lib/ambassador-products.ts`
- Test: `src/lib/ambassador-products.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type GiftRow = { ambassadorId: string; sku: string; name: string; quantity: number }`, `type ProductSummary = { sku: string; name: string; ambassadors: number; units: number }`, `summariseProducts(rows: GiftRow[]): ProductSummary[]`. Prisma model `AmbassadorProduct` with fields `id, ambassadorId, sku, name, quantity, receivedAt, note, createdAt`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ambassador-products.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { summariseProducts } from './ambassador-products'

const gift = (ambassadorId: string, sku: string, name: string, quantity = 1) => ({
  ambassadorId,
  sku,
  name,
  quantity,
})

describe('summariseProducts', () => {
  it('counts a person once per product, however many they were sent', () => {
    // Emma got two of the same chair on two dates. That is one ambassador
    // holding it, not two — the whole reason this is a function and not a
    // groupBy in a route.
    const rows = [gift('emma', 'MACBL661', 'Advanced Comfort', 1), gift('emma', 'MACBL661', 'Advanced Comfort', 2)]

    expect(summariseProducts(rows)).toEqual([
      { sku: 'MACBL661', name: 'Advanced Comfort', ambassadors: 1, units: 3 },
    ])
  })

  it('counts distinct people and sums their units', () => {
    const rows = [
      gift('emma', 'MPX-001', 'Pro X', 1),
      gift('johan', 'MPX-001', 'Pro X', 2),
      gift('sofia', 'MACBL661', 'Advanced Comfort', 1),
    ]

    expect(summariseProducts(rows)).toEqual([
      { sku: 'MPX-001', name: 'Pro X', ambassadors: 2, units: 3 },
      { sku: 'MACBL661', name: 'Advanced Comfort', ambassadors: 1, units: 1 },
    ])
  })

  it('breaks ties by units, then by name, so the order is total', () => {
    const rows = [
      gift('emma', 'B-SKU', 'Bravo', 1),
      gift('johan', 'A-SKU', 'Alpha', 5),
      gift('sofia', 'C-SKU', 'Charlie', 1),
    ]

    // All three have one ambassador; Alpha wins on units, then Bravo before
    // Charlie by name.
    expect(summariseProducts(rows).map((r) => r.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('ranks by people before units, not the other way round', () => {
    // The one case that tells the two orderings apart: A-SKU has more units,
    // B-SKU has more people. Reach is the question this table answers, so
    // B-SKU must come first.
    const rows = [
      gift('emma', 'A-SKU', 'Alpha', 9),
      gift('johan', 'B-SKU', 'Bravo', 1),
      gift('sofia', 'B-SKU', 'Bravo', 1),
    ]

    expect(summariseProducts(rows).map((r) => r.sku)).toEqual(['B-SKU', 'A-SKU'])
  })

  it('falls back to sku when everything else ties, so the order is truly total', () => {
    // Same product name under two SKUs, same reach, same units — without the
    // sku tiebreaker this pair would come back in whatever order the caller
    // happened to supply.
    const rows = [gift('emma', 'Z-SKU', 'Same Name', 1), gift('johan', 'A-SKU', 'Same Name', 1)]

    expect(summariseProducts(rows).map((r) => r.sku)).toEqual(['A-SKU', 'Z-SKU'])
    // Reversing the input must not reverse the output.
    expect(summariseProducts([...rows].reverse()).map((r) => r.sku)).toEqual(['A-SKU', 'Z-SKU'])
  })

  it('returns an empty list when nothing has been handed out', () => {
    expect(summariseProducts([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ambassador-products.test.ts`
Expected: FAIL — cannot resolve `./ambassador-products`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ambassador-products.ts`:

```ts
/**
 * What we sent our ambassadors, counted per product.
 *
 * The one subtlety: an ambassador who was sent the same chair twice is ONE
 * ambassador holding that chair, not two. A `groupBy` on sku would count rows
 * and quietly overstate the reach of every product we ever replaced under
 * warranty, so the people are collected in a Set.
 *
 * Pure on purpose: no Prisma, no request. Same treatment every other
 * calculation in this codebase gets.
 */

export type GiftRow = {
  ambassadorId: string
  sku: string
  name: string
  quantity: number
}

export type ProductSummary = {
  sku: string
  name: string
  ambassadors: number // DISTINCT people
  units: number
}

export function summariseProducts(rows: GiftRow[]): ProductSummary[] {
  const bySku = new Map<string, { name: string; people: Set<string>; units: number }>()

  for (const row of rows) {
    const entry = bySku.get(row.sku) ?? { name: row.name, people: new Set<string>(), units: 0 }
    entry.people.add(row.ambassadorId)
    entry.units += row.quantity
    bySku.set(row.sku, entry)
  }

  return [...bySku.entries()]
    .map(([sku, e]) => ({ sku, name: e.name, ambassadors: e.people.size, units: e.units }))
    // A total order, so the table never reshuffles between two identical loads.
    // SKU is the last tiebreaker and the only one guaranteed distinct: without
    // it, two SKUs tied on count, units AND name fall back to input order, and
    // the caller's query has no ORDER BY to make that stable.
    .sort(
      (a, b) =>
        b.ambassadors - a.ambassadors ||
        b.units - a.units ||
        a.name.localeCompare(b.name) ||
        a.sku.localeCompare(b.sku),
    )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ambassador-products.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the schema model**

In `prisma/schema.prisma`, add `products AmbassadorProduct[]` to the `Ambassador` model's relation block (beside `codes` and `orders`):

```prisma
model Ambassador {
  id             String   @id @default(cuid())
  name           String
  email          String   @unique
  commissionRate Float    @default(0.10) // 10%
  active         Boolean  @default(true)
  createdAt      DateTime @default(now())

  codes    AmbassadorCode[]
  orders   Order[]
  user     User?
  products AmbassadorProduct[]
}
```

Then append the new model at the end of the file:

```prisma
// What we sent an ambassador: a chair, a massage gun, whatever they were given
// to promote. Keyed on SKU, not a Product id, because Product is shop-scoped
// and cascades away with its shop — a gift is a fact about a physical object
// and must outlive a store being removed. `name` is a snapshot for the same
// reason OrderItem.name is one: a shop renaming its listing must not rewrite
// what we already handed over.
//
// No unique on (ambassadorId, sku): two chairs on two dates are two rows, each
// with its own date and note. Collapsing them would lose the second of both.
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

- [ ] **Step 6: Push the schema and regenerate the client**

Run: `npm run db:push`
Expected: "Your database is now in sync with your Prisma schema." No destructive-change prompt — the change is purely additive.

If it asks to reset the database, STOP: something else is wrong. Do not accept.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: 91 files, 651 tests, all passing (baseline 90/645 plus this task’s 1 file / 6 tests).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma src/lib/ambassador-products.ts src/lib/ambassador-products.test.ts
git commit -m "feat: a table for what we sent each ambassador, and the count that respects people"
```

---

### Task 2: The staff route — overview, catalogue, and adding a gift

**Files:**
- Create: `src/app/api/ambassador-products/route.ts`
- Test: `src/app/api/ambassador-products/route.test.ts`

**Interfaces:**
- Consumes: `summariseProducts`, `GiftRow` from Task 1.
- Produces: `GET /api/ambassador-products` → `{ overview: ProductSummary[], catalogue: { sku: string; name: string }[] }`. `POST /api/ambassador-products` body `{ ambassadorId, sku, name, quantity, receivedAt, note? }` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/ambassador-products/route.test.ts`:

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

const EMAIL = 'plan-giftroute-amb@example.local'
const MARK = '[gift-route-test]'
let ambassadorId = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}
const asMarketing = async () => {
  cookieValue.current = await signSession({
    userId: 'test-mkt', email: 'mkt@test.local', role: 'MARKETING', ambassadorId: null,
  })
}
const asAmbassador = async () => {
  cookieValue.current = await signSession({
    userId: 'test-amb', email: EMAIL, role: 'AMBASSADOR', ambassadorId,
  })
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/ambassador-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

async function cleanup() {
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
}

beforeEach(async () => {
  await cleanup()
  const a = await db.ambassador.create({
    data: { name: 'Gift Test', email: EMAIL, commissionRate: 0.1 },
  })
  ambassadorId = a.id
  await asAdmin()
})

afterEach(async () => {
  await cleanup()
  cookieValue.current = undefined
})

describe('POST /api/ambassador-products', () => {
  it('records a gift and it shows up in the overview', async () => {
    // A SKU nothing else in the system uses. The overview aggregates EVERY
    // AmbassadorProduct row with no scoping, so asserting exact counts against
    // a real catalogue SKU would break the moment the seed — or a developer
    // clicking around the local app — created one of the same product. The
    // catalogue test below already uses a synthetic 'DUP-1' for the same
    // reason; this makes the file consistent with itself.
    const res = await post({
      ambassadorId, sku: 'OVERVIEW-TEST-SKU', name: 'Overview Test Product',
      quantity: 2, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(200)

    const overview = (await (await GET()).json()) as {
      overview: { sku: string; ambassadors: number; units: number }[]
    }
    const row = overview.overview.find((r) => r.sku === 'OVERVIEW-TEST-SKU')
    expect(row).toMatchObject({ ambassadors: 1, units: 2 })
  })

  it('stores the date at UTC midnight, like every other date here', async () => {
    await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X',
      quantity: 1, receivedAt: '2026-03-12',
    })
    const stored = await db.ambassadorProduct.findFirst({ where: { ambassadorId } })
    expect(stored!.receivedAt.toISOString()).toBe('2026-03-12T00:00:00.000Z')
  })

  it('refuses a quantity below one', async () => {
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 0, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('at least 1')
  })

  it('refuses an unparseable date', async () => {
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: 'not-a-date',
    })
    expect(res.status).toBe(400)
    // Assert WHICH rejection: a 400 for the wrong reason would otherwise pass.
    expect((await res.json()).error).toContain('date they got it')
  })

  it('refuses a note longer than 200 characters', async () => {
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1,
      receivedAt: '2026-03-12', note: 'x'.repeat(201),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('200 characters')
  })

  it('stores a blank note as null, never an empty string', async () => {
    // An empty string is the ONLY case that discriminates. With `note` omitted,
    // `d.note` is undefined, Prisma drops the key from the INSERT, and the
    // defaultless nullable column yields null under `||`, under `??`, and under
    // no fallback at all — so an omitted note proves nothing about the code.
    // An explicit '' is where they finally diverge: `'' || null` is null (what
    // we want), `'' ?? null` is '' (what the UI would then print as a blank
    // note line). This test fails the moment someone "modernises" || to ??.
    await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1,
      receivedAt: '2026-03-12', note: '',
    })
    const stored = await db.ambassadorProduct.findFirst({ where: { ambassadorId } })
    expect(stored!.note).toBeNull()
  })

  it('404s for an ambassador who does not exist', async () => {
    const res = await post({
      ambassadorId: 'nope', sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(404)
  })

  it('lets marketing record a gift — they run the program', async () => {
    await asMarketing()
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(200)
  })

  it('answers an ambassador with 403 on both verbs', async () => {
    await asAmbassador()
    expect((await GET()).status).toBe(403)
    const res = await post({
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12',
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/ambassador-products', () => {
  it('offers each SKU once, however many shops sell it', async () => {
    const shopA = await db.shop.create({ data: { name: `A ${MARK}`, currency: 'NOK' } })
    const shopB = await db.shop.create({ data: { name: `B ${MARK}`, currency: 'SEK' } })
    // The same physical product, listed in two shops — the exact situation the
    // whole sku-not-productId decision exists for.
    await db.product.create({
      data: { shopId: shopA.id, externalId: '1', sku: 'DUP-1', name: 'Duplicated Chair' },
    })
    await db.product.create({
      data: { shopId: shopB.id, externalId: '1', sku: 'DUP-1', name: 'Duplicated Chair' },
    })

    const body = (await (await GET()).json()) as { catalogue: { sku: string }[] }
    expect(body.catalogue.filter((c) => c.sku === 'DUP-1')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/ambassador-products/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/ambassador-products/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertStaff, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { utcDay } from '@/lib/dates'
import { summariseProducts } from '@/lib/ambassador-products'

/**
 * What we sent our ambassadors: the overview, and the door to add one.
 *
 * GET answers with BOTH the per-product counts and the picker's catalogue, so
 * the ambassadors page makes one request instead of two for the same screen.
 *
 * Staff, not admin: marketing runs the ambassador program, exactly as they do
 * for codes and rates.
 */

export async function GET() {
  try {
    assertStaff(await currentUser())

    const [gifts, products] = await Promise.all([
      db.ambassadorProduct.findMany({
        select: { ambassadorId: true, sku: true, name: true, quantity: true },
      }),
      // Ordered so the name a duplicated SKU ends up with is decided by the
      // data, not by whatever order Postgres felt like returning. Product has
      // no updatedAt, so "the most recent name" is not available to us and is
      // not invented here.
      db.product.findMany({ select: { sku: true, name: true }, orderBy: { name: 'asc' } }),
    ])

    // One entry per SKU: the same physical product is a separate Product row in
    // every shop that ever sold it, and the picker must offer it once.
    const catalogue: { sku: string; name: string }[] = []
    const seen = new Set<string>()
    for (const p of products) {
      if (seen.has(p.sku)) continue
      seen.add(p.sku)
      catalogue.push({ sku: p.sku, name: p.name })
    }

    return NextResponse.json({ overview: summariseProducts(gifts), catalogue })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the products' }, { status: 500 })
  }
}

const Body = z.object({
  ambassadorId: z.string().min(1),
  sku: z.string().trim().min(1, 'Pick a product'),
  name: z.string().trim().min(1, 'Pick a product'),
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
  receivedAt: z.string().min(1, 'Pick the date they got it'),
  note: z.string().trim().max(200, 'Keep the note under 200 characters').optional(),
})

export async function POST(req: Request) {
  try {
    assertStaff(await currentUser())

    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Check the values' },
        { status: 400 },
      )
    }
    const d = parsed.data

    const received = new Date(d.receivedAt)
    if (Number.isNaN(received.getTime())) {
      return NextResponse.json({ error: 'Pick the date they got it' }, { status: 400 })
    }

    // A friendlier answer than a raw foreign-key failure.
    const ambassador = await db.ambassador.findUnique({
      where: { id: d.ambassadorId },
      select: { id: true },
    })
    if (!ambassador) return NextResponse.json({ error: 'No such ambassador' }, { status: 404 })

    await db.ambassadorProduct.create({
      data: {
        ambassadorId: d.ambassadorId,
        sku: d.sku,
        name: d.name,
        quantity: d.quantity,
        // UTC midnight, the convention every dated value here follows.
        receivedAt: utcDay(received),
        note: d.note || null,
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the product' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/ambassador-products/route.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ambassador-products/route.ts src/app/api/ambassador-products/route.test.ts
git commit -m "feat: staff record what an ambassador was sent, and see it counted per product"
```

---

### Task 3: Removing a gift

**Files:**
- Create: `src/app/api/ambassador-products/[id]/route.ts`
- Test: `src/app/api/ambassador-products/[id]/route.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks beyond the `AmbassadorProduct` model.
- Produces: `DELETE /api/ambassador-products/[id]` → `{ ok: true }` or 404.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/ambassador-products/[id]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { DELETE } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const EMAIL = 'plan-giftdel-amb@example.local'
let ambassadorId = ''
let giftId = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const call = (target: string) =>
  DELETE(new Request('http://localhost/api/ambassador-products/x', { method: 'DELETE' }), {
    params: Promise.resolve({ id: target }),
  })

async function cleanup() {
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
}

beforeEach(async () => {
  await cleanup()
  const a = await db.ambassador.create({
    data: { name: 'Gift Del', email: EMAIL, commissionRate: 0.1 },
  })
  ambassadorId = a.id
  const g = await db.ambassadorProduct.create({
    data: {
      ambassadorId, sku: 'MPX-001', name: 'Pro X', quantity: 1,
      receivedAt: new Date('2026-03-12T00:00:00Z'),
    },
  })
  giftId = g.id
  await asAdmin()
})

afterEach(async () => {
  await cleanup()
  cookieValue.current = undefined
})

describe('DELETE /api/ambassador-products/[id]', () => {
  it('removes the record', async () => {
    expect((await call(giftId)).status).toBe(200)
    expect(await db.ambassadorProduct.count({ where: { ambassadorId } })).toBe(0)
  })

  it('404s for an id that is not there, so a no-op never reports success', async () => {
    const res = await call('does-not-exist')
    expect(res.status).toBe(404)
    // The real one is untouched.
    expect(await db.ambassadorProduct.count({ where: { ambassadorId } })).toBe(1)
  })

  it('answers an ambassador with 403', async () => {
    cookieValue.current = await signSession({
      userId: 'test-amb', email: EMAIL, role: 'AMBASSADOR', ambassadorId,
    })
    expect((await call(giftId)).status).toBe(403)
    expect(await db.ambassadorProduct.count({ where: { ambassadorId } })).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/ambassador-products/[id]/route.test.ts"`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/ambassador-products/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertStaff, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

/** Take a product back off an ambassador's record. Staff, like adding one. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertStaff(await currentUser())
    const { id } = await params

    // deleteMany reports how many rows it matched. Zero means the record is not
    // there, and saying so is what stops a no-op being reported as success.
    const gone = await db.ambassadorProduct.deleteMany({ where: { id } })
    if (gone.count === 0) {
      return NextResponse.json({ error: 'No such product record' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not remove the product' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/ambassador-products/[id]/route.test.ts"`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/ambassador-products/[id]/route.ts" "src/app/api/ambassador-products/[id]/route.test.ts"
git commit -m "feat: a product can come back off an ambassador's record"
```

---

### Task 4: The two read paths carry products

**Files:**
- Modify: `src/app/api/ambassadors/route.ts`
- Modify: `src/app/api/portal/route.ts`
- Test: `src/app/api/ambassador-products/reads.test.ts` (create)

**Interfaces:**
- Consumes: the `AmbassadorProduct` model.
- Produces: `GET /api/ambassadors` each ambassador gains `products: { id, sku, name, quantity, receivedAt (ISO string), note }[]`. `GET /api/portal` gains `products: { id, sku, name, quantity, receivedAt (ISO string) }[]` — **no `note`**, that is our internal record.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/ambassador-products/reads.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET: getAmbassadors } = await import('@/app/api/ambassadors/route')
const { GET: getPortal } = await import('@/app/api/portal/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const MINE = 'plan-reads-mine@example.local'
const THEIRS = 'plan-reads-theirs@example.local'
let mineId = ''
let theirsId = ''

async function cleanup() {
  await db.ambassador.deleteMany({ where: { email: { in: [MINE, THEIRS] } } })
}

beforeEach(async () => {
  await cleanup()
  const mine = await db.ambassador.create({
    data: { name: 'Mine', email: MINE, commissionRate: 0.1 },
  })
  const theirs = await db.ambassador.create({
    data: { name: 'Theirs', email: THEIRS, commissionRate: 0.1 },
  })
  mineId = mine.id
  theirsId = theirs.id

  await db.ambassadorProduct.create({
    data: {
      ambassadorId: mineId, sku: 'MPX-001', name: 'Pro X', quantity: 2,
      receivedAt: new Date('2026-03-12T00:00:00Z'), note: 'internal only',
    },
  })
  await db.ambassadorProduct.create({
    data: {
      ambassadorId: theirsId, sku: 'MACBL661', name: 'Advanced Comfort', quantity: 1,
      receivedAt: new Date('2026-04-01T00:00:00Z'),
    },
  })
})

afterEach(async () => {
  await cleanup()
  cookieValue.current = undefined
})

describe('GET /api/ambassadors', () => {
  it('carries each ambassador their products', async () => {
    cookieValue.current = await signSession({
      userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
    })

    const body = (await (await getAmbassadors()).json()) as {
      ambassadors: { id: string; products: { sku: string; quantity: number; note: string | null }[] }[]
    }
    const row = body.ambassadors.find((a) => a.id === mineId)
    expect(row!.products).toEqual([
      expect.objectContaining({ sku: 'MPX-001', quantity: 2, note: 'internal only' }),
    ])
  })
})

describe('GET /api/portal', () => {
  const portal = () => getPortal(new Request('http://localhost/api/portal?preset=this_month'))

  it('shows an ambassador their own products and nobody else’s', async () => {
    cookieValue.current = await signSession({
      userId: 'test-amb', email: MINE, role: 'AMBASSADOR', ambassadorId: mineId,
    })

    const body = (await (await portal()).json()) as {
      products: { sku: string; quantity: number }[]
    }
    expect(body.products).toHaveLength(1)
    expect(body.products[0]).toMatchObject({ sku: 'MPX-001', quantity: 2 })
  })

  it('never sends the internal note to the ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'test-amb', email: MINE, role: 'AMBASSADOR', ambassadorId: mineId,
    })

    const body = (await (await portal()).json()) as { products: Record<string, unknown>[] }
    expect(body.products[0]).not.toHaveProperty('note')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/ambassador-products/reads.test.ts`
Expected: FAIL — `row.products` is undefined and `body.products` is undefined.

- [ ] **Step 3: Add products to the ambassadors route**

In `src/app/api/ambassadors/route.ts`, extend the `include` in the `GET` handler's `db.ambassador.findMany` call:

```ts
    const rows = await db.ambassador.findMany({
      include: {
        codes: { include: { shop: { select: { name: true } } } },
        user: { select: { id: true } },
        // Newest first: what we sent most recently is what anyone is asking about.
        products: {
          orderBy: { receivedAt: 'desc' },
          select: { id: true, sku: true, name: true, quantity: true, receivedAt: true, note: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
```

Then, inside the `rows.map` that builds `ambassadors`, add one property beside `codes`:

```ts
          codes: a.codes.map((c) => ({ id: c.id, code: c.code, shopId: c.shopId, shopName: c.shop.name })),
          products: a.products.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            quantity: p.quantity,
            receivedAt: p.receivedAt.toISOString(),
            note: p.note,
          })),
```

- [ ] **Step 4: Add products to the portal route**

In `src/app/api/portal/route.ts`, after the `lifetime` aggregate and before the `soldLines` query, add:

```ts
    // What we SENT them, which is a different thing entirely from what they
    // sold. No note: that is our internal record, not theirs.
    const ownedProducts = await db.ambassadorProduct.findMany({
      where: { ambassadorId: me.id },
      orderBy: { receivedAt: 'desc' },
      select: { id: true, sku: true, name: true, quantity: true, receivedAt: true },
    })
```

Then add one property to the `NextResponse.json({ ... })` payload, beside `productTotals`:

```ts
      productTotals,
      products: ownedProducts.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        quantity: p.quantity,
        receivedAt: p.receivedAt.toISOString(),
      })),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/api/ambassador-products/reads.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: 94 files, 667 tests, all passing. If `src/app/api/portal/*.test.ts` fails, you changed the shape of an existing field instead of adding a new one — revert that edit and add only.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/ambassadors/route.ts src/app/api/portal/route.ts src/app/api/ambassador-products/reads.test.ts
git commit -m "feat: the roster and the portal both carry what an ambassador was sent"
```

---

### Task 5: The two components

**Files:**
- Create: `src/components/ambassadors/ProductOverview.tsx`
- Create: `src/components/ambassadors/ProductLedger.tsx`
- Test: `src/components/ambassadors/ProductLedger.test.tsx`

**Interfaces:**
- Consumes: `ProductSummary` shape from Task 1 (as `ProductSummaryRow`), the `POST`/`DELETE` routes from Tasks 2 and 3.
- Produces: `<ProductOverview rows={ProductSummaryRow[]} />`, `<ProductLedger ambassadorId gifts catalogue pending send />`, and the exported types `Gift` and `CatalogueItem` that Task 6 imports.

- [ ] **Step 1: Write the failing test**

Create `src/components/ambassadors/ProductLedger.test.tsx`:

Note the first line: `vitest.config.ts` sets `environment: 'node'` globally, so
every component test in this codebase opts into jsdom with that pragma. Without
it, `render` fails with "document is not defined".

`@testing-library/user-event` is **not** a dependency here — every existing
component test drives the DOM with `fireEvent`. Do not add the package.

Assertions use plain `toBeTruthy()` / `toBeNull()` / `toContain()`, which is what
every component test in this codebase already uses. Do **not** reach for
jest-dom matchers (`toBeInTheDocument`, `toBeDisabled`): nothing wires them up —
`vitest.config.ts` has no `setupFiles` — so they fail with "Invalid Chai
property", and adding the import would make this the only file in the repo using
a second assertion style.

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ProductLedger, type Gift, type CatalogueItem } from './ProductLedger'

const CATALOGUE: CatalogueItem[] = [
  { sku: 'MACBL661', name: 'Advanced Comfort' },
  { sku: 'MPX-001', name: 'Pro X' },
]

const GIFTS: Gift[] = [
  { id: 'g1', sku: 'MPX-001', name: 'Pro X', quantity: 2, receivedAt: '2026-03-12T00:00:00.000Z', note: 'replacement' },
]

const setup = (gifts: Gift[] = GIFTS) => {
  const send = vi.fn().mockResolvedValue(true)
  render(
    <ProductLedger
      ambassadorId="amb-1"
      gifts={gifts}
      catalogue={CATALOGUE}
      pending={null}
      send={send}
    />,
  )
  return { send }
}

afterEach(cleanup)

describe('ProductLedger', () => {
  it('lists what they already have, with quantity and date', () => {
    setup()
    // getByText throws when absent, so reaching the assertion is most of the
    // proof; toBeTruthy is the shape every component test here uses.
    expect(screen.getByText('Pro X')).toBeTruthy()
    expect(screen.getByText(/×2/)).toBeTruthy()
    expect(screen.getByText(/2026-03-12/)).toBeTruthy()
  })

  it('teaches the next action when there is nothing yet', () => {
    setup([])
    expect(screen.getByText(/Nothing yet/i)).toBeTruthy()
  })

  it('gives each row its own accessible name when the same product came twice', () => {
    // Repeat gifts are the point of a ledger, so two rows can share a product
    // name. getByRole throws when more than one element matches, so this test
    // fails outright if both rows carry the same label.
    setup([
      { id: 'g1', sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12T00:00:00.000Z', note: null },
      { id: 'g2', sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-06-01T00:00:00.000Z', note: null },
    ])

    expect(screen.getByRole('button', { name: 'Remove Pro X received 2026-03-12' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Pro X received 2026-06-01' })).toBeTruthy()
  })

  it('removes a gift by its own id', () => {
    const { send } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pro X received 2026-03-12' }))

    expect(send).toHaveBeenCalledWith(
      'remove-product-g1',
      '/api/ambassador-products/g1',
      'DELETE',
      {},
    )
  })

  it('will not add until a product is picked', () => {
    setup()
    const add = screen.getByRole('button', { name: /Add product/ }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
  })

  it('sends the picked product with its name, so the record is a snapshot', () => {
    const { send } = setup()

    // SearchableSelect is a button that opens a list of buttons.
    fireEvent.click(screen.getByRole('button', { name: 'Product' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced Comfort' }))

    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Add product/ }))

    expect(send).toHaveBeenCalledWith(
      'add-product',
      '/api/ambassador-products',
      'POST',
      expect.objectContaining({
        ambassadorId: 'amb-1',
        sku: 'MACBL661',
        name: 'Advanced Comfort',
        quantity: 3,
      }),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ambassadors/ProductLedger.test.tsx`
Expected: FAIL — cannot resolve `./ProductLedger`.

- [ ] **Step 3: Write ProductOverview**

Create `src/components/ambassadors/ProductOverview.tsx`:

```tsx
'use client'

export type ProductSummaryRow = {
  sku: string
  name: string
  ambassadors: number
  units: number
}

/**
 * How far each product has spread: how many ambassadors hold it, and how many
 * units went out. One row per real product, because the ledger keys on SKU and
 * not on a shop's own listing of it.
 */
export function ProductOverview({ rows }: { rows: ProductSummaryRow[] }) {
  return (
    <section className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex items-center justify-between px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Products with ambassadors</h2>
        <p className="text-[12px] text-muted">{rows.length} products</p>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="border-y border-line bg-panel text-left text-muted">
            <th className="px-3 py-2.5 font-medium">Product</th>
            <th className="px-3 py-2.5 font-medium">SKU</th>
            <th className="px-3 py-2.5 text-right font-medium">Ambassadors</th>
            <th className="px-3 py-2.5 text-right font-medium">Units</th>
          </tr>
        </thead>
        <tbody className="text-ink">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-faint">
                Nothing handed out yet. Open an ambassador’s Edit and add what they were sent.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.sku} data-testid="product-overview-row" className="border-t border-line">
                <td className="px-3 py-2.5 font-medium text-ink">{r.name}</td>
                <td className="px-3 py-2.5 text-muted">{r.sku}</td>
                <td className="num px-3 py-2.5 text-right">{r.ambassadors}</td>
                <td className="num px-3 py-2.5 text-right">{r.units}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  )
}
```

- [ ] **Step 4: Write ProductLedger**

Create `src/components/ambassadors/ProductLedger.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { SearchableSelect } from '@/components/SearchableSelect'

export type Gift = {
  id: string
  sku: string
  name: string
  quantity: number
  receivedAt: string // ISO
  note: string | null
}

export type CatalogueItem = { sku: string; name: string }

const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** Today as yyyy-mm-dd, which is what a date input wants. */
const today = () => new Date().toISOString().slice(0, 10)

/**
 * What an ambassador was sent, inside the Edit modal.
 *
 * Adds and removes act the moment you press them, exactly like the discount
 * codes above: each is its own request the server can refuse for its own
 * reason, and a reason worth reading should not wait for a Save.
 *
 * The picked product's NAME travels with its SKU on purpose — the record keeps
 * a snapshot, so renaming a shop's listing later never rewrites what we handed
 * over.
 */
export function ProductLedger({
  ambassadorId,
  gifts,
  catalogue,
  pending,
  send,
}: {
  ambassadorId: string
  gifts: Gift[]
  catalogue: CatalogueItem[]
  pending: string | null
  send: (key: string, url: string, method: string, body: unknown) => Promise<boolean>
}) {
  const [sku, setSku] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [receivedAt, setReceivedAt] = useState(today())
  const [note, setNote] = useState('')
  const busy = pending !== null

  const chosen = catalogue.find((c) => c.sku === sku)

  async function add() {
    if (!chosen) return
    const ok = await send('add-product', '/api/ambassador-products', 'POST', {
      ambassadorId,
      sku: chosen.sku,
      name: chosen.name,
      quantity: Number(quantity),
      receivedAt,
      note: note.trim() || undefined,
    })
    if (ok) {
      setSku('')
      setQuantity('1')
      setNote('')
    }
  }

  return (
    <>
      <p className="mt-4 text-xs font-medium text-muted">Products they got from us</p>

      <div className="mt-1 space-y-1">
        {gifts.length === 0 && <p className="text-[11px] text-faint">Nothing yet.</p>}

        {gifts.map((g) => (
          <div
            key={g.id}
            className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line px-3 py-1.5"
          >
            <span className="min-w-0 text-sm text-ink">
              <span className="font-semibold">{g.name}</span>
              <span className="ml-1.5 text-xs font-normal text-faint">
                ×{g.quantity} · {g.receivedAt.slice(0, 10)}
                {g.note ? ` · ${g.note}` : ''}
              </span>
            </span>

            <button
              onClick={() =>
                void send(
                  `remove-product-${g.id}`,
                  `/api/ambassador-products/${g.id}`,
                  'DELETE',
                  {},
                )
              }
              disabled={busy}
              // The date is part of the name because the ledger deliberately
              // allows the same product twice. Two rows labelled only "Remove
              // Pro X" are indistinguishable to a screen reader, and ambiguous
              // to any getByRole that goes looking for one of them.
              aria-label={`Remove ${g.name} received ${g.receivedAt.slice(0, 10)}`}
              className="shrink-0 text-xs font-semibold text-loss hover:underline disabled:opacity-60"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11px] font-medium text-muted">Add a product</p>
      <div className="mt-1 grid gap-2 sm:grid-cols-[1fr_4.5rem_auto]">
        <SearchableSelect
          value={sku}
          onChange={setSku}
          options={catalogue.map((c) => ({ value: c.sku, label: c.name }))}
          ariaLabel="Product"
          placeholder="Pick a product"
        />
        <input
          type="number"
          min="1"
          step="1"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          aria-label="Quantity"
          className={INPUT}
        />
        <button
          onClick={add}
          disabled={busy || !chosen || Number(quantity) < 1}
          className="shrink-0 rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-panel disabled:opacity-60"
        >
          {pending === 'add-product' ? 'Adding…' : 'Add product'}
        </button>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-[10rem_1fr]">
        <input
          type="date"
          value={receivedAt}
          onChange={(e) => setReceivedAt(e.target.value)}
          aria-label="Date received"
          className={INPUT}
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          aria-label="Note"
          placeholder="Note (optional)"
          className={INPUT}
        />
      </div>
    </>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/ambassadors/ProductLedger.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/ambassadors/
git commit -m "feat: a card counting products across ambassadors, and the ledger that fills it"
```

---

### Task 6: Wire the ambassadors page

**Files:**
- Modify: `src/app/ambassadors/AmbassadorsClient.tsx`

**Interfaces:**
- Consumes: `ProductOverview`, `ProductSummaryRow`, `ProductLedger`, `Gift`, `CatalogueItem` from Task 5; `GET /api/ambassador-products` from Task 2; the `products[]` on `GET /api/ambassadors` from Task 4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Import the components and extend the Row type**

At the top of `src/app/ambassadors/AmbassadorsClient.tsx`, add the imports beside the existing ones:

```ts
import { ProductOverview, type ProductSummaryRow } from '@/components/ambassadors/ProductOverview'
import { ProductLedger, type CatalogueItem, type Gift } from '@/components/ambassadors/ProductLedger'
```

Add `products` to the `Row` type:

```ts
type Row = {
  id: string
  name: string
  email: string
  /** A PERCENT: 10 means 10%. The column holds a fraction; the API converts. */
  commissionPercent: number
  active: boolean
  codes: Code[]
  /** What we sent them, newest first. */
  products: Gift[]
  onboarded: boolean
  /** The email already belongs to a login (typically the owner's admin account). */
  emailHasLogin: boolean
  /** A path, so the link is built against whatever host the admin is on. Null when no invite can be redeemed. */
  invitePath: string | null
}
```

- [ ] **Step 2: Load the overview and catalogue**

Inside `AmbassadorsClient`, beside the other `useState` calls, add:

```ts
  // The overview card and the modal's picker come from one request, because
  // they are one screen.
  const [overview, setOverview] = useState<ProductSummaryRow[]>([])
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([])
```

After the `load` callback, add:

```ts
  /** Refreshed alongside the roster: adding a product changes both. */
  const loadProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/ambassador-products')
      if (!res.ok) return // the card simply stays as it was
      const data = (await res.json()) as {
        overview?: ProductSummaryRow[]
        catalogue?: CatalogueItem[]
      }
      setOverview(data.overview ?? [])
      setCatalogue(data.catalogue ?? [])
    } catch {
      // Offline. The roster's own error toast has already said so.
    }
  }, [])

  // Initial load, inlined for the same reason as the roster's own initial-load
  // effect below: calling the `loadProducts` callback directly from an effect
  // body reads as a synchronous setState path to the lint rule, even though the
  // sets only happen after the fetch resolves. `loadProducts` itself stays
  // available for `send()` to call after a write.
  useEffect(() => {
    let live = true
    fetch('/api/ambassador-products')
      .then(async (r) =>
        r.ok
          ? ((await r.json()) as { overview?: ProductSummaryRow[]; catalogue?: CatalogueItem[] })
          : null,
      )
      .then((data) => {
        if (live && data) {
          setOverview(data.overview ?? [])
          setCatalogue(data.catalogue ?? [])
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
```

Note the shape. A bare `useEffect(() => { void loadProducts() }, [loadProducts])`
is the obvious thing to write and it **fails lint** here: the
`react-hooks/set-state-in-effect` rule treats calling a callback that sets state
as a synchronous setState path, even though the sets happen after the fetch
resolves. The file's existing initial-load effect already works around this the
same way, which is why this one matches it rather than inventing a third shape.

In the `send` helper, refresh the products alongside the roster. Change:

```ts
      await load()
      return true
```

to:

```ts
      // Both, because adding a product changes the roster chips AND the counts.
      await Promise.all([load(), loadProducts()])
      return true
```

- [ ] **Step 3: Render the overview card**

In the returned JSX inside `<PageBody>`, place the card immediately before the roster's wrapper `<div className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">`:

```tsx
        <ProductOverview rows={overview} />
```

- [ ] **Step 4: Add the roster column**

In the roster `<thead>`, add a header between `Codes` and `Status`:

```tsx
                <th className="px-3 py-2.5 font-medium">Products</th>
```

Change **both** `colSpan={5}` occurrences (the loading row and the empty row) to `colSpan={6}`.

In the `<tbody>` row, add this cell between the Codes cell and the Status cell:

```tsx
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {row.products.map((p) => (
                          <span
                            key={p.id}
                            title={`${p.quantity} × ${p.name}, received ${p.receivedAt.slice(0, 10)}${p.note ? ` — ${p.note}` : ''}`}
                            className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-ink"
                          >
                            {p.name}
                            <span className="ml-1 font-normal text-faint">×{p.quantity}</span>
                          </span>
                        ))}
                        {row.products.length === 0 && (
                          <span className="text-[11px] text-faint">—</span>
                        )}
                      </div>
                    </td>
```

- [ ] **Step 5: Pass the ledger into the modal**

Extend the `<EditModal>` call site with the two new props:

```tsx
        <EditModal
          key={editing.id}
          row={editing}
          shops={shops}
          catalogue={catalogue}
          pending={pending}
          send={send}
          onClose={() => setEditingId(null)}
        />
```

Extend `EditModal`'s signature:

```tsx
function EditModal({
  row,
  shops,
  catalogue,
  pending,
  send,
  onClose,
}: {
  row: Row
  shops: Shop[]
  catalogue: CatalogueItem[]
  pending: string | null
  send: Send
  onClose: () => void
}) {
```

Inside `EditModal`, render the ledger immediately after the "Add a code on a store" grid closes and before the final `<div className="mt-5 flex justify-end gap-2">`:

```tsx
        <ProductLedger
          ambassadorId={row.id}
          gifts={row.products}
          catalogue={catalogue}
          pending={pending}
          send={send}
        />
```

- [ ] **Step 6: Run the existing page tests**

Run: `npx vitest run src/app/ambassadors/AmbassadorsClient.test.tsx`
Expected: PASS. Two failures are expected and correct to fix:

1. A test asserting the old 5-column table — update that assertion to 6, since
   the extra column is the intended change.
2. `TypeError: Cannot read properties of undefined (reading 'map')` — the file's
   fixtures predate Task 4's contract and carry no `products`. Add `products: []`
   to each. That is fixture INPUT, not an assertion; do not weaken any assertion
   to get green. Commit `AmbassadorsClient.test.tsx` alongside the client, since
   shipping a client whose own test crashes is not a green build.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run: `npm run lint`
Expected: no NEW errors. Six pre-existing errors in `CostsClient.tsx` and `ExpensesClient.tsx` are not yours; leave them.

- [ ] **Step 8: Commit**

```bash
git add src/app/ambassadors/AmbassadorsClient.tsx
git commit -m "feat: the ambassadors tab shows who has what, and how far each product reached"
```

---

### Task 7: The ambassador sees their own

**Files:**
- Modify: `src/app/portal/PortalClient.tsx`

**Interfaces:**
- Consumes: `products[]` on `GET /api/portal` from Task 4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Extend the Portal payload type**

In `src/app/portal/PortalClient.tsx`, add to the `Portal` type, beside `productTotals`:

```ts
  /**
   * What we SENT them. Deliberately not near `productTotals`, which is what
   * they SOLD — two different things that would read the same if either were
   * called just "products" on screen.
   */
  products: {
    id: string
    sku: string
    name: string
    quantity: number
    receivedAt: string
  }[]
```

- [ ] **Step 2: Render the card**

Immediately before the `<section>` that renders the `productTotals` table, add:

```tsx
            {data.products.length > 0 && (
              <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
                <div className="px-5 py-3.5">
                  <h2 className="text-[13px] font-semibold text-ink">Products we sent you</h2>
                  <p className="mt-0.5 text-[12px] text-muted">
                    Yours to keep and promote. Ask us if anything arrives damaged.
                  </p>
                </div>

                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-y border-line bg-panel text-left text-[11px] text-muted">
                      <th className="px-5 py-2 font-semibold">Product</th>
                      <th className="px-5 py-2 text-right font-semibold">Quantity</th>
                      <th className="px-5 py-2 text-right font-semibold">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.products.map((p) => (
                      <tr key={p.id} className="border-b border-line last:border-b-0">
                        <td className="px-5 py-2.5 font-medium text-ink">{p.name}</td>
                        <td className="num px-5 py-2.5 text-right text-ink">{p.quantity}</td>
                        <td className="num px-5 py-2.5 text-right text-muted">
                          {p.receivedAt.slice(0, 10)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
```

The card is hidden entirely when the list is empty: most ambassadors were sent nothing, and an empty table teaching no next action would be noise on the one screen they actually read.

- [ ] **Step 3: Run the portal tests**

Run: `npx vitest run src/app/portal/PortalClient.test.tsx`
Expected: PASS. If the test's mock payload lacks `products`, add `products: []` to it — the component reads `data.products.length`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/portal/PortalClient.tsx
git commit -m "feat: an ambassador can see what we sent them"
```

---

### Task 8: Seed data and the end-to-end proof

**Files:**
- Modify: `prisma/seed.ts`
- Create: `e2e/ambassador-products.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Seed some gifts**

In `prisma/seed.ts`, add `AmbassadorProduct` to the wipe block, immediately **before** the `ambassadorCode.deleteMany()` line (order matters only for readability; the cascade handles it):

```ts
  await db.ambassadorProduct.deleteMany()
```

Then, after the loop that creates ambassadors and their logins (right after `ambassadors.push(a)`'s enclosing `for` block closes and before the `admin@ecom.test` user is created), add:

```ts
  // A few ambassadors were sent product. Enough that the overview card has
  // something to say on a fresh database, and the e2e spec has a row to find.
  console.log('Handing out sample products...')
  const GIFTS: { to: number; sku: string; name: string; quantity: number; day: string }[] = [
    { to: 0, sku: 'MACBL661', name: 'Mazzetti Advanced Comfort - Massasjestol (Svart)', quantity: 1, day: '2026-03-12' },
    { to: 0, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 2, day: '2026-05-02' },
    { to: 1, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 1, day: '2026-04-18' },
    { to: 2, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 1, day: '2026-06-01' },
    { to: 3, sku: 'MLCBL510', name: 'Mazzetti Lite Comfort - Massasjestol (Svart)', quantity: 1, day: '2026-02-20' },
  ]
  for (const g of GIFTS) {
    await db.ambassadorProduct.create({
      data: {
        ambassadorId: ambassadors[g.to].id,
        sku: g.sku,
        name: g.name,
        quantity: g.quantity,
        receivedAt: new Date(`${g.day}T00:00:00Z`),
      },
    })
  }
```

`ambassadors[0]` is Emma Nilsen (`emma@ambassador.test`), which is the account the e2e spec signs in as.

- [ ] **Step 2: Reseed**

Run: `npm run db:seed`
Expected: completes, printing "Handing out sample products...".

- [ ] **Step 3: Write the end-to-end spec**

Create `e2e/ambassador-products.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The click only dispatches the DOM event. Wait for the real signal: we have
  // left /login and the session cookie is genuinely set.
  await page.waitForURL(/\/(dashboard|portal|ambassadors)/)
}

test('an admin records a product, and the ambassador sees it', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/ambassadors')

  // The seeded gifts are already counted.
  const overview = page.getByTestId('product-overview-row')
  await expect(overview.first()).toBeVisible()

  // Pro X went to three of the seeded ambassadors.
  const proX = page.getByTestId('product-overview-row').filter({ hasText: 'MPX-001' })
  await expect(proX).toContainText('3')

  // Emma's row carries her chips.
  const emma = page.getByTestId('ambassador-row').filter({ hasText: 'Emma Nilsen' })
  await expect(emma).toContainText('Massasjepistol Pro X')
})

test('an admin adds a product and it lands on the roster', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/ambassadors')

  const johan = page.getByTestId('ambassador-row').filter({ hasText: 'Johan Berg' })
  await johan.getByRole('button', { name: 'Edit' }).click()

  // exact: true matters. Playwright's getByRole name matching is SUBSTRING by
  // default, so a bare 'Product' also matches the 'Add product' submit button
  // sitting in the same section, and the locator resolves to two elements.
  // Testing Library's getByRole is exact by default, which is why the Task 5
  // unit test uses the same words without this flag — do not "harmonise" them.
  await page.getByRole('button', { name: 'Product', exact: true }).click()
  await page.getByRole('button', { name: 'Mazzetti Lite Comfort - Massasjestol (Beige)' }).click()

  const qty = page.getByLabel('Quantity')
  await qty.fill('2')
  await page.getByLabel('Note').fill('sent for the summer campaign')
  await page.getByRole('button', { name: /Add product/ }).click()

  // The modal stays open and the ledger refreshes in place.
  await expect(page.getByText('sent for the summer campaign')).toBeVisible()

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(johan).toContainText('Mazzetti Lite Comfort - Massasjestol (Beige)')
})

test('an ambassador sees what we sent them, and cannot change it', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  await expect(page).toHaveURL(/\/portal/)
  await expect(page.getByText('Products we sent you')).toBeVisible()
  await expect(page.getByText('Massasjepistol Pro X').first()).toBeVisible()

  // Read only: nothing on this page can add or remove one.
  await expect(page.getByRole('button', { name: /Add product/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
})

test('an ambassador cannot reach the staff product API', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  const read = await page.request.get('/api/ambassador-products')
  expect(read.status()).toBe(403)

  const write = await page.request.post('/api/ambassador-products', {
    data: { ambassadorId: 'anything', sku: 'X', name: 'X', quantity: 1, receivedAt: '2026-01-01' },
  })
  expect(write.status()).toBe(403)
})
```

- [ ] **Step 4: Run the end-to-end spec**

Run: `npx playwright test e2e/ambassador-products.spec.ts`
Expected: 4 passed.

If the dev server is not already running, Playwright starts it via `webServer` — the first run may take up to 120s while Next compiles.

- [ ] **Step 5: Run everything**

Run: `npm test`
Expected: 96 files, all passing.

Run: `npx playwright test`
Expected: all specs passing, including the pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add prisma/seed.ts e2e/ambassador-products.spec.ts
git commit -m "test: the whole loop, from recording a product to the ambassador seeing it"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `AmbassadorProduct` model keyed on sku, name snapshot, cascade, no unique | 1 |
| `summariseProducts` counting distinct ambassadors | 1 |
| `GET /api/ambassador-products` overview + catalogue, deterministic name tie-break | 2 |
| `POST` with quantity ≥ 1, `utcDay` date, 200-char note | 2 |
| `DELETE` with `count === 0` → 404 | 3 |
| `GET /api/ambassadors` gains `products[]` | 4 |
| `GET /api/portal` gains `products[]`, no note | 4 |
| Roster Products column of chips | 6 |
| Edit modal section, acts-on-press | 5, 6 |
| Overview card between statistics and roster | 5, 6 |
| Portal read-only card | 7 |
| `assertStaff` on writes; marketing can manage | 2, 3 |
| Portal id from session | 4 (route already does this; test asserts it) |
| Unit / route / component / e2e / seed tests | 1, 2, 3, 4, 5, 8 |

No gaps.

**Placeholder scan:** No TBD, TODO, "handle edge cases", or "similar to Task N". Every code step carries real code.

**Type consistency checked:**
- `summariseProducts` returns `ProductSummary` (Task 1); the component's prop type is `ProductSummaryRow` (Task 5) with identical fields. These are two names for one shape — deliberate, because the component must not import from a server module. Verified field-for-field: `sku`, `name`, `ambassadors`, `units`.
- `Gift.receivedAt` is an ISO **string** everywhere it crosses the wire (Tasks 4, 5, 6, 7); only Prisma holds a `Date`.
- `send` signature `(key, url, method, body) => Promise<boolean>` matches the existing `Send` type in `AmbassadorsClient.tsx`.
- `ProductLedger` prop names (`ambassadorId`, `gifts`, `catalogue`, `pending`, `send`) match the call site in Task 6 Step 5.
- Pending keys `add-product` and `remove-product-${id}` are used identically in the component and its test.

**Two defects this review caught and fixed, rather than leaving for the implementer to hit:**

1. The component test originally used `@testing-library/user-event`, which is **not a dependency** of this project. Every existing component test uses `fireEvent`. Rewritten; do not add the package.
2. The component test lacked the `// @vitest-environment jsdom` pragma. `vitest.config.ts` sets `environment: 'node'` globally, so without that first line `render` fails with "document is not defined". Added.
