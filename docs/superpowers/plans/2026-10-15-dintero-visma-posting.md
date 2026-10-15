# Dintero → Visma Posting (Test Company) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post each Dintero payout into the Visma **test** company exactly as the bookkeeper's drawing says (one payment per open invoice, one bank/fee/clearing entry per payout), with a dry-run mode, a per-shop account mapping, and a Visma status per payout in Panetti.

**Architecture:** A pure planner turns a payout + its report lines + the customer's open Visma invoices into documents. A runner, called once per cron tick, picks one Ready payout, records every document in the database *before* sending it, and posts through a write client that can only reach the test tenant. Everything is created **on hold** (the app has no `update` scope, so nothing can be released).

**Tech Stack:** Next.js (App Router, read `node_modules/next/dist/docs/` before touching routes), Prisma 6 + PostgreSQL, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-03-visma-payout-posting-design.md` (revised 2026-10-15). Read it first.

## Global Constraints

- Writes go **only** to tenant `08058ec7-a375-11ec-b60b-0638767d04b5` (Test LEDENDE TEKNOLOGI AS). The real tenant `83949a19-af32-11ec-b60b-0638767d04b5` is refused in code, even though production's `VISMA_TENANT_ID` is the real one. (Deviation from the spec's `VISMA_WRITE_TENANT_ID` env setting: the test tenant is a constant, because only Philip can set Vercel env vars and a tenant id is not a secret. Going live is a later, separate change.)
- The write token asks for exactly `vismanet_erp_service_api:read vismanet_erp_service_api:create`. Never `update` (deactivated; asking for it fails the whole token request). The read token used by the live imports is never changed.
- Every document is created with `hold: true`.
- Start date: payouts with `settledAt >= 2026-09-30T22:00:00.000Z` (1 Oct 2026 00:00 Europe/Oslo).
- Payment method `5`. `paymentRef` = `Payout.reference`. Date = `Payout.settledAt` as an Oslo calendar day, sent as `YYYY-MM-DDT00:00:00`.
- Request bodies wrap every scalar as `{ "value": x }`; array rows carry `operation: "Insert"`. Field names below are copied from Visma's OpenAPI document (`https://api.finance.visma.net/API-index/doc/swagger`, downloaded 2026-10-15): `PaymentUpdateDto`, `PaymentLinesUpdateDto`, `JournalTransactionUpdateDto`, `JournalTransactionLineUpdateDto`.
- Amounts are minor units (`Int`) everywhere in our code; converted to decimals (`minor / 100`) only in the request body. All four currencies (EUR, DKK, SEK, NOK) have 2 decimals.
- No test may reach the live ERP: tests stub `fetch` or mock `@/lib/visma/*`.
- Tests run against the LOCAL Postgres (`.env` points at `127.0.0.1:5432`). Never point tests or `prisma db push` at Neon.
- Git: never `git stash`, `git checkout -- <file>`, `git reset --hard`, or `git restore` in this repo. Check `git branch --show-current` after each commit.
- One payout per cron run, at most 20 Visma calls per run.

## Review Focus

1. **A payout whose net is negative** (refunds bigger than captures): the bank line must flip to a credit, the entry must still balance. Test in Task 4.
2. **The same order captured in two report lines**: one payment for the summed capture, never two payments. Test in Task 4.
3. **An invoice whose open balance is lower than the capture** (partly paid, discount): pay the balance, never more. Test in Task 4.
4. **A timeout or 5xx right after a POST** (Visma may have created the document): the row stays `sending` and the next run asks Visma before sending again; a journal it cannot verify becomes `unconfirmed` and is never resent automatically. Test in Task 6.
5. **Production's `VISMA_TENANT_ID` is the real company**: the write path must still only ever use the test tenant. Test in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/visma/client.ts` (modify) | token cache per tenant + scope; export the API base |
| `src/lib/visma/write.ts` (create) | tenant constants, `writeCredentials`, tenant guard, `vismaPost` |
| `src/lib/visma/probe.ts` (modify) | new `test-company` step: proves token, tenant and host for the test company |
| `prisma/schema.prisma` (modify) | `VismaPostingConfig`, `VismaPosting`, `VismaPostingDocument`, 4 mapping columns on `DinteroConfig` |
| `src/lib/visma/posting/plan.ts` (create) | pure: payout → payments, skips, payout entry |
| `src/lib/visma/posting/dto.ts` (create) | pure: request bodies in Visma's shape |
| `src/lib/visma/posting/invoices.ts` (create) | reads: open invoices of a customer; "does our payment exist" |
| `src/lib/visma/posting/run.ts` (create) | picks a payout, records documents, posts, sets status |
| `src/lib/visma/posting/label.ts` (create) | pure: the Visma status text shown per payout |
| `src/app/api/cron/sync/route.ts` (modify) | calls `runVismaPosting` once per tick |
| `src/app/api/visma-posting/route.ts` (create) | admin GET/PUT: mode + per-shop mapping |
| `src/app/settings/payouts/VismaPostingCard.tsx` (create) | the settings card |
| `src/app/api/payouts/route.ts`, `[id]/route.ts`, `src/app/finance/payouts/PayoutsClient.tsx` (modify) | Visma column + documents in the detail |

---

### Task 1: Write client that can only reach the test company

**Files:**
- Modify: `src/lib/visma/client.ts:17-19,64-107`
- Create: `src/lib/visma/write.ts`
- Test: `src/lib/visma/write.test.ts`

**Interfaces:**
- Produces: `vismaToken(creds, now?, opts?, scope?)` (scope defaults to read); `VISMA_BASE`; from `write.ts`: `REAL_TENANT_ID`, `TEST_TENANT_ID`, `WRITE_SCOPE`, `writeCredentials(): VismaCredentials | null`, `assertWritableTenant(tenantId: string): void`, `numberFromLocation(l: string | null): string | null`, `vismaPost(creds, path, body, opts?): Promise<{ status: number; number: string | null }>`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/visma/write.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVismaTokenCache, vismaGet, VismaError } from './client'
import {
  assertWritableTenant,
  numberFromLocation,
  REAL_TENANT_ID,
  TEST_TENANT_ID,
  vismaPost,
  writeCredentials,
} from './write'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

beforeEach(() => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  // Production's value: the REAL company. The write path must ignore it.
  vi.stubEnv('VISMA_TENANT_ID', REAL_TENANT_ID)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('writeCredentials', () => {
  it('always names the test company, whatever VISMA_TENANT_ID says', () => {
    expect(writeCredentials()).toEqual({ clientId: 'cid', clientSecret: 'sec', tenantId: TEST_TENANT_ID })
  })
  it('is null when the credentials are missing', () => {
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    expect(writeCredentials()).toBeNull()
  })
})

describe('assertWritableTenant', () => {
  it('refuses the real company', () => {
    expect(() => assertWritableTenant(REAL_TENANT_ID)).toThrow(/real Visma company/)
    expect(() => assertWritableTenant(REAL_TENANT_ID.toUpperCase())).toThrow(/real Visma company/)
  })
  it('refuses any company that is not the test one', () => {
    expect(() => assertWritableTenant('00000000-0000-0000-0000-000000000000')).toThrow(/unknown Visma company/)
  })
  it('allows the test company', () => {
    expect(() => assertWritableTenant(TEST_TENANT_ID)).not.toThrow()
  })
})

describe('numberFromLocation', () => {
  it('takes the last path segment', () => {
    expect(numberFromLocation('https://api.finance.visma.net/v1/customerPayment/000123')).toBe('000123')
    expect(numberFromLocation('https://x/v2/journaltransaction/GL0042/')).toBe('GL0042')
    expect(numberFromLocation(null)).toBeNull()
  })
})

describe('vismaPost', () => {
  it('never calls fetch for the real company', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      vismaPost({ clientId: 'cid', clientSecret: 'sec', tenantId: REAL_TENANT_ID }, 'controller/api/v1/customerPayment', {}),
    ).rejects.toThrow(/real Visma company/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks for read+create on the test tenant, posts JSON to the new host, returns the number', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), init })
        if (String(url).includes('connect/token')) return json({ access_token: 'wtok', expires_in: 3600 })
        return json({}, 201, { Location: 'https://api.finance.visma.net/v1/customerPayment/000777' })
      }),
    )
    const made = await vismaPost(writeCredentials()!, 'controller/api/v1/customerPayment', { hold: { value: true } })
    expect(made).toEqual({ status: 201, number: '000777' })

    const token = String(seen[0].init?.body)
    expect(token).toContain(`tenant_id=${TEST_TENANT_ID}`)
    expect(token).toContain('scope=vismanet_erp_service_api%3Aread+vismanet_erp_service_api%3Acreate')
    expect(token).not.toContain('update')

    expect(seen[1].url).toBe('https://api.finance.visma.net/v1/customerPayment')
    expect(seen[1].init?.method).toBe('POST')
    expect((seen[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer wtok')
    expect(JSON.parse(String(seen[1].init?.body))).toEqual({ hold: { value: true } })
  })

  it('throws a VismaError carrying the status on a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token')
          ? json({ access_token: 'wtok', expires_in: 3600 })
          : new Response('{"message":"Customer 10859 not found"}', { status: 400 }),
      ),
    )
    const err = await vismaPost(writeCredentials()!, 'controller/api/v1/customerPayment', {}).catch((e) => e)
    expect(err).toBeInstanceOf(VismaError)
    expect(err.status).toBe(400)
    expect(err.message).toContain('Customer 10859 not found')
  })
})

describe('token cache', () => {
  it('keeps the read token and the write token apart', async () => {
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('connect/token')) {
          bodies.push(String(init?.body))
          return json({ access_token: `t${bodies.length}`, expires_in: 3600 })
        }
        return json([], 201)
      }),
    )
    const creds = writeCredentials()!
    await vismaGet(creds, 'controller/api/v1/customer')
    await vismaPost(creds, 'controller/api/v1/customerPayment', {})
    await vismaGet(creds, 'controller/api/v1/customer')
    // One mint per scope: the second GET reuses the read token.
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).not.toContain('create')
    expect(bodies[1]).toContain('create')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/visma/write.test.ts`
Expected: FAIL, `Cannot find module './write'` (or `vismaGet` import errors).

- [ ] **Step 3: Change the token cache in `client.ts`**

Replace the line `const BASE = 'https://api.finance.visma.net'` with:

```ts
const BASE = 'https://api.finance.visma.net'
/** The API host, for the write client in ./write.ts. */
export const VISMA_BASE = BASE
```

Replace the block from `let cached: ...` down to the end of `vismaToken` (lines 64-107) with:

```ts
/**
 * One token per client, tenant and scope. The read imports and the posting
 * job ask for different scopes, sometimes for different companies, in the
 * same run; a single slot would throw one away every time the other asked.
 */
let cached = new Map<string, { token: string; expiresAt: number }>()

/** Tests only. Module state would otherwise leak a token between cases. */
export function resetVismaTokenCache(): void {
  cached = new Map()
}

export async function vismaToken(
  creds: VismaCredentials,
  now: number = Date.now(),
  opts: VismaRequestOpts = {},
  scope: string = SCOPE,
): Promise<string> {
  // Keyed by client, tenant and scope so a change of any is never served a stale token.
  const key = `${creds.clientId}:${creds.tenantId}:${scope}`
  const hit = cached.get(key)
  if (hit && hit.expiresAt - RENEW_MARGIN_MS > now) return hit.token

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope,
      tenant_id: creds.tenantId,
    }),
    // Clamped like the GET below. A cold cache pays this mint FIRST, so a
    // clamp covering only the GET would leave the deadline honoured by the
    // second request and ignored by the one that always precedes it.
    signal: AbortSignal.timeout(vismaRequestBudgetMs(opts)),
  })

  if (!res.ok) {
    // Status only. The request body carried the secret, and an error that echoes
    // the request would put it in a log we do not control.
    throw new VismaError(`Visma refused the credentials (HTTP ${res.status})`)
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new VismaError('Visma returned no access token')

  cached.set(key, { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 })
  return body.access_token
}
```

- [ ] **Step 4: Create `src/lib/visma/write.ts`**

```ts
/**
 * Writing to Visma.net ERP - the TEST company only, by construction.
 *
 * Our app is connected to two companies (Developer Portal, 2026-10-15):
 * the real books, read only, and "Test LEDENDE TEKNOLOGI AS", read + create.
 * Visma itself refuses a write to the real books because that company never
 * accepted the create scope; this file refuses it a second time, before any
 * request leaves, so a mistake in our own code cannot reach the accountant's
 * ledger either. Moving to the real company is a deliberate code change after
 * the bookkeeper signs off, never a setting.
 *
 * The tenant is a constant rather than an env var: only Philip can set Vercel
 * variables, and a tenant id is an address, not a secret.
 */

import {
  vismaCredentials,
  vismaPath,
  vismaRequestBudgetMs,
  vismaToken,
  VismaError,
  VISMA_BASE,
  type VismaCredentials,
  type VismaRequestOpts,
} from './client'

export const REAL_TENANT_ID = '83949a19-af32-11ec-b60b-0638767d04b5'
export const TEST_TENANT_ID = '08058ec7-a375-11ec-b60b-0638767d04b5'

/** Exactly what the test company accepted. Asking for more fails the whole token request. */
export const WRITE_SCOPE = 'vismanet_erp_service_api:read vismanet_erp_service_api:create'

/** The app's client credentials, pointed at the test company whatever VISMA_TENANT_ID says. */
export function writeCredentials(): VismaCredentials | null {
  const base = vismaCredentials()
  if (!base) return null
  return { clientId: base.clientId, clientSecret: base.clientSecret, tenantId: TEST_TENANT_ID }
}

export function assertWritableTenant(tenantId: string): void {
  const t = tenantId.trim().toLowerCase()
  if (t === REAL_TENANT_ID) throw new VismaError('Refusing to write to the real Visma company')
  if (t !== TEST_TENANT_ID) throw new VismaError(`Refusing to write to an unknown Visma company (${tenantId})`)
}

/** The new document's number: the last segment of the 201's Location header. */
export function numberFromLocation(location: string | null): string | null {
  if (!location) return null
  const last = location.split('?')[0].replace(/\/+$/, '').split('/').pop()
  return last ? decodeURIComponent(last) : null
}

export type VismaCreated = { status: number; number: string | null }

export async function vismaPost(
  creds: VismaCredentials,
  path: string,
  body: unknown,
  opts: VismaRequestOpts = {},
): Promise<VismaCreated> {
  assertWritableTenant(creds.tenantId)
  const token = await vismaToken(creds, Date.now(), opts, WRITE_SCOPE)
  const res = await fetch(`${VISMA_BASE}/${vismaPath(path)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(vismaRequestBudgetMs(opts)),
  })
  if (!res.ok) {
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new VismaError(`Visma responded ${res.status} for POST ${path}: ${text}`, res.status)
  }
  return { status: res.status, number: numberFromLocation(res.headers.get('location')) }
}
```

- [ ] **Step 5: Run the new tests and the existing client tests**

Run: `npx vitest run src/lib/visma/write.test.ts src/lib/visma/client.test.ts`
Expected: all PASS. If a `client.test.ts` case asserted the old single-slot cache (e.g. "a second tenant evicts the first"), update it to the per-key behaviour; do not change any read-scope assertion.

- [ ] **Step 6: Commit**

```bash
git add src/lib/visma/client.ts src/lib/visma/write.ts src/lib/visma/write.test.ts src/lib/visma/client.test.ts
git commit -m "feat(visma): a write client that can only reach the test company"
git branch --show-current
```

---

### Task 2: Probe step that proves the test company answers

**Files:**
- Modify: `src/lib/visma/probe.ts:44-51,370-387,411-445`
- Test: `src/lib/visma/probe.test.ts` (append)

**Interfaces:**
- Consumes: `writeCredentials`, `TEST_TENANT_ID` (Task 1); `vismaGet`.
- Produces: `DiagnosticSnapshot` key `visma-probe:v1:test-company` with `{ tenant, customers: [{number,name,status}], cashAccounts: [{number,description,currency}] }` or `{ error }`.

- [ ] **Step 1: Write the failing test** (append to `probe.test.ts`)

```ts
describe('the test-company step', () => {
  it('reads customers and cash accounts with a token for the TEST tenant', async () => {
    // Everything else answered, and write-scope already granted, so only this step runs.
    for (const s of VISMA_PROBE_STEPS) {
      if (s.name === 'test-company') continue
      await db.diagnosticSnapshot.create({
        data: { key: probeKey(s.name), payload: s.name === 'write-scope' ? { granted: true } : { rows: 0 } },
      })
    }
    const tokenBodies: string[] = []
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url)
        if (u.includes('connect/token')) {
          tokenBodies.push(String(init?.body))
          return json({ access_token: 'tok', expires_in: 3600 })
        }
        urls.push(u)
        if (u.includes('/v1/customer?')) return json([{ number: '10000', name: 'Test Kunde Dataplan', status: 'Active' }])
        if (u.includes('/v1/cashaccount')) return json([{ number: '1940', description: 'Bankinnskudd EURO', currency: 'EUR' }])
        return json([])
      }),
    )

    const result = await runVismaProbe({ maxCalls: 2, pauseMs: 0 })
    expect(result.ran).toEqual(['test-company'])
    expect(tokenBodies.every((b) => b.includes('tenant_id=08058ec7-a375-11ec-b60b-0638767d04b5'))).toBe(true)
    expect(urls).toHaveLength(2)

    const stored = await db.diagnosticSnapshot.findUnique({ where: { key: probeKey('test-company') } })
    expect(stored?.payload).toEqual({
      tenant: '08058ec7-a375-11ec-b60b-0638767d04b5',
      customers: [{ number: '10000', name: 'Test Kunde Dataplan', status: 'Active' }],
      cashAccounts: [{ number: '1940', description: 'Bankinnskudd EURO', currency: 'EUR' }],
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/visma/probe.test.ts -t "test-company"`
Expected: FAIL, `ran` is `[]` (no such step).

- [ ] **Step 3: Implement**

In `probe.ts`, add to the imports:

```ts
import { TEST_TENANT_ID, writeCredentials } from './write'
```

Add `testGet` to `Ctx`:

```ts
type Ctx = {
  get: Get
  /** A GET against the TEST company (read scope). Throws when the credentials are missing. */
  testGet: Get
  stored: (step: string) => Promise<unknown>
  /** One token request with the given scopes, answered without the token. */
  scopeCheck: (scope: string) => Promise<VismaScopeAnswer>
}
```

Insert this step into `VISMA_PROBE_STEPS` **directly before** the `write-scope` step (write-scope must stay last; its tests rely on that):

```ts
  {
    // The test company ("Test LEDENDE TEKNOLOGI AS"), connected read + create
    // on 2026-10-15. Before anything is written there, prove the token, the
    // tenant and the API host answer for it. Expect customers 10000-10002.
    name: 'test-company',
    calls: 2,
    run: async ({ testGet }) => {
      const customers = rows(await testGet('controller/api/v1/customer?pageSize=50&pageNumber=1'))
      const cash = rows(await testGet('controller/api/v1/cashaccount'))
      return {
        tenant: TEST_TENANT_ID,
        customers: customers.map((c) => pick(c, ['number', 'name', 'status'])),
        cashAccounts: cash.map((a) => pick(a, ['number', 'description', 'currency'])),
      }
    },
  },
```

In `runVismaProbe`, after `const get: Get = ...`, add:

```ts
    const testCreds = writeCredentials()
    const testGet: Get = async (path) => {
      if (!testCreds) throw new Error('no Visma credentials for the test company')
      if (calls > 0 && pauseMs > 0) await pause(pauseMs)
      calls++
      return vismaGet<unknown>(testCreds, path, { deadline: opts.deadline })
    }
```

and change the step call to `await step.run({ get, testGet, stored, scopeCheck })`.

- [ ] **Step 4: Run all probe tests**

Run: `npx vitest run src/lib/visma/probe.test.ts`
Expected: all PASS. The "runs the steps in order" test computes `pending` from `VISMA_PROBE_STEPS`, so it follows the new step automatically.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visma/probe.ts src/lib/visma/probe.test.ts
git commit -m "feat(visma): probe the test company before anything is written there"
git branch --show-current
```

---

### Task 3: Database models

**Files:**
- Modify: `prisma/schema.prisma` (`DinteroConfig` ~line 1756, `Payout` ~line 1784, append new models after `PayoutLine`)

**Interfaces:**
- Produces: `db.vismaPostingConfig`, `db.vismaPosting` (unique `payoutId_tenantId`), `db.vismaPostingDocument` (unique `postingId_kind_key`), `DinteroConfig.vismaCustomer | vismaClearingAccount | vismaBankAccount | vismaFeeAccount: string | null`, `Payout.vismaPostings`.

- [ ] **Step 1: Edit the schema**

In `model DinteroConfig`, before `active Boolean`, add:

```prisma
  /// Where this shop's payouts go in Visma (bookkeeper's drawing). All four
  /// set = the shop is ready to post; any null = "no Visma setup".
  vismaCustomer        String? // webshop customer, e.g. 10859
  vismaClearingAccount String? // Dintero clearing cash account, e.g. 1509
  vismaBankAccount     String? // bank account the net lands on, e.g. 1940
  vismaFeeAccount      String? // Dintero fees, e.g. 7770
```

In `model Payout`, after `lines PayoutLine[]`, add:

```prisma
  vismaPostings VismaPosting[]
```

After `model PayoutLine { ... }`, add:

```prisma
/// Off until an admin picks a mode on /settings/payouts.
model VismaPostingConfig {
  id        String   @id @default("singleton")
  mode      String   @default("off") // off | dry_run | hold
  updatedAt DateTime @updatedAt
}

/// One payout's posting into one Visma company. Unique per company, so the
/// test company's run never blocks the real one later.
model VismaPosting {
  id        String    @id @default(cuid())
  payoutId  String
  tenantId  String
  status    String // dry_run | posting | posted | error
  matched   Int       @default(0)
  unmatched Int       @default(0)
  attempts  Int       @default(0)
  error     String?
  /// What the planner decided, for the dry run and for a person to read.
  preview   Json?
  postedAt  DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  payout    Payout                 @relation(fields: [payoutId], references: [id], onDelete: Cascade)
  documents VismaPostingDocument[]

  @@unique([payoutId, tenantId])
}

/// One document we send (or decided not to). Written BEFORE the POST, so a
/// crash between Visma's answer and ours is noticed and checked, never resent blind.
model VismaPostingDocument {
  id            String   @id @default(cuid())
  postingId     String
  kind          String // payment | payout
  key           String // order number (payment), payout id (payout)
  status        String // sending | sent | pending | skipped | error | unconfirmed
  reason        String?
  invoiceNumber String?
  vismaNumber   String?
  amount        Int?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  posting VismaPosting @relation(fields: [postingId], references: [id], onDelete: Cascade)

  @@unique([postingId, kind, key])
}
```

- [ ] **Step 2: Confirm the local database is the target, then push**

Run: `grep DATABASE_URL .env | sed 's/:[^:@]*@/:***@/'`
Expected: host `127.0.0.1`. If it is anything else, STOP.

Run: `npx prisma db push`
Expected: "Your database is now in sync with your Prisma schema" and the client regenerated.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): Visma posting state per payout and per document"
git branch --show-current
```

---

### Task 4: The planner and the request bodies (pure)

**Files:**
- Create: `src/lib/visma/posting/plan.ts`, `src/lib/visma/posting/dto.ts`
- Test: `src/lib/visma/posting/plan.test.ts`, `src/lib/visma/posting/dto.test.ts`

**Interfaces:**
- Produces:
  - `type PlanLine = { transactionId: string; reference2: string | null; capture: number }`
  - `type PlanPayout = { currency: string; amount: number; fee: number }`
  - `type PlanMapping = { customer: string; clearingAccount: string; bankAccount: string; feeAccount: string }`
  - `type OpenInvoice = { number: string; customerRefNumber: string; currency: string; balance: number }`
  - `type PlannedPayment = { key: string; invoiceNumber: string; amount: number }`
  - `type PlannedSkip = { key: string; reason: string }`
  - `type EntryLine = { account: string; debit: number; credit: number }`
  - `type PostingPlan = { payments: PlannedPayment[]; skipped: PlannedSkip[]; entry: EntryLine[] }`
  - `planPosting(payout: PlanPayout, lines: PlanLine[], invoices: OpenInvoice[], mapping: PlanMapping): PostingPlan`
  - `payoutEntry(payout: PlanPayout, mapping: PlanMapping): EntryLine[]`
  - from `dto.ts`: `decimal(minor: number): number`, `vismaDate(d: Date): string`, `paymentBody(i: PaymentInput): object`, `journalBody(i: JournalInput): object`

- [ ] **Step 1: Write the failing planner tests**

```ts
// src/lib/visma/posting/plan.test.ts
import { describe, expect, it } from 'vitest'
import { payoutEntry, planPosting, type OpenInvoice, type PlanLine } from './plan'

const DE = { customer: '10859', clearingAccount: '1509', bankAccount: '1940', feeAccount: '7770' }
const inv = (number: string, ref: string, balance: number, currency = 'EUR'): OpenInvoice => ({
  number, customerRefNumber: ref, currency, balance,
})
const line = (transactionId: string, reference2: string | null, capture: number): PlanLine => ({
  transactionId, reference2, capture,
})

describe('planPosting', () => {
  it('pays each order its capture against the one open invoice with that order number', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 19000, fee: 1000 },
      [line('t1', '14238', 12000), line('t2', '14239', 8000)],
      [inv('130474', '14238', 12000), inv('130475', '14239', 8000)],
      DE,
    )
    expect(plan.payments).toEqual([
      { key: '14238', invoiceNumber: '130474', amount: 12000 },
      { key: '14239', invoiceNumber: '130475', amount: 8000 },
    ])
    expect(plan.skipped).toEqual([])
  })

  it('sums an order captured in two lines into ONE payment', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 9000, fee: 1000 },
      [line('t1', '14238', 6000), line('t2', '14238', 4000)],
      [inv('130474', '14238', 10000)],
      DE,
    )
    expect(plan.payments).toEqual([{ key: '14238', invoiceNumber: '130474', amount: 10000 }])
  })

  it('never pays more than the invoice still owes', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 4999, fee: 0 },
      [line('t1', '13710', 4999)],
      [inv('129000', '13710', 4499)],
      DE,
    )
    expect(plan.payments).toEqual([{ key: '13710', invoiceNumber: '129000', amount: 4499 }])
  })

  it('skips an order with no open invoice, two open invoices, or no number at all', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 3000, fee: 0 },
      [line('t1', '1', 1000), line('t2', '2', 1000), line('t3', null, 1000), line('t4', '  ', 500)],
      [inv('A', '2', 1000), inv('B', '2', 1000)],
      DE,
    )
    expect(plan.payments).toEqual([])
    expect(plan.skipped).toEqual([
      { key: 'transaction t3', reason: 'no order number in the Dintero report' },
      { key: 'transaction t4', reason: 'no order number in the Dintero report' },
      { key: '1', reason: 'no open invoice' },
      { key: '2', reason: '2 open invoices for order 2' },
    ])
  })

  it('ignores invoices in another currency, fully paid ones, and refund-only lines', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: -500, fee: 0 },
      [line('t1', '7', 0), line('t2', '8', 1000)],
      [inv('X', '8', 1000, 'NOK'), inv('Y', '8', 0)],
      DE,
    )
    expect(plan.payments).toEqual([])
    expect(plan.skipped).toEqual([{ key: '8', reason: 'no open invoice' }])
  })

  it('matches order numbers with stray spaces on either side', () => {
    const plan = planPosting(
      { currency: 'EUR', amount: 1000, fee: 0 },
      [line('t1', ' 14238 ', 1000)],
      [inv('130474', '14238 ', 1000)],
      DE,
    )
    expect(plan.payments).toEqual([{ key: '14238', invoiceNumber: '130474', amount: 1000 }])
  })
})

describe('payoutEntry', () => {
  it('is the drawing: debit bank = net, debit fees = fee, credit clearing = net + fee', () => {
    expect(payoutEntry({ currency: 'DKK', amount: 7262172, fee: 52528 }, DE)).toEqual([
      { account: '1940', debit: 7262172, credit: 0 },
      { account: '7770', debit: 52528, credit: 0 },
      { account: '1509', debit: 0, credit: 7314700 },
    ])
  })

  it('leaves out a zero fee line', () => {
    expect(payoutEntry({ currency: 'EUR', amount: 1000, fee: 0 }, DE)).toEqual([
      { account: '1940', debit: 1000, credit: 0 },
      { account: '1509', debit: 0, credit: 1000 },
    ])
  })

  it('flips sides when refunds made the net negative, and still balances', () => {
    const lines = payoutEntry({ currency: 'EUR', amount: -3000, fee: 200 }, DE)
    expect(lines).toEqual([
      { account: '1940', debit: 0, credit: 3000 },
      { account: '7770', debit: 200, credit: 0 },
      { account: '1509', debit: 2800, credit: 0 },
    ])
    const debit = lines.reduce((s, l) => s + l.debit, 0)
    const credit = lines.reduce((s, l) => s + l.credit, 0)
    expect(debit).toBe(credit)
  })

  it('is empty when there is nothing to book', () => {
    expect(payoutEntry({ currency: 'EUR', amount: 0, fee: 0 }, DE)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/visma/posting/plan.test.ts`
Expected: FAIL, `Cannot find module './plan'`.

- [ ] **Step 3: Implement `plan.ts`**

```ts
/**
 * What one Dintero payout becomes in Visma, per the bookkeeper's drawing
 * (docs/superpowers/specs/2026-09-03-visma-payout-posting-design.md).
 * Pure: no database, no network. Amounts are minor units throughout.
 *
 * Branch A: each order's capture pays the ONE open invoice of the shop's
 * webshop customer whose Customer order no. is the Dintero event_reference,
 * never more than the invoice still owes. Anything else is skipped with a
 * reason, and the bookkeeper follows it up.
 * Branch B: one entry per payout - debit bank = net, debit fees = fee,
 * credit clearing = net + fee (the drawing's "Capture" whenever there is no
 * refund, and always balanced).
 */

export type PlanLine = { transactionId: string; reference2: string | null; capture: number }
export type PlanPayout = { currency: string; amount: number; fee: number }
export type PlanMapping = { customer: string; clearingAccount: string; bankAccount: string; feeAccount: string }
export type OpenInvoice = { number: string; customerRefNumber: string; currency: string; balance: number }
export type PlannedPayment = { key: string; invoiceNumber: string; amount: number }
export type PlannedSkip = { key: string; reason: string }
export type EntryLine = { account: string; debit: number; credit: number }
export type PostingPlan = { payments: PlannedPayment[]; skipped: PlannedSkip[]; entry: EntryLine[] }

export function planPosting(
  payout: PlanPayout,
  lines: PlanLine[],
  invoices: OpenInvoice[],
  mapping: PlanMapping,
): PostingPlan {
  const skipped: PlannedSkip[] = []
  // One order can be captured in more than one report line; it is still one invoice.
  const captureByOrder = new Map<string, number>()
  for (const l of lines) {
    if (l.capture <= 0) continue
    const key = (l.reference2 ?? '').trim()
    if (!key) {
      skipped.push({ key: `transaction ${l.transactionId}`, reason: 'no order number in the Dintero report' })
      continue
    }
    captureByOrder.set(key, (captureByOrder.get(key) ?? 0) + l.capture)
  }

  const payments: PlannedPayment[] = []
  for (const [key, capture] of captureByOrder) {
    const open = invoices.filter(
      (i) => i.customerRefNumber.trim() === key && i.currency === payout.currency && i.balance > 0,
    )
    if (open.length === 0) {
      skipped.push({ key, reason: 'no open invoice' })
      continue
    }
    if (open.length > 1) {
      // Paying the wrong one is worse than paying none.
      skipped.push({ key, reason: `${open.length} open invoices for order ${key}` })
      continue
    }
    payments.push({ key, invoiceNumber: open[0].number, amount: Math.min(capture, open[0].balance) })
  }

  return { payments, skipped, entry: payoutEntry(payout, mapping) }
}

export function payoutEntry(payout: PlanPayout, mapping: PlanMapping): EntryLine[] {
  // A signed amount on the debit side; a negative one is booked as a credit.
  const side = (account: string, signed: number): EntryLine =>
    signed >= 0 ? { account, debit: signed, credit: 0 } : { account, debit: 0, credit: -signed }
  return [
    side(mapping.bankAccount, payout.amount),
    side(mapping.feeAccount, payout.fee),
    side(mapping.clearingAccount, -(payout.amount + payout.fee)),
  ].filter((l) => l.debit !== 0 || l.credit !== 0)
}
```

- [ ] **Step 4: Run planner tests**

Run: `npx vitest run src/lib/visma/posting/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing dto tests**

```ts
// src/lib/visma/posting/dto.test.ts
import { describe, expect, it } from 'vitest'
import { decimal, journalBody, paymentBody, vismaDate } from './dto'

describe('decimal and vismaDate', () => {
  it('converts minor units without float noise', () => {
    expect(decimal(7314700)).toBe(73147)
    expect(decimal(52528)).toBe(525.28)
    expect(decimal(1)).toBe(0.01)
  })
  it('sends the Oslo calendar day', () => {
    // 23:30 UTC on 30 Sep is 1 Oct in Oslo.
    expect(vismaDate(new Date('2026-09-30T23:30:00Z'))).toBe('2026-10-01T00:00:00')
  })
})

describe('paymentBody', () => {
  it('is one on-hold Payment with one Invoice line, in Visma field names', () => {
    expect(
      paymentBody({
        customer: '10859', clearingAccount: '1509', currency: 'EUR', reference: 'R17882-6311A9',
        date: new Date('2026-10-06T10:00:00Z'), key: '14238', invoiceNumber: '130474', amount: 299900,
      }),
    ).toEqual({
      type: { value: 'Payment' },
      hold: { value: true },
      applicationDate: { value: '2026-10-06T00:00:00' },
      paymentRef: { value: 'R17882-6311A9' },
      customer: { value: '10859' },
      paymentMethod: { value: '5' },
      cashAccount: { value: '1509' },
      currency: { value: 'EUR' },
      paymentAmount: { value: 2999 },
      invoiceText: { value: 'Dintero R17882-6311A9 order 14238' },
      paymentLines: [
        { operation: 'Insert', documentType: { value: 'Invoice' }, refNbr: { value: '130474' }, amountPaid: { value: 2999 } },
      ],
    })
  })
  it('keeps invoiceText within 50 characters', () => {
    const body = paymentBody({
      customer: '1', clearingAccount: '1509', currency: 'EUR', reference: 'R'.repeat(40),
      date: new Date('2026-10-06T10:00:00Z'), key: '123456789', invoiceNumber: '1', amount: 1,
    }) as { invoiceText: { value: string } }
    expect(body.invoiceText.value.length).toBeLessThanOrEqual(50)
  })
})

describe('journalBody', () => {
  it('is one on-hold journal with numbered lines in the payout currency', () => {
    expect(
      journalBody({
        currency: 'DKK', reference: 'R17882-6311A9', date: new Date('2026-09-01T08:00:00Z'),
        lines: [
          { account: '1960', debit: 7262172, credit: 0 },
          { account: '7770', debit: 52528, credit: 0 },
          { account: '1512', debit: 0, credit: 7314700 },
        ],
      }),
    ).toEqual({
      hold: { value: true },
      transactionDate: { value: '2026-09-01T00:00:00' },
      currencyId: { value: 'DKK' },
      description: { value: 'Dintero R17882-6311A9' },
      journalTransactionLines: [
        { operation: 'Insert', lineNumber: { value: 1 }, accountNumber: { value: '1960' }, referenceNumber: { value: 'R17882-6311A9' }, transactionDescription: { value: 'Dintero R17882-6311A9' }, debitAmountInCurrency: { value: 72621.72 }, creditAmountInCurrency: { value: 0 } },
        { operation: 'Insert', lineNumber: { value: 2 }, accountNumber: { value: '7770' }, referenceNumber: { value: 'R17882-6311A9' }, transactionDescription: { value: 'Dintero R17882-6311A9' }, debitAmountInCurrency: { value: 525.28 }, creditAmountInCurrency: { value: 0 } },
        { operation: 'Insert', lineNumber: { value: 3 }, accountNumber: { value: '1512' }, referenceNumber: { value: 'R17882-6311A9' }, transactionDescription: { value: 'Dintero R17882-6311A9' }, debitAmountInCurrency: { value: 0 }, creditAmountInCurrency: { value: 73147 } },
      ],
    })
  })
})
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/lib/visma/posting/dto.test.ts`
Expected: FAIL, `Cannot find module './dto'`.

- [ ] **Step 7: Implement `dto.ts`**

```ts
/**
 * Request bodies in Visma's own shape: every scalar wrapped as { value },
 * every array row with operation "Insert". Field names are copied from the
 * OpenAPI document (PaymentUpdateDto, PaymentLinesUpdateDto,
 * JournalTransactionUpdateDto, JournalTransactionLineUpdateDto). Pure.
 */

import { zonedDayStr } from '../../tz'
import type { EntryLine } from './plan'

const v = <T>(value: T) => ({ value })

/** Minor units to the decimal Visma wants. All four payout currencies have 2 decimals. */
export const decimal = (minor: number): number => Math.round(minor) / 100

/** The Oslo calendar day of an instant, as Visma writes dates. */
export const vismaDate = (d: Date): string => `${zonedDayStr(d, 'Europe/Oslo')}T00:00:00`

export type PaymentInput = {
  customer: string
  clearingAccount: string
  currency: string
  reference: string
  date: Date
  key: string
  invoiceNumber: string
  amount: number
}

export function paymentBody(i: PaymentInput): object {
  return {
    type: v('Payment'),
    hold: v(true),
    applicationDate: v(vismaDate(i.date)),
    paymentRef: v(i.reference),
    customer: v(i.customer),
    paymentMethod: v('5'),
    cashAccount: v(i.clearingAccount),
    currency: v(i.currency),
    paymentAmount: v(decimal(i.amount)),
    invoiceText: v(`Dintero ${i.reference} order ${i.key}`.slice(0, 50)),
    paymentLines: [
      { operation: 'Insert', documentType: v('Invoice'), refNbr: v(i.invoiceNumber), amountPaid: v(decimal(i.amount)) },
    ],
  }
}

export type JournalInput = { currency: string; reference: string; date: Date; lines: EntryLine[] }

export function journalBody(i: JournalInput): object {
  const text = `Dintero ${i.reference}`.slice(0, 50)
  return {
    hold: v(true),
    transactionDate: v(vismaDate(i.date)),
    currencyId: v(i.currency),
    description: v(text),
    journalTransactionLines: i.lines.map((l, n) => ({
      operation: 'Insert',
      lineNumber: v(n + 1),
      accountNumber: v(l.account),
      referenceNumber: v(i.reference),
      transactionDescription: v(text),
      debitAmountInCurrency: v(decimal(l.debit)),
      creditAmountInCurrency: v(decimal(l.credit)),
    })),
  }
}
```

- [ ] **Step 8: Run both test files**

Run: `npx vitest run src/lib/visma/posting/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/visma/posting/plan.ts src/lib/visma/posting/plan.test.ts src/lib/visma/posting/dto.ts src/lib/visma/posting/dto.test.ts
git commit -m "feat(visma): plan a payout into invoice payments and one payout entry"
git branch --show-current
```

---

### Task 5: Reading open invoices and finding our own payment

**Files:**
- Create: `src/lib/visma/posting/invoices.ts`
- Test: `src/lib/visma/posting/invoices.test.ts`

**Interfaces:**
- Consumes: `vismaGet`, `VismaCredentials`, `VismaRequestOpts` (client); `unwrap` (`../purchase-orders`); `OpenInvoice` (Task 4).
- Produces: `readOpenInvoices(creds, customer, opts?): Promise<{ invoices: OpenInvoice[]; calls: number }>`; `findOurPayment(creds, customer, invoiceNumber, reference, opts?): Promise<string | null>` (the payment's `refNbr`, or null).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/visma/posting/invoices.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVismaTokenCache } from '../client'
import { TEST_TENANT_ID } from '../write'
import { findOurPayment, readOpenInvoices } from './invoices'

const creds = { clientId: 'cid', clientSecret: 'sec', tenantId: TEST_TENANT_ID }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

const row = (n: number, over: Record<string, unknown> = {}) => ({
  referenceNumber: { value: String(130000 + n) },
  customer: { number: '10859', name: 'Panetti Deutschland - Webkunde' },
  status: 'Open',
  currencyId: 'EUR',
  balanceInCurrency: 29.99,
  customerRefNumber: String(14000 + n),
  ...over,
})

beforeEach(() => resetVismaTokenCache())
afterEach(() => vi.unstubAllGlobals())

describe('readOpenInvoices', () => {
  it('pages until a short page, and keeps only open invoices of THAT customer', async () => {
    const urls: string[] = []
    const page1 = Array.from({ length: 100 }, (_, i) => row(i))
    const page2 = [row(100), row(101, { status: 'Closed' }), row(102, { customer: { number: '99999' } })]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('connect/token')) return json({ access_token: 't', expires_in: 3600 })
        urls.push(u)
        return json(u.includes('pageNumber=1') ? page1 : page2)
      }),
    )
    const { invoices, calls } = await readOpenInvoices(creds, '10859')
    expect(calls).toBe(2)
    expect(urls[0]).toContain('/v1/customerinvoice?customer=10859&status=Open&pageSize=100&pageNumber=1')
    expect(invoices).toHaveLength(101)
    expect(invoices[0]).toEqual({ number: '130000', customerRefNumber: '14000', currency: 'EUR', balance: 2999 })
  })
})

describe('findOurPayment', () => {
  it('returns the payment carrying our Dintero reference, ignoring others', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('connect/token')) return json({ access_token: 't', expires_in: 3600 })
        expect(u).toContain('/v1/customerPayment?customer=10859&invoiceRefNbr=130474')
        return json([
          { refNbr: '000100', paymentRef: '130474' },
          { refNbr: '000101', paymentRef: { value: 'R17882-6311A9' } },
        ])
      }),
    )
    expect(await findOurPayment(creds, '10859', '130474', 'R17882-6311A9')).toBe('000101')
  })

  it('is null when none carries it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token') ? json({ access_token: 't', expires_in: 3600 }) : json([]),
      ),
    )
    expect(await findOurPayment(creds, '10859', '130474', 'R1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/visma/posting/invoices.test.ts`
Expected: FAIL, `Cannot find module './invoices'`.

- [ ] **Step 3: Implement `invoices.ts`**

```ts
/**
 * The two reads posting needs. Both re-check in code what the query asked
 * for: an unknown or ignored filter answers 200 with the wrong rows, and a
 * payment applied to the wrong invoice is worse than none.
 */

import { vismaGet, type VismaCredentials, type VismaRequestOpts } from '../client'
import { unwrap } from '../purchase-orders'
import type { OpenInvoice } from './plan'

type Row = Record<string, unknown>
const PAGE = 100
const MAX_PAGES = 20
const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()
const num = (v: unknown): number => {
  const raw = unwrap<unknown>(v)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}
const enc = encodeURIComponent

export async function readOpenInvoices(
  creds: VismaCredentials,
  customer: string,
  opts: VismaRequestOpts = {},
): Promise<{ invoices: OpenInvoice[]; calls: number }> {
  const invoices: OpenInvoice[] = []
  let calls = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    calls++
    const rows = await vismaGet<Row[]>(
      creds,
      `controller/api/v1/customerinvoice?customer=${enc(customer)}&status=Open&pageSize=${PAGE}&pageNumber=${page}`,
      opts,
    )
    const list = Array.isArray(rows) ? rows : []
    for (const r of list) {
      if (str(r.status) !== 'Open') continue
      if (str((r.customer as Row | undefined)?.number) !== customer) continue
      invoices.push({
        number: str(r.referenceNumber),
        customerRefNumber: str(r.customerRefNumber),
        currency: str(r.currencyId),
        balance: Math.round(num(r.balanceInCurrency) * 100),
      })
    }
    if (list.length < PAGE) break
  }
  return { invoices, calls }
}

/** Our payment for this invoice, if Visma already holds one: its number, else null. */
export async function findOurPayment(
  creds: VismaCredentials,
  customer: string,
  invoiceNumber: string,
  reference: string,
  opts: VismaRequestOpts = {},
): Promise<string | null> {
  const rows = await vismaGet<Row[]>(
    creds,
    `controller/api/v1/customerPayment?customer=${enc(customer)}&invoiceRefNbr=${enc(invoiceNumber)}`,
    opts,
  )
  const hit = (Array.isArray(rows) ? rows : []).find((r) => str(r.paymentRef) === reference)
  return hit ? str(hit.refNbr) || null : null
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/visma/posting/invoices.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visma/posting/invoices.ts src/lib/visma/posting/invoices.test.ts
git commit -m "feat(visma): read a customer's open invoices and find our own payment"
git branch --show-current
```

---

### Task 6: The runner

**Files:**
- Create: `src/lib/visma/posting/run.ts`
- Test: `src/lib/visma/posting/run.test.ts`

**Interfaces:**
- Consumes: `writeCredentials`, `vismaPost` (Task 1); `planPosting`, `PlanMapping` (Task 4); `paymentBody`, `journalBody` (Task 4); `readOpenInvoices`, `findOurPayment` (Task 5); `payoutIsIngested` (`@/lib/dintero/sync`); Prisma models (Task 3).
- Produces: `POSTING_START: Date`; `type PostingMode = 'off' | 'dry_run' | 'hold'`; `type VismaPostingResult = { mode: PostingMode; configured: boolean; payoutId: string | null; status: string | null; calls: number; error: string | null }`; `runVismaPosting(opts?: { deadline?: number }): Promise<VismaPostingResult>` (never throws).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/visma/posting/run.test.ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const vismaPost = vi.fn()
const readOpenInvoices = vi.fn()
const findOurPayment = vi.fn()
vi.mock('../write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../write')>()),
  vismaPost: (...a: unknown[]) => vismaPost(...a),
}))
vi.mock('./invoices', () => ({
  readOpenInvoices: (...a: unknown[]) => readOpenInvoices(...a),
  findOurPayment: (...a: unknown[]) => findOurPayment(...a),
}))

const { db } = await import('@/lib/db')
const { encryptSecret } = await import('@/lib/secrets')
const { VismaError } = await import('../client')
const { TEST_TENANT_ID } = await import('../write')
const { runVismaPosting } = await import('./run')

const MARK = 'visma-posting-test'

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.payout.deleteMany({ where: { shopId: { in: ids } } })
  await db.dinteroConfig.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
  await db.vismaPostingConfig.deleteMany({})
}
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', '83949a19-af32-11ec-b60b-0638767d04b5')
  vismaPost.mockReset()
  readOpenInvoices.mockReset()
  findOurPayment.mockReset()
})

const mode = (m: string) => db.vismaPostingConfig.create({ data: { id: 'singleton', mode: m } })

async function dePayout(over: Record<string, unknown> = {}, mapped = true) {
  const shop = await db.shop.create({ data: { name: `${MARK} DE`, currency: 'EUR' } })
  await db.dinteroConfig.create({
    data: {
      shopId: shop.id, accountId: 'P11115654', clientId: encryptSecret('c'), clientSecret: encryptSecret('s'),
      ...(mapped ? { vismaCustomer: '10859', vismaClearingAccount: '1509', vismaBankAccount: '1940', vismaFeeAccount: '7770' } : {}),
    },
  })
  return db.payout.create({
    data: {
      shopId: shop.id, externalId: 'set-1', currency: 'EUR', settledAt: new Date('2026-10-06T08:00:00Z'),
      amount: 19000, capture: 20000, refund: 0, fee: 1000, reference: 'R20001-ABC', linesPending: false,
      reportVersion: 99,
      lines: {
        create: [
          { transactionId: 't1', reference: 'dwc1', reference2: '14238', amount: 11500, capture: 12000, refund: 0, fee: 500 },
          { transactionId: 't2', reference: 'dwc2', reference2: '14239', amount: 7500, capture: 8000, refund: 0, fee: 500 },
        ],
      },
      ...over,
    },
  })
}

const invoices = [
  { number: '130474', customerRefNumber: '14238', currency: 'EUR', balance: 12000 },
]

describe('runVismaPosting', () => {
  it('does nothing while the mode is off', async () => {
    await dePayout()
    const r = await runVismaPosting()
    expect(r.mode).toBe('off')
    expect(readOpenInvoices).not.toHaveBeenCalled()
  })

  it('dry run: stores the plan, writes nothing', async () => {
    await mode('dry_run')
    const payout = await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    const r = await runVismaPosting()
    expect(r).toMatchObject({ mode: 'dry_run', configured: true, payoutId: payout.id, status: 'dry_run' })
    expect(vismaPost).not.toHaveBeenCalled()
    const p = await db.vismaPosting.findUnique({ where: { payoutId_tenantId: { payoutId: payout.id, tenantId: TEST_TENANT_ID } } })
    expect(p).toMatchObject({ status: 'dry_run', matched: 1, unmatched: 1 })
  })

  it('hold: one payment per open invoice, skips the rest, then the payout entry; stores Visma numbers', async () => {
    await mode('hold')
    const payout = await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockResolvedValueOnce({ status: 201, number: 'P-1' }).mockResolvedValueOnce({ status: 201, number: 'GL-9' })

    const r = await runVismaPosting()
    expect(r.status).toBe('posted')
    expect(vismaPost).toHaveBeenCalledTimes(2)
    expect(vismaPost.mock.calls[0][0].tenantId).toBe(TEST_TENANT_ID)
    expect(vismaPost.mock.calls[0][1]).toBe('controller/api/v1/customerPayment')
    expect(vismaPost.mock.calls[1][1]).toBe('controller/api/v2/journaltransaction')

    const docs = await db.vismaPostingDocument.findMany({ orderBy: { kind: 'asc' } })
    expect(docs.map((d) => [d.kind, d.key, d.status, d.vismaNumber ?? d.reason])).toEqual(
      expect.arrayContaining([
        ['payment', '14238', 'sent', 'P-1'],
        ['payment', '14239', 'skipped', 'no open invoice'],
        ['payout', payout.id, 'sent', 'GL-9'],
      ]),
    )
    const p = await db.vismaPosting.findFirst({ where: { payoutId: payout.id } })
    expect(p).toMatchObject({ status: 'posted', matched: 1, unmatched: 1 })
  })

  it('never posts the same payout twice', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockResolvedValue({ status: 201, number: 'X' })
    await runVismaPosting()
    vismaPost.mockClear()
    const again = await runVismaPosting()
    expect(again.payoutId).toBeNull()
    expect(vismaPost).not.toHaveBeenCalled()
  })

  it('skips payouts before 1 Oct, without a reference, or for a shop with no Visma setup', async () => {
    await mode('hold')
    await dePayout({ settledAt: new Date('2026-09-29T08:00:00Z') })
    const r = await runVismaPosting()
    expect(r.payoutId).toBeNull()
    await cleanup(); await mode('hold')
    await dePayout({ reference: null })
    expect((await runVismaPosting()).payoutId).toBeNull()
    await cleanup(); await mode('hold')
    await dePayout({}, false)
    expect((await runVismaPosting()).payoutId).toBeNull()
  })

  it('a timeout after a payment POST leaves it sending; the next run asks Visma before resending', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    const first = await runVismaPosting()
    expect(first.status).toBe('posting')
    const sending = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(sending?.status).toBe('sending')

    // Visma DID create it: the invoice is no longer open, and our payment is found.
    readOpenInvoices.mockResolvedValue({ invoices: [], calls: 1 })
    findOurPayment.mockResolvedValue('P-77')
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'GL-1' })
    const second = await runVismaPosting()
    expect(findOurPayment).toHaveBeenCalledWith(expect.anything(), '10859', '130474', 'R20001-ABC', expect.anything())
    expect(vismaPost).toHaveBeenCalledTimes(1) // only the payout entry
    const doc = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(doc).toMatchObject({ status: 'sent', vismaNumber: 'P-77' })
    expect(second.status).toBe('posted')
  })

  it('a payout entry that may have been created is marked unconfirmed and never resent', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices: [], calls: 1 })
    vismaPost.mockRejectedValueOnce(new VismaError('Visma responded 502 for POST', 502))
    await runVismaPosting()
    vismaPost.mockReset()
    const second = await runVismaPosting()
    expect(vismaPost).not.toHaveBeenCalled()
    expect(second.status).toBe('error')
    const doc = await db.vismaPostingDocument.findFirst({ where: { kind: 'payout' } })
    expect(doc?.status).toBe('unconfirmed')
  })

  it('a 400 marks that document error and the posting error, with Visma\'s message', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost
      .mockRejectedValueOnce(new VismaError('Visma responded 400 for POST: Cash account 1509 not found', 400))
      .mockResolvedValueOnce({ status: 201, number: 'GL-2' })
    const r = await runVismaPosting()
    expect(r.status).toBe('error')
    const p = await db.vismaPosting.findFirst({})
    expect(p?.error).toContain('Cash account 1509 not found')
  })

  it('a 429 stops the run cleanly and resumes next time', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new VismaError('rate limited', 429))
    const r = await runVismaPosting()
    expect(r.status).toBe('posting')
    const doc = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(doc?.status).toBe('pending')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/visma/posting/run.test.ts`
Expected: FAIL, `Cannot find module './run'`.

- [ ] **Step 3: Implement `run.ts`**

```ts
/**
 * Posts Dintero payouts into the Visma TEST company, one payout per run,
 * per the bookkeeper's drawing (docs/superpowers/specs/2026-09-03-visma-
 * payout-posting-design.md). Called from the scheduled sync.
 *
 * Every document is written to VismaPostingDocument as `sending` BEFORE its
 * POST. A run that dies between Visma's 201 and our own write leaves that
 * row behind, and the next run asks Visma before deciding: a payment is
 * looked up by invoice and Dintero reference; a payout entry cannot be looked
 * up reliably, so it becomes `unconfirmed` and waits for a person. Nothing
 * is ever sent twice on a guess.
 *
 * Statuses of a document: sending (POST in flight or unanswered), sent,
 * pending (to be sent; a 429 put it back), skipped (no invoice to pay - the
 * bookkeeper follows it up), error (Visma refused it), unconfirmed (may exist
 * in Visma; never resent automatically).
 */

import type { Prisma } from '@prisma/client'
import { db } from '../../db'
import { payoutIsIngested } from '../../dintero/sync'
import { VismaError, type VismaRequestOpts } from '../client'
import { vismaPost, writeCredentials } from '../write'
import { journalBody, paymentBody } from './dto'
import { findOurPayment, readOpenInvoices } from './invoices'
import { planPosting, type PlanMapping } from './plan'

/** 1 Oct 2026 00:00 Europe/Oslo: the bookkeeper's start date. */
export const POSTING_START = new Date('2026-09-30T22:00:00.000Z')

const MAX_CALLS = 20
const MAX_ATTEMPTS = 3
/** No call is started with less than this left of the caller's budget. */
const CALL_MARGIN_MS = 20_000

export type PostingMode = 'off' | 'dry_run' | 'hold'
export type VismaPostingResult = {
  mode: PostingMode
  configured: boolean
  payoutId: string | null
  status: string | null
  calls: number
  error: string | null
}

const PAYMENT_PATH = 'controller/api/v1/customerPayment'
const JOURNAL_PATH = 'controller/api/v2/journaltransaction'
const UNCONFIRMED =
  'Sent to Visma but the answer was lost. Look for this Dintero reference in Visma before sending it again.'

/** A thrown POST we cannot read as "Visma refused it": it may have been created. */
const mayExist = (e: unknown) => !(e instanceof VismaError && e.status !== undefined && e.status < 500)

async function nextPayout(tenantId: string, mode: PostingMode) {
  const done: Prisma.VismaPostingWhereInput[] = [
    { tenantId, status: 'posted' },
    { tenantId, status: 'error', attempts: { gte: MAX_ATTEMPTS } },
  ]
  // A dry run previews each payout once and never touches one a real run has
  // started; holding re-does a previewed one.
  if (mode === 'dry_run') done.push({ tenantId, status: { in: ['dry_run', 'posting', 'error'] } })
  const candidates = await db.payout.findMany({
    where: {
      settledAt: { gte: POSTING_START },
      linesPending: false,
      reference: { not: null },
      shop: {
        dinteroConfig: {
          vismaCustomer: { not: null },
          vismaClearingAccount: { not: null },
          vismaBankAccount: { not: null },
          vismaFeeAccount: { not: null },
        },
      },
      NOT: { vismaPostings: { some: { OR: done } } },
    },
    orderBy: { settledAt: 'asc' },
    take: 20,
    include: { lines: true, shop: { include: { dinteroConfig: true } } },
  })
  return candidates.find((p) => payoutIsIngested(p)) ?? null
}

export async function runVismaPosting(opts: { deadline?: number } = {}): Promise<VismaPostingResult> {
  let mode: PostingMode = 'off'
  const result: VismaPostingResult = { mode, configured: false, payoutId: null, status: null, calls: 0, error: null }
  try {
    const config = await db.vismaPostingConfig.findUnique({ where: { id: 'singleton' } })
    mode = (config?.mode ?? 'off') as PostingMode
    result.mode = mode
    if (mode !== 'dry_run' && mode !== 'hold') return result
    const creds = writeCredentials()
    if (!creds) return result
    result.configured = true

    const ro: VismaRequestOpts = { deadline: opts.deadline }
    const canCall = () =>
      result.calls < MAX_CALLS && (opts.deadline === undefined || Date.now() + CALL_MARGIN_MS < opts.deadline)

    const payout = await nextPayout(creds.tenantId, mode)
    if (!payout) return result
    result.payoutId = payout.id
    const cfg = payout.shop.dinteroConfig!
    const mapping: PlanMapping = {
      customer: cfg.vismaCustomer!,
      clearingAccount: cfg.vismaClearingAccount!,
      bankAccount: cfg.vismaBankAccount!,
      feeAccount: cfg.vismaFeeAccount!,
    }
    const reference = payout.reference!

    const prior = await db.vismaPosting.findUnique({
      where: { payoutId_tenantId: { payoutId: payout.id, tenantId: creds.tenantId } },
    })
    const status = mode === 'dry_run' ? 'dry_run' : 'posting'
    const posting = await db.vismaPosting.upsert({
      where: { payoutId_tenantId: { payoutId: payout.id, tenantId: creds.tenantId } },
      create: { payoutId: payout.id, tenantId: creds.tenantId, status, attempts: 1 },
      update: { status, error: null, ...(prior?.status === 'error' ? { attempts: { increment: 1 } } : {}) },
    })
    result.status = status

    const read = await readOpenInvoices(creds, mapping.customer, ro)
    result.calls += read.calls
    const plan = planPosting(payout, payout.lines, read.invoices, mapping)
    const preview = JSON.parse(JSON.stringify(plan)) as Prisma.InputJsonValue

    if (mode === 'dry_run') {
      await db.vismaPosting.update({
        where: { id: posting.id },
        data: { preview, matched: plan.payments.length, unmatched: plan.skipped.length },
      })
      return result
    }

    const doc = (kind: string, key: string) =>
      db.vismaPostingDocument.findUnique({ where: { postingId_kind_key: { postingId: posting.id, kind, key } } })
    const setDoc = (id: string, data: Prisma.VismaPostingDocumentUpdateInput) =>
      db.vismaPostingDocument.update({ where: { id }, data })

    // 1. Anything left `sending` by an earlier run: ask Visma first.
    for (const d of await db.vismaPostingDocument.findMany({ where: { postingId: posting.id, status: 'sending' } })) {
      if (d.kind !== 'payment' || !d.invoiceNumber) {
        await setDoc(d.id, { status: 'unconfirmed', reason: UNCONFIRMED })
        continue
      }
      if (!canCall()) return result
      result.calls++
      const found = await findOurPayment(creds, mapping.customer, d.invoiceNumber, reference, ro)
      await setDoc(d.id, found ? { status: 'sent', vismaNumber: found, reason: null } : { status: 'pending' })
    }

    // 2. Orders with nothing to pay: recorded once, for the bookkeeper.
    for (const s of plan.skipped) {
      if (await doc('payment', s.key)) continue
      await db.vismaPostingDocument.create({
        data: { postingId: posting.id, kind: 'payment', key: s.key, status: 'skipped', reason: s.reason },
      })
    }

    // 3. Send one document: record, POST, record the answer. False = stop this run.
    const send = async (
      kind: string,
      key: string,
      path: string,
      body: object,
      extra: { invoiceNumber?: string; amount?: number },
    ): Promise<boolean> => {
      const existing = await doc(kind, key)
      if (existing && existing.status !== 'pending' && existing.status !== 'error') return true
      if (!canCall()) return false
      const row = existing
        ? await setDoc(existing.id, { status: 'sending', reason: null, ...extra })
        : await db.vismaPostingDocument.create({
            data: { postingId: posting.id, kind, key, status: 'sending', ...extra },
          })
      result.calls++
      try {
        const made = await vismaPost(creds, path, body, ro)
        await setDoc(row.id, { status: 'sent', vismaNumber: made.number })
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (e instanceof VismaError && e.status === 429) {
          await setDoc(row.id, { status: 'pending' })
          return false
        }
        if (mayExist(e)) return false // stays `sending`; the next run asks Visma
        await setDoc(row.id, { status: 'error', reason: message.slice(0, 500) })
        return true
      }
    }

    for (const p of plan.payments) {
      const body = paymentBody({
        customer: mapping.customer, clearingAccount: mapping.clearingAccount, currency: payout.currency,
        reference, date: payout.settledAt!, key: p.key, invoiceNumber: p.invoiceNumber, amount: p.amount,
      })
      if (!(await send('payment', p.key, PAYMENT_PATH, body, { invoiceNumber: p.invoiceNumber, amount: p.amount }))) {
        return result
      }
    }

    if (plan.entry.length > 0) {
      const body = journalBody({ currency: payout.currency, reference, date: payout.settledAt!, lines: plan.entry })
      if (!(await send('payout', payout.id, JOURNAL_PATH, body, { amount: payout.amount }))) return result
    }

    // 4. The verdict.
    const docs = await db.vismaPostingDocument.findMany({ where: { postingId: posting.id } })
    const failed = docs.find((d) => d.status === 'error' || d.status === 'unconfirmed')
    const final = failed ? 'error' : 'posted'
    await db.vismaPosting.update({
      where: { id: posting.id },
      data: {
        status: final,
        error: failed?.reason ?? null,
        matched: docs.filter((d) => d.kind === 'payment' && d.status === 'sent').length,
        unmatched: docs.filter((d) => d.kind === 'payment' && d.status === 'skipped').length,
        postedAt: failed ? null : new Date(),
        preview,
      },
    })
    result.status = final
    return result
  } catch (e) {
    result.error = e instanceof Error ? e.message : 'Visma posting failed'
    return result
  }
}
```

- [ ] **Step 4: Run the runner tests**

Run: `npx vitest run src/lib/visma/posting/run.test.ts`
Expected: PASS. If the "unconfirmed" test fails because the first run returned before the entry (no invoices → no payments), check that `readOpenInvoices` returning `[]` makes both orders `skipped` and the entry the only POST.

- [ ] **Step 5: Type-check and run all Visma tests**

Run: `npx tsc --noEmit && npx vitest run src/lib/visma`
Expected: no type errors; all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/visma/posting/run.ts src/lib/visma/posting/run.test.ts
git commit -m "feat(visma): post one Dintero payout per run into the test company, never twice"
git branch --show-current
```

---

### Task 7: Call it from the scheduled sync

**Files:**
- Modify: `src/app/api/cron/sync/route.ts` (imports ~line 9; constants ~line 58; after the `settlements` block ~line 397; response object ~line 594)
- Modify: `src/app/api/cron/sync/route.test.ts` (mocks ~line 38)

**Interfaces:**
- Consumes: `runVismaPosting`, `VismaPostingResult` (Task 6).

- [ ] **Step 1: Add the mock to the route test first** (after the `@/lib/visma/probe` mock)

```ts
// Nor the Visma posting job: unmocked it would read the database's mode and
// could POST to the test company from a test run.
vi.mock('@/lib/visma/posting/run', () => ({
  runVismaPosting: async () => ({ mode: 'off', configured: false, payoutId: null, status: null, calls: 0, error: null }),
}))
```

- [ ] **Step 2: Wire the route**

Import:

```ts
import { runVismaPosting, type VismaPostingResult } from '@/lib/visma/posting/run'
```

Constant, next to `VISMA_PROBE_DEADLINE_MS`:

```ts
/**
 * Posting to the Visma test company runs after the payout mirror, so it sees
 * this run's settlements. At most 20 calls; it stops starting calls 20s before
 * this, which leaves the later stages their own deadlines.
 */
const VISMA_POSTING_DEADLINE_MS = 250_000
```

After the `settlements` try/catch block:

```ts
  // Dintero payouts into the Visma TEST company, per the bookkeeper's drawing.
  // Off until an admin picks a mode on /settings/payouts; one payout a run.
  let vismaPosting: VismaPostingResult = {
    mode: 'off', configured: false, payoutId: null, status: null, calls: 0, error: null,
  }
  try {
    vismaPosting = await runVismaPosting({ deadline: runStartedAt + VISMA_POSTING_DEADLINE_MS })
  } catch {
    // It does not throw. Same belt and braces as every other stage.
  }
```

In the response object, after `vismaProbeError: vismaProbe.error,`:

```ts
    vismaPostingMode: vismaPosting.mode,
    vismaPostingPayout: vismaPosting.payoutId,
    vismaPostingStatus: vismaPosting.status,
    vismaPostingError: vismaPosting.error,
```

- [ ] **Step 3: Run the route tests**

Run: `npx vitest run src/app/api/cron/sync/route.test.ts --testTimeout=20000`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/sync/route.ts src/app/api/cron/sync/route.test.ts
git commit -m "feat(cron): run the Visma posting job once a tick, off by default"
git branch --show-current
```

---

### Task 8: Settings: the mode and the per-shop accounts

**Files:**
- Create: `src/app/api/visma-posting/route.ts`, `src/app/api/visma-posting/route.test.ts`
- Create: `src/app/settings/payouts/VismaPostingCard.tsx`
- Modify: `src/app/settings/payouts/DinteroClient.tsx:263` (render the card inside `<PageBody>`)

**Interfaces:**
- Produces: `GET /api/visma-posting` → `{ mode: PostingMode; shops: VismaShopMapping[] }`; `PUT /api/visma-posting` with the same body → the saved state. `type VismaShopMapping = { shopId: string; name: string; currency: string; vismaCustomer: string | null; vismaClearingAccount: string | null; vismaBankAccount: string | null; vismaFeeAccount: string | null }`.

- [ ] **Step 1: Write the failing route test**

```ts
// src/app/api/visma-posting/route.test.ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const currentUser = vi.fn()
vi.mock('@/lib/auth/current-user', () => ({ currentUser: () => currentUser() }))

const { db } = await import('@/lib/db')
const { encryptSecret } = await import('@/lib/secrets')
const { GET, PUT } = await import('./route')

const MARK = 'visma-posting-route-test'
async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  await db.dinteroConfig.deleteMany({ where: { shopId: { in: shops.map((s) => s.id) } } })
  await db.shop.deleteMany({ where: { id: { in: shops.map((s) => s.id) } } })
  await db.vismaPostingConfig.deleteMany({})
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  currentUser.mockResolvedValue({ id: 'u', email: 'a@b.c', role: 'ADMIN' })
})

const put = (body: unknown) =>
  PUT(new Request('http://x/api/visma-posting', { method: 'PUT', body: JSON.stringify(body) }))

describe('/api/visma-posting', () => {
  it('is admin only', async () => {
    currentUser.mockResolvedValue({ id: 'u', email: 'a@b.c', role: 'OPERATIONS' })
    expect((await GET()).status).toBe(403)
  })

  it('starts off, and saves the mode and a shop mapping', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} DE`, currency: 'EUR' } })
    await db.dinteroConfig.create({
      data: { shopId: shop.id, accountId: 'P11115654', clientId: encryptSecret('c'), clientSecret: encryptSecret('s') },
    })
    const before = await (await GET()).json()
    expect(before.mode).toBe('off')

    const res = await put({
      mode: 'dry_run',
      shops: [{ shopId: shop.id, vismaCustomer: '10859', vismaClearingAccount: '1509', vismaBankAccount: '1940', vismaFeeAccount: '7770' }],
    })
    expect(res.status).toBe(200)
    const saved = await res.json()
    expect(saved.mode).toBe('dry_run')
    expect(saved.shops.find((s: { shopId: string }) => s.shopId === shop.id)).toMatchObject({
      vismaCustomer: '10859', vismaClearingAccount: '1509', vismaBankAccount: '1940', vismaFeeAccount: '7770',
    })
  })

  it('refuses an unknown mode and a non-numeric account', async () => {
    expect((await put({ mode: 'live', shops: [] })).status).toBe(400)
    expect((await put({ mode: 'off', shops: [{ shopId: 'x', vismaCustomer: '10859; DROP' }] })).status).toBe(400)
  })

  it('treats an empty field as not set', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} DK`, currency: 'DKK' } })
    await db.dinteroConfig.create({
      data: { shopId: shop.id, accountId: 'P1', clientId: encryptSecret('c'), clientSecret: encryptSecret('s'), vismaCustomer: '10478' },
    })
    await put({ mode: 'off', shops: [{ shopId: shop.id, vismaCustomer: '  ' }] })
    const cfg = await db.dinteroConfig.findUnique({ where: { shopId: shop.id } })
    expect(cfg?.vismaCustomer).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/visma-posting/route.test.ts`
Expected: FAIL, `Cannot find module './route'`.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/visma-posting/route.ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

const MODES = ['off', 'dry_run', 'hold'] as const
const FIELDS = ['vismaCustomer', 'vismaClearingAccount', 'vismaBankAccount', 'vismaFeeAccount'] as const
type Field = (typeof FIELDS)[number]

/** Visma customer and account numbers are digits. Empty = not set. */
function clean(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  const s = String(v ?? '').trim()
  if (s === '') return null
  return /^\d{1,10}$/.test(s) ? s : undefined
}

async function state() {
  const config = await db.vismaPostingConfig.findUnique({ where: { id: 'singleton' } })
  const configs = await db.dinteroConfig.findMany({
    include: { shop: { select: { name: true, currency: true } } },
    orderBy: { shop: { name: 'asc' } },
  })
  return {
    mode: config?.mode ?? 'off',
    shops: configs.map((c) => ({
      shopId: c.shopId,
      name: c.shop.name,
      currency: c.shop.currency,
      vismaCustomer: c.vismaCustomer,
      vismaClearingAccount: c.vismaClearingAccount,
      vismaBankAccount: c.vismaBankAccount,
      vismaFeeAccount: c.vismaFeeAccount,
    })),
  }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    return NextResponse.json(await state(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the Visma posting settings' }, { status: 500, headers: NO_STORE })
  }
}

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const body = (await req.json().catch(() => null)) as { mode?: unknown; shops?: unknown } | null
    const mode = String(body?.mode ?? '')
    if (!(MODES as readonly string[]).includes(mode)) {
      return NextResponse.json({ error: 'Mode must be off, dry_run or hold' }, { status: 400, headers: NO_STORE })
    }
    const shops = Array.isArray(body?.shops) ? (body!.shops as Record<string, unknown>[]) : []
    const updates: { shopId: string; data: Partial<Record<Field, string | null>> }[] = []
    for (const s of shops) {
      const data: Partial<Record<Field, string | null>> = {}
      for (const f of FIELDS) {
        if (!(f in s)) continue
        const v = clean(s[f])
        if (v === undefined) {
          return NextResponse.json({ error: `${f} must be a number` }, { status: 400, headers: NO_STORE })
        }
        data[f] = v
      }
      updates.push({ shopId: String(s.shopId ?? ''), data })
    }
    await db.$transaction([
      db.vismaPostingConfig.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', mode }, update: { mode } }),
      ...updates.map((u) => db.dinteroConfig.updateMany({ where: { shopId: u.shopId }, data: u.data })),
    ])
    return NextResponse.json(await state(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the Visma posting settings' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: Run route tests**

Run: `npx vitest run src/app/api/visma-posting/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the card**

```tsx
// src/app/settings/payouts/VismaPostingCard.tsx
'use client'

import { useEffect, useState } from 'react'
import { useToast } from '@/components/toast/useToast'

/**
 * Posting Dintero payouts into the Visma TEST company. Off by default.
 * "Dry run" shows what would be sent; "Write on hold" creates the documents
 * on hold in the test company for Philip and the bookkeeper to check.
 */

type Mode = 'off' | 'dry_run' | 'hold'
type Shop = {
  shopId: string
  name: string
  currency: string
  vismaCustomer: string | null
  vismaClearingAccount: string | null
  vismaBankAccount: string | null
  vismaFeeAccount: string | null
}
const COLUMNS: { key: keyof Shop; label: string }[] = [
  { key: 'vismaCustomer', label: 'Webshop customer' },
  { key: 'vismaClearingAccount', label: 'Dintero account' },
  { key: 'vismaBankAccount', label: 'Bank account' },
  { key: 'vismaFeeAccount', label: 'Fee account' },
]
const field = 'w-24 rounded-[var(--radius-control)] border border-line px-2 py-1.5 text-sm'
const primaryBtn =
  'rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'

export function VismaPostingCard() {
  const [mode, setMode] = useState<Mode>('off')
  const [shops, setShops] = useState<Shop[]>([])
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    fetch('/api/visma-posting')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        setMode(d.mode)
        setShops(d.shops)
      })
      .catch(() => {})
  }, [])

  const edit = (shopId: string, key: keyof Shop, value: string) =>
    setShops((list) => list.map((s) => (s.shopId === shopId ? { ...s, [key]: value } : s)))

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/visma-posting', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, shops }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Could not save')
      setMode(d.mode)
      setShops(d.shops)
      toast.success('Visma posting saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-8 rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <h2 className="text-base font-semibold text-ink">Visma posting (test company)</h2>
      <p className="mt-1 text-sm text-muted">
        Posts each Dintero payout into Visma as the bookkeeper's drawing describes. Writes go only to the test
        company, and every document is created on hold.
      </p>
      <label className="mt-4 block text-sm font-semibold text-ink">
        Mode{' '}
        <select
          className="ml-2 rounded-[var(--radius-control)] border border-line px-2 py-1.5 text-sm"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          <option value="off">Off</option>
          <option value="dry_run">Dry run (send nothing)</option>
          <option value="hold">Write on hold to the test company</option>
        </select>
      </label>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-2 pr-3">Shop</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="py-2 pr-3">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shops.map((s) => (
            <tr key={s.shopId} className="border-t border-line">
              <td className="py-2 pr-3">{s.name} <span className="text-muted">{s.currency}</span></td>
              {COLUMNS.map((c) => (
                <td key={c.key} className="py-2 pr-3">
                  <input
                    aria-label={`${s.name} ${c.label}`}
                    className={field}
                    inputMode="numeric"
                    value={(s[c.key] as string | null) ?? ''}
                    onChange={(e) => edit(s.shopId, c.key, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <button className={`${primaryBtn} mt-4`} disabled={busy} onClick={save}>
        {busy ? 'Saving' : 'Save'}
      </button>
    </section>
  )
}
```

Before relying on `toast.success` / `toast.error`, open `src/components/toast/useToast.ts(x)` and use the method names it actually exports (DinteroClient.tsx uses the same hook; copy its calls). Use the same CSS variable names DinteroClient.tsx uses for the card radius and muted text; if `--radius-card` or `text-muted` do not exist there, copy DinteroClient's card classes instead.

- [ ] **Step 6: Render the card**

In `DinteroClient.tsx`, add `import { VismaPostingCard } from './VismaPostingCard'` and put `<VismaPostingCard />` on the line directly above `</PageBody>` (line 263).

- [ ] **Step 7: Type-check, lint, run settings tests**

Run: `npx tsc --noEmit && npx eslint src/app/settings/payouts src/app/api/visma-posting && npx vitest run src/app/settings/payouts src/app/api/visma-posting`
Expected: clean; PASS. (If `DinteroClient.test.tsx` mocks `fetch` by URL and now sees an unexpected `/api/visma-posting` call, make its fetch mock answer that URL with `{ mode: 'off', shops: [] }`.)

- [ ] **Step 8: Commit**

```bash
git add src/app/api/visma-posting src/app/settings/payouts/VismaPostingCard.tsx src/app/settings/payouts/DinteroClient.tsx src/app/settings/payouts/DinteroClient.test.tsx
git commit -m "feat(settings): Visma posting mode and per-shop accounts"
git branch --show-current
```

---

### Task 9: The Visma column on Finance → Payouts

**Files:**
- Create: `src/lib/visma/posting/label.ts`, `src/lib/visma/posting/label.test.ts`
- Modify: `src/app/api/payouts/route.ts` (query + `payouts.map`), `src/app/api/payouts/[id]/route.ts` (include + response), `src/app/finance/payouts/PayoutsClient.tsx` (types ~line 20-40, header ~line 369, row cells, detail)
- Test: `src/app/api/payouts/route.test.ts`, `src/app/finance/payouts/PayoutsClient.test.tsx` (append)

**Interfaces:**
- Consumes: `POSTING_START` (Task 6), `TEST_TENANT_ID` (Task 1), `payoutIsIngested`.
- Produces: `vismaLabel(input: VismaLabelInput): string`; list rows gain `visma: string`; detail gains `visma: { status: string; documents: { kind: string; key: string; status: string; reason: string | null; vismaNumber: string | null; amount: number | null }[] } | null`.

- [ ] **Step 1: Write the failing label tests**

```ts
// src/lib/visma/posting/label.test.ts
import { describe, expect, it } from 'vitest'
import { vismaLabel } from './label'

const base = {
  settledAt: new Date('2026-10-06T08:00:00Z'), ingested: true, reference: 'R1', mapped: true, posting: null,
}

describe('vismaLabel', () => {
  it('explains why a payout is not posted', () => {
    expect(vismaLabel({ ...base, settledAt: null })).toBe('Waiting: not paid out yet')
    expect(vismaLabel({ ...base, settledAt: new Date('2026-09-20T08:00:00Z') })).toBe('Before 1 Oct')
    expect(vismaLabel({ ...base, ingested: false })).toBe('Waiting: report pending')
    expect(vismaLabel({ ...base, reference: null })).toBe('Waiting: no Dintero reference')
    expect(vismaLabel({ ...base, mapped: false })).toBe('Waiting: no Visma setup for this shop')
    expect(vismaLabel(base)).toBe('Ready')
  })
  it('states the posting outcome', () => {
    const p = (status: string, matched: number, unmatched: number, error: string | null = null) => ({
      ...base, posting: { status, matched, unmatched, error },
    })
    expect(vismaLabel(p('posted', 23, 0))).toBe('Posted to test: 23 of 23 orders settled')
    expect(vismaLabel(p('posted', 21, 2))).toBe('Posted to test: 21 of 23 orders settled, 2 left for Abacus')
    expect(vismaLabel(p('dry_run', 21, 2))).toBe('Dry run: 21 of 23 orders would settle')
    expect(vismaLabel(p('posting', 0, 0))).toBe('Posting to test')
    expect(vismaLabel(p('error', 0, 0, 'Cash account 1509 not found'))).toBe('Error: Cash account 1509 not found')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/visma/posting/label.test.ts`
Expected: FAIL, `Cannot find module './label'`.

- [ ] **Step 3: Implement `label.ts`**

```ts
/** The Visma status shown per payout on Finance > Payouts. Pure. */

import { POSTING_START } from './run'

export type VismaLabelInput = {
  settledAt: Date | null
  ingested: boolean
  reference: string | null
  mapped: boolean
  posting: { status: string; matched: number; unmatched: number; error: string | null } | null
}

export function vismaLabel(i: VismaLabelInput): string {
  const p = i.posting
  if (p) {
    const total = p.matched + p.unmatched
    if (p.status === 'posted') {
      return p.unmatched === 0
        ? `Posted to test: ${p.matched} of ${total} orders settled`
        : `Posted to test: ${p.matched} of ${total} orders settled, ${p.unmatched} left for Abacus`
    }
    if (p.status === 'dry_run') return `Dry run: ${p.matched} of ${total} orders would settle`
    if (p.status === 'posting') return 'Posting to test'
    return `Error: ${p.error ?? 'unknown'}`
  }
  if (!i.settledAt) return 'Waiting: not paid out yet'
  if (i.settledAt < POSTING_START) return 'Before 1 Oct'
  if (!i.ingested) return 'Waiting: report pending'
  if (!i.reference) return 'Waiting: no Dintero reference'
  if (!i.mapped) return 'Waiting: no Visma setup for this shop'
  return 'Ready'
}
```

`label.ts` imports `run.ts`, which imports the database client. That is fine on the server; `PayoutsClient.tsx` must NOT import `label.ts` (it receives the text from the API).

- [ ] **Step 4: Run label tests**

Run: `npx vitest run src/lib/visma/posting/label.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `visma` to the list API**

In `src/app/api/payouts/route.ts`, add imports:

```ts
import { payoutIsIngested } from '@/lib/dintero/sync'
import { vismaLabel } from '@/lib/visma/posting/label'
import { TEST_TENANT_ID } from '@/lib/visma/write'
```

Change the `db.payout.findMany` `include` to:

```ts
      include: {
        shop: { select: { name: true, dinteroConfig: { select: { vismaCustomer: true, vismaClearingAccount: true, vismaBankAccount: true, vismaFeeAccount: true } } } },
        vismaPostings: { where: { tenantId: TEST_TENANT_ID }, select: { status: true, matched: true, unmatched: true, error: true } },
      },
```

In `payouts.map((p) => ({ ... }))`, after `matched: matchedOf.get(p.id) ?? 0,` add:

```ts
          visma: vismaLabel({
            settledAt: p.settledAt,
            ingested: payoutIsIngested(p),
            reference: p.reference,
            mapped: Boolean(
              p.shop.dinteroConfig?.vismaCustomer && p.shop.dinteroConfig.vismaClearingAccount &&
                p.shop.dinteroConfig.vismaBankAccount && p.shop.dinteroConfig.vismaFeeAccount,
            ),
            posting: p.vismaPostings[0] ?? null,
          }),
```

Append to `src/app/api/payouts/route.test.ts` a case that creates a payout settled after 1 Oct for a shop with no mapping and asserts its row has `visma: 'Waiting: no Visma setup for this shop'` (use that file's existing fixtures/helpers for shop, config and payout creation).

- [ ] **Step 6: Add documents to the detail API**

In `src/app/api/payouts/[id]/route.ts`, add `import { TEST_TENANT_ID } from '@/lib/visma/write'`, extend `include` with:

```ts
        vismaPostings: {
          where: { tenantId: TEST_TENANT_ID },
          include: { documents: { orderBy: [{ kind: 'asc' }, { key: 'asc' }] } },
        },
```

and add to the JSON after `linesPending`:

```ts
        visma: payout.vismaPostings[0]
          ? {
              status: payout.vismaPostings[0].status,
              documents: payout.vismaPostings[0].documents.map((d) => ({
                kind: d.kind, key: d.key, status: d.status, reason: d.reason, vismaNumber: d.vismaNumber, amount: d.amount,
              })),
            }
          : null,
```

- [ ] **Step 7: Show it in `PayoutsClient.tsx`**

- In the payout row type (the one with `matched: number`, ~line 37) add `visma: string`.
- In `type Detail` (~line 77) add `visma: { status: string; documents: { kind: string; key: string; status: string; reason: string | null; vismaNumber: string | null; amount: number | null }[] } | null`.
- In the payouts table header (~line 369), after `<th className="px-3 py-2.5">Orders</th>` add `<th className="px-3 py-2.5">Visma</th>`; in the row, after the Orders cell, add a cell rendering `{p.visma}` with `className="px-3 py-2.5"`, and `text-warn font-semibold` added when `p.visma.startsWith('Error')`. Increase any `colSpan` used for the expanded detail row by 1.
- In the detail view, after the lines table, when `detail.visma` is set render:

```tsx
{detail.visma && (
  <div className="px-4 py-3 text-sm">
    <div className="font-semibold text-ink">In Visma (test company)</div>
    <ul className="mt-1 space-y-0.5">
      {detail.visma.documents.map((d) => (
        <li key={`${d.kind}-${d.key}`}>
          {d.kind === 'payout' ? 'Payout entry' : `Order ${d.key}`}: {d.status}
          {d.vismaNumber ? ` (Visma ${d.vismaNumber})` : ''}
          {d.reason ? ` - ${d.reason}` : ''}
        </li>
      ))}
    </ul>
  </div>
)}
```

Append to `PayoutsClient.test.tsx` a case where the mocked list answer has `visma: 'Ready'` on a payout and assert the text `Ready` is rendered (copy the file's existing render/fetch-mock pattern; add `visma` to its existing fixture rows so they type-check).

- [ ] **Step 8: Type-check and run the payouts tests**

Run: `npx tsc --noEmit && npx vitest run src/app/api/payouts src/app/finance/payouts src/lib/visma/posting`
Expected: clean; PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/visma/posting/label.ts src/lib/visma/posting/label.test.ts src/app/api/payouts src/app/finance/payouts
git commit -m "feat(payouts): show each payout's Visma status and the documents sent"
git branch --show-current
```

---

### Task 10: Full gate, PR, deploy, and the live steps

**Files:** none new.

- [ ] **Step 1: Full test suite, types, lint, build**

Run: `npx vitest run --testTimeout=20000`
Expected: PASS. (2-3 `sync.test.ts` timeouts under load are known contention; re-run those files alone before suspecting the change.)

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

Run: `rm -f .next/dev/types/routes.d.ts; npm run build`
Expected: build succeeds. (`build` runs `scripts/db-push.mjs` first; confirm `.env` is the local database before running it.)

- [ ] **Step 2: PR and merge**

```bash
git push -u origin HEAD
gh pr create --title "Dintero payouts into the Visma test company" --body "Implements docs/superpowers/specs/2026-09-03-visma-payout-posting-design.md (Abacus's drawing) for the TEST company only. Off by default; dry run and write-on-hold modes on /settings/payouts. The real company is refused in code and is read-only in Visma.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Wait for CI and the Vercel preview, merge, then confirm the production deploy is green (`gh run list`, `gh pr view --json mergeStateStatus`). A failed production deploy with a green preview is usually transient: retry once before debugging.

- [ ] **Step 3: Prove the test company answers** (no code)

After the first cron tick on production, read `DiagnosticSnapshot` key `visma-probe:v1:test-company` (through the existing diagnostics route the probe answers are read from). Expected: customers 10000, 10001, 10002 and cash accounts including 1940. If it holds `{ error }`, stop and read the message: a 401/403 is the tenant or scope, a DNS/404 is the host.

- [ ] **Step 4: Fill the test company to mirror Panetti DE** (by hand, with Marvin, in `demo.finance.visma.net`)

1. Cash account 1509 "Dintero - EUR" (EUR) with its GL account, payment method 5 enabled for AR on it.
2. GL account 7770 (Dintero fees) if missing.
3. Customer 10859 "Panetti Deutschland - Webkunde", currency EUR.
4. Pick the newest real Panetti DE payout settled on or after 1 Oct from /finance/payouts; for 2-3 of its orders, create an open invoice for customer 10859 with Customer order no. = that order number and the same EUR amount. Leave at least one order without an invoice (it must come out as "no open invoice").

- [ ] **Step 5: Dry run**

On /settings/payouts, fill Panetti DE: 10859 / 1509 / 1940 / 7770, mode **Dry run**, Save. After the next tick, Finance → Payouts shows `Dry run: N of M orders would settle` on that payout. Check N equals the invoices created in Step 4.

- [ ] **Step 6: Write on hold**

Switch the mode to **Write on hold**, Save. After the next tick the payout shows `Posted to test: ...`. Open the documents in the test company (Customer payments and Journal transactions, status On hold) and compare them with the drawing. Then send Philip the Visma document numbers for him and Abacus to check. If Visma refused the journal transaction (`Error: ...` on the payout entry), stop and ask Abacus which document type "bank transaction (batch)" means; do not invent another.
