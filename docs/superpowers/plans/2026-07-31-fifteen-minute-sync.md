# Fifteen-Minute Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/settings/shops`'s promise true — every connected store re-checked every 15 minutes, and any store that cannot be says why on the page.

**Architecture:** The scheduled sync keeps its single invocation but stops
starving itself. It reclaims the platform's full 300-second budget, visits
stores longest-ignored-first, bounds every store with a deadline and a request
timeout, drains a backlog by advancing the watermark to the last order it
actually processed instead of refusing forever, and records why any attempt
failed.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 6 + PostgreSQL, Vitest
(jsdom component / DB-backed / stubbed-fetch unit), Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-07-31-fifteen-minute-sync-design.md`

## Global Constraints

- **Never run tests against the live database.** Vitest runs against the local portable Postgres in `%LOCALAPPDATA%\panetti-pg`. Neon is production.
- **Edit files with the Edit/Write tools only.** PowerShell 5.1 `Get-Content`/`Set-Content` corrupts UTF-8 in this repo and these files contain `…`, `—` and `ø`.
- **Never run `git stash`, `git checkout -- `, `git reset`, `git clean`, or `git restore`.** Another session shares this working directory; those commands silently destroy its work.
- This project has **no migrations directory**. Schema changes go in `prisma/schema.prisma` and are applied with `npx prisma db push`. The Vercel build runs `prisma db push --skip-generate` itself.
- Exact values, copied from the spec: `maxDuration = 300`, shops deadline `240_000` ms, per-request timeout ceiling `30_000` ms, "catching up" threshold `3_600_000` ms.
- Woo returns GMT timestamps with no zone suffix. Parse them as `new Date(value + 'Z')`, matching `mapOrder` in `src/lib/woo/map.ts`.
- Run the full suite with `npx vitest run`. Type-check with `npx tsc --noEmit`. Lint with `npx eslint`.
- Comments explain **why**, not what. Match the surrounding voice — the existing comments in `sync.ts` are the reference.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/app/api/cron/sync/route.ts` | schedule entry point; owns the run's time budget | 1, 6 |
| `src/app/api/cron/sync/route.test.ts` | guards the budget and the deadline hand-off | 1, 6 |
| `prisma/schema.prisma` | `Shop.lastRunAt`, `Shop.lastError` | 2 |
| `src/lib/woo/sync.ts` | per-shop sync, run bookkeeping, rotation | 2, 5, 6 |
| `src/lib/woo/sync.test.ts` | DB-backed behaviour of the above | 2, 5, 6 |
| `src/lib/woo/client.ts` | Woo HTTP: ordering, GMT, deadline, timeouts | 3, 4 |
| `src/lib/woo/client.test.ts` | stubbed-fetch behaviour of the above | 3, 4 |
| `src/lib/woo/map.ts` | `WooOrder.date_modified_gmt` | 3 |
| `src/app/api/sync/route.ts` | manual Sync all; passes the same deadline | 6 |
| `src/app/settings/shops/page.tsx` | passes the new fields to the client | 7 |
| `src/app/settings/shops/ShopsClient.tsx` | renders run state instead of a bare date | 7 |
| `src/app/settings/shops/ShopsClient.test.tsx` | component behaviour of the above | 7 |

Tasks are ordered so each builds only on those before it. Task 1 alone is
deployable and is the fix for the outage; everything after it prevents the next
one.

---

### Task 1: The cron stops capping its own budget

The outage in one constant. `maxDuration = 60` was written when Vercel's default
was lower; the default is now 300 on every plan, so that line discards 240
seconds. `/api/sync` declares nothing and gets the full 300, which is why the
Sync all button appears to fix the problem.

**Files:**
- Modify: `src/app/api/cron/sync/route.ts:7-12`
- Test: `src/app/api/cron/sync/route.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `maxDuration` exported as `300` from the cron route

- [ ] **Step 1: Write the failing test**

Append to `src/app/api/cron/sync/route.test.ts`, inside the existing
`describe('the scheduled sync endpoint', ...)` block:

```ts
  // This whole outage was one constant: maxDuration 60 while the platform
  // default is 300, so the run was killed four fifths of the way early and the
  // stores it never reached stayed frozen. Nobody re-caps it by accident.
  it('claims the full platform duration, never less', async () => {
    const { maxDuration } = await import('./route')
    expect(maxDuration).toBe(300)
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/app/api/cron/sync/route.test.ts`
Expected: FAIL — `expected 60 to be 300`

- [ ] **Step 3: Reclaim the budget**

In `src/app/api/cron/sync/route.ts`, replace the comment and constant at lines
7-12 with:

```ts
/**
 * Vercel's default maximum duration is 300 seconds on every plan, and this run
 * needs all of it: the stores are pulled one after another, so a lower ceiling
 * kills the invocation part-way and the stores it never reached stay frozen.
 * This once said 60, which is where that bug came from.
 *
 * A run that still overruns is safe: syncShop only moves a shop's watermark on
 * success, so anything missed is simply retried next run. A deadline inside
 * syncAllShops will stop it well before this ceiling.
 */
export const maxDuration = 300
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/app/api/cron/sync/route.test.ts`
Expected: PASS, and every other test in the file still passes

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/sync/route.ts src/app/api/cron/sync/route.test.ts
git commit -m "fix: the scheduled sync stops discarding four fifths of its budget"
```

---

### Task 2: A store records when it last ran, and why it failed

`AdAccount` has `lastError` and the settings page shows it. `Shop` has neither,
which is why a frozen store gives no reason. Two columns and one helper, wired
into every path `syncShop` can leave by.

`lastRunAt` is separate from `lastSyncAt` on purpose. `lastSyncAt` is a
watermark — how far through the store's change stream we have read. `lastRunAt`
is when we last gave the store attention. Task 5 makes a catching-up store move
its watermark *backwards* relative to now, at which point a page showing only
`lastSyncAt` would call a healthy run a failure.

**Files:**
- Modify: `prisma/schema.prisma:13-25`
- Modify: `src/lib/woo/sync.ts` (add helper; wire into the five exits of `syncShop`)
- Test: `src/lib/woo/sync.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `Shop.lastRunAt: DateTime?` and `Shop.lastError: String?`
  - `recordRun(shopId: string, outcome: { lastSyncAt?: Date; error?: string | null }): Promise<void>` — module-private in `sync.ts`

- [ ] **Step 1: Add the columns**

In `prisma/schema.prisma`, in the `Shop` model, replace the line
`  lastSyncAt DateTime?` with:

```prisma
  // How far through this store's change stream we have read.
  lastSyncAt DateTime?
  // When we last gave this store attention, successful or not. Ordering the
  // sync by this is what stops a slow or broken store from starving the rest.
  lastRunAt  DateTime?
  // Why the last attempt failed; null when it succeeded. Without this a frozen
  // store shows a stale date and no reason at all.
  lastError  String?
```

- [ ] **Step 2: Push the schema to the local database**

Run: `npx prisma db push`
Expected: "Your database is now in sync with your Prisma schema", and the
Prisma client regenerates.

- [ ] **Step 3: Write the failing tests**

Append to `src/lib/woo/sync.test.ts`:

```ts
describe('run bookkeeping', () => {
  it('records why a store failed, and leaves the watermark alone', async () => {
    const shop = await connectedShop('[sync-test] refuses')
    const watermark = new Date('2026-07-01T00:00:00Z')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: watermark } })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('nope', { status: 401 }),
    ))

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(false)

    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    // The window is retried unchanged, so the watermark must not move...
    expect(after.lastSyncAt?.toISOString()).toBe(watermark.toISOString())
    // ...but the attempt is on the record, with its reason.
    expect(after.lastError).toContain('401')
    expect(after.lastRunAt).not.toBeNull()
  })

  // A store that always fails must not hold the front of the queue forever.
  it('moves lastRunAt even when the attempt failed', async () => {
    const shop = await connectedShop('[sync-test] always fails')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastRunAt: new Date('2020-01-01T00:00:00Z') },
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await syncShop(shop.id)

    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastRunAt!.getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime())
  })

  it('clears the error once the store answers again', async () => {
    const shop = await connectedShop('[sync-test] recovers')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastError: 'something old' },
    })

    // One empty page: nothing changed since the watermark, which is a success.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => emptyPage()))
    const result = await syncShop(shop.id)

    expect(result.ok).toBe(true)
    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastError).toBeNull()
    expect(after.lastRunAt).not.toBeNull()
  })

  it('records the reason when the saved keys cannot be read', async () => {
    const shop = await connectedShop('[sync-test] bad keys')
    // Ciphertext this deployment's AUTH_SECRET cannot open.
    await db.shop.update({
      where: { id: shop.id },
      data: { wooKey: 'enc:v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    })

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(false)

    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastError).toContain('Reconnect')
    expect(after.lastRunAt).not.toBeNull()
  })
})
```

- [ ] **Step 4: Run them and watch them fail**

Run: `npx vitest run src/lib/woo/sync.test.ts -t "run bookkeeping"`
Expected: FAIL — `lastError` and `lastRunAt` are null, because nothing writes them yet.

- [ ] **Step 5: Add the helper**

In `src/lib/woo/sync.ts`, directly above `export async function syncShop(`:

```ts
/**
 * Record one attempt on a store.
 *
 * `lastRunAt` moves on EVERY attempt, including failures. This is what keeps
 * the rotation in `syncAllShops` fair: a permanently broken store whose
 * `lastRunAt` never moved would sit at the front of the queue and burn a slot
 * on every single run. Moving it costs a broken store one slot, then it goes to
 * the back.
 *
 * `lastSyncAt` moves only when a caller passes one, so a window that failed is
 * retried unchanged rather than skipped.
 *
 * Never throws. If the database is what broke, the caller's own error is the
 * one worth reporting — not a second, more confusing one from the bookkeeping.
 */
async function recordRun(
  shopId: string,
  outcome: { lastSyncAt?: Date; error?: string | null },
): Promise<void> {
  try {
    await db.shop.update({
      where: { id: shopId },
      data: {
        lastRunAt: new Date(),
        lastError: outcome.error ?? null,
        ...(outcome.lastSyncAt ? { lastSyncAt: outcome.lastSyncAt } : {}),
      },
    })
  } catch {
    // Bookkeeping is never worth failing a sync over.
  }
}
```

- [ ] **Step 6: Wire it into every exit of `syncShop`**

Six edits in `src/lib/woo/sync.ts` — every path `syncShop` can leave by. Each
records the attempt immediately before returning.

At the missing-credentials exit (currently line 203-205):

```ts
  if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
    const error = 'No WooCommerce credentials for this shop'
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }
```

At the unreadable-keys exit (currently line 212-215):

```ts
  } catch {
    // Only possible if AUTH_SECRET changed after the shop was connected.
    const error = "Saved keys can't be read. Reconnect this shop."
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }
```

At the over-5,000 exit (currently line 241-250) — Task 5 removes this branch
entirely, so change only the bookkeeping for now:

```ts
    if (!firstSync && hasMore) {
      // lastSyncAt is deliberately NOT updated, so the next run retries this window.
      const error =
        'This store returned over 5,000 changed orders in one pull. Sync stopped so nothing is skipped silently.'
      await recordRun(shop.id, { error })
      return { ...base, ok: false, ordersSynced: 0, error }
    }
```

At the mid-backfill exit (currently line 260-264):

```ts
    if (firstSync && hasMore) {
      // The chunk landed, but older history is still behind it. The watermark
      // stays unset so the next press resumes instead of going incremental.
      await recordRun(shop.id, { error: null })
      return { ...base, ok: true, ordersSynced: synced, more: true }
    }
```

At the completed exit, replace the `db.shop.update` at lines 304-307 with:

```ts
    // Only now — after everything landed — does the watermark move. It moves to
    // when the FETCH began (a completed backfill starts a day back), so nothing
    // changed while we worked can slip between two windows.
    await recordRun(shop.id, {
      lastSyncAt: firstSync ? new Date(Date.now() - DAY) : fetchStartedAt,
      error: null,
    })
```

And in the outer `catch` (currently lines 310-318):

```ts
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Sync failed'
    // lastSyncAt is deliberately NOT updated, so the next run retries this window.
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npx vitest run src/lib/woo/sync.test.ts`
Expected: PASS — the four new tests and every test that was already there.

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: clean. If it complains that `lastRunAt` does not exist on the Shop
type, the Prisma client did not regenerate — run `npx prisma generate`.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma src/lib/woo/sync.ts src/lib/woo/sync.test.ts
git commit -m "feat: a store records when it last ran and why it failed"
```

---

### Task 3: Incremental pulls sort by modified date, in GMT

Two bugs in one request. The pull filters on `modified_after` but sorts by
`date` (created), which is why a truncated result has no safe resume point —
Task 5 needs one. And it sends a UTC timestamp with no `dates_are_gmt`, so the
store compares it against local time: a store at UTC+2 silently widens every
window by two hours, inflating the very count that trips the page cap.

First-sync chunks keep `orderby=date`; they resume on created date and must not
change.

**Files:**
- Modify: `src/lib/woo/map.ts:14-28` (add one optional field)
- Modify: `src/lib/woo/client.ts:43-51`
- Test: `src/lib/woo/client.test.ts`

**Interfaces:**
- Consumes: `FetchFilter` and `fetchOrders` as they already exist; no earlier task
- Produces: `WooOrder.date_modified_gmt?: string` — optional, because every existing test fixture omits it and a store that omits it must degrade safely rather than fail to compile

- [ ] **Step 1: Write the failing tests**

Append to the `describe('fetchOrders', ...)` block in `src/lib/woo/client.test.ts`:

```ts
  // Truncating a modified-filtered list that is sorted by CREATED date leaves
  // nowhere safe to resume from, which is why the old code could only refuse.
  it('sorts incremental pulls by modified date, ascending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('orderby=modified')
    expect(url).toContain('order=asc')
  })

  // Without this the store reads our UTC timestamp as its own local time. A
  // store at UTC+2 then hands back a two-hour-wider window on every sync.
  it('tells the store our dates are GMT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') })

    expect(String(fetchMock.mock.calls[0][0])).toContain('dates_are_gmt=true')
  })

  // A first sync walks history forwards by creation date and resumes on it.
  it('leaves first-sync chunks sorted by created date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { createdAfter: new Date('2026-07-01T10:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('orderby=date')
    expect(url).not.toContain('orderby=modified')
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/woo/client.test.ts -t "sorts incremental"`
Expected: FAIL — the URL contains `orderby=date`, not `orderby=modified`.

- [ ] **Step 3: Add the field to the order type**

In `src/lib/woo/map.ts`, in the `WooOrder` type, immediately after
`  date_created_gmt: string`:

```ts
  /**
   * Optional because every store sends it but our own fixtures predate it, and
   * because a store that somehow omits it must degrade to "cannot resume"
   * rather than crash. Same shape as date_created_gmt: GMT, no zone suffix.
   */
  date_modified_gmt?: string
```

- [ ] **Step 4: Choose the ordering by what is being filtered**

In `src/lib/woo/client.ts`, replace the parameter construction at lines 44-51:

```ts
    // An incremental pull is filtered on modified date, so it must be SORTED on
    // modified date too: that is the only ordering in which a truncated result
    // has a safe place to resume from. A first sync walks history forwards by
    // creation date and resumes on that instead.
    const incremental = Boolean(filter.modifiedAfter)
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      orderby: incremental ? 'modified' : 'date',
      order: 'asc',
    })
    // Woo compares date filters against the STORE's local time unless told
    // otherwise. Ours are UTC, so without this a store at UTC+2 hands back a
    // two-hour-wider window every single pull.
    if (filter.modifiedAfter) {
      params.set('modified_after', filter.modifiedAfter.toISOString().slice(0, 19))
      params.set('dates_are_gmt', 'true')
    }
    if (filter.createdAfter) params.set('after', filter.createdAfter.toISOString().slice(0, 19))
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/lib/woo/client.test.ts`
Expected: PASS, including the pre-existing
`'filters by modified date for incremental syncs'`, which asserts on
`modified_after` and is unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/lib/woo/map.ts src/lib/woo/client.ts src/lib/woo/client.test.ts
git commit -m "fix: incremental pulls sort by modified date and say their dates are GMT"
```

---

### Task 4: The pull stops at a deadline, times out, and reports where it got to

Right now not one `fetch()` in `client.ts` sets a `signal`, so a single
unresponsive store consumes whatever budget is left and takes every store behind
it down too. A per-request timeout alone is not enough — a 30-second request
starting with 10 seconds left still overruns — so the request budget is the
lesser of the ceiling and what remains of the deadline.

The same pass records the resume point Task 5 needs, and whether the store
actually honoured the ordering that makes it safe.

**Files:**
- Modify: `src/lib/woo/client.ts:10-19` (types), `38-66` (`fetchOrders`)
- Test: `src/lib/woo/client.test.ts`

**Interfaces:**
- Consumes: `WooOrder.date_modified_gmt` (Task 3)
- Produces:
  - `FetchFilter` gains `deadline?: number` (epoch ms) and `requestTimeoutMs?: number`
  - `FetchResult` gains `resumeFrom?: string` and `sortedByModified: boolean`
  - `export function requestBudgetMs(filter: FetchFilter, now?: number): number`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/woo/client.test.ts`. Add `requestBudgetMs` to the import at
the top of the file:

```ts
describe('bounded pulls', () => {
  // A store that never answers must cost this run, not every run behind it.
  it('stops before a fetch once the deadline has passed', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => page(100))
    vi.stubGlobal('fetch', fetchMock)

    const { orders, hasMore } = await fetchOrders(CREDS, {
      modifiedAfter: new Date('2026-07-01T10:00:00Z'),
      deadline: Date.now() - 1,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(orders).toHaveLength(0)
    // Nothing was read, so there is certainly more.
    expect(hasMore).toBe(true)
  })

  it('stops between pages when the deadline arrives mid-pull', async () => {
    const deadline = Date.now() + 40
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30))
      return page(100)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { hasMore } = await fetchOrders(CREDS, {
      modifiedAfter: new Date('2026-07-01T10:00:00Z'),
      deadline,
    })

    expect(hasMore).toBe(true)
    // Far fewer than the 50-page ceiling: it stopped on time, not on the cap.
    expect(fetchMock.mock.calls.length).toBeLessThan(5)
  })

  it('gives one request the lesser of the ceiling and what is left', () => {
    const now = 1_000_000
    // Plenty of deadline left: the ceiling wins.
    expect(requestBudgetMs({ deadline: now + 90_000 }, now)).toBe(30_000)
    // Nearly out of deadline: what is left wins.
    expect(requestBudgetMs({ deadline: now + 5_000 }, now)).toBe(5_000)
    // No deadline at all: the ceiling.
    expect(requestBudgetMs({}, now)).toBe(30_000)
    // Never zero or negative — an already-expired budget must still be a valid
    // timeout, and the page loop is what actually stops.
    expect(requestBudgetMs({ deadline: now - 10_000 }, now)).toBe(1)
  })
})

describe('resume points', () => {
  const modifiedPage = (stamps: string[]) =>
    new Response(
      JSON.stringify(stamps.map((date_modified_gmt, i) => ({ id: i, date_modified_gmt }))),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  it('reports the last modified stamp it saw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T10:00:00', '2026-07-01T11:00:00']),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.resumeFrom).toBe('2026-07-01T11:00:00')
    expect(res.sortedByModified).toBe(true)
  })

  // If the store ignored orderby=modified, advancing to the last row would skip
  // every order it did not happen to return. Say so instead.
  it('refuses to vouch for a store that did not sort by modified date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T11:00:00', '2026-07-01T10:00:00']),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(false)
  })

  it('treats a missing modified stamp as unsortable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(false)
  })

  // A first sync is sorted by CREATED date, so modified stamps are legitimately
  // out of order. Checking them there would raise a false alarm every time.
  it('does not judge the ordering of a first-sync chunk', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T11:00:00', '2026-07-01T10:00:00']),
    ))

    const res = await fetchOrders(CREDS, { createdAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(true)
    expect(res.resumeFrom).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/woo/client.test.ts -t "bounded pulls"`
Expected: FAIL — `requestBudgetMs` is not exported.

- [ ] **Step 3: Extend the types**

In `src/lib/woo/client.ts`, replace the `FetchFilter` and `FetchResult` types at
lines 10-19:

```ts
export type FetchFilter = {
  /** Incremental syncs: only orders changed since the last completed sync. */
  modifiedAfter?: Date | null
  /** First-sync chunks: only orders placed after the newest one already stored. */
  createdAfter?: Date | null
  /** Stop after this many pages; `hasMore` tells the caller history is behind it. */
  maxPages?: number
  /**
   * Epoch ms, as from `Date.now()`. Start no further page once it passes. One
   * store must not be able to spend a whole run's budget.
   */
  deadline?: number
  /** Ceiling for a single request; clamped down to what is left of the deadline. */
  requestTimeoutMs?: number
}

export type FetchResult = {
  orders: WooOrder[]
  hasMore: boolean
  /**
   * Incremental pulls only: the last `date_modified_gmt` seen, which is where a
   * truncated pull can safely resume from. Undefined when nothing came back.
   */
  resumeFrom?: string
  /**
   * False when the store did not return orders in modified order, or sent one
   * without the stamp — in either case `resumeFrom` is NOT safe to resume from,
   * because orders we never saw may sit behind it. Always true for a first-sync
   * chunk, which is sorted by created date and makes no such claim.
   */
  sortedByModified: boolean
}

/** No store gets longer than this for one request, deadline or not. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * What one request is allowed. The ceiling, or whatever is left of the run,
 * whichever is smaller — a 30-second request begun with 10 seconds left would
 * overrun the deadline the caller is relying on. Never below 1ms: an expired
 * budget still has to be a valid timeout, and the page loop is what stops.
 */
export function requestBudgetMs(filter: FetchFilter, now = Date.now()): number {
  const ceiling = filter.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const left = filter.deadline === undefined ? ceiling : filter.deadline - now
  return Math.max(1, Math.min(ceiling, left))
}
```

- [ ] **Step 4: Bound the loop and track the resume point**

In `src/lib/woo/client.ts`, replace the body of `fetchOrders` (lines 39-66,
everything after the opening brace) with:

```ts
  const all: WooOrder[] = []
  const maxPages = filter.maxPages ?? 50
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  // Only an incremental pull is sorted by modified date, so only it can claim a
  // resume point. A first-sync chunk makes no such claim.
  const incremental = Boolean(filter.modifiedAfter)
  let resumeFrom: string | undefined
  let sortedByModified = true

  for (let page = 1; page <= maxPages; page++) {
    // Checked before the request, not after: starting a page we have no time to
    // finish wastes the budget of every store still waiting behind this one.
    if (filter.deadline !== undefined && Date.now() >= filter.deadline) {
      return { orders: all, hasMore: true, resumeFrom, sortedByModified }
    }

    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      orderby: incremental ? 'modified' : 'date',
      order: 'asc',
    })
    // Woo compares date filters against the STORE's local time unless told
    // otherwise. Ours are UTC, so without this a store at UTC+2 hands back a
    // two-hour-wider window every single pull.
    //
    // `dates_are_gmt` is set FIRST deliberately. It leaves `modified_after`
    // last in the query string, and the pre-existing test at
    // `client.test.ts:54` asserts `not.toContain('after=<value>&')` — swap the
    // two and `"after=…&"` becomes a substring of `"modified_after=…&"`, and
    // that assertion flips. Param order is meaningless to WooCommerce, so keep
    // the order that keeps the test honest.
    if (filter.modifiedAfter) {
      params.set('dates_are_gmt', 'true')
      params.set('modified_after', filter.modifiedAfter.toISOString().slice(0, 19))
    }
    if (filter.createdAfter) params.set('after', filter.createdAfter.toISOString().slice(0, 19))

    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(requestBudgetMs(filter)),
    })

    if (!res.ok) throw await wooError(res)

    const batch = (await res.json()) as WooOrder[]
    all.push(...batch)

    // Verify the ordering we asked for actually happened. Advancing a watermark
    // to the last row of an unsorted result would skip every order the store
    // did not happen to return.
    if (incremental) {
      for (const o of batch) {
        const stamp = o.date_modified_gmt
        if (!stamp) {
          sortedByModified = false
          continue
        }
        // Fixed-width GMT strings, so lexical order is chronological order.
        if (resumeFrom !== undefined && stamp < resumeFrom) sortedByModified = false
        resumeFrom = stamp
      }
    }

    if (batch.length < 100) return { orders: all, hasMore: false, resumeFrom, sortedByModified } // last page
  }

  // Every page we were allowed to fetch came back full — more is behind it.
  return { orders: all, hasMore: true, resumeFrom, sortedByModified }
```

Also update the doc comment above `fetchOrders` (lines 31-37) to mention the two
new reasons a pull stops:

```ts
/**
 * Fetch orders one page at a time, oldest first. WooCommerce caps `per_page` at 100.
 *
 * Stops on a short page (the end), at `maxPages`, or once the caller's deadline
 * passes — the last two both report `hasMore: true`, and for an incremental
 * pull `resumeFrom` says exactly how far we got, so the caller can carry on next
 * run instead of starting the same window again.
 */
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/lib/woo/client.test.ts`
Expected: PASS, all of them. The pre-existing tests are unaffected: they pass no
deadline, so `requestBudgetMs` returns the ceiling and the loop never
short-circuits.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: clean. `sync.ts` destructures `{ orders, hasMore }` from the result and
ignores the new fields, which is valid.

- [ ] **Step 7: Commit**

```bash
git add src/lib/woo/client.ts src/lib/woo/client.test.ts
git commit -m "feat: pulls stop at a deadline, time out, and report where they got to"
```

---

### Task 5: A backlog drains instead of deadlocking

The current code refuses an incremental pull that fills every page, and leaves
the watermark untouched so "the next run retries this window". The intent is
right and the consequence is not: the next run asks for the *same window, now
larger*. It can only grow. That store is stuck permanently and Sync all hits the
identical wall.

Draining replaces refusing. Store what arrived and move the watermark to the
last order actually processed, so the window shrinks every run. This preserves
the author's safety property more strictly than refusing did — it never skips,
it stops exactly where it got to — as long as the ordering held, which Task 4
now checks.

**Files:**
- Modify: `src/lib/woo/sync.ts` (remove the refusal, unify the two partial-pull exits)
- Test: `src/lib/woo/sync.test.ts`

**Interfaces:**
- Consumes: `resumeFrom`, `sortedByModified` (Task 4); `recordRun` (Task 2)
- Produces: `syncShop` returns `more: true` for a partial incremental pull, having advanced `lastSyncAt`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/woo/sync.test.ts`. Note the fixture needs modified stamps,
so add this helper beside the existing `fullPage`:

```ts
/** `n` orders whose modified stamps ascend, as an incremental pull returns them. */
function fullModifiedPage(n: number, startId: number) {
  return Array.from({ length: n }, (_, i) => ({
    ...wooOrder(startId + i, new Date(Date.UTC(2024, 0, 1, 0, startId + i)).toISOString().slice(0, 19)),
    date_modified_gmt: new Date(Date.UTC(2026, 6, 1, 0, startId + i)).toISOString().slice(0, 19),
  }))
}

/**
 * A partial pull, bounded to one page.
 *
 * The bounding is not incidental. A mock returning full pages forever runs the
 * pull to its 50-page ceiling and `storeOrder` then writes 5,000 orders one at a
 * time — minutes per test. A partial pull is a partial pull whether it stopped
 * at page 2 or page 50, so one page proves the same thing.
 *
 * Bounded by `maxPages` rather than by a deadline on purpose: a deadline is set
 * before `syncShop` does its own database reads, so on a loaded machine it can
 * expire before the FIRST fetch and the test then proves nothing. `maxPages` is
 * the same test-only seam `backfillPages` already provides for the other path.
 */
const onePage = (body: unknown) => vi.fn().mockImplementation(async () => jsonPage(body))

describe('draining a backlog', () => {
  it('advances the watermark to the last order it processed', async () => {
    const shop = await connectedShop('[sync-test] backlog')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-06-01T00:00:00Z') },
    })

    vi.stubGlobal('fetch', onePage(fullModifiedPage(100, 0)))

    const result = await syncShop(shop.id, { maxPages: 1 })

    // It is NOT a failure. It is progress with more to come.
    expect(result.ok).toBe(true)
    expect(result.more).toBe(true)

    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    // The window shrank instead of growing: the watermark moved forward, to a
    // processed order's modified stamp rather than to now.
    expect(after.lastSyncAt!.getTime()).toBeGreaterThan(new Date('2026-06-01T00:00:00Z').getTime())
    expect(after.lastError).toBeNull()
  })

  // The old behaviour: refuse, leave the watermark, and be handed a bigger
  // window next run. Forever.
  it('never returns the over-5,000 refusal again', async () => {
    const shop = await connectedShop('[sync-test] no refusal')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-06-01T00:00:00Z') },
    })

    vi.stubGlobal('fetch', onePage(fullModifiedPage(100, 0)))

    const result = await syncShop(shop.id, { maxPages: 1 })
    expect(result.error ?? '').not.toContain('5,000')
  })

  // Advancing to the last row of an unsorted result would skip everything the
  // store did not happen to return.
  it('refuses to advance when the store ignored the ordering', async () => {
    const shop = await connectedShop('[sync-test] unsorted')
    const watermark = new Date('2026-06-01T00:00:00Z')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: watermark } })

    // Full page, modified stamps descending — the opposite of what we asked.
    // The guard only matters on a PARTIAL pull: a completed one moves its
    // watermark to the fetch time and needs no resume point, so this must stop
    // early to be testing anything at all.
    vi.stubGlobal('fetch', onePage(fullModifiedPage(100, 0).reverse()))

    const result = await syncShop(shop.id, { maxPages: 1 })

    expect(result.ok).toBe(false)
    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastSyncAt!.toISOString()).toBe(watermark.toISOString())
    expect(after.lastError).toContain('modified date')
  })

  // The deadline expired before a single page came back: nothing was stored, so
  // there is nowhere to advance to. The attempt still counts as attention paid.
  it('leaves the watermark alone when nothing arrived', async () => {
    const shop = await connectedShop('[sync-test] no time')
    const watermark = new Date('2026-06-01T00:00:00Z')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: watermark } })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id, { deadline: Date.now() - 1 })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastSyncAt!.toISOString()).toBe(watermark.toISOString())
    expect(after.lastRunAt).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/woo/sync.test.ts -t "draining a backlog"`
Expected: FAIL — the first test gets `ok: false` and the over-5,000 error.

- [ ] **Step 3: Accept a deadline and a page bound, and pass both to the pull**

In `src/lib/woo/sync.ts`, change the `syncShop` signature (line 196-199):

```ts
export async function syncShop(
  shopId: string,
  /**
   * `backfillPages` bounds a first-sync chunk, `maxPages` an incremental one —
   * the same seam for the other half of the function, and the only way a test
   * can produce a partial incremental pull without fetching 5,000 orders.
   */
  opts: { backfillPages?: number; maxPages?: number; deadline?: number } = {},
): Promise<SyncResult> {
```

and the `fetchOrders` call (lines 234-239):

```ts
    const fetchStartedAt = new Date()
    const { orders, hasMore, resumeFrom, sortedByModified } = await fetchOrders(
      creds,
      firstSync
        ? { createdAfter, maxPages: opts.backfillPages ?? BACKFILL_PAGES, deadline: opts.deadline }
        : {
            modifiedAfter: new Date(shop.lastSyncAt!.getTime() - OVERLAP),
            maxPages: opts.maxPages,
            deadline: opts.deadline,
          },
    )
```

`maxPages: undefined` leaves `fetchOrders` on its own 50-page default, so
production behaviour is unchanged.

- [ ] **Step 4: Replace both partial-pull exits with one**

Delete the over-5,000 block entirely (the `if (!firstSync && hasMore)` block,
lines 241-250 as amended in Task 2). Then replace the mid-backfill block
(`if (firstSync && hasMore)`) with this single unified exit, which must sit
*after* the `for (const raw of orders)` storing loop:

```ts
    if (hasMore) {
      // A partial pull: the page cap or the deadline stopped us. The best-effort
      // work below belongs to a completed sync, and if the deadline is what
      // stopped us there is no time for it anyway.
      //
      // A first sync's watermark stays unset so the next run resumes the
      // backfill instead of going incremental. An incremental pull moves its
      // watermark to the last order it actually processed — that is what makes
      // a backlog drain instead of being handed back, bigger, every run.
      const canResume = !firstSync && sortedByModified && resumeFrom !== undefined
      const unsorted = !firstSync && !sortedByModified

      const error = unsorted ? UNSORTED_STORE : null
      await recordRun(shop.id, {
        ...(canResume ? { lastSyncAt: new Date(resumeFrom + 'Z') } : {}),
        error,
      })

      return {
        ...base,
        ok: !unsorted,
        ordersSynced: synced,
        more: true,
        ...(error ? { error } : {}),
      }
    }
```

Add the message beside the other module constants, under `OVERLAP`:

```ts
/**
 * A store that hands back orders in some order other than the one we asked for.
 * We cannot advance the watermark past rows we cannot prove we have seen, so
 * this store needs a human rather than another identical retry.
 */
const UNSORTED_STORE =
  'This store did not return orders sorted by modified date, so the sync cannot safely resume. Check the store for a plugin that overrides REST API ordering.'
```

Finally, update the `SyncResult.more` doc comment (line 17-18), which now
describes both kinds of partial pull:

```ts
  /** This pull landed, but more is behind it: history, a full page cap, or the deadline. */
  more?: boolean
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/lib/woo/sync.test.ts`
Expected: PASS. If a pre-existing backfill test now fails on `more`, read it —
the unified exit reports `more: true` in exactly the cases the two old exits did,
so a failure here means the storing loop and the exit are in the wrong order.

- [ ] **Step 6: Commit**

```bash
git add src/lib/woo/sync.ts src/lib/woo/sync.test.ts
git commit -m "fix: a backlog drains over successive runs instead of deadlocking forever"
```

---

### Task 6: The run rotates fairly and stops on time

`syncAllShops` has no `orderBy`, so nothing gives a store that missed out last
run any priority on the next one. Ordering by `lastRunAt` ascending makes it
round-robin: if a run serves K stores, every store is served within ⌈N/K⌉ runs,
whatever N is. Task 2's rule that `lastRunAt` moves even on failure is what stops
a broken store holding the front of the queue.

**Files:**
- Modify: `src/lib/woo/sync.ts:321-326`
- Modify: `src/app/api/cron/sync/route.ts`
- Modify: `src/app/api/sync/route.ts`
- Test: `src/lib/woo/sync.test.ts`, `src/app/api/cron/sync/route.test.ts`

**Interfaces:**
- Consumes: `Shop.lastRunAt` (Task 2), `syncShop(shopId, { deadline })` (Task 5)
- Produces: `syncAllShops(opts?: { deadline?: number }): Promise<SyncResult[]>` — omitting `deadline` keeps the current unbounded behaviour, so every existing caller and test stays meaningful

> **Read this before writing the tests.** These are the only tests in the repo
> that call `syncAllShops()`, and it syncs **every** shop in the database, not
> just the ones this file created. Vitest runs files in parallel against one
> database, so a shop another file created mid-run will be picked up here,
> synced through this file's stubbed `fetch`, and have its `lastSyncAt` moved
> underneath it. That is a genuine cross-file race and it has bitten this repo
> before.
>
> Two rules, therefore. Assert only on the **relative order of this file's own
> shops** (`[sync-test] …`), never on the length or contents of the whole
> result — the assertions below already do this, so do not "tighten" them. And
> if the suite's pass count moves between the two runs in Task 7 Step 6, that is
> this race, not flakiness: fix it by mocking `syncShop` for these cases. Do
> **not** reach for `--no-file-parallelism`; it was measured at 6.7× slower
> (21s versus 137s) and it hides the problem rather than fixing it.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/woo/sync.test.ts`. Import `syncAllShops` alongside `syncShop`
at the top of the file:

```ts
describe('rotation', () => {
  it('serves the longest-ignored store first', async () => {
    const fresh = await connectedShop('[sync-test] rot fresh')
    const stale = await connectedShop('[sync-test] rot stale')
    await db.shop.update({
      where: { id: fresh.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastRunAt: new Date('2026-07-31T00:00:00Z') },
    })
    await db.shop.update({
      where: { id: stale.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastRunAt: new Date('2026-07-02T00:00:00Z') },
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => emptyPage()))
    const results = await syncAllShops()

    const ours = results.filter((r) => r.shopName.startsWith('[sync-test] rot'))
    expect(ours[0].shopName).toBe('[sync-test] rot stale')
  })

  // Never run = most stale of all, and Postgres sorts nulls LAST by default.
  it('puts a never-run store at the very front', async () => {
    const never = await connectedShop('[sync-test] rot never')
    expect(never.lastRunAt).toBeNull() // the precondition this test rests on
    const ran = await connectedShop('[sync-test] rot ran')
    await db.shop.update({
      where: { id: ran.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastRunAt: new Date('2026-07-02T00:00:00Z') },
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => emptyPage()))
    const results = await syncAllShops()

    const ours = results.filter((r) => r.shopName.startsWith('[sync-test] rot'))
    expect(ours[0].shopName).toBe('[sync-test] rot never')
  })

  it('starts no store once the deadline has passed', async () => {
    await connectedShop('[sync-test] deadline a')
    await connectedShop('[sync-test] deadline b')

    const fetchMock = vi.fn().mockImplementation(async () => emptyPage())
    vi.stubGlobal('fetch', fetchMock)

    const results = await syncAllShops({ deadline: Date.now() - 1 })

    expect(results.filter((r) => r.shopName.startsWith('[sync-test] deadline'))).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // One store failing must never cost the stores behind it their turn.
  it('carries on to the next store after one fails', async () => {
    await connectedShop('[sync-test] pair one')
    await connectedShop('[sync-test] pair two')

    let call = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      call++
      return call === 1 ? new Response('down', { status: 500 }) : emptyPage()
    }))

    const results = await syncAllShops()
    const ours = results.filter((r) => r.shopName.startsWith('[sync-test] pair'))
    expect(ours).toHaveLength(2)
    expect(ours.some((r) => r.ok)).toBe(true)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/woo/sync.test.ts -t "rotation"`
Expected: FAIL — `syncAllShops` takes no argument, and the order is whatever
Postgres returns.

- [ ] **Step 3: Rotate and bound the loop**

In `src/lib/woo/sync.ts`, replace `syncAllShops` (lines 321-326):

```ts
/**
 * Every active, connected store, longest-ignored first.
 *
 * The ordering is the whole point. With no `orderBy` nothing gave a store that
 * missed out last run any priority on the next one, so once the work outgrew the
 * budget the stores at the far end simply stopped being reached. Ordered by
 * `lastRunAt`, a run that serves K stores serves every store within ⌈N/K⌉ runs,
 * whatever N is — and because `recordRun` moves `lastRunAt` even when a store
 * fails, a permanently broken store costs one slot per run instead of holding
 * the front of the queue forever.
 *
 * Without a deadline this runs to completion, which is what the tests and any
 * one-off caller want. The scheduled route always passes one.
 */
export async function syncAllShops(opts: { deadline?: number } = {}): Promise<SyncResult[]> {
  const shops = await db.shop.findMany({
    where: { active: true, wooUrl: { not: null } },
    orderBy: { lastRunAt: { sort: 'asc', nulls: 'first' } },
    select: { id: true },
  })
  const results: SyncResult[] = []
  for (const shop of shops) {
    // Checked before the store, not after: starting one we cannot finish takes
    // the budget from a store that is already further behind.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break
    results.push(await syncShop(shop.id, opts))
  }
  return results
}
```

- [ ] **Step 4: Give the scheduled run its deadline**

In `src/app/api/cron/sync/route.ts`, add beside `maxDuration`:

```ts
/**
 * The stores stop here, leaving the rest of the 300s ceiling for the ad sync and
 * the rate top-up that follow. A store cut off by this deadline is not an error:
 * it stored what it fetched, moved its watermark to match, and goes to the front
 * of the next run.
 */
const SHOPS_DEADLINE_MS = 240_000
```

and change the call:

```ts
  const results = await syncAllShops({ deadline: Date.now() + SHOPS_DEADLINE_MS })
```

- [ ] **Step 5: Give the manual run the same treatment**

In `src/app/api/sync/route.ts`, add above `export async function POST`:

```ts
/**
 * Stated rather than inherited: this route relies on the platform default, and
 * a default that moves under us is exactly how the scheduled sync came to give
 * itself 60 seconds.
 */
export const maxDuration = 300

/** Matches the scheduled run, so pressing the button behaves like waiting for it. */
const SHOPS_DEADLINE_MS = 240_000
```

and change the sync call:

```ts
    const deadline = Date.now() + SHOPS_DEADLINE_MS
    const results = shopId
      ? [await syncShop(shopId, { deadline })]
      : await syncAllShops({ deadline })
```

- [ ] **Step 6: Assert the scheduled run passes a deadline**

In `src/app/api/cron/sync/route.test.ts`, the existing mock drops its arguments.
Change it so they reach the spy:

```ts
vi.mock('@/lib/woo/sync', () => ({ syncAllShops: (...args: unknown[]) => syncAllShops(...args) }))
```

and add inside the existing describe block:

```ts
  // Without a deadline the run keeps starting stores until the platform kills
  // it mid-store, which is the shape of the original bug.
  it('bounds the stores well inside the function ceiling', async () => {
    process.env.CRON_SECRET = 'shhh'
    const before = Date.now()
    await call('Bearer shhh')

    const [opts] = syncAllShops.mock.calls[0] as [{ deadline: number }]
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 240_000)
    // Comfortably under maxDuration, leaving room for the ads and rates after.
    expect(opts.deadline).toBeLessThan(before + 300_000)
  })
```

- [ ] **Step 7: Run everything and watch it pass**

Run: `npx vitest run src/lib/woo/sync.test.ts src/app/api/cron/sync/route.test.ts`
Expected: PASS

- [ ] **Step 8: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint`
Expected: both clean

- [ ] **Step 9: Commit**

```bash
git add src/lib/woo/sync.ts src/lib/woo/sync.test.ts src/app/api/cron/sync/route.ts src/app/api/cron/sync/route.test.ts src/app/api/sync/route.ts
git commit -m "feat: the sync serves the longest-ignored store first and stops on time"
```

---

### Task 7: The shops page says what happened

The page passes only `lastSyncAt`, so a failing store shows a frozen date and no
reason — which is the reason "why did it stop" had no answer. It also has to stop
reading a catching-up store as a broken one: Task 5 deliberately moves the
watermark to an old timestamp while a backlog drains, so the raw date alone would
call a healthy run a failure.

**Files:**
- Modify: `src/app/settings/shops/page.tsx:19-27`
- Modify: `src/app/settings/shops/ShopsClient.tsx` (the `Row` type; the Last sync cell at lines 147-153)
- Test: `src/app/settings/shops/ShopsClient.test.tsx`

**Interfaces:**
- Consumes: `Shop.lastRunAt`, `Shop.lastError` (Task 2)
- Produces: `Row` gains `lastRunAt: string | null` and `lastError: string | null`

- [ ] **Step 1: Write the failing tests**

In `src/app/settings/shops/ShopsClient.test.tsx`, extend the shared fixture so
every existing test keeps compiling:

```ts
const SHOP = {
  id: 's1', name: 'Panetti Norway', currency: 'NOK', wooUrl: '', connected: false, lastSyncAt: null,
  hasOrders: false, lastRunAt: null, lastError: null,
}
```

then append:

```ts
describe('what the Last sync column says', () => {
  it('gives the reason a store stopped, instead of a stale date', () => {
    renderShops([{
      ...SHOP,
      connected: true,
      lastSyncAt: '2026-07-19T22:03:00.000Z',
      lastRunAt: '2026-07-31T14:47:00.000Z',
      lastError: 'WooCommerce responded 401: bad key',
    }])

    expect(screen.getByText(/401/)).toBeTruthy()
    expect(screen.getByText('Sync failed')).toBeTruthy()
  })

  // A draining backlog moves the watermark to an OLD order's stamp on purpose.
  // Showing that alone would call a healthy run a dead one.
  it('reads a catching-up store as catching up, not as stopped', () => {
    renderShops([{
      ...SHOP,
      connected: true,
      lastSyncAt: '2026-07-19T22:03:00.000Z',
      lastRunAt: '2026-07-31T14:47:00.000Z',
      lastError: null,
    }])

    expect(screen.getByText(/Catching up/)).toBeTruthy()
    expect(screen.queryByText('Sync failed')).toBeNull()
  })

  it('shows a healthy store just its sync time', () => {
    const at = '2026-07-31T14:47:00.000Z'
    renderShops([{ ...SHOP, connected: true, lastSyncAt: at, lastRunAt: at, lastError: null }])

    expect(screen.queryByText(/Catching up/)).toBeNull()
    expect(screen.queryByText('Sync failed')).toBeNull()
    expect(screen.getByText(new Date(at).toLocaleString())).toBeTruthy()
  })

  it('still says Never for a store that has never synced', () => {
    renderShops([{ ...SHOP, connected: true }])
    expect(screen.getByText('Never')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/app/settings/shops/ShopsClient.test.tsx -t "what the Last sync column says"`
Expected: FAIL — nothing renders "Sync failed"; TypeScript also rejects the
unknown props, which is the same signal.

- [ ] **Step 3: Pass the fields through the page**

In `src/app/settings/shops/page.tsx`, in the `shops.map`, after the `lastSyncAt`
line:

```ts
        lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
        lastError: s.lastError,
```

- [ ] **Step 4: Widen the row type and render the state**

In `src/app/settings/shops/ShopsClient.tsx`, add to the `Row` type beside
`lastSyncAt`:

```ts
  /** When we last gave this shop attention, successful or not. */
  lastRunAt: string | null
  /** Why the last attempt failed; null when it succeeded. */
  lastError: string | null
```

Add above the `ShopsClient` component:

```ts
/**
 * How far the watermark may trail the last run before we call it catching up
 * rather than current. A healthy incremental sync sets them within a second of
 * each other, so an hour is slack, not a threshold anyone will hit by accident.
 */
const BEHIND_MS = 3_600_000

/**
 * What one shop's sync state actually is. A bare date cannot say it: a shop
 * draining a backlog moves its watermark to an old order's stamp on purpose, so
 * the date alone would read as dead when the sync is working perfectly.
 */
function SyncState({ shop }: { shop: Row }) {
  if (shop.lastError) {
    return (
      <div>
        <div className="font-semibold text-loss">Sync failed</div>
        <div className="mt-0.5 text-[11px] text-muted">{shop.lastError}</div>
      </div>
    )
  }

  if (!shop.lastSyncAt) return <>{shop.hasOrders ? 'Importing history…' : 'Never'}</>

  const behind = shop.lastRunAt
    ? new Date(shop.lastRunAt).getTime() - new Date(shop.lastSyncAt).getTime()
    : 0

  if (behind > BEHIND_MS) {
    return (
      <div>
        <div>{new Date(shop.lastRunAt!).toLocaleString()}</div>
        <div className="mt-0.5 text-[11px] text-muted">
          Catching up, data through {new Date(shop.lastSyncAt).toLocaleString()}
        </div>
      </div>
    )
  }

  return <>{new Date(shop.lastSyncAt).toLocaleString()}</>
}
```

Replace the Last sync cell (lines 147-153):

```tsx
                  <td className="px-3 py-2.5 text-muted">
                    <SyncState shop={s} />
                  </td>
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/app/settings/shops/ShopsClient.test.tsx`
Expected: PASS, new and pre-existing.

- [ ] **Step 6: Run the whole suite twice**

Run: `npx vitest run` — then run it a second time.

Expected: identical pass counts both times. Two runs, not one: these suites share
a database and run in parallel, and a race shows up as a count that moves. If it
does move, that is a real defect — find which two tests share a row, do not
serialize the suite (measured at 6.7× slower).

- [ ] **Step 7: Type-check, lint, build**

Run: `npx tsc --noEmit && npx eslint && npm run build`
Expected: all clean. If `tsc` reports a stale route type, delete `.next` and
retry — the route validator caches deleted routes.

- [ ] **Step 8: Commit**

```bash
git add src/app/settings/shops/page.tsx src/app/settings/shops/ShopsClient.tsx src/app/settings/shops/ShopsClient.test.tsx
git commit -m "feat: the shops page says why a store stopped, and when it is catching up"
```

---

## After the last task

Deploying is the real verification, and the acceptance test is on the page the
problem was reported from:

1. Merge and push. The Vercel build runs `prisma db push --skip-generate`, which
   adds the two columns.
2. Confirm the deploy with `curl -s https://panetti.vercel.app/api/version` —
   it returns the deployed commit sha.
3. Wait for two cron runs (30 minutes) and open
   `https://panetti.vercel.app/settings/shops`.

**Pass:** every store shows a recent time. Any that does not shows a reason
beside it instead of a silent stale date.

**If some stores still lag several runs behind**, one invocation genuinely
cannot cover the store count, and that is the evidence for the fan-out design in
the spec's "Deliberately not done" section. It is no longer a guess at that
point.
