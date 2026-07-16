# Ambassador Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create and manage ambassadors, and let an ambassador claim a login from an invite link — so the discount code earns commission from the next sync, and the person logs in later.

**Architecture:** No schema change. Invite links are stateless JWTs signed with the existing `AUTH_SECRET` via `jose`, carrying only an ambassador id and a 7-day expiry. Single-use and revocation are derived from facts already in the database (does a login exist? is the ambassador active?) rather than stored token state.

**Tech Stack:** Next.js 16 App Router, Prisma 6 on PostgreSQL, `jose` (JWT), `bcryptjs`, `zod`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-16-ambassador-onboarding-design.md`

---

## Proven before planning

Two spikes were run and deleted; the plan depends on both results:

1. **Route handlers are callable from Vitest.** `import { POST } from './route'` then `await POST(new Request(...))` works, and reaches the real database.
2. **`currentUser()` can be driven from a test** by mocking `next/headers` and signing a **real** session with `signSession()`. Anonymous → refused, AMBASSADOR → refused, ADMIN → 200.

This is why the security tests below hit real routes rather than the `guard.ts` helpers (which have zero production callers).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/auth/invite.ts` | **Create.** Sign/verify invite tokens. Mirrors `session.ts`. |
| `src/lib/auth/invite.test.ts` | **Create.** Token unit tests. |
| `src/app/api/ambassadors/route.ts` | **Create.** `GET` list (+ invite links), `POST` create. |
| `src/app/api/ambassadors/route.test.ts` | **Create.** Admin guard + percent→fraction. |
| `src/app/api/ambassadors/[id]/route.ts` | **Create.** `PATCH` name / rate / active. |
| `src/app/api/ambassadors/[id]/route.test.ts` | **Create.** Partial updates. |
| `src/app/api/ambassadors/[id]/codes/route.ts` | **Create.** `POST` add, `DELETE` remove. |
| `src/app/api/ambassadors/[id]/codes/route.test.ts` | **Create.** Refuses deleting the last code. |
| `src/app/api/invite/route.ts` | **Create.** `POST` redeem. The only public route. |
| `src/app/api/invite/route.test.ts` | **Create.** All four guards. Security-critical. |
| `src/app/api/portal/route.ts` | **Modify.** Fix the rank/total population mismatch. |
| `src/app/api/portal/rank.test.ts` | **Create.** rank ≤ total, always. |
| `src/app/settings/ambassadors/page.tsx` | **Create.** Server wrapper + admin guard. |
| `src/app/settings/ambassadors/AmbassadorsClient.tsx` | **Create.** The admin screen. |
| `src/app/invite/[token]/page.tsx` | **Create.** Server wrapper. |
| `src/app/invite/[token]/InviteClient.tsx` | **Create.** Set-password form. |
| `e2e/ambassador-onboarding.spec.ts` | **Create.** Full journey. |

**The test-session pattern.** `vi.mock` is hoisted per file, so this block is repeated in each admin route test rather than shared. Copy it verbatim:

```ts
const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))
```

---

## Task 1: Invite token module

**Files:**
- Create: `src/lib/auth/invite.ts`
- Test: `src/lib/auth/invite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth/invite.test.ts
import { describe, it, expect } from 'vitest'
import { SignJWT } from 'jose'
import { signInvite, verifyInvite } from './invite'

const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET)

describe('invite tokens', () => {
  it('round-trips an ambassador id', async () => {
    const token = await signInvite('amb-123')
    expect(await verifyInvite(token)).toBe('amb-123')
  })

  it('returns null for a tampered token', async () => {
    const token = await signInvite('amb-123')
    expect(await verifyInvite(token.slice(0, -3) + 'aaa')).toBeNull()
  })

  it('returns null for garbage and for empty input', async () => {
    expect(await verifyInvite('not-a-token')).toBeNull()
    expect(await verifyInvite('')).toBeNull()
  })

  it('returns null for a token signed with a different secret', async () => {
    const foreign = await new SignJWT({ ambassadorId: 'amb-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('ambassador-invite')
      .setExpirationTime('7d')
      .sign(new TextEncoder().encode('a-completely-different-secret-0123456789'))
    expect(await verifyInvite(foreign)).toBeNull()
  })

  it('returns null for an expired token', async () => {
    const expired = await new SignJWT({ ambassadorId: 'amb-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('ambassador-invite')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60) // a minute ago
      .sign(secret())
    expect(await verifyInvite(expired)).toBeNull()
  })

  // A session cookie and an invite are both signed with AUTH_SECRET. Without an
  // audience claim, one would verify as the other.
  it('refuses a SESSION token, even though it is signed with the same secret', async () => {
    const { signSession } = await import('./session')
    const session = await signSession({
      userId: 'u1', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'amb-123',
    })
    expect(await verifyInvite(session)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/invite.test.ts`
Expected: FAIL — `Failed to resolve import "./invite"`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/auth/invite.ts
import { SignJWT, jwtVerify } from 'jose'

/**
 * Invite links and login sessions are both signed with AUTH_SECRET. This claim is
 * what stops one being accepted as the other.
 */
const INVITE_AUDIENCE = 'ambassador-invite'

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET
  if (!value) throw new Error('AUTH_SECRET is not set')
  return new TextEncoder().encode(value)
}

/** A 7-day link carrying only who it is for. Nothing is stored. */
export async function signInvite(ambassadorId: string): Promise<string> {
  return new SignJWT({ ambassadorId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(INVITE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

/** The ambassador id, or null if missing, expired, tampered with, or not an invite. */
export async function verifyInvite(token: string): Promise<string | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: INVITE_AUDIENCE })
    return (payload.ambassadorId as string) ?? null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/invite.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/invite.ts src/lib/auth/invite.test.ts
git commit -m "feat: signed, stateless ambassador invite tokens"
```

---

## Task 2: Ambassadors list + create API

**Files:**
- Create: `src/app/api/ambassadors/route.ts`
- Test: `src/app/api/ambassadors/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/ambassadors/route.test.ts
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
  POST(new Request('http://localhost/api/ambassadors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

const EMAIL = 'plan-test-amb@example.local'

async function cleanup() {
  const existing = await db.ambassador.findUnique({ where: { email: EMAIL } })
  if (existing) await db.ambassador.delete({ where: { id: existing.id } })
}

beforeEach(cleanup)
afterEach(cleanup)

describe('GET /api/ambassadors', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await GET()).status).toBe(403)
  })

  it('refuses an ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'u', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'x',
    })
    expect((await GET()).status).toBe(403)
  })

  it('allows an admin', async () => {
    await asAdmin()
    expect((await GET()).status).toBe(200)
  })
})

describe('POST /api/ambassadors', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await post({ name: 'X', email: EMAIL, commissionPercent: 10, code: 'X10' })).status).toBe(403)
  })

  // The whole point of 6.4 in the spec: percent in, fraction stored.
  it('stores 10 percent as the fraction 0.1', async () => {
    await asAdmin()
    const res = await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, code: 'PLANTEST10' })
    expect(res.status).toBe(200)

    const saved = await db.ambassador.findUniqueOrThrow({ where: { email: EMAIL } })
    expect(saved.commissionRate).toBeCloseTo(0.1)
  })

  it('uppercases the code and creates it alongside the ambassador', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 15, code: 'lower10' })

    const saved = await db.ambassador.findUniqueOrThrow({
      where: { email: EMAIL }, include: { codes: true },
    })
    expect(saved.codes).toHaveLength(1)
    expect(saved.codes[0].code).toBe('LOWER10')
    expect(saved.commissionRate).toBeCloseTo(0.15)
  })

  it('rejects a commission percent above 100', async () => {
    await asAdmin()
    expect((await post({ name: 'X', email: EMAIL, commissionPercent: 1000, code: 'X10' })).status).toBe(400)
  })

  it('rejects a duplicate email with 409', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, code: 'DUPE1' })
    const again = await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, code: 'DUPE2' })
    expect(again.status).toBe(409)
  })

  it('gives a new ambassador an invite link, since they have no login yet', async () => {
    await asAdmin()
    await post({ name: 'Plan Test', email: EMAIL, commissionPercent: 10, code: 'INVITE10' })

    const body = await (await GET()).json()
    const row = body.ambassadors.find((a: { email: string }) => a.email === EMAIL)
    expect(row.onboarded).toBe(false)
    expect(row.invitePath).toMatch(/^\/invite\/.+/)
    expect(row.commissionPercent).toBeCloseTo(10) // fraction back out as percent
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/ambassadors/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/ambassadors/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { signInvite } from '@/lib/auth/invite'
import { db } from '@/lib/db'

const Body = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  // The admin types a PERCENT. The column holds a FRACTION. Converted once, here.
  commissionPercent: z.number().min(0).max(100),
  code: z.string().min(1),
})

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
}

export async function GET() {
  try {
    assertAdmin(await currentUser())

    const rows = await db.ambassador.findMany({
      include: { codes: true, user: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
    })

    const ambassadors = await Promise.all(
      rows.map(async (a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        commissionPercent: a.commissionRate * 100,
        active: a.active,
        codes: a.codes.map((c) => ({ id: c.id, code: c.code })),
        onboarded: a.user !== null,
        // Never mint a link for someone who already has a login.
        invitePath: a.user ? null : `/invite/${await signInvite(a.id)}`,
      })),
    )

    return NextResponse.json({ ambassadors })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load ambassadors' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Check the name, email, rate and code' }, { status: 400 })
    }
    const { name, email, commissionPercent, code } = parsed.data

    const ambassador = await db.ambassador.create({
      data: {
        name,
        email: email.toLowerCase(),
        commissionRate: commissionPercent / 100,
        codes: { create: { code: code.toUpperCase() } },
      },
    })

    return NextResponse.json({ ok: true, id: ambassador.id })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: 'That email or discount code is already taken' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Could not create the ambassador' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/ambassadors/route.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ambassadors/route.ts src/app/api/ambassadors/route.test.ts
git commit -m "feat: list and create ambassadors (admin only)"
```

---

## Task 3: Update an ambassador

**Files:**
- Create: `src/app/api/ambassadors/[id]/route.ts`
- Test: `src/app/api/ambassadors/[id]/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/ambassadors/[id]/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { PATCH } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const EMAIL = 'plan-patch-amb@example.local'
let id = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/ambassadors/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

beforeEach(async () => {
  const existing = await db.ambassador.findUnique({ where: { email: EMAIL } })
  if (existing) await db.ambassador.delete({ where: { id: existing.id } })
  const a = await db.ambassador.create({
    data: { name: 'Before', email: EMAIL, commissionRate: 0.1 },
  })
  id = a.id
})

afterEach(async () => {
  const existing = await db.ambassador.findUnique({ where: { email: EMAIL } })
  if (existing) await db.ambassador.delete({ where: { id: existing.id } })
})

describe('PATCH /api/ambassadors/[id]', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await patch({ name: 'Hacked' })).status).toBe(403)
  })

  it('stores a percent as a fraction', async () => {
    await asAdmin()
    expect((await patch({ commissionPercent: 25 })).status).toBe(200)
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.commissionRate).toBeCloseTo(0.25)
  })

  it('leaves absent fields untouched — it is not a full replace', async () => {
    await asAdmin()
    await patch({ name: 'After' })
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.name).toBe('After')
    expect(after.commissionRate).toBeCloseTo(0.1) // untouched
    expect(after.active).toBe(true) // untouched
  })

  it('deactivates', async () => {
    await asAdmin()
    await patch({ active: false })
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.active).toBe(false)
  })

  it('404s for an unknown ambassador', async () => {
    await asAdmin()
    const res = await PATCH(
      new Request('http://localhost/api/ambassadors/nope', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X' }),
      }),
      { params: Promise.resolve({ id: 'does-not-exist' }) },
    )
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/ambassadors/[id]/route.test.ts"`
Expected: FAIL — `Failed to resolve import "./route"`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/ambassadors/[id]/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

// Every field optional: PATCH is a partial update, never a replace.
const Body = z.object({
  name: z.string().min(1).optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  active: z.boolean().optional(),
})

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Check the values' }, { status: 400 })

    const { id } = await params
    const existing = await db.ambassador.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such ambassador' }, { status: 404 })

    const { name, commissionPercent, active } = parsed.data
    await db.ambassador.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(commissionPercent !== undefined && { commissionRate: commissionPercent / 100 }),
        ...(active !== undefined && { active }),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not update the ambassador' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/ambassadors/[id]/route.test.ts"`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/ambassadors/[id]/route.ts" "src/app/api/ambassadors/[id]/route.test.ts"
git commit -m "feat: update an ambassador's name, rate and active flag"
```

---

## Task 4: Manage discount codes

**Files:**
- Create: `src/app/api/ambassadors/[id]/codes/route.ts`
- Test: `src/app/api/ambassadors/[id]/codes/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/ambassadors/[id]/codes/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { POST, DELETE } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const EMAIL = 'plan-codes-amb@example.local'
let id = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const call = (fn: typeof POST | typeof DELETE, body: unknown) =>
  fn(
    new Request('http://localhost/api/ambassadors/x/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

beforeEach(async () => {
  const existing = await db.ambassador.findUnique({ where: { email: EMAIL } })
  if (existing) await db.ambassador.delete({ where: { id: existing.id } })
  const a = await db.ambassador.create({
    data: { name: 'Codes', email: EMAIL, commissionRate: 0.1, codes: { create: { code: 'FIRST10' } } },
  })
  id = a.id
})

afterEach(async () => {
  const existing = await db.ambassador.findUnique({ where: { email: EMAIL } })
  if (existing) await db.ambassador.delete({ where: { id: existing.id } })
})

describe('ambassador codes', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await call(POST, { code: 'X' })).status).toBe(403)
  })

  it('adds a code, uppercased', async () => {
    await asAdmin()
    expect((await call(POST, { code: 'second20' })).status).toBe(200)
    const codes = await db.ambassadorCode.findMany({ where: { ambassadorId: id } })
    expect(codes.map((c) => c.code).sort()).toEqual(['FIRST10', 'SECOND20'])
  })

  it('rejects a code that already exists anywhere with 409', async () => {
    await asAdmin()
    await call(POST, { code: 'TAKEN10' })
    expect((await call(POST, { code: 'TAKEN10' })).status).toBe(409)
  })

  it('removes a code when more than one remains', async () => {
    await asAdmin()
    await call(POST, { code: 'SECOND20' })
    const doomed = await db.ambassadorCode.findFirstOrThrow({ where: { code: 'SECOND20' } })
    expect((await call(DELETE, { codeId: doomed.id })).status).toBe(200)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })

  // An ambassador with no code can never earn again — refuse rather than strand them.
  it('refuses to delete the LAST code', async () => {
    await asAdmin()
    const only = await db.ambassadorCode.findFirstOrThrow({ where: { ambassadorId: id } })
    const res = await call(DELETE, { codeId: only.id })
    expect(res.status).toBe(400)
    expect(await db.ambassadorCode.count({ where: { ambassadorId: id } })).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/ambassadors/[id]/codes/route.test.ts"`
Expected: FAIL — `Failed to resolve import "./route"`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/ambassadors/[id]/codes/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const AddBody = z.object({ code: z.string().min(1) })
const RemoveBody = z.object({ codeId: z.string().min(1) })

type Ctx = { params: Promise<{ id: string }> }

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())

    const parsed = AddBody.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Enter a code' }, { status: 400 })

    const { id } = await params
    const ambassador = await db.ambassador.findUnique({ where: { id } })
    if (!ambassador) return NextResponse.json({ error: 'No such ambassador' }, { status: 404 })

    // Stored uppercase: sync.ts uppercases the coupon before looking it up.
    await db.ambassadorCode.create({
      data: { ambassadorId: id, code: parsed.data.code.toUpperCase() },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: 'That code is already in use' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Could not add the code' }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())

    const parsed = RemoveBody.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Which code?' }, { status: 400 })

    const { id } = await params
    const remaining = await db.ambassadorCode.count({ where: { ambassadorId: id } })
    if (remaining <= 1) {
      return NextResponse.json(
        { error: 'An ambassador must keep at least one code, or they can never earn again' },
        { status: 400 },
      )
    }

    await db.ambassadorCode.deleteMany({ where: { id: parsed.data.codeId, ambassadorId: id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not remove the code' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/ambassadors/[id]/codes/route.test.ts"`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/ambassadors/[id]/codes/route.ts" "src/app/api/ambassadors/[id]/codes/route.test.ts"
git commit -m "feat: add and remove ambassador discount codes"
```

---

## Task 5: Redeem an invite — SECURITY CRITICAL

**Files:**
- Create: `src/app/api/invite/route.ts`
- Test: `src/app/api/invite/route.test.ts`

This route is **public** — no session required — so it needs no `next/headers` mock. Its four guards are the entire security model.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/invite/route.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { POST } from './route'
import { signInvite } from '@/lib/auth/invite'
import { signSession } from '@/lib/auth/session'
import { db } from '@/lib/db'

const EMAIL_A = 'plan-invite-a@example.local'
const EMAIL_B = 'plan-invite-b@example.local'
let ambA = ''
let ambB = ''

const redeem = (body: unknown) =>
  POST(new Request('http://localhost/api/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

async function wipe() {
  for (const email of [EMAIL_A, EMAIL_B]) {
    const found = await db.ambassador.findUnique({ where: { email } })
    if (found) await db.ambassador.delete({ where: { id: found.id } }) // cascades to codes + user
  }
}

beforeEach(async () => {
  await wipe()
  ambA = (await db.ambassador.create({
    data: { name: 'A', email: EMAIL_A, commissionRate: 0.1 },
  })).id
  ambB = (await db.ambassador.create({
    data: { name: 'B', email: EMAIL_B, commissionRate: 0.1 },
  })).id
})

afterEach(wipe)

describe('POST /api/invite — guard 1: the token itself', () => {
  it('rejects garbage', async () => {
    expect((await redeem({ token: 'nonsense', password: 'longenough1' })).status).toBe(400)
  })

  it('rejects a session token being passed off as an invite', async () => {
    const session = await signSession({
      userId: 'u', email: 'x@y.z', role: 'AMBASSADOR', ambassadorId: ambA,
    })
    expect((await redeem({ token: session, password: 'longenough1' })).status).toBe(400)
    expect(await db.user.findUnique({ where: { email: EMAIL_A } })).toBeNull()
  })

  it('rejects a password under 8 characters', async () => {
    const token = await signInvite(ambA)
    expect((await redeem({ token, password: 'short' })).status).toBe(400)
    expect(await db.user.findUnique({ where: { email: EMAIL_A } })).toBeNull()
  })
})

describe('POST /api/invite — guard 2: the ambassador exists', () => {
  it('rejects a token for a deleted ambassador', async () => {
    const token = await signInvite(ambA)
    await db.ambassador.delete({ where: { id: ambA } })
    expect((await redeem({ token, password: 'longenough1' })).status).toBe(400)
  })
})

describe('POST /api/invite — guard 3: active (this is revocation)', () => {
  it('rejects the link of a deactivated ambassador', async () => {
    const token = await signInvite(ambA)
    await db.ambassador.update({ where: { id: ambA }, data: { active: false } })

    expect((await redeem({ token, password: 'longenough1' })).status).toBe(400)
    expect(await db.user.findUnique({ where: { email: EMAIL_A } })).toBeNull()
  })
})

describe('POST /api/invite — guard 4: single use', () => {
  it('refuses a second redemption of the same link', async () => {
    const token = await signInvite(ambA)
    expect((await redeem({ token, password: 'longenough1' })).status).toBe(200)

    const again = await redeem({ token, password: 'different2' })
    expect(again.status).toBe(409)
    expect(await db.user.count({ where: { email: EMAIL_A } })).toBe(1)
  })

  it("a token for A can never create a login for B", async () => {
    const tokenForA = await signInvite(ambA)
    await redeem({ token: tokenForA, password: 'longenough1' })

    const created = await db.user.findUniqueOrThrow({ where: { email: EMAIL_A } })
    expect(created.ambassadorId).toBe(ambA)
    expect(created.ambassadorId).not.toBe(ambB)
    expect(await db.user.findUnique({ where: { email: EMAIL_B } })).toBeNull()
  })
})

describe('POST /api/invite — the happy path', () => {
  it('creates an AMBASSADOR login, signs them in, and sends them to the portal', async () => {
    const token = await signInvite(ambA)
    const res = await redeem({ token, password: 'longenough1' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, redirectTo: '/portal' })
    expect(res.headers.get('set-cookie')).toContain('ecom_session=')

    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL_A } })
    expect(user.role).toBe('AMBASSADOR')
    expect(user.ambassadorId).toBe(ambA)
    expect(user.passwordHash).not.toBe('longenough1') // hashed, never stored raw
  })

  it('stores a hash that actually verifies the chosen password', async () => {
    const { checkPassword } = await import('@/lib/auth/password')
    const token = await signInvite(ambA)
    await redeem({ token, password: 'longenough1' })

    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL_A } })
    expect(await checkPassword('longenough1', user.passwordHash)).toBe(true)
    expect(await checkPassword('wrong-password', user.passwordHash)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/invite/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/invite/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyInvite } from '@/lib/auth/invite'
import { hashPassword } from '@/lib/auth/password'
import { SESSION_COOKIE, signSession } from '@/lib/auth/session'
import { db } from '@/lib/db'

const Body = z.object({ token: z.string().min(1), password: z.string().min(8) })

/**
 * The only public write in the app. Four guards, in order. Guards 3 and 4 are
 * revocation and single-use, and neither needs stored state — they read facts
 * the database already holds.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Choose a password of at least 8 characters' }, { status: 400 })
  }

  // 1. Signature, expiry, and audience — a session token will not pass.
  const ambassadorId = await verifyInvite(parsed.data.token)
  if (!ambassadorId) {
    return NextResponse.json({ error: 'This invite link has expired. Ask for a new one.' }, { status: 400 })
  }

  const ambassador = await db.ambassador.findUnique({
    where: { id: ambassadorId },
    include: { user: { select: { id: true } } },
  })

  // 2. Still exists. 3. Still active — deactivating IS revocation.
  // One message for both: a stranger holding a dead link learns nothing.
  if (!ambassador || !ambassador.active) {
    return NextResponse.json({ error: 'This invite is no longer valid.' }, { status: 400 })
  }

  // 4. Single use — a redeemed link is dead, because the login now exists.
  if (ambassador.user) {
    return NextResponse.json({ error: 'You already have a login. Sign in instead.' }, { status: 409 })
  }

  const user = await db.user.create({
    data: {
      email: ambassador.email,
      passwordHash: await hashPassword(parsed.data.password),
      role: 'AMBASSADOR',
      ambassadorId: ambassador.id,
    },
  })

  const token = await signSession({
    userId: user.id,
    email: user.email,
    role: 'AMBASSADOR',
    ambassadorId: ambassador.id,
  })

  const res = NextResponse.json({ ok: true, redirectTo: '/portal' })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
  return res
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/invite/route.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/app/api/invite/route.ts src/app/api/invite/route.test.ts
git commit -m "feat: redeem an invite link to claim an ambassador login"
```

---

## Task 6: Fix the rank bug deactivation makes reachable

**Files:**
- Modify: `src/app/api/portal/route.ts` (the `everyone` / `totalAmbassadors` block, ~lines 68-92)
- Test: `src/app/api/portal/rank.test.ts`

`totalAmbassadors` counts `active: true`, while `better` ranks against everyone with orders. Nothing can deactivate anyone today, so the two always agree. **Task 3 shipped the deactivate button, so this is now reachable** — deactivate an ambassador with sales and someone else's portal reads "#9 of 8".

- [ ] **Step 1: Read the current code**

Run: `sed -n '60,95p' src/app/api/portal/route.ts`

Confirm it matches: `everyone` from `db.order.groupBy`, `better` filtered from `everyone`, and `totalAmbassadors` from `db.ambassador.count({ where: { active: true } })`.

- [ ] **Step 2: Write the failing test**

```ts
// src/app/api/portal/rank.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const EMAILS = ['plan-rank-1@example.local', 'plan-rank-2@example.local']
const ids: string[] = []

async function wipe() {
  for (const email of EMAILS) {
    const found = await db.ambassador.findUnique({ where: { email } })
    if (found) await db.ambassador.delete({ where: { id: found.id } })
  }
}

beforeEach(async () => {
  await wipe()
  ids.length = 0
  for (const email of EMAILS) {
    const a = await db.ambassador.create({ data: { name: email, email, commissionRate: 0.1 } })
    const u = await db.user.create({
      data: { email, passwordHash: 'x', role: 'AMBASSADOR', ambassadorId: a.id },
    })
    ids.push(a.id)
    if (email === EMAILS[0]) {
      cookieValue.current = await signSession({
        userId: u.id, email, role: 'AMBASSADOR', ambassadorId: a.id,
      })
    }
  }
})

afterEach(wipe)

describe('portal rank', () => {
  // The invariant. Whatever the population, you can never be 9th of 8.
  it('never reports a rank greater than the total', async () => {
    const res = await GET(new Request('http://localhost/api/portal?preset=this_month'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rank).toBeLessThanOrEqual(body.totalAmbassadors)
    expect(body.rank).toBeGreaterThanOrEqual(1)
  })

  it('holds the invariant even when another ambassador is deactivated', async () => {
    await db.ambassador.update({ where: { id: ids[1] }, data: { active: false } })

    const res = await GET(new Request('http://localhost/api/portal?preset=this_month'))
    const body = await res.json()
    expect(body.rank).toBeLessThanOrEqual(body.totalAmbassadors)
  })

  it('holds the invariant when I am deactivated myself', async () => {
    await db.ambassador.update({ where: { id: ids[0] }, data: { active: false } })

    const res = await GET(new Request('http://localhost/api/portal?preset=this_month'))
    const body = await res.json()
    expect(body.rank).toBeLessThanOrEqual(body.totalAmbassadors)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/app/api/portal/rank.test.ts`
Expected: FAIL on at least one case — `rank` exceeds `totalAmbassadors`, because the two are computed over different populations.

- [ ] **Step 4: Fix the implementation**

Replace the `totalAmbassadors` line in `src/app/api/portal/route.ts`:

```ts
// BEFORE — a different population from the one `better` ranks against.
// const totalAmbassadors = await db.ambassador.count({ where: { active: true } })

// AFTER — rank and total must come from the SAME population, or you get "#9 of 8".
// The population is everyone with an attributed order in range; `active` plays no
// part, because a deactivated ambassador's past sales genuinely happened.
// If I have no orders in range I am absent from `everyone`, so count me in myself.
const iAmInPopulation = everyone.some((row) => row.ambassadorId === me.id)
const totalAmbassadors = iAmInPopulation ? everyone.length : everyone.length + 1
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/api/portal/rank.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 6: Run the FULL suite — this touched shared code**

Run: `npm test`
Expected: PASS — every test, no regressions in the portal or leaderboard.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/portal/route.ts src/app/api/portal/rank.test.ts
git commit -m "fix: rank and total must share one population

Deactivating an ambassador with sales made another ambassador's portal
read '#9 of 8'. Unreachable until the deactivate button existed."
```

---

## Task 7: The admin screen

**Files:**
- Create: `src/app/settings/ambassadors/page.tsx`
- Create: `src/app/settings/ambassadors/AmbassadorsClient.tsx`

Follow `src/app/settings/shops/page.tsx` for the server-wrapper shape and `ShopsClient.tsx` for the client shape. Read both before starting.

- [ ] **Step 1: Read the patterns to copy**

Run: `cat src/app/settings/shops/page.tsx` and `sed -n '1,60p' src/app/settings/shops/ShopsClient.tsx`

- [ ] **Step 2: Write the server wrapper**

```tsx
// src/app/settings/ambassadors/page.tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { AmbassadorsClient } from './AmbassadorsClient'

export default async function AmbassadorsPage() {
  const user = await currentUser()
  if (!user) redirect('/admin')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <AmbassadorsClient />
}
```

- [ ] **Step 3: Write the client**

Key requirements — every one of these is load-bearing:

- `commissionPercent` is a **percent** in the field, with a `%` suffix. The API converts. Never send a fraction.
- **Every fetch checks `res.ok`**, renders the server's `error` string, and uses `try`/`finally` so a button cannot stick on "Saving…". The existing `CostsClient.tsx:283-294` does the opposite — do not copy it.
- The invite link is built client-side: `` `${window.location.origin}${row.invitePath}` `` — so no base-URL env var is needed.
- Show **Copy invite link** only when `row.onboarded === false`.

```tsx
// src/app/settings/ambassadors/AmbassadorsClient.tsx
'use client'

import { useCallback, useEffect, useState } from 'react'

type Code = { id: string; code: string }
type Row = {
  id: string
  name: string
  email: string
  commissionPercent: number
  active: boolean
  codes: Code[]
  onboarded: boolean
  invitePath: string | null
}

export function AmbassadorsClient() {
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ambassadors')
      if (!res.ok) {
        setError((await res.json()).error ?? 'Could not load ambassadors')
        return
      }
      setRows((await res.json()).ambassadors)
      setError(null)
    } catch {
      setError('Could not reach the server')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** One place that talks to the API, so res.ok is never forgotten. */
  async function send(url: string, method: string, body: unknown) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError((await res.json()).error ?? 'That did not work')
        return false
      }
      await load()
      return true
    } catch {
      setError('Could not reach the server')
      return false
    } finally {
      setBusy(false) // always — a button must never stick on "Saving…"
    }
  }

  async function copyInvite(row: Row) {
    if (!row.invitePath) return
    await navigator.clipboard.writeText(`${window.location.origin}${row.invitePath}`)
    setCopied(row.id)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-[var(--radius-control)] bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      <AddAmbassadorForm busy={busy} onAdd={(body) => send('/api/ambassadors', 'POST', body)} />

      <table className="w-full text-sm">
        <thead>
          <tr>
            <th>Name</th><th>Email</th><th>Rate</th><th>Codes</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid="ambassador-row">
              <td>{row.name}</td>
              <td>{row.email}</td>
              <td>
                <input
                  type="number"
                  defaultValue={row.commissionPercent}
                  min={0}
                  max={100}
                  disabled={busy}
                  onBlur={(e) => {
                    const next = parseFloat(e.target.value)
                    if (!Number.isNaN(next) && next !== row.commissionPercent) {
                      void send(`/api/ambassadors/${row.id}`, 'PATCH', { commissionPercent: next })
                    }
                  }}
                />
                <span> %</span>
              </td>
              <td>{row.codes.map((c) => c.code).join(', ')}</td>
              <td>{row.onboarded ? 'Active' : 'Not set up yet'}</td>
              <td>
                {!row.onboarded && row.invitePath && (
                  <button onClick={() => void copyInvite(row)} data-testid="copy-invite">
                    {copied === row.id ? 'Copied' : 'Copy invite link'}
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => void send(`/api/ambassadors/${row.id}`, 'PATCH', { active: !row.active })}
                >
                  {row.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AddAmbassadorForm({
  busy,
  onAdd,
}: {
  busy: boolean
  onAdd: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [percent, setPercent] = useState('10') // a PERCENT, per spec 6.4
  const [code, setCode] = useState('')

  return (
    <form
      data-testid="add-ambassador"
      onSubmit={async (e) => {
        e.preventDefault()
        const ok = await onAdd({
          name,
          email,
          commissionPercent: parseFloat(percent) || 0,
          code,
        })
        if (ok) {
          setName(''); setEmail(''); setPercent('10'); setCode('')
        }
      }}
    >
      <input required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input required type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input required type="number" min={0} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} />
      <span>%</span>
      <input required placeholder="Discount code" value={code} onChange={(e) => setCode(e.target.value)} />
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add ambassador'}</button>
    </form>
  )
}
```

- [ ] **Step 4: Verify it compiles and the suite is still green**

Run: `npx tsc --noEmit && npm test`
Expected: exit 0, all tests pass.

- [ ] **Step 5: Style it to match the existing design system**

Read `src/app/settings/shops/ShopsClient.tsx` and apply the same class names, spacing, and table styling. The markup above is deliberately unstyled — the app has one consistent design system and this screen must not look foreign.

- [ ] **Step 6: Commit**

```bash
git add src/app/settings/ambassadors/
git commit -m "feat: admin screen to create and manage ambassadors"
```

---

## Task 8: The set-password page

**Files:**
- Create: `src/app/invite/[token]/page.tsx`
- Create: `src/app/invite/[token]/InviteClient.tsx`

- [ ] **Step 1: Write the server wrapper**

It looks the invite up server-side purely so the page can greet them by name and fail early on a dead link. **This is presentation only** — `POST /api/invite` re-checks all four guards regardless.

```tsx
// src/app/invite/[token]/page.tsx
import { verifyInvite } from '@/lib/auth/invite'
import { db } from '@/lib/db'
import { InviteClient } from './InviteClient'

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const ambassadorId = await verifyInvite(token)

  const ambassador = ambassadorId
    ? await db.ambassador.findUnique({
        where: { id: ambassadorId },
        include: { user: { select: { id: true } } },
      })
    : null

  if (!ambassador || !ambassador.active) {
    return <p>This invite link is not valid. Ask for a new one.</p>
  }
  if (ambassador.user) {
    return <p>You already have a login. <a href="/login">Sign in</a> instead.</p>
  }

  return <InviteClient token={token} name={ambassador.name} />
}
```

- [ ] **Step 2: Write the client**

```tsx
// src/app/invite/[token]/InviteClient.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PasswordField } from '@/components/PasswordField'

export function InviteClient({ token, name }: { token: string; name: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirm) {
      setError('Those two passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Use at least 8 characters')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      if (!res.ok) {
        setError((await res.json()).error ?? 'That did not work')
        return
      }
      router.push((await res.json()).redirectTo)
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} data-testid="invite-form">
      <h1>Welcome, {name}</h1>
      <p>Choose a password and you are in.</p>
      {error && <p role="alert">{error}</p>}
      <PasswordField value={password} onChange={setPassword} label="Password" />
      <PasswordField value={confirm} onChange={setConfirm} label="Confirm password" />
      <button type="submit" disabled={busy}>{busy ? 'Setting up…' : 'Set password'}</button>
    </form>
  )
}
```

- [ ] **Step 3: Check the PasswordField interface actually matches**

Run: `sed -n '1,30p' src/components/PasswordField.tsx`

If its props differ from `value`/`onChange`/`label`, adapt the calls above to the real interface. Do not change `PasswordField` itself — other screens use it.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: exit 0, all pass.

- [ ] **Step 5: Style to match, then commit**

```bash
git add "src/app/invite/[token]/"
git commit -m "feat: invite page where an ambassador sets their own password"
```

---

## Task 9: End-to-end journey

**Files:**
- Create: `e2e/ambassador-onboarding.spec.ts`

- [ ] **Step 1: Read an existing spec for the login pattern**

Run: `cat e2e/ambassador.spec.ts`

Reuse its sign-in helper and seeded admin credentials. Do not invent new ones.

- [ ] **Step 2: Write the test**

```ts
// e2e/ambassador-onboarding.spec.ts
import { test, expect } from '@playwright/test'

// Unique per run, so repeated runs never collide on the unique email/code.
const stamp = String(process.env.E2E_STAMP ?? Date.now())
const EMAIL = `e2e-onboard-${stamp}@example.local`
const CODE = `E2E${stamp.slice(-6)}`
const PASSWORD = 'chosen-by-the-ambassador-1'

test('an admin creates an ambassador, who claims a login and sees only their own data', async ({ page }) => {
  // --- Admin signs in and creates the ambassador ---
  await page.goto('/admin')
  await page.getByLabel('Email').fill('admin@panetti.test')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard/)

  await page.goto('/settings/ambassadors')
  const form = page.getByTestId('add-ambassador')
  await form.getByPlaceholder('Name').fill('E2E Onboard')
  await form.getByPlaceholder('Email').fill(EMAIL)
  await form.getByPlaceholder('Discount code').fill(CODE)
  await form.getByRole('button', { name: 'Add ambassador' }).click()

  const row = page.getByTestId('ambassador-row').filter({ hasText: EMAIL })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Not set up yet')

  // --- Admin copies the invite link ---
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await row.getByTestId('copy-invite').click()
  const inviteUrl = await page.evaluate(() => navigator.clipboard.readText())
  expect(inviteUrl).toContain('/invite/')

  // --- The ambassador redeems it in a clean session ---
  await page.context().clearCookies()
  await page.goto(inviteUrl)
  await expect(page.getByText('Welcome, E2E Onboard')).toBeVisible()

  await page.getByTestId('invite-form').getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByTestId('invite-form').getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Set password' }).click()

  // --- They land in their own portal, signed in ---
  await expect(page).toHaveURL(/\/portal/)

  // --- And they cannot reach company data ---
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/portal/) // bounced back by the guard

  // --- The link is single-use: it will not work twice ---
  await page.context().clearCookies()
  await page.goto(inviteUrl)
  await expect(page.getByText(/already have a login/i)).toBeVisible()
})
```

- [ ] **Step 3: Run it**

Run: `npx playwright test e2e/ambassador-onboarding.spec.ts`
Expected: PASS. Playwright starts the dev server itself (`reuseExistingServer: true`).

If the admin credentials differ, take them from `prisma/seed.ts` — do not guess.

- [ ] **Step 4: Run EVERYTHING green, as asked**

```bash
npm test && npx tsc --noEmit && npm run build && npx playwright test
```

Expected: unit suite passes with the new tests included, typecheck exit 0, build exit 0, all E2E specs pass.

- [ ] **Step 5: Commit**

```bash
git add e2e/ambassador-onboarding.spec.ts
git commit -m "test: end-to-end ambassador onboarding journey"
```

---

## Definition of done

- [ ] `npm test` — green, including every new test
- [ ] `npx tsc --noEmit` — exit 0
- [ ] `npm run build` — exit 0
- [ ] `npx playwright test` — green
- [ ] An admin can create an ambassador; the code exists, so the **next sync attributes orders to them before they have ever logged in**
- [ ] A deactivated ambassador's invite link stops working immediately
- [ ] A redeemed invite link cannot be redeemed twice
- [ ] An ambassador reaching `/dashboard` is bounced to `/portal`
- [ ] No ambassador can ever see `rank > totalAmbassadors`

## Known limitations, deliberately not fixed here

`portal/route.ts` ranks on **raw `netSales` across mixed currencies** with no FX conversion (1000 NOK sorts above 500 USD), so the portal's rank can disagree with the admin leaderboard, which does convert. This is pre-existing, is documented in the code, and is not made worse by this work. It needs its own decision and its own change.
