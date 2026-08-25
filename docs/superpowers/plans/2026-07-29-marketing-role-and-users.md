# Marketing Role and Users Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A MARKETING role restricted to ambassador statistics and ambassador management, plus an admin-only Users page that creates Admin/Marketing logins.

**Architecture:** Third value in the existing role string; a new `assertStaff` guard allow-lists exactly four API surfaces; a top-level `/ambassadors` staff page (stats + roster); `/settings/users` + `/api/users` for login management; middleware/nav/landing fences per role. Spec: `docs/superpowers/specs/2026-07-29-marketing-role-and-users-design.md`.

**Tech Stack:** Next.js App Router, Prisma (no migration - role is a string), vitest (DB-backed route tests, jsdom component tests), Playwright.

---

### Task 1: Role plumbing and guards

**Files:**
- Modify: `src/lib/auth/session.ts` (Role union)
- Modify: `src/lib/auth/guard.ts` (assertStaff, staff-wide canViewAmbassador)
- Modify: `src/app/api/auth/login/route.ts` (drop the cast; marketing landing)
- Test: `src/lib/auth/guard.test.ts`, `src/app/api/auth/login/route.test.ts`

- [x] **Step 1: Failing tests.** In `guard.test.ts` (read first, follow style): `assertStaff` passes ADMIN and MARKETING, throws for AMBASSADOR and null; `canViewAmbassador` true for MARKETING on any id. In `login/route.test.ts`: a created MARKETING user logging in gets `redirectTo: '/ambassadors'`.
- [x] **Step 2: Run those files, watch the new cases fail** (`npx vitest run src/lib/auth/guard.test.ts src/app/api/auth/login/route.test.ts`).
- [x] **Step 3: Implement.**

```ts
// session.ts
export type Role = 'ADMIN' | 'MARKETING' | 'AMBASSADOR'

// guard.ts
const isStaff = (user: SessionUser | null): user is SessionUser =>
  !!user && (user.role === 'ADMIN' || user.role === 'MARKETING')

export function canViewAmbassador(user: SessionUser | null, ambassadorId: string): boolean {
  if (isStaff(user)) return true
  return user?.ambassadorId === ambassadorId
}

/** Ambassador management and statistics - the marketing half of the house. */
export function assertStaff(user: SessionUser | null): asserts user is SessionUser {
  if (!isStaff(user)) throw new AuthError('Staff only')
}

// login/route.ts - replace the cast and the landing block
import type { Role } from '@/lib/auth/session'
role: user.role as Role,
let redirectTo = '/dashboard'
if (user.role === 'AMBASSADOR') redirectTo = '/portal'
else if (user.role === 'MARKETING') redirectTo = '/ambassadors'
else if (parsed.data.mode === 'ambassador') { /* existing mine-check unchanged */ }
```

- [x] **Step 4: Green** on both files. **Step 5: Commit** `feat: a MARKETING role exists, with staff guards and its own landing`.

### Task 2: Middleware fences

**Files:** Modify `src/middleware.ts`; Test `src/middleware.test.ts`.

- [x] **Step 1: Failing tests:** marketing session on `/dashboard` → location `/ambassadors`; on `/ambassadors` and `/account` → pass-through; admin behavior unchanged. Build a marketing session with `signSession({ role: 'MARKETING', ambassadorId: null, ... })`.
- [x] **Step 2: Implement:** `/ambassadors` joins `PROTECTED_PAGES`; after the ambassador branch:

```ts
const MARKETING_PAGES = ['/ambassadors', '/account']
if (user.role === 'MARKETING' && !MARKETING_PAGES.some((p) => req.nextUrl.pathname.startsWith(p))) {
  const url = req.nextUrl.clone()
  url.pathname = '/ambassadors'
  return NextResponse.redirect(url)
}
```

- [x] **Step 3: Green. Commit** `feat: the middleware fences marketing onto the ambassadors page`.

### Task 3: Ambassador APIs open to staff; the financial wall stays

**Files:** Modify `src/app/api/ambassadors/route.ts`, `src/app/api/ambassadors/[id]/route.ts`, `src/app/api/ambassadors/[id]/codes/route.ts` (assertAdmin → assertStaff). Create test `src/app/api/marketing-role.test.ts`.

- [x] **Step 1: Failing tests** (new file, cookie-mock pattern from `leaderboard.test.ts`): with a MARKETING session - GET `/api/ambassadors` 200; POST creates one (marked email, wiped after); GET `/api/metrics` 403; GET `/api/orders` 403; GET `/api/settings` 403.
- [x] **Step 2: Flip the three route files' guards** (import assertStaff, replace assertAdmin call sites - nothing else).
- [x] **Step 3: Green. Commit** `feat: marketing manages ambassadors; every financial door still answers 403`.

### Task 4: The stats endpoint

**Files:** Create `src/app/api/ambassadors/stats/route.ts`; Test `src/app/api/ambassadors/stats.test.ts`.

- [x] **Step 1: Failing tests** (DB pattern from `leaderboard.test.ts`, marked fixtures): marketing session gets `leaderboard` rows (the seller ranks first, shops named) and `shopOptions` containing the fixture shop; the raw body text contains neither `"metrics"` nor `"profit"`; an AMBASSADOR session gets 403.
- [x] **Step 2: Implement:**

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertStaff, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { leaderboard } from '@/lib/metrics/ambassadors'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Ambassador statistics for staff: the leaderboard and nothing else. */
export async function GET(req: Request) {
  try {
    assertStaff(await currentUser())
    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const [input, roster, shopOptions] = await Promise.all([
      loadMetricsInput({ shopIds, from, to, timezone }),
      db.ambassador.findMany({
        where: { active: true, ...(shopIds ? { codes: { some: { shopId: { in: shopIds } } } } : {}) },
        select: { id: true, name: true, codes: { select: { shop: { select: { name: true } } } } },
      }),
      db.shop.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ])
    const people = roster.map((p) => ({
      id: p.id, name: p.name, shops: [...new Set(p.codes.map((c) => c.shop.name))].sort(),
    }))
    const top = leaderboard({
      ambassadors: people, orders: input.orders, rates: input.rates,
      displayCurrency: input.displayCurrency, from, to, timezone,
    })
    return NextResponse.json({
      leaderboard: top, shopOptions, displayCurrency: input.displayCurrency,
      range: { from: from.toISOString(), to: to.toISOString() },
    }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load ambassador statistics' }, { status: 500, headers: NO_STORE })
  }
}
```

- [x] **Step 3: Green. Commit** `feat: an ambassador statistics endpoint that knows no revenue`.

### Task 5: The users API

**Files:** Create `src/app/api/users/route.ts`, `src/app/api/users/[id]/route.ts`; Test `src/app/api/users/route.test.ts`.

- [x] **Step 1: Failing tests:** admin lists staff logins (no AMBASSADOR rows); creates an ADMIN and a MARKETING login (password ≥ 8, stored hashed); duplicate email → 409 with a readable message; short password → 400; DELETE own id → 409; DELETE the marketing user → gone; MARKETING session on GET → 403.
- [x] **Step 2: Implement:**

```ts
// route.ts
const Body = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MARKETING']),
  password: z.string().min(8, 'Choose a password of at least 8 characters'),
})
export async function GET() { /* assertAdmin; db.user.findMany({ where: { role: { in: ['ADMIN','MARKETING'] } }, select: { id, email, role } , orderBy: { email: 'asc' } }) */ }
export async function POST(req: Request) {
  /* assertAdmin; parse; db.user.create({ email: lowercased, passwordHash: await hashPassword(password), role });
     P2002 → 409 'That email already has a login'; answer { ok: true, id } */
}
// [id]/route.ts
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  /* const me = await currentUser(); assertAdmin(me); const { id } = await params;
     if (me.userId === id) 409 'You cannot remove your own login.';
     deleteMany({ where: { id, role: { in: ['ADMIN','MARKETING'] } } }) - ambassador logins are not this page's to delete;
     count 0 → 404 'No such login' */
}
```

- [x] **Step 3: Green. Commit** `feat: admins mint and revoke staff logins over an api`.

### Task 6: The staff Ambassadors page, nav, and landings

**Files:**
- Create: `src/app/ambassadors/page.tsx`, `src/app/ambassadors/AmbassadorsHubClient.tsx`
- Move: `src/app/settings/ambassadors/AmbassadorsClient.tsx` → `src/app/ambassadors/AmbassadorsClient.tsx` (with its test alongside; `git mv`, imports updated, component internals untouched)
- Modify: `src/app/settings/ambassadors/page.tsx` → `redirect('/ambassadors')`; `src/components/shell/AppShell.tsx` (role-aware nav); `src/app/page.tsx`, `src/app/admin/page.tsx` (marketing → `/ambassadors`); the account page passes the user's role to AppShell if it renders staff nav.
- Test: `src/app/ambassadors/AmbassadorsHubClient.test.tsx`

- [x] **Step 1: Failing component test:** stub fetch of `/api/ambassadors/stats` (one row, one shopOption) and `/api/ambassadors` (empty roster); marketing render shows 'Top ambassadors', the row, the shop filter - and NO 'Dashboard' nav link; admin render DOES show 'Dashboard'.
- [x] **Step 2: Implement.** Page guard: no user → `/login`; AMBASSADOR → `/portal`; else render hub with `email` and `role`. Hub: `AppShell role={role}` + `PageHeader title="Ambassadors"` carrying a shop `<select>` (from shopOptions, 'All shops' default) and preset `<select>` (reuse the dashboard's preset list), refetching stats on change; `Leaderboard rows currency` on top; the moved `AmbassadorsClient` below. AppShell: `role?: 'ADMIN' | 'MARKETING'` prop, default `'ADMIN'`; marketing sees one nav group (`People` → Ambassadors) and the wordmark links `/ambassadors`; the admin NAV's Analytics group gains the Ambassadors item after Marketing.
- [x] **Step 3: Green (component test + full suite - settings/ambassadors component test moved, page redirect test via e2e).**
- [x] **Step 4: Commit** `feat: a staff ambassadors page - statistics on top, the roster below`.

### Task 7: The Users settings page

**Files:** Create `src/app/settings/users/page.tsx`, `src/app/settings/users/UsersClient.tsx`; Modify `src/app/settings/SettingsTabs.tsx` (read first: point the Ambassadors entry at `/ambassadors`, add Users); Test `src/app/settings/users/UsersClient.test.tsx`.

- [x] **Step 1: Failing component test:** lists two stubbed logins with roles; submitting the form POSTs email/role/password and toasts success; the delete button asks `window.confirm` and DELETEs.
- [x] **Step 2: Implement** in the house card/table style (AdAccountsClient is the reference): table (email, role chip), form (email, role select, starter password), quiet note: 'Removing a login stops new sign-ins at once; a session already open ends by itself within 7 days.'
- [x] **Step 3: Green. Commit** `feat: a users page where admins mint admin and marketing logins`.

### Task 8: Seed, e2e, ship

**Files:** Modify `prisma/seed.ts` (a `marketing@ecom.test` user, MARKETING role, same seed password convention); Create `e2e/marketing-role.spec.ts`; check `e2e/login-routing.spec.ts` and `e2e/admin.spec.ts` still hold (settings/ambassadors links now land on `/ambassadors`).

- [x] **Step 1: e2e:** marketing signs in via `/admin` → lands on `/ambassadors` with 'Top ambassadors' visible; navigating to `/dashboard` bounces back to `/ambassadors`; the nav shows no 'Orders'; an admin still reaches `/settings/users` and sees the marketing login listed.
- [x] **Step 2:** `npm run db:seed`, full `npm test`, `npx playwright test`, `npm run build`, lint changed files.
- [x] **Step 3: Commit** `feat: seed a marketing login and prove the fences end to end` **, push, verify the Vercel deploy state is success.**
