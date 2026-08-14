# Visma Purchase Order Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read purchase orders out of Visma so the forecast knows what is already on the water and when it lands, without anyone typing a date twice.

**Architecture:** Three units with one job each. `client.ts` talks HTTP and knows nothing about purchase orders. `purchase-orders.ts` turns a Visma order into rows and is pure, so the arithmetic that decides what counts as incoming is tested with no network and no database. `import.ts` writes, upserting on `externalId` so re-runs are free. The forecast is untouched; one line of `load.ts` learns to subtract what has already landed.

**Tech Stack:** TypeScript, Next.js 16 App Router, Prisma 6 + PostgreSQL, Vitest 4, Visma.net ERP API over OAuth2 client credentials.

**Spec:** `docs/superpowers/specs/2026-08-14-visma-purchase-order-import-design.md`

## Global Constraints

- **Branch is `feat/visma-purchase-orders`.** A background worktree sync moves this checkout between branches without warning. Run `git branch --show-current` before EVERY commit; if it is not `feat/visma-purchase-orders`, stop and report rather than committing.
- **Never run `git stash`, `git checkout -- <path>`, `git restore`, `git reset`, or `git clean`.** Work here has been silently reverted by exactly these. If you believe you need one, stop and report instead.
- **Edit files with the Edit/Write tools only.** PowerShell `Get-Content`/`Set-Content` mangles UTF-8 in this repo and corrupts source files.
- **Never point tests at production.** Tests use the local Postgres from `.env`. Never Neon.
- **Never commit the Visma client secret.** It lives in `.env` locally and in Vercel env vars. No secret in any committed file, fixture, log line, or error message.
- **Visma access is READ-ONLY.** The token holds `vismanet_erp_service_api:read`. Never issue a POST/PUT/PATCH/DELETE against Visma. It is the client's live ERP.
- **Do NOT run `npm run db:push` anywhere in this plan.** The shared local Postgres carries another branch's column that this branch's `schema.prisma` does not declare, and `db push` would drop it. Task 4 Step 2 adds the two new columns with additive SQL instead. This repo has no migrations directory, so the normal `db push` resumes once both branches are on main.
- Tests: `npx vitest run <path>`. Under a full-suite load a few DB tests can exceed the 5s default; re-run with `--testTimeout=20000` before treating a timeout as a failure.
- Do NOT add patterns to `vitest.config.ts`. Its three projects partition the suite exactly. Files named `src/lib/visma/*.test.ts` land in the `app` project automatically.
- Any test that calls `render()` needs `// @vitest-environment jsdom` as **line 1**.
- `@testing-library/user-event` is NOT installed. Use `fireEvent` and `waitFor`.
- Only theme tokens that exist: `text-warn`, `text-loss`, `text-gain`, `text-ink`, `text-muted`, `text-faint`, `text-accent`, `border-line`, `bg-surface`, `bg-canvas`. There is no `--warn` or `--ink-muted`; `var(--warn)` renders as nothing.
- Every blank must say why (`impeccable/DESIGN.md`). An empty state teaches the next action.

---

## Before starting: a collision to check for

As of 2026-08-14 another branch, `feat/stock-source-shops-and-sorting`, was in
progress against **the same two files Task 4 modifies**. It adds a `stockSource`
flag to `Shop`, scopes `loadInventory`'s product query to the shops that carry
it, and reads product names from those shops instead of `SupplyItem`. It also
restructures the `items.map(...)` block that Task 4 edits at `load.ts:143`.

Before Task 4, check whether that work has landed:

```bash
git log --oneline main | head -20
grep -n "stockSource" prisma/schema.prisma src/lib/inventory/load.ts
```

- **Landed:** line 143 has moved. Find the `arrivals:` mapping wherever it now
  lives — it is the only place a purchase order becomes an arrival — and apply
  Task 4's subtraction there. The arithmetic is unchanged.
- **Still in flight:** do not rebase onto it and do not merge it. Apply Task 4 as
  written and resolve the overlap when whichever branch lands second is merged.
  The two changes are independent: one decides *which shops* report stock, the
  other decides *how much of an order* is still coming.

**Confirmed on 2026-08-14:** `Shop.stockSource` is ALREADY present in the shared
local Postgres, pushed from that branch. This branch's `schema.prisma` does not
declare it, so `npm run db:push` from here would drop it and break their tests.
Task 4 Step 2 therefore adds columns with additive SQL and never calls `db push`.
Check with:

```sh
node --env-file=.env -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
db.\$queryRawUnsafe(\`select column_name from information_schema.columns where table_name='Shop' and column_name='stockSource'\`)
  .then(r => console.log(r.length ? 'stockSource IS live - do not db:push' : 'gone - their work landed, db:push is safe again'))
  .finally(() => db.\$disconnect())
"
```

---

## File Structure

**Create:**
- `src/lib/visma/client.ts` — token + GET. One dependency on the outside world.
- `src/lib/visma/client.test.ts`
- `src/lib/visma/types.ts` — the shape of a Visma purchase order as we read it.
- `src/lib/visma/purchase-orders.ts` — pure mapping, no DB, no network.
- `src/lib/visma/purchase-orders.test.ts`
- `src/lib/visma/__fixtures__/purchase-order.json` — one real order, recorded in Task 1, secrets and prices stripped.
- `src/lib/visma/import.ts` — fetch, map, upsert, report.
- `src/lib/visma/import.test.ts`

**Modify:**
- `prisma/schema.prisma:655-671` — `externalId` gains `@unique`; add `receivedQuantity Int?`.
- `src/lib/inventory/load.ts:59` and `:143` — select and subtract `receivedQuantity`.
- `src/lib/inventory/load.test.ts` — regression tests for the subtraction.
- `src/app/api/cron/sync/route.ts` — call the import, best-effort.
- `src/app/api/inventory/purchase-orders/route.ts:40-46` — return the new fields.
- `src/app/inventory/purchase-orders/PurchaseOrdersClient.tsx` — source column, three numbers, no "Mark received" on Visma rows.
- `src/app/inventory/purchase-orders/PurchaseOrdersClient.test.tsx`

---

## Task 1: Confirm the receipt date, and record fixtures — DONE 2026-08-14

**Already completed by the session lead against the live company. Do not re-run
it.** The findings below are the input to Tasks 3 and 5, and six fixtures are
committed under `src/lib/visma/__fixtures__/`.

The full evidence is in the spec under "When an order counts as received —
measured, not assumed". The four results that change the code:

**1. The company is small enough to read in one page.** 227 purchase orders, 719
lines, 208 receipts. No paging and no date filter; Task 5 still reports a full
page rather than trusting one.

**2. Quantity is NOT the completion test.** 59 `Closed` lines have
`qtyOnReceipts < orderQty`. Order 500148 is the worst case: `Closed`,
`openQuantity: 0`, every line `completed: true`, `qtyOnReceipts: 0`, and no
receipt in the company references it. A quantity test reads that as 47 units
still arriving, forever, against an ETA in 2024. Confirmed on the detail
endpoint, so it is the data rather than a lossy list response.

**3. `line.completed` IS the test.** Across all 719 lines:

| status | `completed` | lines |
|---|---|---|
| Closed | `true` | 672 |
| Cancelled | `true` | 7 |
| Open | `false` | 37 |
| Hold | `false` | 3 |

No exceptions. Cancellation is checked first, because cancelled lines also carry
`completed: true`.

**4. The receipt date joins perfectly, and the planned fallback was wrong.**
Order `purchaseReceipts[].receiptNumber` → `controller/api/v1/purchasereceipt`
`receiptNbr` → `date`: **195 of 195 resolved, 0 missing.** Meanwhile orders
500023-500025 carry a receipt date of `2023-11-14` and a
`lastModifiedDateTime` of `2026-07-29` — out by nearly three years. So the
receipt date is used where it exists; `lastModifiedDateTime` remains the
fallback for the 7 Closed orders with no receipt, and the page labels that
column "recorded" rather than "received".

**5. There is real stock to gain.** Open orders include `PANPIZPRO` × 3055 and
`PANPIZOVEBRU` × 1000. 653 of 719 lines belong to the other brands sharing the
ERP and are skipped as "not our product" — expect that count to be large and do
not treat it as a fault.

### The fixtures

`src/lib/visma/__fixtures__/purchase-orders.json` — six real orders, costs and
supplier contacts stripped, one per shape the mapper must handle:

| order | status | why it is there |
|---|---|---|
| 500254 | Open | our products, nothing received yet |
| 500259 | Open | one large Panetti line (3055 units) |
| 500017 | Closed | has a receipt, so a real received date exists |
| **500148** | **Closed** | **no receipt, `qtyOnReceipts: 0` — the trap** |
| 500000 | Cancelled | must be skipped |
| 500235 | Hold | never released, must be skipped |

`src/lib/visma/__fixtures__/purchase-receipts.json` — the receipts those orders
reference, so the date join is testable with no network.

- [x] **Done.** Fixtures recorded and committed; findings above are authoritative.

## Task 2: The Visma client

**Files:**
- Create: `src/lib/visma/client.ts`
- Test: `src/lib/visma/client.test.ts`

**Interfaces:**
- Produces:
  - `export type VismaCredentials = { clientId: string; clientSecret: string; tenantId: string }`
  - `export function vismaCredentials(): VismaCredentials | null` — reads env, null when unconfigured
  - `export async function vismaToken(creds: VismaCredentials, now?: number): Promise<string>`
  - `export async function vismaGet<T>(creds: VismaCredentials, path: string): Promise<T>`
  - `export function resetVismaTokenCache(): void` — tests only
  - `export class VismaError extends Error`

- [ ] **Step 1: Write the failing test**

Create `src/lib/visma/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetVismaTokenCache,
  VismaError,
  vismaCredentials,
  vismaGet,
  vismaToken,
  type VismaCredentials,
} from './client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const CREDS: VismaCredentials = { clientId: 'cid', clientSecret: 'sec', tenantId: 'tid' }

beforeEach(() => resetVismaTokenCache())
afterEach(() => vi.unstubAllGlobals())

describe('vismaCredentials', () => {
  it('is null when nothing is configured, because a missing integration is not an error', () => {
    vi.stubEnv('VISMA_CLIENT_ID', '')
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    vi.stubEnv('VISMA_TENANT_ID', '')
    expect(vismaCredentials()).toBeNull()
  })

  it('is null when only some of the three are set', () => {
    vi.stubEnv('VISMA_CLIENT_ID', 'cid')
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    vi.stubEnv('VISMA_TENANT_ID', 'tid')
    expect(vismaCredentials()).toBeNull()
  })

  it('reads all three', () => {
    vi.stubEnv('VISMA_CLIENT_ID', 'cid')
    vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
    vi.stubEnv('VISMA_TENANT_ID', 'tid')
    expect(vismaCredentials()).toEqual(CREDS)
  })
})

describe('vismaToken', () => {
  it('asks for the read scope and the tenant', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ access_token: 'tok', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await vismaToken(CREDS)).toBe('tok')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://connect.visma.com/connect/token')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('scope')).toBe('vismanet_erp_service_api:read')
    expect(body.get('tenant_id')).toBe('tid')
  })

  it('reuses a live token instead of minting one per request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ access_token: 'tok', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    await vismaToken(CREDS, 1_000_000)
    await vismaToken(CREDS, 1_000_000 + 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('mints a new one once the old is near expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ access_token: 'tok', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    await vismaToken(CREDS, 1_000_000)
    await vismaToken(CREDS, 1_000_000 + 3_600_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not put the secret in the error when Visma rejects it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'invalid_client' }, 401)))
    await expect(vismaToken(CREDS)).rejects.toThrow(VismaError)
    await expect(vismaToken(CREDS)).rejects.not.toThrow(/sec/)
  })
})

describe('vismaGet', () => {
  it('sends the bearer token to the integration host', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(json([{ orderNbr: '500000' }]))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await vismaGet<{ orderNbr: string }[]>(CREDS, 'controller/api/v1/purchaseorder')
    expect(rows).toEqual([{ orderNbr: '500000' }])

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://integration.visma.net/API/controller/api/v1/purchaseorder')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('truncates a gateway HTML error rather than logging the page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(new Response('<html>' + 'x'.repeat(5000) + '</html>', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(vismaGet(CREDS, 'controller/api/v1/purchaseorder')).rejects.toThrow(/502/)
    await expect(vismaGet(CREDS, 'controller/api/v1/purchaseorder')).rejects.toThrow(
      (e: Error) => e.message.length < 400,
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/visma/client.test.ts`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/visma/client.ts`:

```ts
/**
 * Visma.net ERP, over HTTP. Read-only, and deliberately the same shape as
 * src/lib/bring/client.ts: a hard request ceiling and error bodies truncated so
 * a gateway's HTML page never reaches a log line.
 *
 * The host is the trap. The Developer Portal advertises
 * `https://api.finance.visma.net/erp/service`, which is the token's AUDIENCE —
 * every path under it 404s. Requests go to `https://integration.visma.net/API`.
 * Confirmed by probing unauthenticated: 404 means no route, 401 means the route
 * is there and only auth is missing.
 */

const TOKEN_URL = 'https://connect.visma.com/connect/token'
const BASE = 'https://integration.visma.net/API'
const SCOPE = 'vismanet_erp_service_api:read'

/** No single request gets longer than this. */
const REQUEST_TIMEOUT_MS = 60_000

/** Mint a new token this far before the old one dies, so a slow run cannot expire mid-flight. */
const RENEW_MARGIN_MS = 60_000

export type VismaCredentials = { clientId: string; clientSecret: string; tenantId: string }

export class VismaError extends Error {}

/**
 * The three values from the environment, or null when they are not all there.
 *
 * Null is not a failure. An unconfigured integration is skipped quietly, the
 * same way ensureWebhooks skips with no APP_URL — a deployment without Visma
 * credentials is a normal deployment.
 */
export function vismaCredentials(): VismaCredentials | null {
  const clientId = process.env.VISMA_CLIENT_ID?.trim()
  const clientSecret = process.env.VISMA_CLIENT_SECRET?.trim()
  const tenantId = process.env.VISMA_TENANT_ID?.trim()
  if (!clientId || !clientSecret || !tenantId) return null
  return { clientId, clientSecret, tenantId }
}

let cached: { token: string; expiresAt: number; key: string } | null = null

/** Tests only. Module state would otherwise leak a token between cases. */
export function resetVismaTokenCache(): void {
  cached = null
}

export async function vismaToken(creds: VismaCredentials, now: number = Date.now()): Promise<string> {
  // Keyed by client and tenant so a credential change is never served a stale token.
  const key = `${creds.clientId}:${creds.tenantId}`
  if (cached && cached.key === key && cached.expiresAt - RENEW_MARGIN_MS > now) return cached.token

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: SCOPE,
      tenant_id: creds.tenantId,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    // Status only. The request body carried the secret, and an error that echoes
    // the request would put it in a log we do not control.
    throw new VismaError(`Visma refused the credentials (HTTP ${res.status})`)
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new VismaError('Visma returned no access token')

  cached = {
    token: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
    key,
  }
  return cached.token
}

export async function vismaGet<T>(creds: VismaCredentials, path: string): Promise<T> {
  const token = await vismaToken(creds)
  const res = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new VismaError(`Visma responded ${res.status} for ${path}: ${text}`)
  }

  return (await res.json()) as T
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/visma/client.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add src/lib/visma/client.ts src/lib/visma/client.test.ts
git commit -m "feat(visma): read-only client, and the host the portal does not name"
```

---

## Task 3: Map a Visma order to purchase order rows

**Files:**
- Create: `src/lib/visma/types.ts`, `src/lib/visma/purchase-orders.ts`
- Test: `src/lib/visma/purchase-orders.test.ts`
- Read: `src/lib/visma/__fixtures__/purchase-orders.json`, `src/lib/visma/__fixtures__/purchase-receipts.json` (recorded in Task 1)

**Interfaces:**
- Consumes: the Task 1 findings. Nothing else — pure, no network, no database.
- Produces:
  ```ts
  // types.ts — what Visma sends. Scalars arrive EITHER bare or wrapped as
  // { value: x }, so every field goes through unwrap().
  export type Wrapped<T> = T | { value: T } | null | undefined
  export type VismaOrderLine = {
    lineNbr?: Wrapped<number>
    inventory?: { number?: Wrapped<string> }
    orderQty?: Wrapped<number>
    qtyOnReceipts?: Wrapped<number>
    promised?: Wrapped<string>
    completed?: Wrapped<boolean>
    canceled?: Wrapped<boolean>
    warehouse?: unknown
  }
  export type VismaReceiptRef = { receiptNumber?: Wrapped<string>; receiptNbr?: Wrapped<string> }
  export type VismaOrder = {
    orderNbr?: Wrapped<string | number>
    status?: Wrapped<string>
    hold?: Wrapped<boolean>
    date?: Wrapped<string>
    promisedOn?: Wrapped<string>
    lastModifiedDateTime?: Wrapped<string>
    purchaseReceipts?: Wrapped<VismaReceiptRef[]>
    lines?: VismaOrderLine[]
  }
  export type VismaReceipt = { receiptNbr?: Wrapped<string>; status?: Wrapped<string>; date?: Wrapped<string> }

  // purchase-orders.ts — ours.
  export type MappedOrder = {
    externalId: string
    sku: string
    quantity: number
    receivedQuantity: number
    orderedAt: Date
    eta: Date | null
    receivedAt: Date | null
  }
  export type SkipReason =
    | 'cancelled order' | 'order on hold' | 'cancelled line'
    | 'not our product' | 'unusable line'
  export type MapResult = {
    orders: MappedOrder[]
    read: number
    skipped: { reason: SkipReason; count: number }[]
  }
  export function unwrap<T>(v: unknown): T | null
  export function receiptDatesByNumber(receipts: VismaReceipt[]): Map<string, Date>
  export function mapVismaOrders(
    orders: VismaOrder[],
    ourSkus: Set<string>,
    receiptDates?: Map<string, Date>,
  ): MapResult
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/visma/purchase-orders.test.ts`. The fixtures hold BARE scalars
(they were recorded unwrapped) and the synthetic builders below use the WRAPPED
form, so both branches of `unwrap` are exercised.

```ts
import { describe, expect, it } from 'vitest'
import orderFixtures from './__fixtures__/purchase-orders.json'
import receiptFixtures from './__fixtures__/purchase-receipts.json'
import {
  mapVismaOrders,
  receiptDatesByNumber,
  unwrap,
  type VismaOrder,
  type VismaReceipt,
} from './purchase-orders'

const FIXTURES = orderFixtures as unknown as VismaOrder[]
const RECEIPTS = receiptFixtures as unknown as VismaReceipt[]
const byNbr = (n: string) => FIXTURES.find((o) => String(unwrap(o.orderNbr)) === n)!

const OURS = new Set(['PANPIZPRO', 'PANPRIMIXPRO', 'MACBL661', 'MACBE661', 'MLCBL510', 'MLCBE51'])
const DATES = receiptDatesByNumber(RECEIPTS)

const order = (over: Partial<VismaOrder> = {}): VismaOrder => ({
  orderNbr: '500001',
  status: { value: 'Open' },
  date: { value: '2026-06-01' },
  promisedOn: { value: '2026-09-01' },
  lastModifiedDateTime: { value: '2026-07-15T09:00:00Z' },
  purchaseReceipts: [],
  lines: [
    {
      lineNbr: 1,
      inventory: { number: { value: 'PANPIZPRO' } },
      orderQty: { value: 800 },
      qtyOnReceipts: { value: 300 },
      promised: { value: '2026-08-20' },
      completed: { value: false },
      canceled: false,
    },
  ],
  ...over,
})

describe('unwrap', () => {
  it('reads both the wrapped and the bare form, because Visma sends both', () => {
    expect(unwrap<number>({ value: 7 })).toBe(7)
    expect(unwrap<number>(7)).toBe(7)
    expect(unwrap<string>(null)).toBeNull()
    expect(unwrap<string>(undefined)).toBeNull()
    expect(unwrap<string>({ value: null })).toBeNull()
  })
})

describe('receiptDatesByNumber', () => {
  it('indexes the recorded receipts by their number', () => {
    expect(DATES.size).toBe(RECEIPTS.length)
    for (const [nbr, d] of DATES) {
      expect(typeof nbr).toBe('string')
      expect(d).toBeInstanceOf(Date)
    }
  })
})

describe('mapVismaOrders', () => {
  it('keeps ordered and received as two separate numbers', () => {
    const { orders } = mapVismaOrders([order()], OURS, DATES)
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      externalId: '500001-1',
      sku: 'PANPIZPRO',
      quantity: 800,
      receivedQuantity: 300,
    })
  })

  it('prefers the line promise over the order promise', () => {
    expect(mapVismaOrders([order()], OURS, DATES).orders[0].eta).toEqual(
      new Date('2026-08-20T00:00:00Z'),
    )
  })

  it('falls back to the order promise when the line has none', () => {
    const o = order()
    o.lines![0].promised = null
    expect(mapVismaOrders([o], OURS, DATES).orders[0].eta).toEqual(
      new Date('2026-09-01T00:00:00Z'),
    )
  })

  it('leaves eta null when nobody promised anything, so it moves no date', () => {
    const o = order({ promisedOn: null })
    o.lines![0].promised = null
    expect(mapVismaOrders([o], OURS, DATES).orders[0].eta).toBeNull()
  })

  it('does not mark an incomplete line received, whatever the quantities say', () => {
    expect(mapVismaOrders([order()], OURS, DATES).orders[0].receivedAt).toBeNull()
  })

  it('marks a completed line received even though quantities disagree', () => {
    // This is the whole point. Visma closes orders without receipts.
    const o = order()
    o.lines![0].completed = { value: true }
    expect(mapVismaOrders([o], OURS, DATES).orders[0].receivedAt).not.toBeNull()
  })

  it('skips a cancelled order and counts every one of its lines', () => {
    const { orders, skipped } = mapVismaOrders([order({ status: { value: 'Cancelled' } })], OURS, DATES)
    expect(orders).toHaveLength(0)
    expect(skipped).toContainEqual({ reason: 'cancelled order', count: 1 })
  })

  it('skips an order on hold, because nobody has actually placed it', () => {
    const { orders, skipped } = mapVismaOrders([order({ status: { value: 'Hold' } })], OURS, DATES)
    expect(orders).toHaveLength(0)
    expect(skipped).toContainEqual({ reason: 'order on hold', count: 1 })
  })

  it('skips an order flagged hold even when its status does not say so', () => {
    const { orders } = mapVismaOrders([order({ hold: { value: true } })], OURS, DATES)
    expect(orders).toHaveLength(0)
  })

  it('skips a cancelled line but keeps its siblings', () => {
    const o = order()
    o.lines!.push({
      lineNbr: 2,
      inventory: { number: { value: 'PANPRIMIXPRO' } },
      orderQty: { value: 100 },
      qtyOnReceipts: { value: 0 },
      completed: { value: true },
      canceled: { value: true },
    })
    const { orders, skipped } = mapVismaOrders([o], OURS, DATES)
    expect(orders.map((r) => r.sku)).toEqual(['PANPIZPRO'])
    expect(skipped).toContainEqual({ reason: 'cancelled line', count: 1 })
  })

  it('skips a product that is not ours, and says so rather than going quiet', () => {
    const o = order()
    o.lines![0].inventory = { number: { value: 'COSORI-AF-500' } }
    const { orders, skipped, read } = mapVismaOrders([o], OURS, DATES)
    expect(orders).toHaveLength(0)
    expect(read).toBe(1)
    expect(skipped).toContainEqual({ reason: 'not our product', count: 1 })
  })

  it('matches a SKU case-insensitively and ignores surrounding space', () => {
    const o = order()
    o.lines![0].inventory = { number: '  panpizpro ' }
    expect(mapVismaOrders([o], OURS, DATES).orders[0].sku).toBe('PANPIZPRO')
  })

  it('skips a line with no product or no quantity rather than storing a zero-unit order', () => {
    const o = order()
    o.lines = [{ lineNbr: 1, inventory: { number: { value: 'PANPIZPRO' } }, orderQty: { value: 0 } }]
    const { orders, skipped } = mapVismaOrders([o], OURS, DATES)
    expect(orders).toHaveLength(0)
    expect(skipped).toContainEqual({ reason: 'unusable line', count: 1 })
  })

  it('skips an order with no usable date rather than inventing one', () => {
    expect(mapVismaOrders([order({ date: null })], OURS, DATES).orders).toHaveLength(0)
  })
})

// The recorded company data. These are the cases that decided the design.
describe('mapVismaOrders, against the recorded orders', () => {
  it('order 500148 is NOT incoming, though it has zero receipts', () => {
    // Closed, completed:true, qtyOnReceipts:0, no receipt anywhere. A
    // quantity-based test reads this as 47 units arriving in 2024, forever.
    const rows = mapVismaOrders([byNbr('500148')], OURS, DATES).orders
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.receivedAt).not.toBeNull()
      expect(r.receivedQuantity).toBe(0)
    }
  })

  it('order 500017 takes its date from the joined receipt, not from lastModified', () => {
    const rows = mapVismaOrders([byNbr('500017')], new Set(['1298']), DATES).orders
    const receipt = DATES.get('000009')
    if (rows.length && receipt) expect(rows[0].receivedAt).toEqual(receipt)
  })

  it('order 500259 is a real open order for a Panetti product', () => {
    const rows = mapVismaOrders([byNbr('500259')], OURS, DATES).orders
    const pizza = rows.find((r) => r.sku === 'PANPIZPRO')
    expect(pizza).toBeDefined()
    expect(pizza!.quantity).toBe(3055)
    expect(pizza!.receivedQuantity).toBe(0)
    expect(pizza!.receivedAt).toBeNull() // still coming
  })

  it('order 500254 contributes its open lines and nothing else', () => {
    const rows = mapVismaOrders([byNbr('500254')], OURS, DATES).orders
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.receivedAt).toBeNull()
  })

  it('the cancelled and held orders contribute nothing', () => {
    const { orders, skipped } = mapVismaOrders([byNbr('500000'), byNbr('500235')], OURS, DATES)
    expect(orders).toHaveLength(0)
    const reasons = skipped.map((s) => s.reason)
    expect(reasons).toContain('cancelled order')
    expect(reasons).toContain('order on hold')
  })

  it('reads all six recorded orders without throwing', () => {
    const result = mapVismaOrders(FIXTURES, OURS, DATES)
    expect(result.read).toBeGreaterThan(0)
    const counted = result.orders.length + result.skipped.reduce((n, s) => n + s.count, 0)
    // Every line read is either mapped or skipped with a reason. Nothing vanishes.
    expect(counted).toBe(result.read)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/visma/purchase-orders.test.ts`
Expected: FAIL — `Failed to resolve import "./purchase-orders"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/visma/types.ts` holding exactly the wire types from the
Interfaces block above, copied verbatim. They describe what Visma sends, so they
live apart from the mapper that interprets it. Then
`src/lib/visma/purchase-orders.ts`:

```ts
import { normaliseSku } from '../inventory/sku'
import type { VismaOrder, VismaOrderLine, VismaReceipt, VismaReceiptRef } from './types'

export type { VismaOrder, VismaOrderLine, VismaReceipt, VismaReceiptRef } from './types'

export type MappedOrder = {
  externalId: string
  sku: string
  /** What was ordered. Never the outstanding amount — see the design doc. */
  quantity: number
  /** What Visma says has landed. Subtracted at the one place that counts arrivals. */
  receivedQuantity: number
  orderedAt: Date
  eta: Date | null
  /** Non-null means finished, which is what takes it out of the incoming set. */
  receivedAt: Date | null
}

export type SkipReason =
  | 'cancelled order'
  | 'order on hold'
  | 'cancelled line'
  | 'not our product'
  | 'unusable line'

export type MapResult = {
  orders: MappedOrder[]
  read: number
  skipped: { reason: SkipReason; count: number }[]
}

/** Visma wraps most scalars as `{ value: x }` — but not all of them. */
export function unwrap<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value
    return inner === null || inner === undefined ? null : (inner as T)
  }
  return v as T
}

const num = (v: unknown): number | null => {
  const raw = unwrap<unknown>(v)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

const date = (v: unknown): Date | null => {
  const raw = unwrap<string>(v)
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

const truthy = (v: unknown): boolean => unwrap<boolean>(v) === true

/** Receipt number to the date the goods were booked in. */
export function receiptDatesByNumber(receipts: VismaReceipt[]): Map<string, Date> {
  const map = new Map<string, Date>()
  for (const r of receipts ?? []) {
    const nbr = String(unwrap<string>(r?.receiptNbr) ?? '').trim()
    const d = date(r?.date)
    if (nbr && d) map.set(nbr, d)
  }
  return map
}

/**
 * The date an order actually finished.
 *
 * The latest of its receipts, because an order delivered in two shipments is
 * done when the last one lands. Falls back to `lastModifiedDateTime` for the
 * seven closed orders that carry no receipt at all, and to the order date if
 * even that is missing — all three are real dates Visma recorded, which is why
 * the page labels the column "recorded" rather than "received".
 *
 * Never the clock. `lastModifiedDateTime` alone would have been badly wrong:
 * orders 500023-500025 were received in November 2023 and last modified in July
 * 2026.
 */
function finishedOn(
  order: VismaOrder,
  receiptDates: Map<string, Date>,
  orderedAt: Date,
): Date {
  const refs = unwrap<VismaReceiptRef[]>(order.purchaseReceipts)
  let latest: Date | null = null
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      const nbr = String(unwrap<string>(ref?.receiptNumber) ?? unwrap<string>(ref?.receiptNbr) ?? '').trim()
      const d = nbr ? receiptDates.get(nbr) : undefined
      if (d && (latest === null || d > latest)) latest = d
    }
  }
  return latest ?? date(order.lastModifiedDateTime) ?? orderedAt
}

/**
 * Visma purchase orders, as rows we can store.
 *
 * One line becomes one row. `quantity` is always what was ordered and
 * `receivedQuantity` always what Visma says has landed, because a single column
 * holding "outstanding" would read as zero on a finished order and the page
 * could never show what arrived. The subtraction happens once, in load.ts.
 *
 * Completion is `line.completed`, NOT a quantity comparison. Visma closes orders
 * without booking receipts against them — 59 closed lines in the live company
 * have fewer receipts than they ordered, and order 500148 has none at all. A
 * quantity test leaves those counting as incoming stock forever.
 *
 * Every skip is counted with its reason. A line dropped silently because its SKU
 * did not match is indistinguishable from a line that never existed, and that is
 * exactly how a missing purchase order goes unnoticed.
 */
export function mapVismaOrders(
  orders: VismaOrder[],
  ourSkus: Set<string>,
  receiptDates: Map<string, Date> = new Map(),
): MapResult {
  const wanted = new Set([...ourSkus].map((s) => normaliseSku(s)))
  const out: MappedOrder[] = []
  const counts = new Map<SkipReason, number>()
  let read = 0

  const skip = (reason: SkipReason, n = 1) => counts.set(reason, (counts.get(reason) ?? 0) + n)

  for (const order of orders ?? []) {
    const lines = order.lines ?? []
    read += lines.length

    const status = String(unwrap<string>(order.status) ?? '').toLowerCase()

    if (status === 'cancelled' || status === 'canceled') {
      skip('cancelled order', lines.length)
      continue
    }

    // An order on hold has not been placed with the supplier. Counting it would
    // push a run-out date out on stock that may never be ordered — the same
    // reason an order with no ETA moves no date.
    if (status === 'hold' || truthy(order.hold)) {
      skip('order on hold', lines.length)
      continue
    }

    const orderedAt = date(order.date)
    const orderNbr = unwrap<string | number>(order.orderNbr)
    // No order date means no honest orderedAt, and orderedAt is not nullable.
    if (!orderedAt || orderNbr === null) {
      skip('unusable line', lines.length)
      continue
    }

    const orderEta = date(order.promisedOn)
    const finished = finishedOn(order, receiptDates, orderedAt)

    for (const line of lines) {
      // Checked before `completed`, because a cancelled line carries
      // completed: true as well.
      if (truthy(line.canceled)) {
        skip('cancelled line')
        continue
      }

      const rawSku = unwrap<string>(line.inventory?.number)
      const lineNbr = num(line.lineNbr)
      const ordered = num(line.orderQty)
      if (!rawSku || lineNbr === null || ordered === null || ordered <= 0) {
        skip('unusable line')
        continue
      }

      const sku = normaliseSku(rawSku)
      if (!wanted.has(sku)) {
        skip('not our product')
        continue
      }

      out.push({
        externalId: `${orderNbr}-${lineNbr}`,
        sku,
        quantity: ordered,
        receivedQuantity: Math.max(0, num(line.qtyOnReceipts) ?? 0),
        orderedAt,
        // The line's own promise beats the order's: a container of two products
        // can land on two different days.
        eta: date(line.promised) ?? orderEta,
        receivedAt: truthy(line.completed) ? finished : null,
      })
    }
  }

  return {
    orders: out,
    read,
    skipped: [...counts].map(([reason, count]) => ({ reason, count })),
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/visma/purchase-orders.test.ts`
Expected: PASS, every case.

If a fixture case fails, the recorded data is shaped differently than the mapper
assumes. **Fix the mapper to match the real data — never edit the fixture to
match the mapper.** The fixtures are the evidence.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add src/lib/visma/types.ts src/lib/visma/purchase-orders.ts src/lib/visma/purchase-orders.test.ts
git commit -m "feat(visma): map an order to rows, completed not counted"
```

## Task 4: Store both numbers, and subtract once

**Files:**
- Modify: `prisma/schema.prisma:655-671`
- Modify: `src/lib/inventory/load.ts:59` and `:143`
- Test: `src/lib/inventory/load.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PurchaseOrder.receivedQuantity: Int?`, `PurchaseOrder.externalId` unique. Later tasks upsert on `externalId`.

This is the task most likely to move a run-out date by accident. It ships with regression tests for hand-entered rows because those must keep behaving exactly as they do today.

- [ ] **Step 1: Change the schema**

In `prisma/schema.prisma`, in `model PurchaseOrder`:

```prisma
  quantity     Int
  /// What has landed so far, from Visma's `qtyOnReceipts`. Null on every
  /// hand-entered row, which tracks no receipts — so a null falls back to
  /// counting the whole quantity as incoming, exactly as before this existed.
  receivedQuantity Int?
```

and add `@unique` to `externalId`:

```prisma
  externalId   String?   @unique
```

- [ ] **Step 2: Add the columns to the local database — with SQL, NOT `db:push`**

**Do not run `npm run db:push`.** Verified on 2026-08-14: the shared local
Postgres already carries `Shop.stockSource` from the in-flight branch described
at the top of this plan, and that column is not in this branch's
`schema.prisma`. `prisma db push` makes the database match the schema file, so it
would DROP their column and break their tests — the failure mode recorded in the
`shared-local-postgres-drops-columns` note, arrived at from the other direction.

Two additive statements do exactly what this task needs and touch nothing else:

```sh
node --env-file=.env -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  await db.\$executeRawUnsafe('ALTER TABLE \"PurchaseOrder\" ADD COLUMN IF NOT EXISTS \"receivedQuantity\" INTEGER');
  await db.\$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS \"PurchaseOrder_externalId_key\" ON \"PurchaseOrder\"(\"externalId\")');
  console.log('ok');
  await db.\$disconnect();
})().catch(e => { console.log('ERR ' + e.message.slice(0, 300)); process.exit(1) })
"
```

Then regenerate the client so TypeScript knows about the column:

```sh
npx prisma generate
```

Expected: `ok`, then a successful generate. Postgres allows many nulls in a
unique index, so the index applies cleanly to existing hand-entered rows. If it
reports a duplicate key, some row already holds a repeated non-null `externalId`
— stop and report, because nothing writes that column yet.

Prisma names an index on a single column `<Table>_<column>_key`, which is what a
later `db push` will look for — so using that exact name means the eventual push
finds the index already present and does not recreate it.

Extra columns the client does not declare are harmless: Prisma selects columns
by name, so the other session's `stockSource` stays invisible to this branch and
intact in the database.

- [ ] **Step 3: Write the failing tests**

Append to `src/lib/inventory/load.test.ts`, inside the existing `describe('loadInventory', ...)`:

These assert EQUIVALENCES rather than hand-computed dates. A literal expected
date here would be a number somebody guessed, and it would break for the wrong
reason the first time the burn window or the cover default moved. "800 ordered
with 300 landed behaves exactly like 500 on the water" is the actual claim, and
it stays true however the forecast is tuned.

```ts
  // Shared setup for the three arithmetic tests below.
  const orderShape = (itemId: string) => ({
    supplyItemId: itemId,
    orderedAt: new Date('2026-07-01T00:00:00Z'),
    eta: new Date('2026-08-20T00:00:00Z'),
  })
  const runsOut = async () =>
    (await loadInventory(TODAY)).rows.find((r) => r.sku === SKU)!.forecast.runsOutOn

  it('counts only what has not landed yet, so received units are not counted twice', async () => {
    await sell(`${TAG}-no`, SKU, 100, 60, 5, 'NO')
    const item = await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })
    const po = orderShape(item.id)

    await db.purchaseOrder.create({ data: { ...po, quantity: 500 } })
    const asFiveHundred = await runsOut()

    await db.purchaseOrder.deleteMany({ where: { supplyItemId: item.id } })
    await db.purchaseOrder.create({ data: { ...po, quantity: 800, receivedQuantity: 300 } })
    const asEightMinusThree = await runsOut()

    await db.purchaseOrder.deleteMany({ where: { supplyItemId: item.id } })
    await db.purchaseOrder.create({ data: { ...po, quantity: 800 } })
    const asEightHundred = await runsOut()

    // 500 still coming, not 800.
    expect(asEightMinusThree).toEqual(asFiveHundred)
    // And the two really are distinguishable, or the assertion above proves nothing.
    expect(asEightHundred).not.toEqual(asFiveHundred)
  })

  it('never lets an over-receipt subtract from incoming stock', async () => {
    await sell(`${TAG}-no`, SKU, 100, 60, 5, 'NO')
    const item = await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })

    const withNoOrderAtAll = await runsOut()

    // 900 landed against 800 ordered contributes zero, never minus one hundred,
    // so the row must forecast exactly as it does with no order at all.
    await db.purchaseOrder.create({
      data: { ...orderShape(item.id), quantity: 800, receivedQuantity: 900 },
    })
    expect(await runsOut()).toEqual(withNoOrderAtAll)
  })

  it('leaves a hand-entered order counting its whole quantity', async () => {
    // The regression guard for the new column. Every row that exists today has
    // no receivedQuantity, and must forecast exactly as it did before the column
    // was added — which is to say, identically to one that has received nothing.
    await sell(`${TAG}-no`, SKU, 100, 60, 5, 'NO')
    const item = await db.supplyItem.create({ data: { sku: SKU, name: 'Pasta Maker' } })
    const po = orderShape(item.id)

    await db.purchaseOrder.create({ data: { ...po, quantity: 500, receivedQuantity: 0 } })
    const explicitZero = await runsOut()

    await db.purchaseOrder.deleteMany({ where: { supplyItemId: item.id } })
    const created = await db.purchaseOrder.create({ data: { ...po, quantity: 500 } })
    expect(created.receivedQuantity).toBeNull()

    expect(await runsOut()).toEqual(explicitZero)
  })
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run src/lib/inventory/load.test.ts --testTimeout=20000`
Expected: the first two FAIL. The first because `load.ts` still counts the whole 800, so `asEightMinusThree` equals `asEightHundred` rather than `asFiveHundred`. The second because an over-receipt is not yet clamped. The third should already PASS — it is a regression guard for behaviour that must not change.

If the first test passes BEFORE the change, stop: either the assertion is not reaching `load.ts` or the two orders are not distinguishable. The `expect(asEightHundred).not.toEqual(asFiveHundred)` line exists to catch exactly that — if it fails, the burn rate is too low for a 300-unit difference to move the date, so raise the units sold in `sell()` until it does.

- [ ] **Step 5: Make the change**

In `src/lib/inventory/load.ts`, line 59, select the new column:

```ts
          select: { quantity: true, receivedQuantity: true, eta: true },
```

and at line 143, subtract what has landed:

```ts
          // Units already received are already in the stock figure above.
          // Counting the whole order as incoming would count them twice and the
          // forecast would advise ordering too little. A hand-entered row has no
          // receivedQuantity and so still contributes its whole quantity.
          // Math.max because an over-receipt must never subtract from another
          // order's incoming stock.
          arrivals: item.purchaseOrders.map((o) => ({
            eta: o.eta,
            quantity: Math.max(0, o.quantity - (o.receivedQuantity ?? 0)),
          })),
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/inventory/load.test.ts --testTimeout=20000`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add prisma/schema.prisma src/lib/inventory/load.ts src/lib/inventory/load.test.ts
git commit -m "feat(inventory): count what has not landed, not what was ordered"
```

---

## Task 5: The import

**Files:**
- Create: `src/lib/visma/import.ts`
- Test: `src/lib/visma/import.test.ts`

**Interfaces:**
- Consumes: `vismaCredentials`, `vismaGet` (Task 2); `mapVismaOrders`, `receiptDatesByNumber` (Task 3); `receivedQuantity`, unique `externalId` (Task 4).
- Produces:
  ```ts
  export const PAGE_SIZE = 500
  export type VismaImportResult = {
    configured: boolean
    read: number
    imported: number
    skipped: { reason: string; count: number }[]
    truncated: boolean
    error: string | null
  }
  export async function importVismaPurchaseOrders(): Promise<VismaImportResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/visma/import.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { resetVismaTokenCache } from './client'
import { importVismaPurchaseOrders, PAGE_SIZE } from './import'

const TAG = `TEST-VISMA-${Date.now()}`
const SKU = `${TAG}-A`

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** An order the mapper will accept: open, not held, one line for our SKU. */
const vismaOrder = (over: Record<string, unknown> = {}) => ({
  orderNbr: TAG,
  status: { value: 'Open' },
  hold: { value: false },
  date: { value: '2026-06-01' },
  promisedOn: { value: '2026-09-01' },
  lastModifiedDateTime: { value: '2026-07-15T09:00:00Z' },
  purchaseReceipts: [],
  lines: [
    {
      lineNbr: 1,
      inventory: { number: { value: SKU } },
      orderQty: { value: 800 },
      qtyOnReceipts: { value: 300 },
      promised: { value: '2026-08-20' },
      completed: { value: false },
      canceled: false,
    },
  ],
  ...over,
})

/** Finished, with a receipt that dates it. */
const closedOrder = () =>
  vismaOrder({
    status: { value: 'Closed' },
    purchaseReceipts: [{ receiptNumber: { value: 'R-1' } }],
    lines: [
      {
        lineNbr: 1,
        inventory: { number: { value: SKU } },
        orderQty: { value: 800 },
        qtyOnReceipts: { value: 800 },
        promised: { value: '2026-08-20' },
        completed: { value: true },
        canceled: false,
      },
    ],
  })

const RECEIPTS = [{ receiptNbr: { value: 'R-1' }, status: { value: 'Released' }, date: { value: '2026-08-18' } }]

/** Routes the token call, the orders call and the receipts call. */
const stubVisma = (orders: unknown[], receipts: unknown[] = RECEIPTS) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
      if (u.includes('purchasereceipt')) return json(receipts)
      return json(orders)
    }),
  )

beforeEach(async () => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')
  await db.supplyItem.create({ data: { sku: SKU, name: `${TAG} Pasta Maker` } })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await db.purchaseOrder.deleteMany({ where: { item: { sku: { startsWith: TAG } } } })
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
})

describe('importVismaPurchaseOrders', () => {
  it('stores ordered and received as two numbers', async () => {
    stubVisma([vismaOrder()])

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(1)
    expect(result.error).toBeNull()

    const row = await db.purchaseOrder.findFirst({ where: { item: { sku: SKU } } })
    expect(row).toMatchObject({
      externalId: `${TAG}-1`,
      quantity: 800,
      receivedQuantity: 300,
      receivedAt: null,
    })
    expect(row!.eta).toEqual(new Date('2026-08-20T00:00:00Z'))
  })

  it('dates a finished order from its receipt, not from lastModified', async () => {
    stubVisma([closedOrder()])
    await importVismaPurchaseOrders()

    const row = await db.purchaseOrder.findFirst({ where: { item: { sku: SKU } } })
    // The receipt says 18 Aug; lastModifiedDateTime says 15 Jul. The receipt wins.
    expect(row!.receivedAt).toEqual(new Date('2026-08-18T00:00:00Z'))
  })

  it('re-running changes nothing, because the import is keyed on Visma"s own id', async () => {
    stubVisma([vismaOrder()])
    await importVismaPurchaseOrders()
    await importVismaPurchaseOrders()

    expect(await db.purchaseOrder.count({ where: { item: { sku: SKU } } })).toBe(1)
  })

  it('moves the received figure when more units land', async () => {
    stubVisma([vismaOrder()])
    await importVismaPurchaseOrders()

    vi.unstubAllGlobals()
    resetVismaTokenCache()
    stubVisma([closedOrder()])
    await importVismaPurchaseOrders()

    const row = await db.purchaseOrder.findFirst({ where: { item: { sku: SKU } } })
    expect(row!.receivedQuantity).toBe(800)
    expect(row!.receivedAt).not.toBeNull()
  })

  it('never touches a hand-entered row', async () => {
    const item = await db.supplyItem.findFirstOrThrow({ where: { sku: SKU } })
    const mine = await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 42, orderedAt: new Date('2026-01-01T00:00:00Z') },
    })
    stubVisma([vismaOrder()])

    await importVismaPurchaseOrders()

    const after = await db.purchaseOrder.findUniqueOrThrow({ where: { id: mine.id } })
    expect(after.quantity).toBe(42)
    expect(after.externalId).toBeNull()
    expect(after.receivedQuantity).toBeNull()
  })

  it('is skipped, not failed, when no credentials are configured', async () => {
    vi.stubEnv('VISMA_CLIENT_ID', '')
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    vi.stubEnv('VISMA_TENANT_ID', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await importVismaPurchaseOrders()
    expect(result).toMatchObject({ configured: false, imported: 0, error: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a Visma outage instead of throwing into the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token')
          ? json({ access_token: 'tok', expires_in: 3600 })
          : json({ error: 'down' }, 503),
      ),
    )

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(0)
    expect(result.error).toMatch(/503/)
  })

  it('still imports when the receipts call fails, because dates are not the point', async () => {
    // A finished order without a resolvable receipt falls back to
    // lastModifiedDateTime. Losing the dates must not lose the orders.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
        if (u.includes('purchasereceipt')) return json({ error: 'down' }, 503)
        return json([vismaOrder()])
      }),
    )

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(1)
    expect(result.error).toBeNull()
  })

  it('counts a line for a product we do not sell', async () => {
    const foreign = vismaOrder()
    foreign.lines[0].inventory = { number: { value: 'COSORI-NOT-OURS' } }
    stubVisma([foreign])

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(0)
    expect(result.skipped).toContainEqual({ reason: 'not our product', count: 1 })
  })

  it('says so when the page came back full, rather than reporting a clean run', async () => {
    // A full page means orders past it were dropped, which otherwise looks
    // exactly like a company that has no more. Foreign SKUs so the test costs
    // 500 map operations rather than 500 writes.
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => {
      const o = vismaOrder({ orderNbr: `${TAG}-${i}` })
      o.lines[0].inventory = { number: { value: 'COSORI-NOT-OURS' } }
      return o
    })
    stubVisma(full)

    expect((await importVismaPurchaseOrders()).truncated).toBe(true)
  })

  it('does not claim truncation on a normal page', async () => {
    stubVisma([vismaOrder()])
    expect((await importVismaPurchaseOrders()).truncated).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/visma/import.test.ts --testTimeout=20000`
Expected: FAIL — `Failed to resolve import "./import"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/visma/import.ts`:

```ts
import { db } from '../db'
import { normaliseSku } from '../inventory/sku'
import { vismaCredentials, vismaGet } from './client'
import { mapVismaOrders, receiptDatesByNumber } from './purchase-orders'
import type { VismaOrder, VismaReceipt } from './types'

/**
 * One page, wide. Measured 2026-08-14: the company holds 227 purchase orders and
 * 208 receipts in its entire history, so this reads everything in one request
 * each and needs no date filter.
 *
 * If Visma ever returns exactly this many, the page is full and orders beyond it
 * were silently dropped — which would look identical to a company that simply
 * has no more. That case reports itself; see `truncated` below. The fix when it
 * fires is paging, not a bigger number.
 */
export const PAGE_SIZE = 500

export type VismaImportResult = {
  configured: boolean
  read: number
  imported: number
  skipped: { reason: string; count: number }[]
  /** True when the page came back full, so orders may have been missed. */
  truncated: boolean
  error: string | null
}

const nothing = (over: Partial<VismaImportResult> = {}): VismaImportResult => ({
  configured: true,
  read: 0,
  imported: 0,
  skipped: [],
  truncated: false,
  error: null,
  ...over,
})

/**
 * Pull purchase orders from Visma into our own table.
 *
 * Never throws. The scheduled sync calls this alongside the store pull, and
 * Visma being down must never fail that — the next run simply tries again.
 *
 * Idempotent: every row is keyed on Visma's `orderNbr-lineNbr`, so a re-run
 * updates rather than duplicates. Rows someone typed here have no externalId and
 * are invisible to this function.
 */
export async function importVismaPurchaseOrders(): Promise<VismaImportResult> {
  const creds = vismaCredentials()
  // Not an error. A deployment without Visma credentials is a normal deployment.
  if (!creds) return nothing({ configured: false })

  try {
    const orders = await vismaGet<VismaOrder[]>(
      creds,
      `controller/api/v1/purchaseorder?pageSize=${PAGE_SIZE}`,
    )
    const rows = Array.isArray(orders) ? orders : []

    // Receipts only date the finished orders. Losing them must not lose the
    // orders themselves, so this failing falls back to lastModifiedDateTime
    // rather than failing the import.
    let receiptDates = new Map<string, Date>()
    try {
      const receipts = await vismaGet<VismaReceipt[]>(
        creds,
        `controller/api/v1/purchasereceipt?pageSize=${PAGE_SIZE}`,
      )
      receiptDates = receiptDatesByNumber(Array.isArray(receipts) ? receipts : [])
    } catch {
      // Dates degrade; the import continues.
    }

    const items = await db.supplyItem.findMany({ select: { id: true, sku: true } })
    // normaliseSku, not a hand-rolled trim/uppercase: the mapper keys on it too,
    // and two spellings of "the same SKU" would fail to join for no visible reason.
    const idBySku = new Map(items.map((i) => [normaliseSku(i.sku), i.id]))

    const mapped = mapVismaOrders(rows, new Set(idBySku.keys()), receiptDates)

    let imported = 0
    for (const row of mapped.orders) {
      const supplyItemId = idBySku.get(row.sku)
      // mapVismaOrders already filtered to our SKUs, so this cannot normally miss.
      if (!supplyItemId) continue

      const fields = {
        supplyItemId,
        quantity: row.quantity,
        receivedQuantity: row.receivedQuantity,
        orderedAt: row.orderedAt,
        eta: row.eta,
        receivedAt: row.receivedAt,
      }

      await db.purchaseOrder.upsert({
        where: { externalId: row.externalId },
        create: { externalId: row.externalId, ...fields },
        // `notes` is deliberately absent: someone may have written one here, and
        // Visma has no opinion about it.
        update: fields,
      })
      imported += 1
    }

    return nothing({
      read: mapped.read,
      imported,
      skipped: mapped.skipped,
      truncated: rows.length >= PAGE_SIZE,
    })
  } catch (e) {
    // Reported, not thrown. The sync route shows this and the next run retries.
    return nothing({ error: e instanceof Error ? e.message : 'Visma import failed' })
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/visma/import.test.ts --testTimeout=20000`
Expected: PASS, all eleven cases.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add src/lib/visma/import.ts src/lib/visma/import.test.ts
git commit -m "feat(visma): import purchase orders, idempotently, without touching typed rows"
```

## Task 6: Run it on the existing schedule

**Files:**
- Modify: `src/app/api/cron/sync/route.ts`

**Interfaces:**
- Consumes: `importVismaPurchaseOrders` (Task 5).
- Produces: `vismaImported`, `vismaSkipped`, `vismaError` on the sync response body.

- [ ] **Step 1: Add the import to the run**

In `src/app/api/cron/sync/route.ts`, add to the imports at the top:

```ts
import { importVismaPurchaseOrders, type VismaImportResult } from '@/lib/visma/import'
```

Then, immediately AFTER the `syncAllShops` block and BEFORE the ad sync (Visma is one cheap bounded call, and it must not sit behind the greedy parcel poll):

```ts
  // Purchase orders from Visma. One bounded call, and purchase orders change
  // slowly, so it costs the run almost nothing. Best-effort like everything
  // after the shops: the ERP being unreachable must never fail the store sync,
  // and the result carries its own error for the response below.
  let visma: VismaImportResult = {
    configured: false, read: 0, imported: 0, skipped: [], truncated: false, error: null,
  }
  try {
    visma = await importVismaPurchaseOrders()
  } catch {
    // importVismaPurchaseOrders does not throw, but a caller that assumes so is
    // one refactor away from a failed sync.
  }
```

Add to the response body, before the closing brace:

```ts
    vismaConfigured: visma.configured,
    vismaImported: visma.imported,
    vismaSkipped: visma.skipped,
    vismaTruncated: visma.truncated,
    vismaError: visma.error,
```

- [ ] **Step 2: Check it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Mock Visma in the sync route's test, BEFORE running it**

Not optional, and not merely for speed. The route sees the `VISMA_*` values from
`.env` even though a plain unit test does not, so without this the test reaches
**the client's live ERP**. Measured: 719 real order lines read, 62 rows written
to the local database, 39 seconds per test. Read-only against Visma, so nothing
there was harmed, but a test must not do it at all.

`src/app/api/cron/sync/route.test.ts` already mocks `@/lib/woo/sync` and
`@/lib/fx/rates` for the same reason. Add a third, next to them:

```ts
// Nor is Visma. This one is not merely slow, it is the CLIENT'S LIVE ERP — and
// without this mock the test really does reach it, because the route sees the
// VISMA_* credentials from .env even though a plain unit test does not. Left
// unmocked it read 719 real order lines and wrote 62 rows into the local
// database, taking 39 seconds to do it.
const importVismaPurchaseOrders = vi.fn(async () => ({
  configured: false, read: 0, imported: 0, skipped: [], truncated: false, error: null,
}))
vi.mock('@/lib/visma/import', () => ({
  importVismaPurchaseOrders: () => importVismaPurchaseOrders(),
}))
```

- [ ] **Step 4: Run the sync route's existing tests**

Run: `npx vitest run src/app/api/cron --testTimeout=20000`
Expected: PASS, in normal time. A 20-second timeout here means the mock above is
missing or misnamed, and the test is talking to Visma — stop and fix it rather
than raising the timeout.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add src/app/api/cron/sync/route.ts
git commit -m "feat(visma): pull purchase orders on the hourly sync"
```

---

## Task 7: Show where a row came from, and all three numbers

**Files:**
- Modify: `src/app/api/inventory/purchase-orders/route.ts:37-47`
- Modify: `src/app/inventory/purchase-orders/PurchaseOrdersClient.tsx`
- Test: `src/app/inventory/purchase-orders/PurchaseOrdersClient.test.tsx`

**Interfaces:**
- Consumes: `receivedQuantity`, `externalId` (Task 4).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

The file already has a module-scope `order()` builder (around line 18). **Extend it** with the two new fields defaulting to the hand-entered shape — that keeps every existing test passing unchanged:

```tsx
const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1',
  quantity: 10,
  // A hand-entered row is the default here, because that is what every existing
  // test in this file is about.
  receivedQuantity: null,
  externalId: null,
  orderedAt: '2026-08-01T00:00:00.000Z',
  eta: null,
  receivedAt: null,
  item: { sku: 'PANPIZPRO', name: 'Pizzetta Pro' },
  ...over,
})

/** The same row as Visma would deliver it: part received, with an id of its own. */
const vismaOrder = (over: Partial<Order> = {}): Order =>
  order({
    id: 'v1',
    quantity: 800,
    receivedQuantity: 300,
    externalId: '500001-1',
    eta: '2026-08-20T00:00:00.000Z',
    ...over,
  })
```

Then append these cases inside the existing `describe('PurchaseOrdersClient', ...)`:

```tsx
  it('says a row came from Visma, so someone knows where to fix it', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.getByText('Visma')).toBeInTheDocument()
  })

  it('says a hand-entered row was added here', () => {
    render(<PurchaseOrdersClient orders={[order()]} items={[]} />)
    expect(screen.getByText('added here')).toBeInTheDocument()
  })

  it('shows what landed and what is still coming, not just one number', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.getByText(/800 ordered/)).toBeInTheDocument()
    expect(screen.getByText(/300 landed/)).toBeInTheDocument()
    expect(screen.getByText(/500 still coming/)).toBeInTheDocument()
  })

  it('shows a hand-entered row as one number, exactly as before', () => {
    render(<PurchaseOrdersClient orders={[order({ quantity: 42 })]} items={[]} />)
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.queryByText(/landed/)).not.toBeInTheDocument()
  })

  it('does not offer to mark a Visma row received, because receipt is Visma"s fact', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.queryByRole('button', { name: 'Mark received' })).not.toBeInTheDocument()
    expect(screen.getByText(/Visma records receipts/)).toBeInTheDocument()
  })

  it('still offers it on a hand-entered row', () => {
    render(<PurchaseOrdersClient orders={[order()]} items={[]} />)
    expect(screen.getByRole('button', { name: 'Mark received' })).toBeInTheDocument()
  })

  it('says "recorded" on a Visma row, because seven of them have no real receipt', () => {
    render(
      <PurchaseOrdersClient
        orders={[vismaOrder({ receivedQuantity: 800, receivedAt: '2026-08-18T00:00:00.000Z' })]}
        items={[]}
      />,
    )
    expect(screen.getByText(/recorded/)).toBeInTheDocument()
    expect(screen.queryByText(/^received/)).not.toBeInTheDocument()
  })

  it('says "received" on a hand-entered row, where someone really did mark it', () => {
    render(
      <PurchaseOrdersClient
        orders={[order({ receivedAt: '2026-08-18T00:00:00.000Z' })]}
        items={[]}
      />,
    )
    expect(screen.getByText(/received/)).toBeInTheDocument()
  })

  it('does not say "none landed yet" about an order Visma has closed', () => {
    // Order 500148's shape: closed, nothing ever booked against it. Saying we
    // are still waiting would be the opposite of the truth.
    render(
      <PurchaseOrdersClient
        orders={[vismaOrder({ quantity: 17, receivedQuantity: 0, receivedAt: '2024-11-20T00:00:00.000Z' })]}
        items={[]}
      />,
    )
    expect(screen.getByText(/closed with no receipt/)).toBeInTheDocument()
    expect(screen.queryByText(/none landed yet/)).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/app/inventory/purchase-orders/PurchaseOrdersClient.test.tsx`
Expected: FAIL — TypeScript rejects `receivedQuantity` and `externalId` on `Order`, and the new text is absent.

- [ ] **Step 3: Return the new fields from the API**

In `src/app/api/inventory/purchase-orders/route.ts`, the `GET` already returns whole rows via `findMany`, so `externalId` and `receivedQuantity` come back automatically once the schema has them. Confirm by reading the handler — if it grows an explicit `select`, add both fields. No change is expected here.

- [ ] **Step 4: Update the component**

In `src/app/inventory/purchase-orders/PurchaseOrdersClient.tsx`, extend the exported type:

```ts
export type Order = {
  id: string
  quantity: number
  /** What has landed. Null on a hand-entered row, which tracks no receipts. */
  receivedQuantity: number | null
  /** Visma's own id. Null means someone typed this row here. */
  externalId: string | null
  orderedAt: string
  eta: string | null
  receivedAt: string | null
  item: { sku: string; name: string }
}
```

Add a helper above the component:

```ts
/**
 * What a row is actually saying about its units.
 *
 * A part-received order shows all three numbers rather than the outstanding one
 * alone: "500" by itself invites the question of what happened to the other 300,
 * and the answer is already in the row.
 */
function units(o: Order) {
  if (o.receivedQuantity === null) return String(o.quantity)
  const outstanding = Math.max(0, o.quantity - o.receivedQuantity)

  // Finished, per Visma. It closes some orders without ever booking a receipt
  // against them, so "0 landed" on a closed row is the paperwork rather than the
  // pallet — and saying "none landed yet" there would imply we are still waiting.
  if (o.receivedAt) {
    return o.receivedQuantity === 0
      ? `${o.quantity} ordered · closed with no receipt`
      : `${o.quantity} ordered · ${o.receivedQuantity} landed`
  }

  if (o.receivedQuantity === 0) return `${o.quantity} ordered · none landed yet`
  return `${o.quantity} ordered · ${o.receivedQuantity} landed · ${outstanding} still coming`
}
```

Add a `Source` header to the `<thead>` row, before the trailing empty `<th>`:

```tsx
              <th className="px-4 py-2.5">Source</th>
```

Replace the units cell:

```tsx
                <td className="px-4 py-2.5 tabular-nums">{units(o)}</td>
```

Add the source cell, before the actions cell:

```tsx
                <td className="px-4 py-2.5 text-muted">{o.externalId ? 'Visma' : 'added here'}</td>
```

Replace the actions cell so a Visma row explains itself rather than offering a button that would create a second answer to one question:

```tsx
                <td className="px-4 py-2.5 text-right">
                  {o.receivedAt ? (
                    // "recorded", not "received", on a Visma row. Most of these
                    // dates come from a real goods receipt, but seven closed
                    // orders have none and fall back to when the record last
                    // changed. The word has to cover both without overstating.
                    <span className="text-muted">
                      {o.externalId ? 'recorded' : 'received'} {when(o.receivedAt)}
                    </span>
                  ) : o.externalId ? (
                    <span className="text-muted">Visma records receipts</span>
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
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/app/inventory/purchase-orders/PurchaseOrdersClient.test.tsx`
Expected: PASS, including every pre-existing case — extending the shared `order()` builder is what keeps them passing. If any test builds an `Order` literal inline rather than through the builder, add `receivedQuantity: null` and `externalId: null` to it; that is the correct shape for a hand-entered row.

- [ ] **Step 6: Check the page compiles**

Run: `npx tsc --noEmit`
Expected: no errors. `src/app/inventory/purchase-orders/page.tsx` passes rows straight through, so it needs no change; if `tsc` disagrees, add the two fields to whatever it selects.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add src/app/inventory/purchase-orders/ src/app/api/inventory/purchase-orders/route.ts
git commit -m "feat(inventory): say where a purchase order came from, and what landed"
```

---

## Task 8: Whole suite, lint, build

**Files:** none created.

- [ ] **Step 1: Run every test**

Run: `npx vitest run --testTimeout=20000`
Expected: PASS. The baseline before this plan was 1707 passing; expect that plus roughly 30 new. A handful of `sync.test.ts` timeouts under load are contention rather than breakage — re-run just that file before investigating.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Types**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: succeeds. Run this in the PRIMARY checkout — a build inside `C:/panetti-wt` fails on a Turbopack symlink and tells you nothing about the code.

- [ ] **Step 5: Report**

State the test count, and list anything deferred. Do not merge or push; the lead decides that, and the production environment variables must exist first.

---

## Deployment notes (lead, not an implementer)

Before this does anything in production:

1. **Rotate the Visma client secret.** It was pasted into a chat transcript, so treat it as compromised. Generate a fresh one in the Visma Developer Portal.
2. Set in Vercel (all environments): `VISMA_CLIENT_ID`, `VISMA_TENANT_ID`, `VISMA_CLIENT_SECRET`.
3. Until those exist, `importVismaPurchaseOrders` returns `configured: false` and the sync is unchanged — deploying early is safe.
4. After the first scheduled run, check the sync response:
   - `vismaImported` — should be non-zero.
   - `vismaSkipped` — a large `not our product` count is expected, since Cosori, Levoit and the rest share the ERP. A large `unusable line` count is not; investigate it.
   - `vismaTruncated: true` means the page came back full and orders were dropped. Add paging before trusting any forecast.
   - `vismaError` — a string here means the ERP was unreachable; the run is otherwise unaffected and the next one retries.

## Still open with Philip

- Is "Oslo Lagerhotell" the only physical warehouse? The forecast treats stock as one pool.
- The Chinese supplier on order 500000 is recorded as `CH — SWITZERLAND` in Visma; the address is Guangdong. His to fix, and it would corrupt any country-based supplier reporting.
