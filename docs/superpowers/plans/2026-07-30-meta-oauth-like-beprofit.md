# Connect with Facebook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore "Connect with Facebook" so Meta connects by login and account picker, exactly the way our Google path and BeProfit both already work.

**Architecture:** Meta rejoins the provider-generic OAuth pipeline it was removed from in `fb4686d`. `buildMetaAuthUrl` and `exchangeMetaCode` come back from git unchanged because they were already correct; `ensureMetaApp` stays deleted because it was the loop. The start and callback routes drop their `provider !== 'google'` gate. Everything downstream of the callback - the picker, `/me/adaccounts`, bulk connect, the 365-day backfill - already exists and is tested.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 6 + PostgreSQL, Vitest (jsdom + DB-backed + stubbed fetch), Playwright, Tailwind 4.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-30-meta-oauth-like-beprofit-design.md`.
- Send `scope=ads_read,business_management`. Do **not** add `config_id`: Meta's reference says `scope` "can still be included" and `config_id` is "an optional parameter", and requiring one would mean the client creating a configuration and pasting a second id into our app.
- Full-page redirect, never a popup. BeProfit's own troubleshooting panel warns about blocked popups; the redirect has no such failure mode.
- `ensureMetaApp` and its `covered` helper stay deleted. Never reintroduce a self-healing App Domains write.
- `inspectMetaToken` and `POST /api/ads/connections/meta` stay, with their tests, even though nothing in the UI calls them after Task 3. Tracked debt, deleted in a follow-up once the login is confirmed live.
- The per-account "Advanced: paste credentials manually" path stays untouched for both providers.
- The Meta setup card must display the exact callback URL. That is the only mitigation for the one failure we cannot catch server-side.
- The product the client adds is **Facebook Login for Business**, not "Facebook Login". Business type apps only get the former.
- Never test against live Neon. Use the local Postgres in `%LOCALAPPDATA%\panetti-pg`; `.env.test` already points there.
- Edit files with the Edit/Write tools only. PowerShell 5.1 `Get-Content`/`Set-Content` mojibakes UTF-8 in this repo.
- Instruction copy the client reads uses plain words and exact values. No menu-path jargon.
- Run the full suite, not just the file you touched. `AdPlatformApp` rows are per-provider singletons shared with seed data, and suites borrow them.

---

### Task 1: Restore the Meta OAuth helpers

**Files:**
- Modify: `src/lib/ads/oauth.ts`
- Test: `src/lib/ads/oauth.test.ts`

**Interfaces:**
- Consumes: `AdApiError` from `./types`; the existing `PlatformApp` type and `readJson` helper pattern in this file.
- Produces:
  - `buildMetaAuthUrl(clientId: string, redirectUri: string, state: string): string`
  - `exchangeMetaCode(app: PlatformApp, redirectUri: string, code: string): Promise<{ token: string; expiresAt: Date; label: string }>`

  Task 2 imports both.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/ads/oauth.test.ts`. Import `buildMetaAuthUrl` and `exchangeMetaCode` alongside the existing imports, and add a Meta redirect constant next to the existing `REDIRECT`:

```ts
const META_REDIRECT = 'https://panetti.vercel.app/api/ads/oauth/meta/callback'
```

Then add these suites:

```ts
describe('buildMetaAuthUrl', () => {
  it('sends the state and the ads scopes to the same dialog BeProfit uses', () => {
    const url = buildMetaAuthUrl('app-1', META_REDIRECT, 'st-1')
    expect(url).toContain('facebook.com/v25.0/dialog/oauth')
    expect(url).toContain('client_id=app-1')
    expect(url).toContain('state=st-1')
    expect(url).toContain(encodeURIComponent('ads_read,business_management'))
    expect(url).toContain(encodeURIComponent(META_REDIRECT))
  })

  // config_id is optional and scope still works. Sending one would cost the
  // client a configuration to create and a second id to paste.
  it('sends no config_id', () => {
    expect(buildMetaAuthUrl('app-1', META_REDIRECT, 'st-1')).not.toContain('config_id')
  })
})

describe('exchangeMetaCode', () => {
  it('trades the code for a long-lived token and reads who logged in', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'short' }))
      .mockResolvedValueOnce(json({ access_token: 'long', expires_in: 5_184_000 }))
      .mockResolvedValueOnce(json({ name: 'Jacob Kjos Hanssen' }))
    vi.stubGlobal('fetch', fetchMock)

    const before = Date.now()
    const result = await exchangeMetaCode(APP, META_REDIRECT, 'code-1')
    expect(result.token).toBe('long')
    expect(result.label).toBe('Jacob Kjos Hanssen')
    const days = (result.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(59)
    expect(days).toBeLessThan(61)

    // The long-lived exchange carried the short token, not the code.
    expect(String(fetchMock.mock.calls[1][0])).toContain('fb_exchange_token=short')
  })

  it('keeps the short token when the long-lived exchange says nothing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'short' }))
      .mockResolvedValueOnce(json({}, 400))
      .mockResolvedValueOnce(json({ name: 'Jacob' }))
    vi.stubGlobal('fetch', fetchMock)

    // A silent exchange must not lose a token that already works.
    const result = await exchangeMetaCode(APP, META_REDIRECT, 'code-1')
    expect(result.token).toBe('short')
  })

  it("surfaces Facebook's own words on a rejected code", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({ error: { message: 'This authorization code has expired.' } }, 400),
      ),
    )
    await expect(exchangeMetaCode(APP, META_REDIRECT, 'old')).rejects.toThrow(
      new AdApiError('This authorization code has expired.'),
    )
  })
})
```

`AdApiError` must be imported in this file. The current version dropped that import when the Meta tests went, so add it back:

```ts
import { AdApiError } from './types'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/ads/oauth.test.ts`
Expected: FAIL - `buildMetaAuthUrl` and `exchangeMetaCode` are not exported from `./oauth`.

- [ ] **Step 3: Restore the implementation**

In `src/lib/ads/oauth.ts`, add the Meta constants next to the existing `GOOGLE_TOKEN`:

```ts
const META = 'https://graph.facebook.com/v25.0'

/** Meta tokens usually say how long they live; when silent, plan for 60 days. */
const META_TOKEN_DAYS = 60
```

Add a `readJson` helper if the current file no longer has one:

```ts
async function readJson<T>(res: Response): Promise<T & { error?: { message?: string } }> {
  return (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
}
```

Add `buildMetaAuthUrl` beside `buildGoogleAuthUrl`:

```ts
/**
 * The dialog BeProfit's own login popup runs on, same endpoint and version.
 *
 * No `config_id`. Meta recommends one for Facebook Login for Business, but its
 * reference calls it optional and says `scope` "can still be included" - and a
 * configuration id would be one more value the client has to create and paste.
 * The redirect URI is the only thing this dialog needs that no API can set.
 */
export function buildMetaAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: 'ads_read,business_management',
  })
  return `https://www.facebook.com/v25.0/dialog/oauth?${params}`
}
```

Add `exchangeMetaCode` beside `exchangeGoogleCode`:

```ts
export async function exchangeMetaCode(
  app: PlatformApp,
  redirectUri: string,
  code: string,
): Promise<{ token: string; expiresAt: Date; label: string }> {
  const short = await readJson<{ access_token?: string }>(
    await fetch(
      `${META}/oauth/access_token?${new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: redirectUri,
        client_secret: app.clientSecret,
        code,
      })}`,
    ),
  )
  if (!short.access_token)
    throw new AdApiError(short.error?.message ?? 'Facebook did not accept the login')

  // Trade the hours-lived token for the ~60-day one before storing anything.
  // A silent answer here is not a failure: the short token already works.
  const long = await readJson<{ access_token?: string; expires_in?: number }>(
    await fetch(
      `${META}/oauth/access_token?${new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        fb_exchange_token: short.access_token,
      })}`,
    ),
  )
  const token = long.access_token ?? short.access_token
  const seconds = long.expires_in ?? META_TOKEN_DAYS * 24 * 60 * 60
  const expiresAt = new Date(Date.now() + seconds * 1000)

  const me = await readJson<{ name?: string }>(
    await fetch(`${META}/me?fields=name`, { headers: { Authorization: `Bearer ${token}` } }),
  )
  return { token, expiresAt, label: me.name ?? 'Facebook' }
}
```

Update the file's header comment, which currently describes Google only:

```ts
/**
 * The OAuth handshakes behind "Connect with Facebook / Google".
 *
 * The apps are the CLIENT'S own: their admin is the only person who ever logs
 * in, which is exactly the case both platforms allow without app review. Meta
 * calls that Standard Access, and a Business type app gets it automatically.
 *
 * There is no app-settings healing here any more. `ensureMetaApp` used to
 * prove the App ID, read the app's `app_domains` and write ours in - eighty
 * lines aimed at a field that was never the problem. The redirect URI was.
 */
```

Also replace the stale note left where the Meta tests used to live in `src/lib/ads/oauth.test.ts`:

```ts
// ensureMetaApp was tested here at length: the domain write, the "healed"
// answer, the refused write. All of it went with the loop it powered, and
// none of it comes back. What proves a pasted token lives in ./token.test.ts.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/ads/oauth.test.ts`
Expected: PASS, including the pre-existing Google cases.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ads/oauth.ts src/lib/ads/oauth.test.ts
git commit -m "feat: the Meta auth URL and code exchange come back, without the healing"
```

---

### Task 2: The start and callback routes accept meta again

**Files:**
- Modify: `src/app/api/ads/oauth/[provider]/start/route.ts`
- Modify: `src/app/api/ads/oauth/[provider]/callback/route.ts`
- Test: `src/app/api/ads/oauth.test.ts`

**Interfaces:**
- Consumes: `buildMetaAuthUrl`, `exchangeMetaCode` from Task 1; the existing `STATE_COOKIE`, `buildGoogleAuthUrl`, `exchangeGoogleCode`.
- Produces: `GET /api/ads/oauth/meta/start` redirecting to Facebook's dialog with a state cookie, and `GET /api/ads/oauth/meta/callback` creating an `AdConnection` and redirecting to `/settings/ad-accounts?picker=<id>`. Task 3's button links to the start route.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/api/ads/oauth.test.ts`. The file already has `start`, `callback`, `asAdmin`, `wipe`, `restoreSeedApps`, and a `beforeEach` that already upserts **both** app rows - meta as `clientId: 'oauth-test-app'` and google as `clientId: 'oauth-test-google'`. No setup change is needed; the assertions below use `oauth-test-app` because that is the row already there.

Add:

```ts
describe('meta oauth start', () => {
  it('stamps a state cookie and sends the admin to the Facebook dialog', async () => {
    const res = await start('meta')
    expect(res.status).toBe(307)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('facebook.com/v25.0/dialog/oauth')
    expect(location).toContain('client_id=oauth-test-app')
    expect(location).toContain(encodeURIComponent('/api/ads/oauth/meta/callback'))
    expect(res.headers.get('set-cookie') ?? '').toMatch(/ads_oauth_state=meta(%3A|:)/)
  })

  // Saving the app row no longer calls Meta, so starting must not either.
  it('reaches the dialog without asking Facebook anything first', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await start('meta')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the admin to the setup when no meta app row exists', async () => {
    await db.adPlatformApp.delete({ where: { provider: 'meta' } })
    const res = await start('meta')
    expect(res.headers.get('location')).toContain(
      encodeURIComponent('Fill in the platform setup below first.'),
    )
  })
})

describe('meta oauth callback', () => {
  const stubExchange = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('fb_exchange_token'))
          return json({ access_token: 'long-lived', expires_in: 5_184_000 })
        if (url.includes('/me')) return json({ name: `${MARK} Jacob` })
        return json({ access_token: 'short' })
      }),
    )

  it('stores the long-lived token and opens the picker', async () => {
    stubExchange()
    cookieJar.state = 'meta:st-1'
    const res = await callback('meta', 'code=c1&state=st-1')

    expect(res.status).toBe(307)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/settings/ad-accounts?picker=')

    const row = await db.adConnection.findFirstOrThrow({
      where: { provider: 'meta', label: `${MARK} Jacob` },
    })
    expect(row.secret.startsWith('enc:v1:')).toBe(true)
    expect(row.secret).not.toContain('long-lived')
    // Meta tokens die; Google refresh tokens do not. The date must be real.
    expect(row.expiresAt).not.toBeNull()
    expect(location).toContain(row.id)
  })

  it('logging in again refreshes the same connection instead of piling up', async () => {
    stubExchange()
    cookieJar.state = 'meta:st-1'
    await callback('meta', 'code=c1&state=st-1')
    cookieJar.state = 'meta:st-2'
    await callback('meta', 'code=c2&state=st-2')

    const rows = await db.adConnection.findMany({
      where: { provider: 'meta', label: `${MARK} Jacob` },
    })
    expect(rows).toHaveLength(1)
  })

  it('refuses a callback whose state does not match the cookie', async () => {
    cookieJar.state = 'meta:st-1'
    const res = await callback('meta', 'code=c1&state=somebody-elses')
    expect(res.headers.get('location')).toContain(
      encodeURIComponent('The login came back wrong. Try again.'),
    )
    expect(await db.adConnection.count({ where: { label: { contains: MARK } } })).toBe(0)
  })

  it("passes Facebook's refusal straight through", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'Code was invalid.' } }, 400)),
    )
    cookieJar.state = 'meta:st-1'
    const res = await callback('meta', 'code=bad&state=st-1')
    expect(res.headers.get('location')).toContain(encodeURIComponent('Code was invalid.'))
  })
})

describe('unknown providers', () => {
  it('still refuses a platform we do not support', async () => {
    expect((await start('tiktok')).status).toBe(404)
    expect((await callback('tiktok', 'code=c&state=s')).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/ads/oauth.test.ts`
Expected: FAIL - the meta start and callback answer 404, so the status and location assertions fail.

- [ ] **Step 3: Open the start route to meta**

In `src/app/api/ads/oauth/[provider]/start/route.ts`, change the import:

```ts
import { STATE_COOKIE, buildGoogleAuthUrl, buildMetaAuthUrl } from '@/lib/ads/oauth'
```

Replace the gate and the URL construction:

```ts
    // Both platforms again. Meta's dialog needs one thing no API can set: the
    // callback URL registered under Facebook Login for Business. The setup
    // card prints it, so the wall is a visible instruction instead of a
    // "Can't load URL" screen.
    if (provider !== 'meta' && provider !== 'google') {
      return NextResponse.json({ error: 'No such platform' }, { status: 404 })
    }
```

```ts
    const url =
      provider === 'meta'
        ? buildMetaAuthUrl(app.clientId, redirectUri, state)
        : buildGoogleAuthUrl(app.clientId, redirectUri, state)
```

Update the route's header comment:

```ts
/**
 * Step one of "Connect with Facebook / Google": stamp a state cookie and send
 * the admin to the platform's login dialog. The callback checks the stamp so a
 * foreign redirect cannot plant a connection.
 *
 * Nothing is asked of the platform here. An earlier version proved the app and
 * healed its domains first, then told the admin to press the button again -
 * which it could do forever.
 */
```

- [ ] **Step 4: Open the callback route to meta**

In `src/app/api/ads/oauth/[provider]/callback/route.ts`, change the import:

```ts
import { STATE_COOKIE, exchangeGoogleCode, exchangeMetaCode } from '@/lib/ads/oauth'
```

Replace the gate:

```ts
    if (provider !== 'meta' && provider !== 'google') {
      return NextResponse.json({ error: 'No such platform' }, { status: 404 })
    }
```

Replace the single-provider exchange block with the branch:

```ts
    let secret: string
    let label: string
    // Google refresh tokens live as long as the client stays published; a
    // Meta user token is good for about 60 days and says so.
    let expiresAt: Date | null = null

    if (provider === 'meta') {
      const meta = await exchangeMetaCode(platformApp, redirectUri, code)
      secret = meta.token
      label = meta.label
      expiresAt = meta.expiresAt
    } else {
      const google = await exchangeGoogleCode(platformApp, redirectUri, code)
      secret = google.refreshToken
      label = google.label
    }
```

The existing upsert below already reads `secret`, `label` and `expiresAt`, so it needs no change.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/ads/oauth.test.ts`
Expected: PASS, Google cases included.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS. `AdPlatformApp` rows are per-provider singletons shared with seed data; if a unique-constraint error appears, the new meta upsert in `beforeEach` is colliding with another suite and `restoreSeedApps` must put it back in `afterEach`.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/ads/oauth/[provider]/start/route.ts src/app/api/ads/oauth/[provider]/callback/route.ts src/app/api/ads/oauth.test.ts
git commit -m "feat: the Facebook login round trip works again, end to end"
```

---

### Task 3: The page gets its Facebook button back and loses the token card

**Files:**
- Modify: `src/app/settings/ad-accounts/AdAccountsClient.tsx`
- Test: `src/app/settings/ad-accounts/AdAccountsClient.test.tsx`

**Interfaces:**
- Consumes: `GET /api/ads/oauth/meta/start` from Task 2; the existing `PlatformSetup` type, `PickerModal`, `quietBtn`, `primaryBtn`, `label`, `field`.
- Produces: no new exports. `MetaTokenCard` is deleted; `ConnectButton` and `PlatformCard` widen from `provider: 'google'` back to `provider: 'meta' | 'google'`.

- [ ] **Step 1: Write the failing tests**

In `src/app/settings/ad-accounts/AdAccountsClient.test.tsx`, replace the three token-card tests - `'offers Meta a token box instead of a Facebook login that never worked'`, `'saves a pasted Meta token and opens the picker on what comes back'`, and `'keeps the card open and says why when Facebook refuses the token'` - plus `'asks Meta for nothing but the token'`, with:

```ts
  it('links Connect with Facebook straight to the oauth start when ready', () => {
    renderPage([])
    expect(screen.getByText('Connect with Facebook').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/meta/start',
    )
  })

  it('walks you to the setup when the Facebook connect button is pressed too early', async () => {
    renderPage([], { platform: { meta: null, google: { clientId: 'x', hasDeveloperToken: true } } })

    expect(screen.getByText('Connect with Facebook').closest('a')).toBeNull()
    fireEvent.click(screen.getByText('Connect with Facebook'))
    await waitFor(() =>
      expect(
        screen.getByText('One-time setup needed first. Two minutes, the steps are right below.'),
      ).toBeTruthy(),
    )
  })

  it('asks for the token nowhere on the page any more', () => {
    renderPage([])
    // One button per platform, like BeProfit. The per-account paste behind
    // Advanced is the only place a token is still typed.
    expect(screen.queryByLabelText('System user access token')).toBeNull()
    expect(screen.queryByText('Meta: paste a system user token')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save token' })).toBeNull()
  })

  it('offers a one-time setup card for both platforms', () => {
    renderPage([])
    expect(screen.getByText('Platform setup')).toBeTruthy()
    expect(screen.getByLabelText('meta client id')).toBeTruthy()
    expect(screen.getByLabelText('meta client secret')).toBeTruthy()
    expect(screen.getByLabelText('google client id')).toBeTruthy()
  })
```

Also fix the existing test `'saves the platform setup and never demands a saved secret again'`. It currently presses `screen.getAllByRole('button', { name: 'Save' })[0]`, which was Google's card while Google's was the only one. With two cards `[0]` is Meta's, and the test asserts `provider === 'google'`, so it would fail. Target the button by its new name instead:

```ts
    fireEvent.change(screen.getByLabelText('google client id'), { target: { value: 'new-app-id' } })
    fireEvent.click(screen.getByRole('button', { name: 'save google setup' }))
```

The rest of that test is unchanged.

Update `'still offers the manual path behind Advanced, with provider fields switching'` - the Meta card has no Developer token field, so the count stays 1 before the tab switch and the modal's Meta label is unchanged:

```ts
  it('still offers the manual path behind Advanced, with provider fields switching', () => {
    renderPage([])
    // Only Google's setup card carries a Developer token.
    expect(screen.getAllByText('Developer token')).toHaveLength(1)

    fireEvent.click(screen.getByText('Advanced: paste credentials manually'))
    // The page-level token field is gone, so this label is now unique. Keep
    // the distinct wording anyway: it says what the field is scoped to.
    expect(screen.getByText('Access token for this account')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Google' }))
    expect(screen.getAllByText('Developer token')).toHaveLength(2) // card + modal
    expect(screen.queryByText('Access token for this account')).toBeNull()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/settings/ad-accounts/AdAccountsClient.test.tsx`
Expected: FAIL - no "Connect with Facebook" text, no `meta client id` label, and "Platform setup" still reads "Google setup".

- [ ] **Step 3: Delete MetaTokenCard and restore the Meta button**

In `AdAccountsClient.tsx`:

Delete the whole `MetaTokenCard` function and the comment block above it, and delete its usage:

```tsx
        <MetaTokenCard saved={platform.meta} onConnected={setPickerId} />
```

Add the Meta button in the header, before the Google one:

```tsx
        <div className="flex flex-wrap items-center gap-2">
          <ConnectButton provider="meta" ready={Boolean(platform.meta)} />
          <ConnectButton
            provider="google"
            ready={Boolean(platform.google && platform.google.hasDeveloperToken)}
          />
```

Delete the `{/* Meta has no button: it connects by pasted token, below. */}` comment.

Widen `ConnectButton`:

```tsx
function ConnectButton({ provider, ready }: { provider: 'meta' | 'google'; ready: boolean }) {
  const toast = useToast()
  const text = provider === 'meta' ? 'Connect with Facebook' : 'Connect with Google'
```

Its body is otherwise unchanged.

Update the page subtitle:

```tsx
        subtitle="Log in with Facebook or Google, tick the ad accounts you want, done. Daily spend then syncs itself a few times a day and lands on the Marketing page, shop by shop."
```

Update the empty-table copy:

```tsx
                    Nothing connected yet. Fill in the setup below, then press “Connect with
                    Facebook” or “Connect with Google”.
```

- [ ] **Step 4: Restore both setup cards**

Replace `PlatformSetupSection`:

```tsx
/**
 * The one-time setup, per platform. Both need the client's own app keys: ours
 * cannot stand in, because reading someone else's ad accounts through our app
 * is the exact case Meta requires App Review for. Their own app needs none.
 */
function PlatformSetupSection({ platform }: { platform: PlatformSetup }) {
  return (
    <section id="platform-setup" className="mt-8">
      <h2 className="text-[13px] font-semibold text-ink">Platform setup</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        A one-time step per platform: create your own app, paste its keys here, and the connect
        buttons above come alive. Only you ever log in through it, so no app review is needed.
      </p>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <PlatformCard provider="meta" saved={platform.meta} />
        <PlatformCard provider="google" saved={platform.google} />
      </div>
    </section>
  )
}
```

Widen `PlatformCard`'s signature:

```tsx
function PlatformCard({
  provider,
  saved,
}: {
  provider: 'meta' | 'google'
  saved: { clientId: string; hasDeveloperToken?: boolean } | null
}) {
```

Replace its `<h3>` and the description below it. The step list is the client's instructions, so it names the product exactly and drops the old "Saving adds this site to the app's domains for you" claim, which described code that no longer exists:

```tsx
      <h3 className="text-sm font-semibold text-ink">
        {provider === 'meta' ? 'Meta app' : 'Google app'}
      </h3>
      {provider === 'meta' ? (
        <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11px] text-muted">
          <li>developers.facebook.com: Create app, Business type.</li>
          <li>Paste the App ID and App secret here and press Save.</li>
          <li>
            In the app, add the product called “Facebook Login for Business”. A Business type app
            is only offered that one.
          </li>
          <li>
            Open its Settings and paste the callback URL below under Valid OAuth Redirect URIs.
            Press Save changes. Skip this and Facebook shows “Can’t load URL”.
          </li>
        </ol>
      ) : (
        <p className="mt-1 text-[11px] text-muted">
          console.cloud.google.com, Credentials, OAuth client (Web application) with the callback
          URL below. Set the consent screen to In production. The developer token comes from
          Google Ads, manager account, API Center.
        </p>
      )}
```

Fix the success toast, which currently always says Google:

```tsx
      toast.success(provider === 'meta' ? 'Meta setup saved' : 'Google setup saved')
```

Give the card's Save button a per-provider accessible name. This is required, not cosmetic: with two cards there are two buttons both named "Save", so `getAllByRole('button', { name: 'Save' })[0]` silently starts hitting Meta's card. Two identical buttons also read the same to a screen reader. At `AdAccountsClient.tsx:705`, on the button whose label is `{busy ? 'Saving…' : 'Save'}`, add:

```tsx
        aria-label={`save ${provider} setup`}
```

The `redirectUri` line already interpolates `provider`, so the Meta card prints `/api/ads/oauth/meta/callback` with no change. The `provider === 'google' &&` guard around the Developer token field also needs no change.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/settings/ad-accounts/AdAccountsClient.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/app/settings/ad-accounts/AdAccountsClient.tsx`
Expected: no errors. `CostsClient.tsx` has pre-existing errors on `main`; do not fix them here.

- [ ] **Step 7: Commit**

```bash
git add src/app/settings/ad-accounts/AdAccountsClient.tsx src/app/settings/ad-accounts/AdAccountsClient.test.tsx
git commit -m "feat: one connect button per platform, and the token card is gone"
```

---

### Task 4: The rest of the app stops describing a token-only Meta

**Files:**
- Modify: `src/lib/ads/sync.ts:64`
- Modify: `src/lib/ads/sync.test.ts:193,197`
- Modify: `src/app/api/ad-platform-apps/route.ts:9-15` (header comment)
- Modify: `src/app/settings/ad-accounts/AdAccountsClient.tsx:414` (picker empty state only)
- Modify: `prisma/schema.prisma` (comments only)
- Modify: `e2e/marketing.spec.ts:62-81`

**Interfaces:**
- Consumes: everything from Tasks 1 to 3.
- Produces: no new code. Copy, comments and the e2e expectations catch up.

- [ ] **Step 1: Write the failing e2e and unit expectations**

In `e2e/marketing.spec.ts`, replace the Meta assertions in `'the ad accounts page offers one-click connect and lists the seeded accounts'`:

```ts
  // Both platforms connect by login again, like BeProfit does.
  const f = page.getByRole('link', { name: 'Connect with Facebook' })
  await expect(f).toBeVisible()
  await expect(f).toHaveAttribute('href', '/api/ads/oauth/meta/start')
  const g = page.getByRole('link', { name: 'Connect with Google' })
  await expect(g).toBeVisible()
  await expect(g).toHaveAttribute('href', '/api/ads/oauth/google/start')
  await expect(page.getByLabel('System user access token')).toHaveCount(0)
```

and the setup assertions:

```ts
  // A one-time setup card per platform, each printing its own callback URL.
  await expect(page.getByRole('heading', { name: 'Platform setup' })).toBeVisible()
  await expect(page.getByText('/api/ads/oauth/google/callback')).toBeVisible()
  await expect(page.getByText('/api/ads/oauth/meta/callback')).toBeVisible()
  await expect(page.getByText('Meta app', { exact: true })).toBeVisible()
```

In `src/lib/ads/sync.test.ts:193` and `:197`, change both expectations from `'Facebook token expired'` to:

```ts
    expect(result.error).toContain('Facebook login expired')
```

```ts
    expect(fresh.lastError).toContain('Facebook login expired')
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/ads/sync.test.ts`
Expected: FAIL - the message still reads "Facebook token expired".

- [ ] **Step 3: Update the messages and comments**

`src/lib/ads/sync.ts:64` currently throws `'Facebook token expired. Paste a new system user token.'`. Replace the whole line with:

```ts
        throw new AdApiError('Facebook login expired. Press Connect with Facebook to renew it.')
```

`src/app/settings/ad-accounts/AdAccountsClient.tsx:414`, the picker's empty state. It currently tells people to open the system user in Business settings and add assets, which no longer applies to a login. Replace those lines with:

```tsx
              This login can see no ad accounts. Check you logged in with the Facebook account
              that has access to them.
```

`src/app/api/ad-platform-apps/route.ts`, the header comment:

```ts
/**
 * The client's own Meta and Google apps - the one-time setup that makes the
 * connect buttons work. Secrets go in, never out.
 *
 * Saving does not call either platform. Four designs tried to make the app
 * prove itself here and heal its own domains; the wall was never the domains,
 * it was the callback URL, and no API can register that.
 */
```

`prisma/schema.prisma`, the `AdPlatformApp` comment:

```prisma
// The client's own Meta and Google apps, entered once in settings. They are
// what make "Connect with Facebook" and "Connect with Google" possible
// without pasting tokens. Standard Access covers reading the client's own ad
// accounts, so neither app needs review.
```

and the `AdConnection` comment:

```prisma
// One way in - a Facebook or Google login someone completed.
// Many ad accounts can hang off it.
```

and the `expiresAt` comment:

```prisma
  // A Meta user token lasts about 60 days and says so. A Google refresh
  // token does not expire while the client stays published, so it is null.
```

- [ ] **Step 4: Verify the schema change is comments only**

Run: `npx prisma db push`
Expected: "The database is already in sync with the Prisma schema." If it reports a migration, a real field was changed by mistake - revert it.

- [ ] **Step 5: Run everything**

Run: `npx vitest run`
Expected: PASS, all files.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx next build`
Expected: compiles. If it fails with `EPERM: operation not permitted, unlink '.next/...'`, a dev server is holding a Windows file lock: stop it, `rm -rf .next`, rebuild. Never push on a red build.

Run: `npx playwright test`
Expected: PASS, all specs.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ads/sync.ts src/lib/ads/sync.test.ts src/app/api/ad-platform-apps/route.ts src/app/settings/ad-accounts/AdAccountsClient.tsx prisma/schema.prisma e2e/marketing.spec.ts
git commit -m "docs: the copy and comments describe a login again, not a pasted token"
```

---

## After the plan

Two things remain that code cannot do.

**The client's one manual step.** Open `https://developers.facebook.com/apps/1526277315425302/`, add the **Facebook Login for Business** product, and paste `https://panetti.vercel.app/api/ads/oauth/meta/callback` under Valid OAuth Redirect URIs. Save changes. Until this is done, pressing Connect with Facebook still shows "Can't load URL", and the setup card now prints the exact URL to paste.

**Renaming the legacy Meta connection, before the first real login.** The callback upserts an `AdConnection` by `provider` and `label`, and `label` is whatever `/me?fields=name` answers. A person's login returns that person's name; the system user token the old flow stored returned the system user's name instead, so the row already sitting in production carries the wrong label to match against. The first genuine "Connect with Facebook" will not find it, and will create a second Meta connection next to it. The picker then marks an account `alreadyConnected` from any `AdAccount` row for the provider, regardless of which connection owns it, so every account still shows up checked and disabled under that new connection too - the picker has nothing left to tick, and Save can only answer "Tick at least one account." None of this needs a code fix: before that first login, rename the legacy connection's `label` in the database to the exact name Facebook will hand back for the person logging in, and the upsert adopts the existing row in place, keeping every `AdAccount` binding and all its spend history intact. The durable fix - letting the bulk route re-point an existing account's `connectionId` when the provider already matches, so a relabel is never load-bearing again - is deliberately left out of this branch.

**Who presses the button.** BeProfit shows Google under Philip Antonetti and Facebook under Jacob Kjos Hanssen, so the Facebook ad accounts sit under Jacob's login. Whoever logs in must be the person who can see those accounts, or the picker comes back empty. That is real information, not a bug.

**The tracked debt, and why it should be argued rather than executed.** `POST /api/ads/connections/meta` and `src/lib/ads/token.ts` survive this plan with no caller in the UI, as the only path to the picker that needs no registered redirect URI. The obvious follow-up deletes them once the live login is confirmed. Do not run that deletion on autopilot: they are also the only Meta credential path in the app that can never expire, because Facebook caps a login-issued user token at about 60 days while a system user token can be generated with no expiry at all. That is a broader reason to keep them than the one this plan was written around, and it deserves a decision rather than a cleanup commit.

## Follow-ups this branch deliberately did not do

Recorded here because the review that found them was thorough and the reasoning should not evaporate.

**No warning before a Meta connection expires.** `expiresAt` now holds a real date, and exactly one place reads it - the expiry guard in `sync.ts` - which only fires after the date has already passed. So Meta ingestion stops roughly every 60 days and the only signal is an "Error" pill in a settings table nobody is watching, on a dashboard whose entire job is spend reporting. The reactive path does work: the same person logs in again, the label matches, the upsert refreshes the token. But the recurring chore is new, and it arrived with the decision to trade a never-expiring system user token for a user token. A banner when any connection expires inside seven days is the small fix.

**The bulk route cannot re-point an account to a different connection.** `alreadyConnected` is computed from any `AdAccount` row for the provider, ignoring which connection owns it, and the bulk route skips those rows. That is what makes the relabel above load-bearing. Letting bulk move an existing account's `connectionId` when the provider already matches would make "Press Connect with Facebook to renew it" true in every case instead of most, and would retire a manual database step.

**`client_secret` travels in a Graph query string.** That is Meta's documented shape and the wire is TLS, so the request itself is fine. The exposure is `console.error(e)` in the OAuth callback: a fetch failure whose message or cause carries the request URL would write the app secret into Vercel logs. Low likelihood, and the same pattern predates this branch in `token.ts`. Bounding it means catching failures around the exchange and rethrowing an `AdApiError` carrying no URL.

**`AdConnection` has no `@@unique([provider, label])`.** Both upsert sites do `findFirst` then `create`, which is a time-of-check-to-time-of-use race. Pre-existing, and realistic traffic is one admin clicking at human speed, but this branch doubles the paths through it. A unique constraint plus a real `upsert` would remove the pattern rather than narrow it.

**`next-env.d.ts` goes dirty on every Next command.** The committed copy imports `./.next/types/routes.d.ts`; the installed Next regenerates it as `./.next/dev/types/routes.d.ts`. Nothing in this branch touched the file - it was last committed in `4e631ef` - but it dirties the tree constantly and invites exactly the kind of `git checkout` reflex that has already cost this project uncommitted work once. Either commit what Next now generates, or gitignore it.
