# Meta System User Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Meta ad accounts by pasting one system user token, and delete the Facebook login dialog that never worked.

**Architecture:** The pasted token becomes an `AdConnection` (no schema change - `secret` is already an encrypted credential and `expiresAt` is already nullable, which is exactly "never expires"). A new admin route proves the token and returns a connection id; the page opens the picker that already exists, and `POST /api/ad-accounts/bulk`, the per-account backfill and `resolveCredentials` all work untouched. The Meta half of the OAuth flow is then removed. Spec: `docs/superpowers/specs/2026-07-29-meta-system-user-token-design.md`.

**Tech Stack:** Next.js App Router, Prisma (no migration), vitest (stubbed-fetch unit tests, DB-backed route tests, jsdom component tests), Playwright.

**Before you start:** the DB-backed tests need local Postgres. Run `%LOCALAPPDATA%\panetti-pg\start-pg.cmd` and leave it running. Never point `DATABASE_URL` at the live Neon database.

**Branch:** `meta-system-user-token` (already created, spec already committed there).

---

### Task 1: Proving a pasted Meta token

**Files:**
- Create: `src/lib/ads/token.ts`
- Test: `src/lib/ads/token.test.ts`

`metaAppToken` is lifted from the top of `ensureMetaApp` in `src/lib/ads/oauth.ts` (which Task 4 deletes). `tokenVerdict` is pure so the rules are readable and cheap to test; `inspectMetaToken` is the one call the route makes.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/ads/token.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { tokenVerdict, inspectMetaToken } from './token'
import { AdApiError } from './types'

afterEach(() => vi.unstubAllGlobals())

const APP = { clientId: '1526277315425302', clientSecret: 'shh' }

describe('tokenVerdict', () => {
  it('accepts a never-expiring token and reports no expiry', () => {
    expect(tokenVerdict({ is_valid: true, expires_at: 0, scopes: ['ads_read'] }, APP.clientId))
      .toEqual({ ok: true, expiresAt: null })
  })

  it('reads a dated expiry into a Date', () => {
    const verdict = tokenVerdict(
      { is_valid: true, expires_at: 1790000000, scopes: ['ads_read'] },
      APP.clientId,
    )
    expect(verdict).toEqual({ ok: true, expiresAt: new Date(1790000000 * 1000) })
  })

  it('refuses a token Facebook calls invalid', () => {
    expect(tokenVerdict({ is_valid: false }, APP.clientId)).toEqual({
      ok: false,
      reason: 'Facebook says this token is not valid. Generate it again.',
    })
  })

  it('refuses a token from a different app, before looking at scopes', () => {
    expect(tokenVerdict({ is_valid: true, app_id: '999', scopes: [] }, APP.clientId)).toEqual({
      ok: false,
      reason: 'This token belongs to a different Facebook app.',
    })
  })

  it('refuses a token that never got ads_read', () => {
    expect(
      tokenVerdict({ is_valid: true, app_id: APP.clientId, scopes: ['email'] }, APP.clientId),
    ).toEqual({
      ok: false,
      reason: 'This token has no ads_read permission. Generate it again and tick ads_read.',
    })
  })

  it('holds no opinion when Facebook says nothing useful', () => {
    // An unreadable answer must never block: only /me proves a token.
    expect(tokenVerdict(null, APP.clientId)).toEqual({ ok: true, expiresAt: null })
    expect(tokenVerdict({}, APP.clientId)).toEqual({ ok: true, expiresAt: null })
    // Scopes absent or empty is silence, not a missing permission.
    expect(tokenVerdict({ is_valid: true, scopes: [] }, APP.clientId)).toEqual({
      ok: true,
      expiresAt: null,
    })
  })
})

describe('inspectMetaToken', () => {
  it('returns the label from /me and the verdict from debug_token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('grant_type=client_credentials'))
          return Response.json({ access_token: 'APP|TOKEN' })
        if (url.includes('/debug_token'))
          return Response.json({ data: { is_valid: true, expires_at: 0, scopes: ['ads_read'] } })
        return Response.json({ name: 'Philip Antonetti' })
      }),
    )

    await expect(inspectMetaToken(APP, 'EAABpasted')).resolves.toEqual({
      label: 'Philip Antonetti',
      expiresAt: null,
    })
  })

  it('throws the verdict reason without ever calling /me', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('grant_type=client_credentials'))
        return Response.json({ access_token: 'APP|TOKEN' })
      if (url.includes('/debug_token'))
        return Response.json({ data: { is_valid: true, scopes: ['email'] } })
      throw new Error('/me must not be called once the token is already refused')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(inspectMetaToken(APP, 'EAABpasted')).rejects.toThrow(/ads_read/)
  })

  it('still accepts the token when debug_token itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('grant_type=client_credentials'))
          return Response.json({ access_token: 'APP|TOKEN' })
        if (url.includes('/debug_token')) return new Response('nope', { status: 500 })
        return Response.json({ name: 'Philip Antonetti' })
      }),
    )

    await expect(inspectMetaToken(APP, 'EAABpasted')).resolves.toEqual({
      label: 'Philip Antonetti',
      expiresAt: null,
    })
  })

  it('fails with Facebook words when /me refuses the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('grant_type=client_credentials'))
          return Response.json({ access_token: 'APP|TOKEN' })
        if (url.includes('/debug_token')) return new Response('nope', { status: 500 })
        return Response.json({ error: { message: 'Malformed access token' } }, { status: 400 })
      }),
    )

    await expect(inspectMetaToken(APP, 'bad')).rejects.toThrow(AdApiError)
    await expect(inspectMetaToken(APP, 'bad')).rejects.toThrow('Malformed access token')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/ads/token.test.ts`
Expected: FAIL - `Failed to resolve import "./token"`.

- [ ] **Step 3: Implement**

```ts
// src/lib/ads/token.ts
import { AdApiError } from './types'

/**
 * Proving a pasted Meta system user token.
 *
 * Two questions, in order. `debug_token` asks what Facebook already knows
 * about the token - the app it belongs to, the permissions on it, when it
 * dies. `/me` asks the only question that truly matters: does it work.
 *
 * The first is a courtesy and never blocks: neither `expires_at: 0` meaning
 * "never" nor a SYSTEM_USER token type is documented in the current Graph
 * reference, so silence from Facebook proves nothing. The second is fatal,
 * and speaks Facebook's own words when it fails.
 */

const GRAPH = 'https://graph.facebook.com/v25.0'

/** Named MetaApp, not PlatformApp: oauth.ts already exports that name for Google. */
export type MetaApp = { clientId: string; clientSecret: string }

/** The fields of `debug_token`'s data object that we act on. */
export type DebugTokenData = {
  is_valid?: boolean
  expires_at?: number
  scopes?: string[]
  app_id?: string
}

export type TokenVerdict =
  | { ok: true; expiresAt: Date | null }
  | { ok: false; reason: string }

/** The app access token that lets us ask about somebody else's token. */
export async function metaAppToken(app: MetaApp): Promise<string> {
  const res = await fetch(
    `${GRAPH}/oauth/access_token?${new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: 'client_credentials',
    })}`,
  )
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    error?: { message?: string }
  }
  if (!body.access_token)
    throw new AdApiError(body.error?.message ?? 'Meta did not accept the App ID and secret')
  return body.access_token
}

/**
 * What `debug_token` said, turned into a decision. `null` - an unreadable or
 * failed answer - is silence, and silence blocks nothing.
 */
export function tokenVerdict(data: DebugTokenData | null, clientId: string): TokenVerdict {
  if (!data) return { ok: true, expiresAt: null }

  if (data.is_valid === false) {
    return { ok: false, reason: 'Facebook says this token is not valid. Generate it again.' }
  }
  if (data.app_id && data.app_id !== clientId) {
    return { ok: false, reason: 'This token belongs to a different Facebook app.' }
  }
  // An absent or empty scope list is silence too - only a populated list that
  // leaves ads_read out is evidence the permission was never ticked.
  if (data.scopes?.length && !data.scopes.includes('ads_read')) {
    return {
      ok: false,
      reason: 'This token has no ads_read permission. Generate it again and tick ads_read.',
    }
  }
  return { ok: true, expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null }
}

/** Prove a pasted token and learn who it belongs to. Throws AdApiError. */
export async function inspectMetaToken(
  app: MetaApp,
  token: string,
): Promise<{ label: string; expiresAt: Date | null }> {
  let data: DebugTokenData | null = null
  try {
    const appToken = await metaAppToken(app)
    const res = await fetch(
      `${GRAPH}/debug_token?${new URLSearchParams({
        input_token: token,
        access_token: appToken,
      })}`,
    )
    if (res.ok) data = ((await res.json()) as { data?: DebugTokenData }).data ?? null
  } catch {
    // A courtesy check that cannot run tells us nothing. Fall through to /me.
  }

  const verdict = tokenVerdict(data, app.clientId)
  if (!verdict.ok) throw new AdApiError(verdict.reason)

  // The only question that proves anything.
  const meRes = await fetch(`${GRAPH}/me?fields=name`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const me = (await meRes.json().catch(() => ({}))) as {
    name?: string
    error?: { message?: string }
  }
  if (!meRes.ok) {
    throw new AdApiError(me.error?.message ?? 'Facebook did not accept this token')
  }
  return { label: me.name ?? 'Facebook', expiresAt: verdict.expiresAt }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/ads/token.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/token.ts src/lib/ads/token.test.ts
git commit -m "feat: a pasted Meta token proves itself before it is stored"
```

---

### Task 2: The route that turns a token into a connection

**Files:**
- Create: `src/app/api/ads/connections/meta/route.ts`
- Test: `src/app/api/ads/connections/meta/route.test.ts`

The static `meta` segment sits beside the existing `[id]` segment. Next resolves static before dynamic, and `[id]` has no `route.ts` of its own (only `[id]/accounts`), so there is nothing to collide with.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/ads/connections/meta/route.test.ts
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
const { decryptSecret, encryptSecret } = await import('@/lib/secrets')

const ME = 'plan-metatoken-me@example.local'
const LABEL = 'Plan Metatoken Person'
let myId = ''

async function wipe() {
  await db.adConnection.deleteMany({ where: { label: LABEL } })
  await db.adPlatformApp.deleteMany({ where: { provider: 'meta' } })
  await db.user.deleteMany({ where: { email: ME } })
}

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: myId, email: ME, role: 'ADMIN', ambassadorId: null,
  })
}

beforeEach(async () => {
  await wipe()
  const me = await db.user.create({ data: { email: ME, passwordHash: 'x', role: 'ADMIN' } })
  myId = me.id
  await asAdmin()
})

afterEach(async () => {
  await wipe()
  vi.unstubAllGlobals()
})

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/ads/connections/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const app = () =>
  db.adPlatformApp.create({
    data: { provider: 'meta', clientId: 'appid', clientSecret: encryptSecret('shh') },
  })

/** Facebook, agreeing with everything. */
function stubHappyMeta(name = LABEL) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('grant_type=client_credentials'))
        return Response.json({ access_token: 'APP|TOKEN' })
      if (url.includes('/debug_token'))
        return Response.json({ data: { is_valid: true, expires_at: 0, scopes: ['ads_read'] } })
      return Response.json({ name })
    }),
  )
}

describe('POST /api/ads/connections/meta', () => {
  it('stores the token encrypted, never expiring, and hands back the connection', async () => {
    await app()
    stubHappyMeta()

    const res = await post({ token: 'EAABpasted' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.label).toBe(LABEL)
    expect(body.expiresAt).toBeNull()

    const stored = await db.adConnection.findUniqueOrThrow({ where: { id: body.connectionId } })
    expect(stored.provider).toBe('meta')
    expect(stored.expiresAt).toBeNull()
    expect(stored.secret).not.toContain('EAABpasted')
    expect(decryptSecret(stored.secret)).toBe('EAABpasted')
  })

  it('refreshes the same person instead of piling up connections', async () => {
    await app()
    stubHappyMeta()
    const first = await (await post({ token: 'EAABone' })).json()
    const second = await (await post({ token: 'EAABtwo' })).json()

    expect(second.connectionId).toBe(first.connectionId)
    const rows = await db.adConnection.findMany({ where: { label: LABEL } })
    expect(rows).toHaveLength(1)
    expect(decryptSecret(rows[0].secret)).toBe('EAABtwo')
  })

  it('answers 400 with Facebook words when the token is refused', async () => {
    await app()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('grant_type=client_credentials'))
          return Response.json({ access_token: 'APP|TOKEN' })
        if (url.includes('/debug_token')) return new Response('x', { status: 500 })
        return Response.json({ error: { message: 'Malformed access token' } }, { status: 400 })
      }),
    )

    const res = await post({ token: 'bad' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Malformed access token')
    expect(await db.adConnection.count({ where: { label: LABEL } })).toBe(0)
  })

  it('asks for the app first when no platform setup exists', async () => {
    stubHappyMeta()
    const res = await post({ token: 'EAABpasted' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/app ID and secret/i)
  })

  it('refuses an empty token without calling Facebook', async () => {
    await app()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await post({ token: '  ' })).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is admin only', async () => {
    await app()
    stubHappyMeta()
    cookieValue.current = await signSession({
      userId: myId, email: ME, role: 'MARKETING', ambassadorId: null,
    })
    expect((await post({ token: 'EAABpasted' })).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/app/api/ads/connections/meta/route.test.ts`
Expected: FAIL - `Failed to resolve import "./route"`.

- [ ] **Step 3: Implement**

```ts
// src/app/api/ads/connections/meta/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/secrets'
import { inspectMetaToken } from '@/lib/ads/token'
import { AdApiError } from '@/lib/ads/types'

/**
 * "I pasted a system user token." Prove it, remember who it belongs to, and
 * hand back a connection the account picker can open.
 *
 * This replaces the Facebook login dialog, which could never work against a
 * Business type app without a login configuration we cannot create for him.
 * A token needs no login product, no redirect URI and no app domains.
 */

const Body = z.object({
  token: z.string().trim().min(1, 'Paste the system user access token'),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400 },
      )
    }

    const app = await db.adPlatformApp.findUnique({ where: { provider: 'meta' } })
    if (!app) {
      return NextResponse.json(
        { error: 'Fill in the Meta app ID and secret below first.' },
        { status: 400 },
      )
    }

    const { label, expiresAt } = await inspectMetaToken(
      { clientId: app.clientId, clientSecret: decryptSecret(app.clientSecret) },
      parsed.data.token,
    )

    // Same de-dupe rule the Google callback uses: one row per person, so
    // pasting a fresh token refreshes rather than piling up connections.
    const existing = await db.adConnection.findFirst({ where: { provider: 'meta', label } })
    const connection = existing
      ? await db.adConnection.update({
          where: { id: existing.id },
          data: { secret: encryptSecret(parsed.data.token), expiresAt },
        })
      : await db.adConnection.create({
          data: { provider: 'meta', label, secret: encryptSecret(parsed.data.token), expiresAt },
        })

    return NextResponse.json({ connectionId: connection.id, label, expiresAt })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (e instanceof AdApiError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the token' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/app/api/ads/connections/meta/route.test.ts`
Expected: PASS, 6 tests. (Local Postgres must be running.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ads/connections/meta/route.ts src/app/api/ads/connections/meta/route.test.ts
git commit -m "feat: one pasted token becomes the Meta connection the picker opens"
```

---

### Task 3: The card on the page, and the dead button goes

**Files:**
- Modify: `src/app/settings/ad-accounts/AdAccountsClient.tsx` (read it first - match the existing card and field styling exactly)
- Test: `src/app/settings/ad-accounts/AdAccountsClient.test.tsx`

Four edits: drop the Meta `ConnectButton` at line 129; add `MetaTokenCard` after the Advanced link; fix the two strings that still name the dead button (`:126` subtitle, `:169` empty state); widen the picker's empty-list line at `:408` to say what to do about it.

- [ ] **Step 1: Write the failing component test**

In `src/app/settings/ad-accounts/AdAccountsClient.test.tsx`, first **delete** the test at lines 185-187 that asserts the `'The Facebook app was just fixed. Press Connect with Facebook again.'` notice renders. That notice IS the loop, and after Task 4 nothing can ever produce it. It would keep passing - a green test guarding a message that can no longer happen is worse than no test.

(Leave the `initialNotice` prop itself alone. `?error=` still reaches the page from the Google callback, and the notice plumbing costs nothing; removing it would touch `page.tsx` for no user-visible gain.)

Then replace the two tests named `'walks you to the setup when a connect button is pressed too early'` and `'links the connect buttons straight to the oauth start when ready'` with these - the Meta halves of both assert behaviour that is being deleted.

```tsx
  it('walks you to the setup when the Google connect button is pressed too early', async () => {
    renderPage([], { platform: { meta: null, google: { clientId: 'x', hasDeveloperToken: false } } })

    expect(screen.getByText('Connect with Google').closest('a')).toBeNull()
    fireEvent.click(screen.getByText('Connect with Google'))
    await waitFor(() =>
      expect(
        screen.getByText('One-time setup needed first. Two minutes, the steps are right below.'),
      ).toBeTruthy(),
    )
  })

  it('links the Google connect button straight to the oauth start when ready', () => {
    renderPage([])
    expect(screen.getByText('Connect with Google').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/google/start',
    )
  })

  it('offers Meta a token box instead of a Facebook login that never worked', () => {
    renderPage([])
    expect(screen.queryByText('Connect with Facebook')).toBeNull()
    expect(screen.getByLabelText('System user access token')).toBeTruthy()
  })

  it('saves a pasted Meta token and opens the picker on what comes back', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ connectionId: 'conn1', label: 'Philip', expiresAt: null }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderPage([])

    fireEvent.change(screen.getByLabelText('System user access token'), {
      target: { value: 'EAABpasted' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/ads/connections/meta')
    expect(JSON.parse(init.body as string)).toEqual({ token: 'EAABpasted' })
    // The picker took over, which is the whole point of pasting once.
    await waitFor(() => expect(screen.getByText('Pick the ad accounts')).toBeTruthy())
  })

  it('keeps the card open and says why when Facebook refuses the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'This token has no ads_read permission.' }, { status: 400 }),
      ),
    )
    renderPage([])

    fireEvent.change(screen.getByLabelText('System user access token'), {
      target: { value: 'bad' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    await waitFor(() =>
      expect(screen.getByText('This token has no ads_read permission.')).toBeTruthy(),
    )
    expect(screen.queryByText('Pick the ad accounts')).toBeNull()
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/app/settings/ad-accounts/AdAccountsClient.test.tsx`
Expected: FAIL - `Unable to find a label with the text of: System user access token`.

- [ ] **Step 3: Remove the Meta connect button**

In `src/app/settings/ad-accounts/AdAccountsClient.tsx`, delete line 129 entirely:

```tsx
          <ConnectButton provider="meta" ready={Boolean(platform.meta)} />
```

Then narrow `ConnectButton` to the one provider it still serves. Replace its signature and first lines:

```tsx
function ConnectButton({ provider, ready }: { provider: 'google'; ready: boolean }) {
  const toast = useToast()
  const text = 'Connect with Google'
```

- [ ] **Step 4: Fix the three strings that still describe the old flow**

Line 126, the page subtitle:

```tsx
        subtitle="Paste one Meta token or log in with Google, tick the ad accounts you want, done. Daily spend then syncs itself a few times a day and lands on the Marketing page, shop by shop."
```

Line 169, the empty table:

```tsx
                    Nothing connected yet. Paste a Meta system user token below, or fill in the
                    Google setup and press “Connect with Google”.
```

Line 408, the picker's empty list - the most likely stumble, so it says what to do:

```tsx
              <p className="text-sm text-muted">
                This token can see no ad accounts. Open the system user in Meta Business settings,
                press Add assets, choose Ad accounts, tick them and turn on “View performance”.
              </p>
```

- [ ] **Step 5: Add the card**

Insert `<MetaTokenCard saved={platform.meta} onConnected={setPickerId} />` directly after the Advanced button (line 236) and before `<PlatformSetupSection />`, then add the component beside the other card components:

```tsx
function MetaTokenCard({
  saved,
  onConnected,
}: {
  saved: { clientId: string } | null
  onConnected: (connectionId: string) => void
}) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!token.trim()) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/ads/connections/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      })
      const data = (await res.json().catch(() => null)) as
        | { connectionId?: string; error?: string }
        | null
      if (!res.ok || !data?.connectionId) {
        setError(data?.error ?? 'Could not save the token')
        return
      }
      setToken('')
      onConnected(data.connectionId) // straight into the picker
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-8">
      <h2 className="text-[13px] font-semibold text-ink">Meta: paste a system user token</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        One token covers every ad account. There is no Facebook login screen: a token needs no
        login product, no redirect URL and no app domains.
      </p>

      <div className="mt-3 max-w-2xl rounded-[var(--radius-card)] border border-line bg-surface p-4">
        <ol className="list-decimal space-y-1 pl-4 text-xs text-muted">
          <li>
            Open{' '}
            <a
              href="https://business.facebook.com/settings/system-users"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent hover:underline"
            >
              Business settings, System users
            </a>
            , press Add, name it “panetti analytics”, role Admin.
          </li>
          <li>
            Press Add assets, choose Ad accounts, tick your ad accounts, turn on “View
            performance”, save. Skip this and the list below comes back empty.
          </li>
          <li>
            Press Generate token, choose your app
            {saved ? ` (${saved.clientId})` : ''}, set expiration to Never, tick ads_read.
          </li>
          <li>Paste it here.</li>
        </ol>

        {!saved && (
          <p className="mt-3 text-xs text-warn">
            Fill in the Meta app ID and secret under Platform setup below first - they are what
            proves the token.
          </p>
        )}

        <label htmlFor="meta-token" className="mt-3 block text-xs font-medium text-ink">
          System user access token
        </label>
        <input
          id="meta-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="EAAB…"
          className="mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs"
        />

        {error && <p className="mt-2 text-xs text-loss">{error}</p>}

        <div className="mt-3 flex justify-end">
          <button
            onClick={save}
            disabled={busy || !token.trim()}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Checking…' : 'Save token'}
          </button>
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 6: Run the component tests**

Run: `npx vitest run src/app/settings/ad-accounts/AdAccountsClient.test.tsx`
Expected: PASS. If `Save token` is found twice, the card was inserted inside `PlatformSetupSection` instead of before it - move it out.

- [ ] **Step 7: Commit**

```bash
git add src/app/settings/ad-accounts/AdAccountsClient.tsx src/app/settings/ad-accounts/AdAccountsClient.test.tsx
git commit -m "feat: Meta connects by pasted token, and the button that never worked is gone"
```

---

### Task 4: Delete the Meta OAuth path

**Files:**
- Modify: `src/lib/ads/oauth.ts` (remove `ensureMetaApp`, `exchangeMetaCode`, `buildMetaAuthUrl`, the `META` const and the `covered` helper)
- Modify: `src/app/api/ads/oauth/[provider]/start/route.ts:20-67`
- Modify: `src/app/api/ads/oauth/[provider]/callback/route.ts:26-62`
- Modify: `src/app/api/ad-platform-apps/route.ts:7,62-71`
- Modify: `src/lib/ads/sync.ts:63-66`
- Modify: `src/app/api/ads/oauth.test.ts`

This is the task that removes the loop: `start/route.ts:44-49` answers "press Connect with Facebook again" every time `ensureMetaApp` reports `healed`, and it can report `healed` forever.

- [ ] **Step 1: Cut the Meta cases from the OAuth test**

In `src/app/api/ads/oauth.test.ts`, delete the whole `describe('platform setup', …)` block covering `ensureMetaApp` (from line 100) and every case that drives `/api/ads/oauth/meta/…`. Keep every Google case and keep the file name. Run it and expect the Google cases still to pass:

Run: `npx vitest run src/app/api/ads/oauth.test.ts`
Expected: PASS, Google cases only.

- [ ] **Step 2: Make the two OAuth routes Google-only**

In `start/route.ts`, delete the whole `if (provider === 'meta') { … }` block (lines 31-59) and narrow the guard and the URL builder:

```ts
    const { provider } = await params
    if (provider !== 'google') {
      return NextResponse.json({ error: 'No such platform' }, { status: 404 })
    }
```

```ts
    const url = buildGoogleAuthUrl(app.clientId, redirectUri, state)
```

Also drop `buildMetaAuthUrl` and `ensureMetaApp` from the import at line 7. Delete the `AdApiError` import at line 8 too: its only use was the catch inside the Meta block you just removed.

In `callback/route.ts`, narrow the same guard and collapse the exchange:

```ts
    const { provider } = await params
    if (provider !== 'google') {
      return NextResponse.json({ error: 'No such platform' }, { status: 404 })
    }
```

```ts
    const { refreshToken, label } = await exchangeGoogleCode(platformApp, redirectUri, code)
    const secret = refreshToken
    const expiresAt: Date | null = null
```

Drop `exchangeMetaCode` from the import at line 7.

- [ ] **Step 3: Stop the platform-app save from healing anything**

In `src/app/api/ad-platform-apps/route.ts`, delete the `ensureMetaApp` import at line 7 and the whole warning block at lines 62-71, then simplify the answer at line 88:

```ts
    return NextResponse.json({ ok: true })
```

- [ ] **Step 4: Fix the expiry message that names a button that no longer exists**

In `src/lib/ads/sync.ts`, line 65:

```ts
        throw new AdApiError('Facebook token expired. Paste a new system user token.')
```

- [ ] **Step 5: Delete the dead Meta helpers**

In `src/lib/ads/oauth.ts`, remove `ensureMetaApp`, `exchangeMetaCode`, `buildMetaAuthUrl`, the `covered` helper, and the `META` and `META_TOKEN_DAYS` constants. Remove `readJson` as well: `exchangeGoogleCode` does its own `res.json().catch(...)`, so the two Meta functions were its only callers. Update the file's opening comment to say it is the Google handshake. `STATE_COOKIE`, `PlatformApp`, `buildGoogleAuthUrl` and `exchangeGoogleCode` stay.

- [ ] **Step 6: Prove nothing else referenced them**

Run: `npx tsc --noEmit`
Expected: no errors. Then run the full unit suite:

Run: `npm test`
Expected: PASS. A failure naming `ensureMetaApp` means a test file still drives the deleted path - delete that case, do not restore the function.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ads/oauth.ts src/lib/ads/sync.ts src/app/api/ads/oauth src/app/api/ad-platform-apps/route.ts
git commit -m "refactor: the Facebook login dialog and its healing loop are gone"
```

---

### Task 5: End to end, and ship

**Files:**
- Modify: `e2e/marketing.spec.ts:62-66`

- [ ] **Step 1: Point the e2e at what the page says now**

Replace lines 62-66 with:

```ts
  // Meta connects by pasted token; only Google still has a login button.
  await expect(page.getByLabel('System user access token')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Connect with Facebook' })).toHaveCount(0)
  const g = page.getByRole('link', { name: 'Connect with Google' })
  await expect(g).toBeVisible()
  await expect(g).toHaveAttribute('href', '/api/ads/oauth/google/start')
```

- [ ] **Step 2: Reseed and run everything**

```bash
npm run db:seed
npm test
npx playwright test
npm run build
npx eslint src/lib/ads/token.ts src/app/api/ads/connections/meta/route.ts src/app/settings/ad-accounts/AdAccountsClient.tsx
```

Expected: unit suite green, Playwright green, build succeeds, lint clean. Do not proceed on a red suite - `superpowers:verification-before-completion` applies: paste the actual output, do not claim it passed.

- [ ] **Step 3: Commit**

```bash
git add e2e/marketing.spec.ts
git commit -m "test: the ad accounts page proves Meta connects by token"
```

- [ ] **Step 4: Merge and deploy**

Use `superpowers:finishing-a-development-branch` to decide how `meta-system-user-token` lands on `main`. After it lands and Vercel reports success, confirm on the live host (`panetti.vercel.app`, never a hashed deployment URL) that the Meta card renders and no "Connect with Facebook" button remains.

- [ ] **Step 5: Hand Philip the steps**

Send the six steps from the spec's "What the client does, once", including the preflight: **"Require app secret proof for server API calls" must be OFF** at
`https://developers.facebook.com/apps/1526277315425302/settings/advanced/`. With it on, every Graph call fails whatever we build, because none of our calls send `appsecret_proof`.
