# Platform Credentials Become Server Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the Meta and Google app credentials off the ad-accounts page entirely, so the client presses one button per platform and registers nothing.

**Architecture:** One new accessor, `platformApp(provider)`, reads five environment variables and falls back to the existing `AdPlatformApp` row. The six production readers of `db.adPlatformApp` move to it. The setup section and the `/api/ad-platform-apps` route are deleted. Nothing downstream of the login changes.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 6 + PostgreSQL, Vitest (jsdom + DB-backed + stubbed fetch), Playwright, Tailwind 4.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-30-platform-credentials-are-server-config-design.md`.
- **Environment first, database row second.** The fallback is deliberate, not tidiness: a mistyped Vercel variable would otherwise take the live site dark, and falling back leaves it running on the row the client already saved. Never invert this order.
- Run both sources through `decryptSecret`. It returns any value without the `enc:v1:` prefix unchanged (`src/lib/secrets.ts:35`), so a plaintext environment variable passes straight through and a database value decrypts. Do not branch on which source it came from.
- An environment variable set to an empty string counts as **unset**. Vercel produces these.
- **Any test that depends on the `AdPlatformApp` row must stub the five variables empty first.** Two files do — `src/app/api/ads/oauth.test.ts` and `src/app/api/ads/connections/meta/route.test.ts` — and neither is protected today. They pass right now only because nobody has these variables in their local `.env` yet. The day somebody does, they would silently read the environment instead of the row they seeded, and fail for a reason that looks nothing like its cause. Stub in `beforeEach`, `vi.unstubAllEnvs()` in `afterEach`.
- Nothing secret-shaped may cross to the browser. `PlatformSetup` becomes two booleans. No client ID, no `hasSecret`, no `hasDeveloperToken`.
- The `AdPlatformApp` **model stays**, unchanged. It is still read as the fallback. No schema change in this plan at all.
- The per-account "Advanced: paste credentials manually" path stays untouched for both providers.
- Do not delete `src/lib/ads/token.ts` or `POST /api/ads/connections/meta`. They are tracked debt from the previous branch, kept one release on purpose.
- Do not reintroduce `ensureMetaApp` or any claim that saving writes domains into the Facebook app.
- Never test against live Neon. Tests and `prisma` use the local Postgres via the gitignored `.env`.
- Edit files with the Edit/Write tools only. PowerShell 5.1 `Get-Content`/`Set-Content` mojibakes UTF-8 in this repo, and `AdAccountsClient.tsx` holds curly quotes and en dashes.
- **Never run `git stash`, `git checkout`, `git reset`, or `git clean`**, in any form, including on a single named file. A previous agent here ran `git stash` and silently reverted another agent's work. If `next-env.d.ts` shows up dirty, leave it and say so.
- Run the full suite before committing. `AdPlatformApp` rows are per-provider singletons shared with seed data that several suites borrow.

---

### Task 1: The accessor

**Files:**
- Create: `src/lib/ads/platform-app.ts`
- Test: `src/lib/ads/platform-app.test.ts`

**Interfaces:**
- Consumes: `db` from `@/lib/db`, `decryptSecret` from `@/lib/secrets`.
- Produces:
  - `export type PlatformCredentials = { clientId: string; clientSecret: string; developerToken?: string }`
  - `export async function platformApp(provider: 'meta' | 'google'): Promise<PlatformCredentials | null>`
  - `export async function configuredProviders(): Promise<{ meta: boolean; google: boolean }>`

  Tasks 2 and 3 import these. Note the type is named `PlatformCredentials`, **not** `PlatformApp` — `src/lib/ads/oauth.ts` already exports `PlatformApp` and the two must not collide.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ads/platform-app.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { encryptSecret } from '../secrets'
import { configuredProviders, platformApp } from './platform-app'

/**
 * DB-backed for the fallback path. AdPlatformApp rows are per-provider
 * singletons shared with seed data, so this file borrows them and always
 * puts them back.
 */

const ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
] as const

async function restoreSeedApps() {
  await db.adPlatformApp.upsert({
    where: { provider: 'meta' },
    create: { provider: 'meta', clientId: 'seed-app', clientSecret: 'seed' },
    update: { clientId: 'seed-app', clientSecret: 'seed' },
  })
  await db.adPlatformApp.upsert({
    where: { provider: 'google' },
    create: { provider: 'google', clientId: 'seed-app', clientSecret: 'seed', developerToken: 'seed' },
    update: { clientId: 'seed-app', clientSecret: 'seed', developerToken: 'seed' },
  })
}

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await restoreSeedApps()
})

describe('platformApp', () => {
  it('reads the environment and never touches the database row', async () => {
    vi.stubEnv('META_APP_ID', 'env-app')
    vi.stubEnv('META_APP_SECRET', 'env-secret')
    // The row says something different, so a wrong answer is visible.
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'env-app', clientSecret: 'env-secret' })
  })

  it('leaves a plaintext environment secret alone', async () => {
    vi.stubEnv('META_APP_ID', 'env-app')
    vi.stubEnv('META_APP_SECRET', 'not-encrypted-at-all')
    expect((await platformApp('meta'))?.clientSecret).toBe('not-encrypted-at-all')
  })

  it('decrypts an environment secret too, so a value copied out of the database still works', async () => {
    // The deployment step is "copy the values already in the database", and a
    // row's clientSecret is stored encrypted — so what somebody reads out and
    // pastes into Vercel is enc:v1: ciphertext. This is the case that fails if
    // the env path skips decryptSecret, and the previous version of this test
    // could not catch it: asserting plaintext-in-plaintext-out passes whether
    // decryptSecret is called or not.
    vi.stubEnv('META_APP_ID', 'env-app')
    vi.stubEnv('META_APP_SECRET', encryptSecret('the-real-secret'))
    expect((await platformApp('meta'))?.clientSecret).toBe('the-real-secret')
  })

  it('falls through to the row when only one of the two variables is set', async () => {
    vi.stubEnv('META_APP_ID', 'env-app-only')
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })
    expect((await platformApp('meta'))?.clientId).toBe('row-app')
  })

  it('counts a whitespace-only variable as unset', async () => {
    vi.stubEnv('META_APP_ID', '   ')
    vi.stubEnv('META_APP_SECRET', '   ')
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })
    expect((await platformApp('meta'))?.clientId).toBe('row-app')
  })

  it('falls back to the database row and decrypts it', async () => {
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'row-app', clientSecret: 'row-secret' })
  })

  it('treats an empty environment variable as unset, not as a blank secret', async () => {
    // Vercel produces empty strings. Treating one as configured would send
    // somebody to Facebook with no client_id.
    vi.stubEnv('META_APP_ID', '')
    vi.stubEnv('META_APP_SECRET', '')
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })

    expect((await platformApp('meta'))?.clientId).toBe('row-app')
  })

  it('answers null when neither the environment nor a row has it', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'meta' } })
    expect(await platformApp('meta')).toBeNull()
  })

  it('carries the developer token for Google and omits it for Meta', async () => {
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'g-app')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'g-secret')
    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'g-dev')
    vi.stubEnv('META_APP_ID', 'm-app')
    vi.stubEnv('META_APP_SECRET', 'm-secret')

    expect(await platformApp('google')).toEqual({
      clientId: 'g-app',
      clientSecret: 'g-secret',
      developerToken: 'g-dev',
    })
    expect(await platformApp('meta')).not.toHaveProperty('developerToken')
  })

  it('still answers for Google when only the developer token is missing', async () => {
    // The login dialog needs no developer token; only the API calls do. The
    // callers that need it check for themselves.
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'g-app')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'g-secret')
    const app = await platformApp('google')
    expect(app?.clientId).toBe('g-app')
    expect(app?.developerToken).toBeUndefined()
  })
})

describe('configuredProviders', () => {
  it('calls Google configured only when the developer token is there too', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'google' } })
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'g-app')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'g-secret')
    expect((await configuredProviders()).google).toBe(false)

    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'g-dev')
    expect((await configuredProviders()).google).toBe(true)
  })

  it('calls Meta configured on an id and a secret alone', async () => {
    vi.stubEnv('META_APP_ID', 'm-app')
    vi.stubEnv('META_APP_SECRET', 'm-secret')
    expect((await configuredProviders()).meta).toBe(true)
  })

  it('reports both false when nothing is configured anywhere', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: { in: ['meta', 'google'] } } })
    expect(await configuredProviders()).toEqual({ meta: false, google: false })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/ads/platform-app.test.ts`
Expected: FAIL — `./platform-app` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ads/platform-app.ts`:

```ts
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'

/**
 * Where the Meta and Google app credentials come from.
 *
 * The environment first, the AdPlatformApp row second. That order is the whole
 * point: these used to be a form the client filled in, which made him register
 * a Facebook app and apply for a Google developer token before he could press
 * a button. They are server configuration, and BeProfit — the tool he compared
 * us to — has always treated them that way.
 *
 * The row survives as a fallback rather than being dropped, so a mistyped
 * variable name on Vercel cannot take the live site dark.
 */

export type PlatformCredentials = {
  clientId: string
  clientSecret: string
  developerToken?: string
}

type Provider = 'meta' | 'google'

const ENV: Record<Provider, { id: string; secret: string; developerToken?: string }> = {
  meta: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
  google: {
    id: 'GOOGLE_ADS_CLIENT_ID',
    secret: 'GOOGLE_ADS_CLIENT_SECRET',
    developerToken: 'GOOGLE_ADS_DEVELOPER_TOKEN',
  },
}

/** Vercel hands back empty strings for variables that were never filled in. */
function env(name: string | undefined): string | undefined {
  if (!name) return undefined
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export async function platformApp(provider: Provider): Promise<PlatformCredentials | null> {
  const keys = ENV[provider]
  let clientId = env(keys.id)
  let clientSecret = env(keys.secret)
  let developerToken = env(keys.developerToken)

  if (!clientId || !clientSecret) {
    const row = await db.adPlatformApp.findUnique({ where: { provider } })
    if (!row) return null
    clientId = row.clientId
    clientSecret = row.clientSecret
    developerToken = row.developerToken ?? undefined
  }

  // One decrypt for both sources, deliberately. decryptSecret returns a value
  // without the enc:v1: prefix unchanged, so a plaintext variable is untouched
  // — and the deployment step for this change is "copy the values already in
  // the database", where what you read out of a row IS enc:v1: ciphertext.
  // Branching here would turn that instruction into a trap.
  return {
    clientId,
    clientSecret: decryptSecret(clientSecret),
    ...(developerToken ? { developerToken: decryptSecret(developerToken) } : {}),
  }
}

/**
 * What the ad-accounts page is allowed to know: whether a button will work.
 * Google needs the developer token as well, because every call after the login
 * carries it. Meta needs only the app it logs into.
 */
export async function configuredProviders(): Promise<{ meta: boolean; google: boolean }> {
  const [meta, google] = await Promise.all([platformApp('meta'), platformApp('google')])
  return {
    meta: Boolean(meta),
    google: Boolean(google?.developerToken),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/ads/platform-app.test.ts`
Expected: PASS, all 10 cases.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors. Baseline before this task is 626 tests across 89 files, so expect 636 across 90.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ads/platform-app.ts src/lib/ads/platform-app.test.ts
git commit -m "feat: the app credentials can come from the environment"
```

---

### Task 2: The server reads the accessor

**Files:**
- Modify: `src/app/api/ads/oauth/[provider]/start/route.ts:30`
- Modify: `src/app/api/ads/oauth/[provider]/callback/route.ts:42`
- Modify: `src/lib/ads/sync.ts:68`
- Modify: `src/app/api/ads/connections/[id]/accounts/route.ts:29`
- Modify: `src/app/api/ads/connections/meta/route.ts:47`
- Test: `src/app/api/ads/oauth.test.ts`

**Interfaces:**
- Consumes: `platformApp` from Task 1.
- Produces: no new exports. After this, no production code outside `platform-app.ts` reads `db.adPlatformApp`.

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/ads/oauth.test.ts`. The file's `beforeEach` upserts both rows; these cases delete a row and lean on the environment instead, which is the production shape after this change and is untested today.

```ts
describe('credentials from the environment', () => {
  it('starts the Facebook login with no database row at all', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'meta' } })
    vi.stubEnv('META_APP_ID', 'env-meta-app')
    vi.stubEnv('META_APP_SECRET', 'env-meta-secret')

    const res = await start('meta')
    expect(res.status).toBe(307)
    expect(res.headers.get('location') ?? '').toContain('client_id=env-meta-app')
  })

  it('prefers the environment over a row that disagrees', async () => {
    vi.stubEnv('META_APP_ID', 'env-wins')
    vi.stubEnv('META_APP_SECRET', 'env-secret')
    const res = await start('meta')
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('client_id=env-wins')
    expect(location).not.toContain('oauth-test-app')
  })

  it('says the server is not configured when neither has it', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'meta' } })
    const res = await start('meta')
    expect(res.headers.get('location')).toContain(
      encodeURIComponent('Facebook connect is not configured on the server.'),
    )
  })
})
```

Add `vi.unstubAllEnvs()` to the file's existing `afterEach`, beside `vi.unstubAllGlobals()`.

Then protect the suites that seed a row and expect it to be used. At the top of `src/app/api/ads/oauth.test.ts`, and again in `src/app/api/ads/connections/meta/route.test.ts`, add to the existing `beforeEach`:

```ts
  // These suites seed an AdPlatformApp row and expect it to be read. The
  // accessor prefers the environment, so a developer with these set in their
  // local .env would silently exercise the wrong source.
  for (const k of [
    'META_APP_ID',
    'META_APP_SECRET',
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
  ]) {
    vi.stubEnv(k, '')
  }
```

and `vi.unstubAllEnvs()` to `afterEach` in `route.test.ts` too. The three new cases above re-stub the two Meta variables they need after this baseline, which is why they must call `vi.stubEnv` themselves rather than relying on ambient values.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/ads/oauth.test.ts`
Expected: FAIL — the routes still read the row directly, so deleting it produces "Fill in the platform setup below first." rather than reading the environment.

- [ ] **Step 3: Move the start route**

In `src/app/api/ads/oauth/[provider]/start/route.ts`, replace the `db` import with the accessor:

```ts
import { platformApp } from '@/lib/ads/platform-app'
```

Remove the now-unused `import { db } from '@/lib/db'`. Replace the lookup and its error:

```ts
    const app = await platformApp(provider)
    if (!app) {
      // There is no setup form to send anyone to any more. This is an
      // operator's problem: a missing Vercel variable and no fallback row.
      const platform = provider === 'meta' ? 'Facebook' : 'Google'
      return back(
        `/settings/ad-accounts?error=${encodeURIComponent(
          `${platform} connect is not configured on the server.`,
        )}`,
      )
    }
```

`buildMetaAuthUrl(app.clientId, ...)` and `buildGoogleAuthUrl(app.clientId, ...)` below need no change.

- [ ] **Step 4: Move the callback route**

In `src/app/api/ads/oauth/[provider]/callback/route.ts`, same import swap, then:

```ts
    const app = await platformApp(provider)
    if (!app) {
      const platform = provider === 'meta' ? 'Facebook' : 'Google'
      return fail(`${platform} connect is not configured on the server.`)
    }
    const platformCredentials = { clientId: app.clientId, clientSecret: app.clientSecret }
```

Then use `platformCredentials` where the old `platformApp` local object was passed to `exchangeMetaCode` / `exchangeGoogleCode`. **Rename the local** — the old code names it `platformApp`, which now collides with the imported function. The `decryptSecret` calls on `app.clientSecret` go: the accessor already decrypted.

- [ ] **Step 5: Move sync.ts**

In `src/lib/ads/sync.ts`, add the import and replace lines 68-78:

```ts
    const app = await platformApp('google')
    if (!app?.developerToken) {
      throw new AdApiError('Google connect is not configured on the server.')
    }
    return {
      developerToken: app.developerToken,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken: decryptSecret(account.connection.secret),
      ...(account.loginCustomerId ? { loginCustomerId: account.loginCustomerId } : {}),
    }
```

The message changes because "Fill it in under Ad accounts" now points at a form that does not exist. `decryptSecret` stays for `account.connection.secret`, which is a connection token and still encrypted — only the app credentials came pre-decrypted.

- [ ] **Step 6: Move the accounts route**

In `src/app/api/ads/connections/[id]/accounts/route.ts`, replace lines 29-41:

```ts
      const app = await platformApp('google')
      if (!app?.developerToken) {
        return NextResponse.json(
          { error: 'Google connect is not configured on the server.' },
          { status: 400 },
        )
      }
      listed = await listGoogleAdAccounts({
        developerToken: app.developerToken,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken: decryptSecret(connection.secret),
      })
```

- [ ] **Step 7: Move the meta token route**

In `src/app/api/ads/connections/meta/route.ts`, replace the lookup at line 47:

```ts
    const app = await platformApp('meta')
    const { label, expiresAt } = await inspectMetaToken(
      app ? { clientId: app.clientId, clientSecret: app.clientSecret } : null,
      parsed.data.token,
    )
```

This route is unreachable from the UI and tracked for deletion, but leaving one direct `db.adPlatformApp` read behind would make the rule "only `platform-app.ts` reads that table" untrue, and the next reader would have to work out which is authoritative.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/app/api/ads/oauth.test.ts src/lib/ads/sync.test.ts src/app/api/ads/connections/meta/route.test.ts`
Expected: PASS. `sync.test.ts` needs no change — it was checked, and it never asserted the old "Google platform setup is missing" wording, so renaming that message breaks nothing.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/ads/oauth src/lib/ads/sync.ts src/app/api/ads/connections src/app/api/ads/oauth.test.ts src/lib/ads/sync.test.ts
git commit -m "refactor: every credential read goes through one accessor"
```

---

### Task 3: The page loses its setup section

**Files:**
- Modify: `src/app/settings/ad-accounts/page.tsx`
- Modify: `src/app/settings/ad-accounts/AdAccountsClient.tsx`
- Test: `src/app/settings/ad-accounts/AdAccountsClient.test.tsx`

**Interfaces:**
- Consumes: `configuredProviders` from Task 1.
- Produces: `export type PlatformSetup = { meta: boolean; google: boolean }` — the same exported name, a narrower shape. `AdAccountsClient.test.tsx` imports it.

- [ ] **Step 1: Write the failing tests**

In `src/app/settings/ad-accounts/AdAccountsClient.test.tsx`, change the fixture:

```ts
const READY: PlatformSetup = { meta: true, google: true }
```

Delete four tests, each because the thing it asserted no longer exists:

| Test | Line | Why |
| --- | --- | --- |
| `'walks you to the setup when the Google connect button is pressed too early'` | 76 | no setup to walk to |
| `'walks you to the setup when the Facebook connect button is pressed too early'` | 103 | same |
| `'offers a one-time setup card for both platforms'` | 124 | no card |
| `'saves the platform setup and never demands a saved secret again'` | 225 | no form to save |

Add in their place:

```ts
  it('offers both connect buttons as real links when the server is configured', () => {
    renderPage([])
    expect(screen.getByText('Connect with Facebook').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/meta/start',
    )
    expect(screen.getByText('Connect with Google').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/google/start',
    )
  })

  it('says so plainly when a platform is not configured on the server', async () => {
    renderPage([], { platform: { meta: false, google: true } })

    // Not a link: pressing it would only bounce off Facebook with a worse error.
    expect(screen.getByText('Connect with Facebook').closest('a')).toBeNull()
    fireEvent.click(screen.getByText('Connect with Facebook'))
    await waitFor(() =>
      expect(
        screen.getByText('Facebook connect is not set up on the server yet.'),
      ).toBeTruthy(),
    )
    // Google is unaffected.
    expect(screen.getByText('Connect with Google').closest('a')).toBeTruthy()
  })

  it('asks the client for no app credentials anywhere', () => {
    renderPage([])
    expect(screen.queryByText('Platform setup')).toBeNull()
    expect(screen.queryByLabelText('meta client id')).toBeNull()
    expect(screen.queryByLabelText('google client id')).toBeNull()
    expect(screen.queryByLabelText('google developer token')).toBeNull()
    expect(screen.queryByText('Callback URL:')).toBeNull()
  })
```

Update `'still offers the manual path behind Advanced, with provider fields switching'` at line 132 — the Google setup card was the page's other "Developer token" label, so the count before opening the modal is now zero:

```ts
  it('still offers the manual path behind Advanced, with provider fields switching', () => {
    renderPage([])
    // The setup cards are gone, so the modal is the only place this label lives.
    expect(screen.queryAllByText('Developer token')).toHaveLength(0)

    fireEvent.click(screen.getByText('Advanced: paste credentials manually'))
    expect(screen.getByText('Access token for this account')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Google' }))
    expect(screen.getAllByText('Developer token')).toHaveLength(1) // modal only
    expect(screen.queryByText('Access token for this account')).toBeNull()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/settings/ad-accounts/AdAccountsClient.test.tsx`
Expected: FAIL — `PlatformSetup` still wants objects, so the fixture is a type error, and "Platform setup" still renders.

- [ ] **Step 3: Narrow the type and the buttons**

In `AdAccountsClient.tsx`, replace the type at line 23:

```tsx
/** Whether each platform's app is configured on the server. Nothing more: the
 * client never types these credentials, so the browser never needs to see
 * them. */
export type PlatformSetup = { meta: boolean; google: boolean }
```

Replace the header buttons at lines 129-133:

```tsx
          <ConnectButton provider="meta" ready={platform.meta} />
          <ConnectButton provider="google" ready={platform.google} />
```

Replace `ConnectButton`'s not-ready branch. It currently scrolls to a setup section that will not exist:

```tsx
function ConnectButton({ provider, ready }: { provider: 'meta' | 'google'; ready: boolean }) {
  const toast = useToast()
  const text = provider === 'meta' ? 'Connect with Facebook' : 'Connect with Google'
  if (!ready) {
    // A button that cannot be pressed and cannot say why is a dead end. There
    // is nowhere on the page to send anyone now: the credentials are server
    // config, so a missing one is ours to fix, not the reader's.
    const platform = provider === 'meta' ? 'Facebook' : 'Google'
    return (
      <button
        onClick={() => toast.error(`${platform} connect is not set up on the server yet.`)}
        className={quietBtn}
      >
        {text}
      </button>
    )
  }
  return (
    <a href={`/api/ads/oauth/${provider}/start`} className={primaryBtn}>
      {text}
    </a>
  )
}
```

- [ ] **Step 4: Delete the setup section**

Delete the whole `PlatformSetupSection` function and its doc comment, the whole `PlatformCard` function, and the usage at line 238:

```tsx
        <PlatformSetupSection platform={platform} />
```

`PlatformCard` was the only user of the `field` and `label` style constants at lines 30-31 and of `useEffect`. Remove whichever become unused — `npx eslint` and `npx tsc --noEmit` will name them. The `useRouter`, `useState` and `useRef` imports are used elsewhere; leave them.

Update the empty-table copy, which still points at a setup that is gone:

```tsx
                    Nothing connected yet. Press “Connect with Facebook” or “Connect with
                    Google” above.
```

- [ ] **Step 5: Feed the page booleans**

In `src/app/settings/ad-accounts/page.tsx`, replace `db.adPlatformApp.findMany()` in the `Promise.all` with `configuredProviders()`, import it from `@/lib/ads/platform-app`, delete the `meta`/`google` `find` lines, and pass the result straight through:

```tsx
  const [accounts, shops, platform] = await Promise.all([
    db.adAccount.findMany({
      include: { shop: { select: { name: true } }, connection: { select: { label: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.shop.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    configuredProviders(),
  ])
```

and `platform={platform}` in the JSX.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/app/settings/ad-accounts/AdAccountsClient.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/app/settings/ad-accounts/AdAccountsClient.tsx src/app/settings/ad-accounts/page.tsx`
Expected: clean. `src/app/settings/costs/CostsClient.tsx` has eslint errors that predate this work — do not fix them.

- [ ] **Step 8: Commit**

```bash
git add src/app/settings/ad-accounts
git commit -m "feat: the ad accounts page is two buttons and a table"
```

---

### Task 4: The write path goes, and the gate runs

**Files:**
- Delete: `src/app/api/ad-platform-apps/route.ts`
- Modify: `src/app/api/ads/oauth.test.ts` (remove the `platform setup` suite)
- Modify: `.env.example`
- Modify: `e2e/marketing.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 3.
- Produces: no code. This is deletion, documentation and verification.

- [ ] **Step 1: Write the failing e2e expectations**

In `e2e/marketing.spec.ts`, inside `'the ad accounts page offers one-click connect and lists the seeded accounts'`, replace the setup-card assertions with:

```ts
  // The client registers nothing: the app credentials are server config now.
  await expect(page.getByRole('heading', { name: 'Platform setup' })).toHaveCount(0)
  await expect(page.getByText('Callback URL:')).toHaveCount(0)
  await expect(page.getByText('/api/ads/oauth/google/callback')).toHaveCount(0)
  await expect(page.getByText('/api/ads/oauth/meta/callback')).toHaveCount(0)
  await expect(page.getByText('Meta app', { exact: true })).toHaveCount(0)
```

Keep the two `Connect with …` link assertions and the seeded-account assertions exactly as they are — they must still pass, which is the point.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/marketing.spec.ts`
Expected: FAIL — the setup heading and callback URLs are still on the page until Task 3's changes are in. If Task 3 is already committed this passes immediately; that is fine, note it and continue.

- [ ] **Step 3: Delete the route and its tests**

Delete the file `src/app/api/ad-platform-apps/route.ts`.

In `src/app/api/ads/oauth.test.ts`, delete the import at line 19:

```ts
const { GET: appsGet, PUT: appsPut } = await import('../ad-platform-apps/route')
```

and delete the whole `describe('platform setup', …)` block at lines 104-141. Leave a note where it was, in the file's existing voice:

```ts
// A "platform setup" suite lived here, covering the route that saved the
// client's App ID and secret. Both are gone: the credentials are environment
// variables now, so there is no form, no route and nothing to encrypt at
// save time. What proves a credential is read correctly lives in
// src/lib/ads/platform-app.test.ts.
```

- [ ] **Step 4: Document the variables**

Append to `.env.example`, matching the explanatory tone of the entries already there:

```
# --- Ad platform apps ---
# The Meta app and Google OAuth client behind "Connect with Facebook" and
# "Connect with Google". These used to be a form the client filled in, which
# made him register a Facebook app and apply for a Google developer token
# before either button worked. They are server config: set them here and he
# presses one button and picks his ad accounts.
#
# Leave them unset and the app falls back to the AdPlatformApp row already in
# the database, so a typo here cannot take a working deployment down.
# META_APP_ID="..."
# META_APP_SECRET="..."
# GOOGLE_ADS_CLIENT_ID="....apps.googleusercontent.com"
# GOOGLE_ADS_CLIENT_SECRET="..."
# GOOGLE_ADS_DEVELOPER_TOKEN="..."
```

- [ ] **Step 5: Run the whole gate**

Run each and report real output:

1. `npx vitest run` — full suite.
2. `npx tsc --noEmit` — must be clean.
3. `npx next build` — must compile. On `EPERM: operation not permitted, unlink '.next/...'`, a dev server holds a Windows file lock: stop it, delete `.next`, rebuild. Never report success on a red build.
4. `npx playwright test` — all specs.

- [ ] **Step 6: Commit**

```bash
git add -A src/app/api/ad-platform-apps src/app/api/ads/oauth.test.ts .env.example e2e/marketing.spec.ts
git commit -m "refactor: nothing writes the platform app rows any more"
```

---

## After the plan

**Set the five variables on Vercel** to the values already in the database. Until then the fallback keeps the site working, so this is not urgent — but the point of the change is unmet until it is done.

**The Facebook app still needs its redirect URI.** Open `https://developers.facebook.com/apps/1526277315425302/`, add the **Facebook Login for Business** product, paste `https://panetti.vercel.app/api/ads/oauth/meta/callback` under Valid OAuth Redirect URIs, save. No API can do this, and nothing else works until it is done.

**Jacob needs a role on the Facebook app.** Meta's App Modes reference: a Development-mode app "can only request permissions from role users". BeProfit shows the Facebook ad accounts under Jacob Kjos Hanssen, not Philip, so Jacob needs at least Tester on that app or his login is refused for a reason no error message will explain. This is the likeliest remaining thing to look like a bug.

**Check the Google client's publishing status.** It must be *In production*. Unverified is fine — one "Google hasn't verified this app" screen, clicked past, with a 100-account lifetime cap that does not concern us. On *Testing* status Google issues refresh tokens that expire after **seven days**, and the sync would die weekly for a reason nothing in our code could report.

**The legacy Meta connection rename**, carried from `2026-07-30-meta-oauth-like-beprofit.md`, still applies and still has to happen before the first real login.

**Follow-ups from the previous branch stand**, including the missing expiry warning and the bulk route's inability to re-point an account's connection. Nothing here changes them.
