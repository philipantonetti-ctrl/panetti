# Shop Connection + Compare Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the client create and connect his real WooCommerce shops (with keys encrypted at rest and honest sync reporting), and show the BeProfit-style column set on Compare shops.

**Architecture:** A tiny crypto module (`src/lib/secrets.ts`) wraps AES-256-GCM with a key derived from the existing `AUTH_SECRET`; the shop PATCH route encrypts on write and gains "blank = keep" semantics; `syncShop` decrypts on read and fails loudly. A new `POST /api/shops` plus an Add-shop modal complete the front door. Separately, the metrics engine gains a `taxes` figure and the Compare table displays five already-computed figures.

**Tech Stack:** Next.js 16 App Router, Prisma 6 + PostgreSQL, zod v4, Vitest (node env for lib/routes, jsdom docblock for components), Node built-in `crypto` — **no new dependencies, no schema change, no migration.**

**Specs:** `docs/superpowers/specs/2026-07-17-shop-connection-design.md` and `docs/superpowers/specs/2026-07-17-compare-columns-design.md`

---

## Ground rules for this repo (read first)

- **Local only.** Tests hit the local PG17 database `ecom_analytics` via `.env`. NEVER run anything against the production (Neon) database. No `prisma db push` is needed — this plan changes no schema.
- **Never** commit `.env`, never `git add .` or `git add -A` — stage files **by name**.
- Commands are for Windows PowerShell 5.1 — no `&&`; run commands one at a time.
- Test fixtures created in the shared local DB must carry `[test]` in their name and be deleted in `beforeEach`/`afterEach` (`deleteMany({ where: { name: { contains: '[test]' } } })`). Never `deleteMany({})`.
- Money is integer minor units everywhere. Commission rates are fractions (0.10 = 10%).
- Component tests need the `// @vitest-environment jsdom` docblock as line 1 and mock `next/navigation` + `next/link` (copy the pattern from `src/app/settings/expenses/ExpensesClient.test.tsx`).

### Task 0: Branch

- [ ] **Step 0.1:** Create the working branch.

```powershell
git checkout -b feat/shop-connection
```

---

### Task 1: Secrets module (encrypt/decrypt)

**Files:**
- Create: `src/lib/secrets.ts`
- Test: `src/lib/secrets.test.ts`

- [ ] **Step 1.1: Write the failing test**

```ts
// src/lib/secrets.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from './secrets'

beforeAll(() => {
  // Real runs use the .env value; make the suite self-sufficient anyway.
  process.env.AUTH_SECRET ??= 'test-only-secret-for-crypto-round-trips'
})

describe('secrets', () => {
  it('round-trips a WooCommerce key', () => {
    const stored = encryptSecret('ck_live_abc123')
    expect(stored.startsWith('enc:v1:')).toBe(true)
    expect(stored).not.toContain('ck_live_abc123')
    expect(decryptSecret(stored)).toBe('ck_live_abc123')
  })

  it('encrypts the same value differently every time (fresh IV)', () => {
    const a = encryptSecret('cs_same')
    const b = encryptSecret('cs_same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('cs_same')
    expect(decryptSecret(b)).toBe('cs_same')
  })

  it('throws on a tampered value instead of returning garbage', () => {
    const stored = encryptSecret('cs_live_secret')
    const tampered = stored.slice(0, -4) + 'AAAA'
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('passes a pre-encryption plaintext value through unchanged', () => {
    // Local dev rows created before this module keep working.
    expect(decryptSecret('ck_plain_old_row')).toBe('ck_plain_old_row')
  })

  it('refuses to run without AUTH_SECRET', () => {
    const orig = process.env.AUTH_SECRET
    delete process.env.AUTH_SECRET
    try {
      expect(() => encryptSecret('x')).toThrow(/AUTH_SECRET/)
    } finally {
      process.env.AUTH_SECRET = orig
    }
  })
})
```

- [ ] **Step 1.2: Run it — must fail (module does not exist)**

```powershell
npx vitest run src/lib/secrets.test.ts
```
Expected: FAIL — cannot resolve `./secrets`.

- [ ] **Step 1.3: Implement**

```ts
// src/lib/secrets.ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'

/**
 * Shop API keys, encrypted at rest.
 *
 * AES-256-GCM with a key derived (HKDF-SHA256) from AUTH_SECRET — the one secret
 * that already exists on Vercel, so connecting a shop needs no extra setup.
 * A value without the prefix is returned as-is: rows written before this module
 * (local dev) keep working. If AUTH_SECRET ever changes, decryption throws and
 * the sync reports "reconnect this shop" — a visible failure, never a silent one.
 */

const PREFIX = 'enc:v1:'
const TAG_LENGTH = 16

function key(): Buffer {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is not set')
  return Buffer.from(hkdfSync('sha256', secret, 'shop-credentials', 'v1', 32))
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tagged = Buffer.concat([encrypted, cipher.getAuthTag()])
  return `${PREFIX}${iv.toString('base64')}:${tagged.toString('base64')}`
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored

  const [ivPart, taggedPart] = stored.slice(PREFIX.length).split(':')
  const iv = Buffer.from(ivPart, 'base64')
  const tagged = Buffer.from(taggedPart ?? '', 'base64')

  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tagged.subarray(tagged.length - TAG_LENGTH))
  return Buffer.concat([
    decipher.update(tagged.subarray(0, tagged.length - TAG_LENGTH)),
    decipher.final(),
  ]).toString('utf8')
}
```

- [ ] **Step 1.4: Run it — must pass**

```powershell
npx vitest run src/lib/secrets.test.ts
```
Expected: 5 passed.

- [ ] **Step 1.5: Commit**

```powershell
git add src/lib/secrets.ts src/lib/secrets.test.ts
git commit -m "feat: encrypt shop API keys at rest with a key derived from AUTH_SECRET"
```

---

### Task 2: PATCH /api/shops/[id] — blank keeps, values encrypt

**Files:**
- Modify: `src/app/api/shops/[id]/route.ts`
- Test: `src/app/api/shops/[id]/route.test.ts` (create)

- [ ] **Step 2.1: Write the failing test**

```ts
// src/app/api/shops/[id]/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { PATCH } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { decryptSecret } = await import('@/lib/secrets')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/shops/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[test]' } } })
}
beforeEach(cleanup)
afterEach(cleanup)

describe('PATCH /api/shops/[id]', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    const shop = await db.shop.create({ data: { name: 'Patch [test]', currency: 'NOK' } })
    expect((await patch(shop.id, { wooUrl: '', wooKey: '', wooSecret: '' })).status).toBe(403)
  })

  it('stores keys encrypted, never as pasted', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Patch [test]', currency: 'NOK' } })

    const res = await patch(shop.id, {
      wooUrl: 'https://mazzetti.no', wooKey: 'ck_live_1', wooSecret: 'cs_live_1',
    })
    expect(res.status).toBe(200)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.wooUrl).toBe('https://mazzetti.no')
    expect(saved.wooKey).not.toBe('ck_live_1')
    expect(saved.wooKey!.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(saved.wooKey!)).toBe('ck_live_1')
    expect(decryptSecret(saved.wooSecret!)).toBe('cs_live_1')
  })

  it('a blank field keeps the stored value — saving must never wipe keys', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Patch [test]', currency: 'NOK' } })
    await patch(shop.id, { wooUrl: 'https://mazzetti.no', wooKey: 'ck_1', wooSecret: 'cs_1' })

    // The day-one bug: the edit form posts blank key fields and the old code
    // wrote `'' || null` — erasing the connection it claimed to save.
    const res = await patch(shop.id, { wooUrl: 'https://mazzetti.se', wooKey: '', wooSecret: '' })
    expect(res.status).toBe(200)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.wooUrl).toBe('https://mazzetti.se') // the typed value updated
    expect(decryptSecret(saved.wooKey!)).toBe('ck_1') // the blanks kept
    expect(decryptSecret(saved.wooSecret!)).toBe('cs_1')
  })
})
```

- [ ] **Step 2.2: Run it — the "blank keeps" and "encrypted" tests must fail**

```powershell
npx vitest run src/app/api/shops/[id]/route.test.ts
```
Expected: FAIL — `wooKey` equals `'ck_live_1'` (stored raw), and blanks null the keys.

- [ ] **Step 2.3: Rewrite the route's data mapping**

Replace the `db.shop.update` call in `src/app/api/shops/[id]/route.ts` and add the import:

```ts
import { encryptSecret } from '@/lib/secrets'
```

```ts
    // An empty field means "leave what is saved". The form posts blank key
    // fields on every edit, so writing them through would wipe the connection.
    const { wooUrl, wooKey, wooSecret } = parsed.data
    await db.shop.update({
      where: { id },
      data: {
        ...(wooUrl ? { wooUrl } : {}),
        ...(wooKey ? { wooKey: encryptSecret(wooKey) } : {}),
        ...(wooSecret ? { wooSecret: encryptSecret(wooSecret) } : {}),
      },
    })
```

The zod `Body` schema stays exactly as it is.

- [ ] **Step 2.4: Run it — must pass**

```powershell
npx vitest run src/app/api/shops/[id]/route.test.ts
```
Expected: 3 passed.

- [ ] **Step 2.5: Commit**

```powershell
git add "src/app/api/shops/[id]/route.ts" "src/app/api/shops/[id]/route.test.ts"
git commit -m "fix: saving a shop never wipes its keys, and keys are stored encrypted"
```

---

### Task 3: POST /api/shops — create a shop

**Files:**
- Modify: `src/app/api/shops/route.ts` (add POST; GET stays untouched)
- Test: `src/app/api/shops/route.test.ts` (create)

- [ ] **Step 3.1: Write the failing test**

```ts
// src/app/api/shops/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { POST } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/shops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[test]' } } })
}
beforeEach(cleanup)
afterEach(cleanup)

describe('POST /api/shops', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({ name: 'Nope [test]', currency: 'NOK' })).status).toBe(403)
  })

  it('creates a shop with no credentials, ready to connect', async () => {
    await asAdmin()
    const res = await post({ name: 'Panetti Norway [test]', currency: 'nok' })
    expect(res.status).toBe(200)

    const saved = await db.shop.findFirstOrThrow({ where: { name: 'Panetti Norway [test]' } })
    expect(saved.currency).toBe('NOK') // uppercased
    expect(saved.wooUrl).toBeNull()
    expect(saved.active).toBe(true)
  })

  it('rejects an empty name', async () => {
    await asAdmin()
    expect((await post({ name: '   ', currency: 'NOK' })).status).toBe(400)
  })

  it('rejects a made-up currency code', async () => {
    await asAdmin()
    expect((await post({ name: 'Bad Currency [test]', currency: 'KRONER' })).status).toBe(400)
  })
})
```

- [ ] **Step 3.2: Run it — must fail (no POST export)**

```powershell
npx vitest run src/app/api/shops/route.test.ts
```
Expected: FAIL — `POST` is undefined.

- [ ] **Step 3.3: Add POST to the route**

Append to `src/app/api/shops/route.ts` (add `import { z } from 'zod'` at the top):

```ts
const CreateBody = z.object({
  name: z.string().trim().min(1, 'Give the shop a name').max(60, 'Keep the name under 60 characters'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Pick the store's currency"),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = CreateBody.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400 },
      )
    }

    const shop = await db.shop.create({
      data: { name: parsed.data.name, currency: parsed.data.currency },
    })
    return NextResponse.json({ shop: { id: shop.id, name: shop.name, currency: shop.currency } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not add the shop' }, { status: 500 })
  }
}
```

(zod v4: `.trim()` / `.toUpperCase()` are overwrites, so chaining `.regex()` after them works.)

- [ ] **Step 3.4: Run it — must pass**

```powershell
npx vitest run src/app/api/shops/route.test.ts
```
Expected: 4 passed.

- [ ] **Step 3.5: Commit**

```powershell
git add src/app/api/shops/route.ts src/app/api/shops/route.test.ts
git commit -m "feat: POST /api/shops creates a shop ready to connect"
```

---

### Task 4: Sync decrypts keys and refuses to lie

**Files:**
- Modify: `src/lib/woo/client.ts` (capped pull throws)
- Modify: `src/lib/woo/sync.ts` (decrypt + reconnect message)
- Test: `src/lib/woo/client.test.ts` (create)
- Test: `src/lib/woo/sync.test.ts` (create)

- [ ] **Step 4.1: Write the failing client test**

```ts
// src/lib/woo/client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchOrders } from './client'

const CREDS = { url: 'https://shop.example', key: 'ck', secret: 'cs' }

function page(n: number) {
  return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchOrders', () => {
  it('collects pages until a short one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(37))
    vi.stubGlobal('fetch', fetchMock)

    const orders = await fetchOrders(CREDS, null)
    expect(orders).toHaveLength(137)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws instead of silently truncating a 5,000+ order store', async () => {
    // 50 full pages and still more coming: stopping quietly would mark the
    // sync done while orders are missing. Refuse loudly instead.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(100)))

    await expect(fetchOrders(CREDS, null)).rejects.toThrow(/over 5,000 orders/)
  })
})
```

- [ ] **Step 4.2: Run it — the cap test must fail**

```powershell
npx vitest run src/lib/woo/client.test.ts
```
Expected: first test passes already; the cap test FAILS (resolves with 5000 instead of throwing).

- [ ] **Step 4.3: Make the cap throw**

In `src/lib/woo/client.ts`, replace the end of the `for` loop body:

```ts
    const batch = (await res.json()) as WooOrder[]
    all.push(...batch)
    if (batch.length < 100) return all // last page

    if (page === 50) {
      // 50 full pages and more behind them. Stopping here quietly would move
      // the sync watermark past orders we never fetched — refuse instead.
      throw new Error(
        'This store returned over 5,000 orders in one pull. Sync stopped so nothing ' +
          'is skipped silently — this store needs a staged first sync.',
      )
    }
```

and change the final `return all` after the loop to `return all` only if still reachable — the function now returns from inside the loop, so the code after the loop becomes unreachable; end the function with the loop followed by `return all` removed (TypeScript will flag unreachable code — the loop itself is the body). The finished function:

```ts
export async function fetchOrders(creds: WooCredentials, since: Date | null): Promise<WooOrder[]> {
  const all: WooOrder[] = []
  const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')

  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      orderby: 'date',
      order: 'asc',
    })
    if (since) params.set('modified_after', since.toISOString().slice(0, 19))

    const res = await fetch(`${creds.url.replace(/\/$/, '')}/wp-json/wc/v3/orders?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
    })

    if (!res.ok) {
      throw new Error(`WooCommerce responded ${res.status}: ${await res.text()}`)
    }

    const batch = (await res.json()) as WooOrder[]
    all.push(...batch)
    if (batch.length < 100) return all // last page

    if (page === 50) {
      // 50 full pages and more behind them. Stopping here quietly would move
      // the sync watermark past orders we never fetched — refuse instead.
      throw new Error(
        'This store returned over 5,000 orders in one pull. Sync stopped so nothing ' +
          'is skipped silently — this store needs a staged first sync.',
      )
    }
  }

  return all
}
```

- [ ] **Step 4.4: Run it — must pass**

```powershell
npx vitest run src/lib/woo/client.test.ts
```
Expected: 2 passed.

- [ ] **Step 4.5: Write the failing sync test**

```ts
// src/lib/woo/sync.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { syncShop } from './sync'
import { encryptSecret } from '../secrets'
import { db } from '../db'

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[test]' } } })
}
beforeEach(cleanup)
afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
})

const emptyPage = () =>
  new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('syncShop', () => {
  it('decrypts stored keys and syncs (0 orders is a fine sync)', async () => {
    const shop = await db.shop.create({
      data: {
        name: 'Sync [test]',
        currency: 'NOK',
        wooUrl: 'https://shop.example',
        wooKey: encryptSecret('ck_real'),
        wooSecret: encryptSecret('cs_real'),
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(emptyPage())
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(true)
    expect(result.ordersSynced).toBe(0)

    // The decrypted key — not the enc:v1: blob — must reach WooCommerce.
    const auth = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('ck_real:cs_real').toString('base64')}`)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).not.toBeNull()
  })

  it('reports unreadable keys as "reconnect", and never calls the store', async () => {
    const shop = await db.shop.create({
      data: {
        name: 'Sync bad key [test]',
        currency: 'NOK',
        wooUrl: 'https://shop.example',
        wooKey: 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        wooSecret: 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/reconnect this shop/)
    expect(fetchMock).not.toHaveBeenCalled()

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).toBeNull() // watermark untouched on failure
  })
})
```

- [ ] **Step 4.6: Run it — must fail**

```powershell
npx vitest run src/lib/woo/sync.test.ts
```
Expected: FAIL — first test's Authorization contains the `enc:v1:` blob (sync sends the encrypted key as-is); second test calls fetch and errors with a Woo message, not "reconnect".

- [ ] **Step 4.7: Decrypt in syncShop**

In `src/lib/woo/sync.ts`, add the import and replace the credentials block:

```ts
import { decryptSecret } from '../secrets'
```

Replace:

```ts
  try {
    const orders = await fetchOrders(
      { url: shop.wooUrl, key: shop.wooKey, secret: shop.wooSecret },
      shop.lastSyncAt,
    )
```

with:

```ts
  let key: string
  let secret: string
  try {
    key = decryptSecret(shop.wooKey)
    secret = decryptSecret(shop.wooSecret)
  } catch {
    // Only possible if AUTH_SECRET changed after the shop was connected.
    return { ...base, ok: false, ordersSynced: 0, error: "Saved keys can't be read — reconnect this shop." }
  }

  try {
    const orders = await fetchOrders({ url: shop.wooUrl, key, secret }, shop.lastSyncAt)
```

- [ ] **Step 4.8: Run it — must pass, then run the whole woo folder**

```powershell
npx vitest run src/lib/woo
```
Expected: client, sync and map suites all pass.

- [ ] **Step 4.9: Commit**

```powershell
git add src/lib/woo/client.ts src/lib/woo/client.test.ts src/lib/woo/sync.ts src/lib/woo/sync.test.ts
git commit -m "fix: sync decrypts stored keys and refuses to truncate or lie"
```

---

### Task 5: ShopsClient — Add shop, honest sync, honest labels

**Files:**
- Modify: `src/app/settings/shops/ShopsClient.tsx`
- Test: `src/app/settings/shops/ShopsClient.test.tsx` (create)

- [ ] **Step 5.1: Check nothing else asserts the old copy**

```powershell
git grep -n "Sample data" -- ":!docs"
```
Expected: only `ShopsClient.tsx`. If an E2E spec matches, update its assertion to `Not connected` in the same commit.

- [ ] **Step 5.2: Write the failing component test**

```tsx
// src/app/settings/shops/ShopsClient.test.tsx
// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ShopsClient } from './ShopsClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/shops',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

afterEach(() => vi.unstubAllGlobals())

const SHOP = {
  id: 's1', name: 'Panetti Norway', currency: 'NOK', wooUrl: '', connected: false, lastSyncAt: null,
}

function renderShops(shops = [SHOP]) {
  return render(
    <ToastProvider>
      <ShopsClient email="admin@test.local" shops={shops} />
    </ToastProvider>,
  )
}

describe('ShopsClient', () => {
  it('labels an unconnected shop "Not connected", not "Sample data"', () => {
    renderShops()
    expect(screen.getByText('Not connected')).toBeTruthy()
    expect(screen.queryByText('Sample data')).toBeNull()
  })

  it('a failed sync says so — never "Synced 0 orders"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Sync failed' }), { status: 500 }),
    ))
    renderShops()

    fireEvent.click(screen.getByRole('button', { name: 'Sync all' }))

    await waitFor(() => {
      expect(screen.getByText('Sync failed')).toBeTruthy()
    })
    expect(screen.queryByText(/Synced 0 orders/)).toBeNull()
  })

  it('offers an Add shop button and validates before posting', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderShops([])

    fireEvent.click(screen.getByRole('button', { name: 'Add shop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.getByText('Give the shop a name and pick its currency')).toBeTruthy()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5.3: Run it — must fail**

```powershell
npx vitest run src/app/settings/shops/ShopsClient.test.tsx
```
Expected: FAIL — "Not connected" not found; no "Add shop" button; failed sync shows "Synced 0 orders from 0 shop(s)".

- [ ] **Step 5.4: Rework ShopsClient**

In `src/app/settings/shops/ShopsClient.tsx`:

1. Imports: add `useMemo` to the react import; add:

```ts
import { SearchableSelect } from '@/components/SearchableSelect'
import { allCurrencies } from '@/lib/currencies'
```

2. Inside `ShopsClient`, add state + toast:

```ts
const [adding, setAdding] = useState(false)
const toast = useToast()
```

3. Replace `syncAll` with:

```ts
  async function syncAll() {
    setSyncing(true)
    setMessage('')
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      if (!res.ok) {
        // A failed sync must say so — "Synced 0 orders" would be a lie.
        toast.error((await res.json().catch(() => null))?.error ?? 'Sync failed')
        return
      }
      const data = await res.json()

      const results: { shopName: string; ok: boolean; ordersSynced: number; error?: string }[] =
        data.results ?? []
      const good = results.filter((r) => r.ok)
      const bad = results.filter((r) => !r.ok)

      setMessage(
        `Synced ${good.reduce((n, r) => n + r.ordersSynced, 0)} orders from ${good.length} shop(s).` +
          (bad.length ? ` Failed: ${bad.map((r) => `${r.shopName} (${r.error})`).join(', ')}` : ''),
      )
      router.refresh()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSyncing(false)
    }
  }
```

4. Header: subtitle becomes `"Connect each WooCommerce store with its API keys — synced orders update every screen."` and the children become two buttons:

```tsx
      <PageHeader
        title="Shops"
        subtitle="Connect each WooCommerce store with its API keys — synced orders update every screen."
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAdding(true)}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
          >
            Add shop
          </button>
          <button
            onClick={syncAll}
            disabled={syncing}
            className="rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {syncing ? 'Syncing…' : 'Sync all'}
          </button>
        </div>
      </PageHeader>
```

5. Badge: replace the `Sample data` span content with `Not connected` (same classes).

6. Render the new modal next to the Connect one:

```tsx
      {adding && (
        <AddShopModal
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            router.refresh()
          }}
        />
      )}
```

7. New component at the bottom of the file (same style as `ConnectModal`):

```tsx
function AddShopModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const options = useMemo(
    () => allCurrencies().map((c) => ({ value: c.code, label: c.label })),
    [],
  )

  async function save() {
    if (!name.trim() || !currency) {
      toast.error('Give the shop a name and pick its currency')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/shops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), currency }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not add the shop')
        return
      }
      toast.success(`${name.trim()} added — now connect it`)
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-[var(--radius-card)] bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-bold text-ink">Add shop</h2>
        <p className="mt-1 text-xs text-muted">
          Name it the way you say it — "Panetti Norway" — and pick the currency it trades in.
        </p>

        <label className="mt-4 block text-xs font-medium text-muted">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Panetti Norway"
          className="mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm" />

        <label className="mt-3 block text-xs font-medium text-muted">Currency</label>
        <div className="mt-1">
          <SearchableSelect
            value={currency}
            options={options}
            onChange={setCurrency}
            ariaLabel="Currency"
            placeholder="Pick a currency…"
          />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-muted">Cancel</button>
          <button onClick={save} disabled={busy}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

8. In `ConnectModal`: key and secret placeholders become conditional, and first-time connects must be complete. Add `const canKeepBlank = shop.connected` at the top of the component, change the two placeholders to `placeholder={canKeepBlank ? 'saved — leave blank to keep' : 'ck_…'}` (and `'cs_…'`), and add to the top of `save()`:

```ts
    if (!shop.connected && (!wooUrl || !wooKey || !wooSecret)) {
      toast.error('Fill in the store URL and both keys')
      return
    }
```

- [ ] **Step 5.5: Run it — must pass**

```powershell
npx vitest run src/app/settings/shops/ShopsClient.test.tsx
```
Expected: 3 passed.

- [ ] **Step 5.6: Commit**

```powershell
git add src/app/settings/shops/ShopsClient.tsx src/app/settings/shops/ShopsClient.test.tsx
git commit -m "feat: Add shop button, honest sync reporting, Not connected labels"
```

---

### Task 6: Engine reports VAT (`taxes` figure)

**Files:**
- Modify: `src/lib/metrics/types.ts`
- Modify: `src/lib/metrics/engine.ts`
- Test: `src/lib/metrics/engine.test.ts` (extend)

- [ ] **Step 6.1: Write the failing test** — add to the existing `describe('computeMetrics')` block (the `order()` fixture already sets `taxTotal: 22500`):

```ts
  it('reports VAT for the period without letting it touch profit', () => {
    const res = computeMetrics({
      shops: [shops[0]],
      orders: [
        order(),
        order({ id: 'refunded', status: 'refunded' }), // contributes no tax either
      ],
      expenses: [], costs, rates,
      displayCurrency: 'NOK', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.taxes).toBe(22500) // the one live order's VAT
    expect(res.total.netProfit).toBe(73000) // unchanged — VAT is not a cost
    expect(res.byShop[0].taxes).toBe(22500)
  })

  it('converts VAT at each order own-date rate like every other figure', () => {
    const res = computeMetrics({
      shops: [shops[0]], orders: [order()], expenses: [], costs, rates,
      displayCurrency: 'USD', from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })
    expect(res.total.taxes).toBe(2250) // 22 500 øre x 0.10
  })
```

- [ ] **Step 6.2: Run it — must fail (property does not exist / undefined)**

```powershell
npx vitest run src/lib/metrics/engine.test.ts
```
Expected: FAIL — `taxes` is `undefined`.

- [ ] **Step 6.3: Implement**

`src/lib/metrics/types.ts` — in `Figures`, after `shippingCharged`:

```ts
  taxes: number // VAT collected — reported, never revenue and never a cost
```

and in `ZERO_FIGURES`, after `shippingCharged: 0,`:

```ts
  taxes: 0,
```

`src/lib/metrics/engine.ts` — in the per-shop block, after the `shippingCharged` line:

```ts
    const taxes = sum(shopOrders.map((o) => conv(o.taxTotal, o)))
```

add `taxes,` to the returned shop object (after `shippingCharged,`), and in `totalOf`, after `shippingCharged:`:

```ts
    taxes: add((r) => r.taxes),
```

- [ ] **Step 6.4: Run the engine suite + typecheck — must pass**

```powershell
npx vitest run src/lib/metrics
npx tsc --noEmit
```
Expected: all metrics tests pass; tsc exit 0 (this proves every `Figures` construction site was updated).

- [ ] **Step 6.5: Commit**

```powershell
git add src/lib/metrics/types.ts src/lib/metrics/engine.ts src/lib/metrics/engine.test.ts
git commit -m "feat: the engine reports VAT for the period, outside the profit math"
```

---

### Task 7: Compare table shows the full column set

**Files:**
- Modify: `src/components/dashboard/CompareTable.tsx` (the `COLUMNS` array only)
- Test: `src/components/dashboard/CompareTable.test.tsx` (create)

- [ ] **Step 7.1: Write the failing test**

```tsx
// src/components/dashboard/CompareTable.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CompareTable } from './CompareTable'
import { ZERO_FIGURES } from '@/lib/metrics/types'

const row = {
  ...ZERO_FIGURES,
  shopId: 's1',
  shopName: 'Panetti Norway',
  orders: 2,
  grossSales: 100000,
  discounts: 10000,
  netSales: 90000,
  shippingCharged: 5000,
  netRevenue: 95000,
  taxes: 22500,
  netProfit: 73000,
  netMargin: 73000 / 95000,
}

describe('CompareTable', () => {
  it('shows the full BeProfit-style column set', () => {
    render(<CompareTable result={{ displayCurrency: 'NOK', byShop: [row], total: row }} />)

    for (const label of [
      'Orders', 'Gross sales', 'Discounts', 'Net sales', 'Shipping', 'Net revenue',
      'COGS', 'Op. expenses', 'Commission', 'Net profit', 'Margin', 'Taxes',
    ]) {
      expect(screen.getByRole('button', { name: `Sort by ${label}` })).toBeTruthy()
    }
  })
})
```

- [ ] **Step 7.2: Run it — must fail (new columns missing)**

```powershell
npx vitest run src/components/dashboard/CompareTable.test.tsx
```
Expected: FAIL — no "Sort by Gross sales" button.

- [ ] **Step 7.3: Replace the `COLUMNS` array**

```ts
const COLUMNS: Column[] = [
  { key: 'orders', label: 'Orders' },
  { key: 'grossSales', label: 'Gross sales', money: true, hint: 'Before discounts, excl. VAT' },
  { key: 'discounts', label: 'Discounts', money: true, hint: 'Coupon and code discounts, excl. VAT' },
  { key: 'netSales', label: 'Net sales', money: true, hint: 'After discounts — the commission base' },
  { key: 'shippingCharged', label: 'Shipping', money: true, hint: 'Shipping charged to customers, excl. VAT' },
  { key: 'netRevenue', label: 'Net revenue', money: true, hint: 'Net sales + shipping' },
  { key: 'cogs', label: 'COGS', money: true, hint: 'Product cost + handling' },
  { key: 'operationalExpenses', label: 'Op. expenses', money: true },
  { key: 'commission', label: 'Commission', money: true },
  { key: 'netProfit', label: 'Net profit', money: true, tone: true },
  { key: 'netMargin', label: 'Margin', percent: true, tone: true },
  { key: 'taxes', label: 'Taxes', money: true, hint: 'VAT collected — passed on to the tax office, not income or cost' },
]
```

- [ ] **Step 7.4: Run it — must pass**

```powershell
npx vitest run src/components/dashboard/CompareTable.test.tsx
```
Expected: 1 passed.

- [ ] **Step 7.5: Commit**

```powershell
git add src/components/dashboard/CompareTable.tsx src/components/dashboard/CompareTable.test.tsx
git commit -m "feat: compare shops shows the BeProfit-style column set"
```

---

### Task 8: Full verification

- [ ] **Step 8.1: Whole suite, typecheck, build**

```powershell
npm test
npx tsc --noEmit
npm run build
```
Expected: every test file passes — 38 files (31 existing + 7 new), tsc exit 0, build compiles. Any failure: stop and fix before continuing.

- [ ] **Step 8.2: E2E** (needs the dev server per `playwright.config`)

```powershell
npm run test:e2e
```
Expected: all E2E pass (18 today; update any that asserted the old "Sample data" copy — Step 5.1 already located them).

- [ ] **Step 8.3: Verify the real flow in a browser** (dev server + seeded local DB): log in as the admin seed user → Settings → Shops → Add shop "Verify Shop [test]" / NOK → row appears "Not connected" → Connect it with dummy keys → badge flips to Connected → Sync all → the summary line names the shop as failed (dummy URL — that's the honest reporting working). Delete the row afterwards:

```powershell
npx tsx --env-file=.env -e "import('./src/lib/db').then(async ({db}) => { await db.shop.deleteMany({ where: { name: { contains: '[test]' } } }); process.exit(0) })"
```

---

### Task 9: Ship

- [ ] **Step 9.1:** Merge to main (fast-forward is fine), push — Vercel deploys `main` automatically:

```powershell
git checkout main
git merge feat/shop-connection
git push origin main
```

- [ ] **Step 9.2:** Prove the deploy landed — the new POST route is the cleanest signal (yesterday it would 405, now it must 403 for an anonymous caller):

```powershell
curl.exe -s -o NUL -w "%{http_code}" -X POST https://panetti.vercel.app/api/shops
```
Expected: `403` (was `405` before this change). Give Vercel ~2 minutes after the push.

- [ ] **Step 9.3:** Report to the user: what shipped, the one-line client message, and that Philip can now Add shop → Connect → Sync all himself.
