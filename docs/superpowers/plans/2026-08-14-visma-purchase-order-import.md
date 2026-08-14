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
- Schema changes go through `npm run db:push` — this repo has no migrations directory.
- Tests: `npx vitest run <path>`. Under a full-suite load a few DB tests can exceed the 5s default; re-run with `--testTimeout=20000` before treating a timeout as a failure.
- Do NOT add patterns to `vitest.config.ts`. Its three projects partition the suite exactly. Files named `src/lib/visma/*.test.ts` land in the `app` project automatically.
- Any test that calls `render()` needs `// @vitest-environment jsdom` as **line 1**.
- `@testing-library/user-event` is NOT installed. Use `fireEvent` and `waitFor`.
- Only theme tokens that exist: `text-warn`, `text-loss`, `text-gain`, `text-ink`, `text-muted`, `text-faint`, `text-accent`, `border-line`, `bg-surface`, `bg-canvas`. There is no `--warn` or `--ink-muted`; `var(--warn)` renders as nothing.
- Every blank must say why (`impeccable/DESIGN.md`). An empty state teaches the next action.

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

## Task 1: Confirm the receipt date, and record a fixture

**This task is run by the session lead, not a subagent.** It needs the Visma client secret, which must not be handed to a subagent, and it reads the client's live ERP.

**Files:**
- Create: `<scratchpad>/visma-po-shape.mjs` (throwaway, NOT committed)
- Create: `src/lib/visma/__fixtures__/purchase-order.json` (committed)

**Interfaces:**
- Produces: the answer to "which field dates a completed purchase order", and a recorded fixture every later test runs against.

The spec deliberately refuses to guess this. `receivedAt` must not be stamped from the clock — that would record a 2023 delivery as arriving today.

- [ ] **Step 1: Confirm the secret is in `.env`, not in chat**

`.env` needs these three. The secret must come from the Visma Developer Portal directly — if it has ever been pasted into a chat, rotate it first and use the new one.

```
VISMA_CLIENT_ID=isv_panetti_inventory_forecast
VISMA_TENANT_ID=83949a19-af32-11ec-b60b-0638767d04b5
VISMA_CLIENT_SECRET=<from the portal>
```

Confirm `.env` is gitignored: `git check-ignore .env` must print `.env`.

- [ ] **Step 2: Write the probe**

Write to the scratchpad, not the repo. Every request is a GET.

```js
// Which field dates a COMPLETED purchase order? Read-only.
const BASE = 'https://integration.visma.net/API'

const res = await fetch('https://connect.visma.com/connect/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.VISMA_CLIENT_ID,
    client_secret: process.env.VISMA_CLIENT_SECRET,
    scope: 'vismanet_erp_service_api:read',
    tenant_id: process.env.VISMA_TENANT_ID,
  }),
})
if (!res.ok) { console.log('token failed ' + res.status); process.exit(1) }
const { access_token } = await res.json()

const get = async (p) => {
  const r = await fetch(BASE + '/' + p, {
    headers: { Authorization: 'Bearer ' + access_token, Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  })
  return r.ok ? r.json() : (console.log(p + ' -> ' + r.status), null)
}

const orders = await get('controller/api/v1/purchaseorder?pageSize=500')
if (!orders) process.exit(1)
console.log('orders: ' + orders.length + (orders.length >= 500 ? '  <-- FULL PAGE, the import needs paging' : ''))
console.log('statuses: ' + [...new Set(orders.map((o) => o.status?.value ?? o.status))].join(', '))

// Top-level date-ish fields, and whether a COMPLETED order fills them in.
const done = orders.find((o) => {
  const lines = o.lines ?? []
  return lines.length && lines.every((l) => (l.qtyOnReceipts ?? 0) >= (l.orderQty ?? 0))
})
console.log('\na fully received order: ' + (done ? (done.orderNbr?.value ?? done.orderNbr) : 'NONE FOUND'))
if (done) {
  for (const [k, v] of Object.entries(done)) {
    if (!/date|time|promis|receipt|complet|close/i.test(k)) continue
    console.log('  ' + k.padEnd(28) + JSON.stringify(v?.value ?? v))
  }
  console.log('  --- its first line ---')
  for (const [k, v] of Object.entries(done.lines?.[0] ?? {})) {
    if (!/date|time|promis|receipt|qty|complet/i.test(k)) continue
    console.log('    ' + k.padEnd(26) + JSON.stringify(v?.value ?? v))
  }
}
```

- [ ] **Step 3: Run it**

Run: `node --env-file=.env <scratchpad>/visma-po-shape.mjs`
Expected: an order count, the set of statuses in use, and a list of date-bearing fields on a fully received order.

Note the ORDER COUNT. It answers the spec's open question about how far back to read: under 500 and the import fetches the lot in one request, which is what Task 5 assumes. If the probe prints `FULL PAGE`, stop and report — Task 5 needs paging or a date filter, and shipping it without one would silently drop orders.

- [ ] **Step 4: Decide, and write the decision down**

Apply the spec's rule, in order:
1. A real receipt or completion date on the order → use it.
2. Otherwise `lastModifiedDateTime` → use it, and the UI column reads **"recorded"**, not "received".
3. Never the clock.

Record the choice as a comment at the top of `src/lib/visma/purchase-orders.ts` in Task 3. If no fully received order exists in the company at all, use `lastModifiedDateTime` and say so.

- [ ] **Step 5: Record the fixture**

Save ONE real purchase order to `src/lib/visma/__fixtures__/purchase-order.json`, preferring one with at least two lines and a partial receipt. Before saving, strip: unit costs, extended costs, supplier contact details, and any `taxes` block. Keep `orderNbr`, `status`, `date`, `promisedOn`, `lastModifiedDateTime`, `supplierName`, and per line `lineNbr`, `inventory.number`, `orderQty`, `qtyOnReceipts`, `promised`, `canceled`, `warehouse`.

Read the file back and confirm no secret, price, or personal contact detail survived.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add src/lib/visma/__fixtures__/purchase-order.json
git commit -m "test(visma): record one real purchase order to map against"
```

---

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
- Read: `src/lib/visma/__fixtures__/purchase-order.json` (Task 1)

**Interfaces:**
- Consumes: nothing. Pure — no network, no database.
- Produces:
  ```ts
  export type VismaOrderLine = {
    lineNbr?: number | { value: number }
    inventory?: { number?: string | { value: string } }
    orderQty?: number | { value: number }
    qtyOnReceipts?: number | { value: number }
    promised?: string | { value: string } | null
    canceled?: boolean | { value: boolean }
    warehouse?: unknown
  }
  export type VismaOrder = {
    orderNbr?: string | number | { value: string | number }
    status?: string | { value: string }
    date?: string | { value: string } | null
    promisedOn?: string | { value: string } | null
    lastModifiedDateTime?: string | { value: string } | null
    lines?: VismaOrderLine[]
  }
  export type MappedOrder = {
    externalId: string
    sku: string
    quantity: number
    receivedQuantity: number
    orderedAt: Date
    eta: Date | null
    receivedAt: Date | null
  }
  export type SkipReason = 'cancelled order' | 'cancelled line' | 'not our product' | 'unusable line'
  export type MapResult = {
    orders: MappedOrder[]
    read: number
    skipped: { reason: SkipReason; count: number }[]
  }
  export function unwrap<T>(v: unknown): T | null
  export function mapVismaOrders(orders: VismaOrder[], ourSkus: Set<string>): MapResult
  ```

Visma wraps most scalars as `{ value: x }` but not all of them, which is why `unwrap` exists and why every field goes through it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/visma/purchase-orders.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/purchase-order.json'
import { mapVismaOrders, unwrap, type VismaOrder } from './purchase-orders'

const OURS = new Set(['PANPIZPRO', 'PANPRIMIXPRO'])

const order = (over: Partial<VismaOrder> = {}): VismaOrder => ({
  orderNbr: '500001',
  status: { value: 'Open' },
  date: { value: '2026-06-01' },
  promisedOn: { value: '2026-09-01' },
  lastModifiedDateTime: { value: '2026-07-15T09:00:00Z' },
  lines: [
    {
      lineNbr: 1,
      inventory: { number: { value: 'PANPIZPRO' } },
      orderQty: { value: 800 },
      qtyOnReceipts: { value: 300 },
      promised: { value: '2026-08-20' },
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
  })
})

describe('mapVismaOrders', () => {
  it('keeps ordered and received as two separate numbers', () => {
    const { orders } = mapVismaOrders([order()], OURS)
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      externalId: '500001-1',
      sku: 'PANPIZPRO',
      quantity: 800,
      receivedQuantity: 300,
    })
  })

  it('prefers the line promise over the order promise', () => {
    const { orders } = mapVismaOrders([order()], OURS)
    expect(orders[0].eta).toEqual(new Date('2026-08-20T00:00:00Z'))
  })

  it('falls back to the order promise when the line has none', () => {
    const o = order()
    o.lines![0].promised = null
    expect(mapVismaOrders([o], OURS).orders[0].eta).toEqual(new Date('2026-09-01T00:00:00Z'))
  })

  it('leaves eta null when nobody promised anything, so it moves no date', () => {
    const o = order({ promisedOn: null })
    o.lines![0].promised = null
    expect(mapVismaOrders([o], OURS).orders[0].eta).toBeNull()
  })

  it('does not mark an order received while units are outstanding', () => {
    expect(mapVismaOrders([order()], OURS).orders[0].receivedAt).toBeNull()
  })

  it('marks it received once nothing is outstanding, using Visma"s own date', () => {
    const o = order()
    o.lines![0].qtyOnReceipts = { value: 800 }
    const row = mapVismaOrders([o], OURS).orders[0]
    expect(row.receivedAt).toEqual(new Date('2026-07-15T09:00:00Z'))
  })

  it('marks an over-receipt received too', () => {
    const o = order()
    o.lines![0].qtyOnReceipts = { value: 900 }
    expect(mapVismaOrders([o], OURS).orders[0].receivedAt).not.toBeNull()
  })

  it('skips a cancelled order and counts it', () => {
    const { orders, skipped } = mapVismaOrders([order({ status: { value: 'Cancelled' } })], OURS)
    expect(orders).toHaveLength(0)
    expect(skipped).toContainEqual({ reason: 'cancelled order', count: 1 })
  })

  it('skips a cancelled line but keeps its siblings', () => {
    const o = order()
    o.lines!.push({
      lineNbr: 2,
      inventory: { number: { value: 'PANPRIMIXPRO' } },
      orderQty: { value: 100 },
      qtyOnReceipts: { value: 0 },
      canceled: { value: true },
    })
    const { orders, skipped } = mapVismaOrders([o], OURS)
    expect(orders.map((r) => r.sku)).toEqual(['PANPIZPRO'])
    expect(skipped).toContainEqual({ reason: 'cancelled line', count: 1 })
  })

  it('skips a product that is not ours, and says so rather than going quiet', () => {
    const o = order()
    o.lines![0].inventory = { number: { value: 'COSORI-AF-500' } }
    const { orders, skipped, read } = mapVismaOrders([o], OURS)
    expect(orders).toHaveLength(0)
    expect(read).toBe(1)
    expect(skipped).toContainEqual({ reason: 'not our product', count: 1 })
  })

  it('matches a SKU case-insensitively and ignores surrounding space', () => {
    const o = order()
    o.lines![0].inventory = { number: '  panpizpro ' }
    expect(mapVismaOrders([o], OURS).orders[0].sku).toBe('PANPIZPRO')
  })

  it('skips a line with no quantity or no product rather than storing a zero-unit order', () => {
    const o = order()
    o.lines = [{ lineNbr: 1, inventory: { number: { value: 'PANPIZPRO' } }, orderQty: { value: 0 } }]
    const { orders, skipped } = mapVismaOrders([o], OURS)
    expect(orders).toHaveLength(0)
    expect(skipped).toContainEqual({ reason: 'unusable line', count: 1 })
  })

  it('skips an order with no usable date rather than inventing one', () => {
    const { orders } = mapVismaOrders([order({ date: null })], OURS)
    expect(orders).toHaveLength(0)
  })

  it('reads the recorded order without throwing', () => {
    const result = mapVismaOrders([fixture as VismaOrder], new Set())
    expect(result.read).toBeGreaterThan(0)
    expect(result.orders).toHaveLength(0) // no SKUs supplied, so nothing is ours
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/visma/purchase-orders.test.ts`
Expected: FAIL — `Failed to resolve import "./purchase-orders"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/visma/types.ts` holding exactly the two wire types from the Interfaces block above — `VismaOrderLine` and `VismaOrder`, copied verbatim. They describe what Visma sends, so they live apart from the mapper that interprets it. The remaining types (`MappedOrder`, `SkipReason`, `MapResult`) are ours and belong in `purchase-orders.ts`:

```ts
import { normaliseSku } from '../inventory/sku'
import type { VismaOrder, VismaOrderLine } from './types'

export type { VismaOrder, VismaOrderLine } from './types'

export type MappedOrder = {
  externalId: string
  sku: string
  /** What was ordered. Never the outstanding amount — see the design doc. */
  quantity: number
  /** What has landed. Subtracted from `quantity` at the one place that counts arrivals. */
  receivedQuantity: number
  orderedAt: Date
  eta: Date | null
  receivedAt: Date | null
}

export type SkipReason = 'cancelled order' | 'cancelled line' | 'not our product' | 'unusable line'

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
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw
}

const date = (v: unknown): Date | null => {
  const raw = unwrap<string>(v)
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

const truthy = (v: unknown): boolean => unwrap<boolean>(v) === true

/**
 * Visma purchase orders, as rows we can store.
 *
 * One line becomes one row. `quantity` is always what was ordered and
 * `receivedQuantity` always what has landed, because a single column holding
 * "outstanding" would read as zero on a finished order and the page could never
 * show what arrived. The subtraction happens once, in load.ts, where arrivals
 * are counted.
 *
 * Every skip is counted with its reason. A line dropped silently because its SKU
 * did not match is indistinguishable from a line that never existed, and that is
 * exactly how a missing purchase order goes unnoticed.
 */
export function mapVismaOrders(orders: VismaOrder[], ourSkus: Set<string>): MapResult {
  const wanted = new Set([...ourSkus].map((s) => normaliseSku(s)))
  const out: MappedOrder[] = []
  const counts = new Map<SkipReason, number>()
  let read = 0

  const skip = (reason: SkipReason) => counts.set(reason, (counts.get(reason) ?? 0) + 1)

  for (const order of orders) {
    const lines = order.lines ?? []
    read += lines.length

    const status = String(unwrap<string>(order.status) ?? '').toLowerCase()
    if (status === 'cancelled' || status === 'canceled') {
      for (const _ of lines) skip('cancelled order')
      continue
    }

    const orderedAt = date(order.date)
    const orderNbr = unwrap<string | number>(order.orderNbr)
    // No order date means no honest orderedAt, and orderedAt is not nullable.
    if (!orderedAt || orderNbr === null) {
      for (const _ of lines) skip('unusable line')
      continue
    }

    const orderEta = date(order.promisedOn)
    const modified = date(order.lastModifiedDateTime)

    for (const line of lines as VismaOrderLine[]) {
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

      const received = Math.max(0, num(line.qtyOnReceipts) ?? 0)
      const complete = received >= ordered

      out.push({
        externalId: `${orderNbr}-${lineNbr}`,
        sku,
        quantity: ordered,
        receivedQuantity: received,
        orderedAt,
        // The line's own promise beats the order's: a container of two products
        // can land on two different days.
        eta: date(line.promised) ?? orderEta,
        // Visma's date or nothing. Stamping the clock would record a delivery
        // from years ago as having arrived today.
        receivedAt: complete ? modified : null,
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

**If Task 1 found a real receipt/completion date**, replace `date(order.lastModifiedDateTime)` with that field and update the comment. Everything else stands.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/visma/purchase-orders.test.ts`
Expected: PASS. If the fixture case fails, the fixture is shaped differently than assumed — fix the mapper to match the real data, never the fixture to match the mapper.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add src/lib/visma/types.ts src/lib/visma/purchase-orders.ts src/lib/visma/purchase-orders.test.ts
git commit -m "feat(visma): map an order to rows, and count every skip out loud"
```

---

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

- [ ] **Step 2: Push it to the local database**

Run: `npm run db:push`
Expected: succeeds. If it reports the unique index cannot be created, some row already holds a duplicate non-null `externalId` — stop and report; nothing writes that column yet, so a duplicate means something unexpected.

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
- Consumes: `vismaCredentials`, `vismaGet` (Task 2); `mapVismaOrders` (Task 3); `receivedQuantity`, unique `externalId` (Task 4).
- Produces:
  ```ts
  export type VismaImportResult = {
    configured: boolean
    read: number
    imported: number
    skipped: { reason: string; count: number }[]
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

const vismaOrder = (qtyOnReceipts: number) => ({
  orderNbr: TAG,
  status: { value: 'Open' },
  date: { value: '2026-06-01' },
  promisedOn: { value: '2026-09-01' },
  lastModifiedDateTime: { value: '2026-07-15T09:00:00Z' },
  lines: [
    {
      lineNbr: 1,
      inventory: { number: { value: SKU } },
      orderQty: { value: 800 },
      qtyOnReceipts: { value: qtyOnReceipts },
      promised: { value: '2026-08-20' },
      canceled: false,
    },
  ],
})

const stubVisma = (orders: unknown[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('connect/token')
        ? json({ access_token: 'tok', expires_in: 3600 })
        : json(orders),
    ),
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
    stubVisma([vismaOrder(300)])

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

  it('re-running changes nothing, because the import is keyed on Visma"s own id', async () => {
    stubVisma([vismaOrder(300)])
    await importVismaPurchaseOrders()
    await importVismaPurchaseOrders()

    expect(await db.purchaseOrder.count({ where: { item: { sku: SKU } } })).toBe(1)
  })

  it('moves the received figure when more units land', async () => {
    stubVisma([vismaOrder(300)])
    await importVismaPurchaseOrders()

    vi.unstubAllGlobals()
    resetVismaTokenCache()
    stubVisma([vismaOrder(800)])
    await importVismaPurchaseOrders()

    const row = await db.purchaseOrder.findFirst({ where: { item: { sku: SKU } } })
    expect(row!.receivedQuantity).toBe(800)
    expect(row!.receivedAt).toEqual(new Date('2026-07-15T09:00:00Z'))
  })

  it('never touches a hand-entered row', async () => {
    const item = await db.supplyItem.findFirstOrThrow({ where: { sku: SKU } })
    const mine = await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 42, orderedAt: new Date('2026-01-01T00:00:00Z') },
    })
    stubVisma([vismaOrder(300)])

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

  it('counts a line for a product we do not sell', async () => {
    const foreign = vismaOrder(0)
    foreign.lines[0].inventory = { number: { value: 'COSORI-NOT-OURS' } }
    stubVisma([foreign])

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(0)
    expect(result.skipped).toContainEqual({ reason: 'not our product', count: 1 })
  })

  it('says so when the page came back full, rather than reporting a clean run', async () => {
    // A full page means orders past it were dropped, which otherwise looks
    // exactly like a company that has no more of them. Foreign SKUs so the test
    // costs 500 map operations rather than 500 writes.
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => {
      const o = vismaOrder(0)
      o.orderNbr = `${TAG}-${i}`
      o.lines[0].inventory = { number: { value: 'COSORI-NOT-OURS' } }
      return o
    })
    stubVisma(full)

    expect((await importVismaPurchaseOrders()).truncated).toBe(true)
  })

  it('does not claim truncation on a normal page', async () => {
    stubVisma([vismaOrder(300)])
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
import { mapVismaOrders } from './purchase-orders'
import type { VismaOrder } from './types'

/**
 * One page, wide. The company holds a few hundred purchase orders in total, so
 * this fetches all of them and the import stays a single request.
 *
 * If Visma ever returns exactly this many, the page is full and orders beyond it
 * were silently dropped — which would look identical to a company that simply
 * has no more. That case reports itself rather than going quiet; see `truncated`
 * below. The fix when it fires is paging, not a bigger number.
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

    const items = await db.supplyItem.findMany({ select: { id: true, sku: true } })
    // normaliseSku, not a hand-rolled trim/uppercase: the mapper keys on it too,
    // and two spellings of "the same SKU" would fail to join for no visible reason.
    const idBySku = new Map(items.map((i) => [normaliseSku(i.sku), i.id]))

    const mapped = mapVismaOrders(rows, new Set(idBySku.keys()))

    let imported = 0
    for (const row of mapped.orders) {
      const supplyItemId = idBySku.get(row.sku)
      // mapVismaOrders already filtered to our SKUs, so this cannot normally miss.
      if (!supplyItemId) continue

      await db.purchaseOrder.upsert({
        where: { externalId: row.externalId },
        create: {
          externalId: row.externalId,
          supplyItemId,
          quantity: row.quantity,
          receivedQuantity: row.receivedQuantity,
          orderedAt: row.orderedAt,
          eta: row.eta,
          receivedAt: row.receivedAt,
        },
        // Notes are deliberately absent: someone may have written one here, and
        // Visma has no opinion about it.
        update: {
          supplyItemId,
          quantity: row.quantity,
          receivedQuantity: row.receivedQuantity,
          orderedAt: row.orderedAt,
          eta: row.eta,
          receivedAt: row.receivedAt,
        },
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
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must be feat/visma-purchase-orders
git add src/lib/visma/import.ts src/lib/visma/import.test.ts
git commit -m "feat(visma): import purchase orders, idempotently, without touching typed rows"
```

---

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

- [ ] **Step 3: Run the sync route's existing tests**

Run: `npx vitest run src/app/api/cron --testTimeout=20000`
Expected: PASS. Unconfigured credentials mean the import is skipped, so nothing existing changes.

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
  if (o.receivedQuantity === 0) return `${o.quantity} ordered · none landed yet`
  if (outstanding === 0) return `${o.quantity} ordered · all landed`
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
                    <span className="text-muted">received {when(o.receivedAt)}</span>
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
