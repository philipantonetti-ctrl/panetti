# OAuth Ad Connecting + Client Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Connect with Facebook/Google" login flows with a multi-account picker (shop auto-suggested), and the client's Meta metric set synced daily.

**Architecture:** Client-owned platform apps stored encrypted (`AdPlatformApp`), one OAuth login = one `AdConnection` holding the durable token, many `AdAccount`s per connection (`credentials` now nullable; manual paste stays as fallback). Daily `AdSpend` widens with additive metrics; ratios derive at read time in `buildMarketing`. Executing inline in this session on the local test DB (pg started inside each tool call).

**Tech Stack:** unchanged (Next 16, Prisma 6, zod, Vitest, Playwright). New endpoints wrap Meta Graph v25.0 OAuth + `/me/adaccounts`, Google OAuth v2 + `customers:listAccessibleCustomers` + `customer_client` GAQL.

---

### Task 1: Schema + seed

**Files:** Modify `prisma/schema.prisma`, `prisma/seed.ts`.

- [ ] Add models/columns:

```prisma
// The client's own Meta app / Google OAuth client, entered once in settings.
model AdPlatformApp {
  id             String   @id @default(cuid())
  provider       String   @unique // "meta" | "google"
  clientId       String
  clientSecret   String   // encrypted
  developerToken String?  // Google only, encrypted
  createdAt      DateTime @default(now())
}

// One "Logged in with Facebook/Google"; many ad accounts can hang off it.
model AdConnection {
  id        String      @id @default(cuid())
  provider  String
  label     String      // who logged in
  secret    String      // encrypted: Meta long-lived user token / Google refresh token
  expiresAt DateTime?   // Meta ~60 days; null for Google
  createdAt DateTime    @default(now())
  accounts  AdAccount[]
}
```

`AdAccount`: `credentials String?` (nullable now), add `connectionId String?`,
`loginCustomerId String?`, relation `connection AdConnection? @relation(fields:
[connectionId], references: [id], onDelete: SetNull)`.
`AdSpend`: add `linkClicks Int @default(0)`, `conversions Float @default(0)`,
`conversionValue Int @default(0)`, `videoViews3s Int @default(0)`,
`thruplays Int @default(0)`, `reach Int @default(0)`.

- [ ] `npx prisma generate` + `npx prisma db push --skip-generate` (local DB, pg started in-call).
- [ ] Seed: wipe adds `adConnection`/`adPlatformApp` deletes; create both platform apps (`clientId: 'seed-app'`, `clientSecret: 'seed'`, google `developerToken: 'seed'`), one meta `AdConnection` (`label: 'Philip (sample)'`, `secret: JSON-free plain 'seed'`), bind shop[0]'s meta account to it (`connectionId`, `credentials: null`). Spend rows gain deterministic metrics: `linkClicks = round(clicks*0.8)`, `conversions = round(clicks*0.06 * 10)/10`, `conversionValue = round(spend * (2 + rnd()*6))`, `videoViews3s = round(impressions*0.25)`, `thruplays = round(impressions*0.05)`, `reach = round(impressions*0.6)`. Re-seed.
- [ ] Commit `feat: connections, platform apps and richer daily ad metrics in the schema`.

### Task 2: OAuth + listing + suggestion libs (TDD, stubbed fetch)

**Files:** Create `src/lib/ads/oauth.ts`, `src/lib/ads/listing.ts`, `src/lib/ads/suggest.ts` (+ `.test.ts` each).

`oauth.ts` (throws `AdApiError` with the provider's words):

```ts
export type PlatformApp = { clientId: string; clientSecret: string; developerToken?: string }

buildMetaAuthUrl(clientId, redirectUri, state): string
  // https://www.facebook.com/v25.0/dialog/oauth?client_id&redirect_uri&state&scope=ads_read,business_management
buildGoogleAuthUrl(clientId, redirectUri, state): string
  // https://accounts.google.com/o/oauth2/v2/auth?client_id&redirect_uri&state&response_type=code
  //   &scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent
exchangeMetaCode(app, redirectUri, code): Promise<{ token: string; expiresAt: Date; label: string }>
  // GET /v25.0/oauth/access_token?client_id&redirect_uri&client_secret&code -> {access_token}
  // GET /v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token -> {access_token, expires_in?}
  // expiresAt = now + (expires_in ?? 60 days); label from GET /v25.0/me?fields=name (Bearer)
exchangeGoogleCode(app, redirectUri, code): Promise<{ refreshToken: string; label: string }>
  // POST oauth2.googleapis.com/token {code, client_id, client_secret, redirect_uri, grant_type:'authorization_code'}
  // missing refresh_token -> AdApiError('Google did not return a refresh token. Remove the app under myaccount.google.com/permissions and connect again.')
  // label from openidconnect.googleapis.com/v1/userinfo (Bearer) name ?? email ?? 'Google Ads'
```

`listing.ts`:

```ts
export type ListedAccount = { externalId: string; name: string; currency: string; loginCustomerId?: string }
listMetaAdAccounts(token): Promise<ListedAccount[]>
  // GET /v25.0/me/adaccounts?fields=name,account_id,currency&limit=100 (Bearer), follow paging.next (cap 10)
listGoogleAdAccounts(creds: GoogleCredentials): Promise<ListedAccount[]>
  // reuse googleAccessToken; GET /v25/customers:listAccessibleCustomers (Bearer + developer-token) -> {resourceNames}
  // per accessible id: searchStream 'SELECT customer_client.id, customer_client.descriptive_name,
  //   customer_client.currency_code, customer_client.manager, customer_client.level FROM customer_client
  //   WHERE customer_client.level <= 1' with login-customer-id = that id
  // keep manager=false rows; loginCustomerId = accessible id when it differs from the row id; dedupe by externalId
```

(Google result parsing tolerates camel and snake case like `google.ts`; export a
`parseCustomerClients(results, accessId)` pure helper for the unit test.)

`suggest.ts`:

```ts
const ALIASES: Record<string, string> = { no:'norway', se:'sweden', dk:'denmark', fi:'finland',
  de:'germany', danmark:'denmark', norge:'norway', sverige:'sweden', suomi:'finland' }
tokensOf(name): string[]        // lowercase, split on non-alphanumerics, map through ALIASES
suggestShop(accountName, shops: {id,name}[]): string | null
  // score = |token intersection|; winner needs score >= 2 and to be the UNIQUE maximum, else null
```

- [ ] Tests first (auth URLs carry scope/state; exchanges send right params and surface provider errors; refresh-token-missing throws; meta paging; google flattening keeps leaf accounts and tags loginCustomerId; 'Mazzetti NO'→Mazzetti.no, 'Panetti Danmark'→Panetti Denmark, 'Levoit - NO'→null). Then implement, run, commit `feat: oauth exchanges, account listings and shop suggestions`.

### Task 3: Wider fetchers + connection-aware sync (TDD)

**Files:** Modify `src/lib/ads/types.ts`, `meta.ts`, `google.ts`, `sync.ts` (+ their tests).

- [ ] `DailyRow` gains `linkClicks, conversions, conversionValue, videoViews3s, thruplays, reach` (numbers). Meta fields param becomes
`spend,impressions,clicks,inline_link_clicks,reach,actions,action_values,video_thruplay_watched_actions`;
parser reads `actions[omni_purchase ?? purchase]` → conversions, `action_values[omni_purchase ?? purchase]` → `toMinor` → conversionValue, `actions[video_view]` → videoViews3s, first `video_thruplay_watched_actions` value → thruplays. Google query adds `metrics.conversions, metrics.conversions_value`; `linkClicks = clicks`, conversionValue = `toMinor(conversions_value)`, video/reach 0.
- [ ] `sync.ts`: `AdAccountRow` gains `connectionId, loginCustomerId, connection: { provider, secret, expiresAt } | null`; `syncAllAdAccounts` fetches `include: { connection: true }`. Credential resolution (exported `resolveCredentials(account, appFor)` or inline):
  - connection + meta → expired (`expiresAt < now`) throws `AdApiError('Facebook login expired. Press Connect with Facebook to renew it.')`; else `{ accessToken: decryptSecret(connection.secret) }`
  - connection + google → needs `AdPlatformApp` google row (`db.adPlatformApp.findUnique`) else AdApiError('Google platform setup is missing.'); creds from app + refresh token + `account.loginCustomerId`
  - no connection → parse `credentials` as before; `credentials` null too → AdApiError('No credentials. Reconnect this account.')
  - `storeDaily` upserts all new columns.
- [ ] Update existing tests (DailyRow literals get the six new zeros — helper `daily(over)` keeps them short), new tests: meta actions parsing, google conversions, connection-resolved sync (create connection + account with `credentials: null`, stub fetch, expect rows), expired meta connection sets lastError with the plain words.
- [ ] Commit `feat: purchases, conversion value and video metrics sync daily; connections feed the sync`.

### Task 4: Routes

**Files:** Create `src/app/api/ad-platform-apps/route.ts`, `src/app/api/ads/oauth/[provider]/start/route.ts`, `.../callback/route.ts`, `src/app/api/ads/connections/[id]/accounts/route.ts`, `src/app/api/ad-accounts/bulk/route.ts`. Modify `src/app/api/ad-accounts/route.ts` (GET gains `connectionLabel`). Test: `src/app/api/ads/oauth.test.ts`, extend `src/app/api/ad-accounts/route.test.ts`.

- [ ] `ad-platform-apps`: GET → `{ apps: [{ provider, clientId, hasSecret, hasDeveloperToken }] }` (never the secrets). PUT zod `{ provider: enum, clientId min 1, clientSecret optional, developerToken optional }`; blank secret keeps stored; upsert by provider; encrypt on write.
- [ ] `start`: admin; 404 unknown provider; missing app row → redirect `/settings/ad-accounts?error=Set up the …`; `state = randomBytes(16).toString('hex')`; cookie `ads_oauth_state=${provider}:${state}` httpOnly lax 600s via `res.cookies.set`; redirect to `build…AuthUrl(app.clientId, origin + '/api/ads/oauth/' + provider + '/callback', state)` where `origin = new URL(req.url).origin`.
- [ ] `callback`: admin; provider-denied (`?error=`) or state mismatch → redirect with readable `?error=`; exchange via oauth lib; upsert connection by `(provider, label)` (update secret/expiresAt) else create, secret encrypted; delete state cookie; redirect `/settings/ad-accounts?picker=<id>`; `AdApiError` → redirect `?error=<message>`.
- [ ] `connections/[id]/accounts`: admin; 404 unknown; meta → `listMetaAdAccounts(decrypt(secret))`; google → app row required, `listGoogleAdAccounts(creds)`; decorate each with `alreadyConnected` (existing `(provider, externalId)`) and `suggestedShopId` (suggest over active shops); response `{ provider, label, accounts }`.
- [ ] `bulk`: admin; zod `{ connectionId, accounts: [{ externalId, name, currency, shopId, loginCustomerId? }] min 1 }`; connection must exist; per entry: skip if `(provider, externalId)` exists (collect `skipped`), else create (`credentials: null`, `connectionId`, `loginCustomerId`) then `syncAdAccount` (sequential, best-effort); `maxDuration = 60`; response `{ results, skipped }`.
- [ ] Tests (cookie mock as in existing route tests; stub fetch): callback stores encrypted connection + redirects to picker; reconnect updates not duplicates; state mismatch never stores; accounts listing marks `alreadyConnected` and suggests shops; bulk creates + backfills + skips + never leaks secrets; platform-apps PUT stores `enc:v1:` and GET shows only booleans.
- [ ] Commit `feat: one-click platform connect routes with account picker backend`.

### Task 5: Marketing compute + route + cron

**Files:** Modify `src/lib/ads/marketing.ts` (+test), `src/app/api/marketing/route.ts` (+test).

- [ ] `SpendRow` gains the six fields; accumulator sums them (`conversionValue` cross-converted like spend); `MarketingShopRow` adds `linkClicks, conversions, conversionValue, videoViews3s, thruplays` and null-able ratios `platformRoas (=conversionValue/spend), costPerPurchase (=round(spend/conversions)), avgPurchaseValue (=round(conversionValue/conversions)), cpm (=round(spend/impressions*1000)), costPerLinkClick (=round(spend/linkClicks)), linkCtr (=linkClicks/impressions), holdRate (=thruplays/videoViews3s)`; marketing route selects the new columns. Tests: hand-computed fixture incl. conversion-value conversion and each zero-denominator dash.
- [ ] Commit `feat: platform ROAS, cost per purchase, CPM and video ratios per shop`.

### Task 6: UI

**Files:** Modify `src/app/settings/ad-accounts/page.tsx`, `AdAccountsClient.tsx` (+test), `src/components/marketing/MarketingStats.tsx`, `MarketingTable.tsx` (+tests), `src/app/marketing/MarketingClient.test.tsx`.

- [ ] `page.tsx` also loads platform apps (`{provider, clientId}` rows → `{ meta?, google? }`), passes `searchParams` values `picker`/`error` (Next 16: `searchParams: Promise<…>` awaited), and account rows gain `connectionLabel`.
- [ ] `AdAccountsClient`:
  - Header: `Connect with Facebook` / `Connect with Google` as `<a href="/api/ads/oauth/…/start">` styled buttons, disabled look + title 'Fill in Platform setup below first' when the app row is missing; keep `Sync now`; manual connect moves to a quiet `Advanced: paste credentials manually` link under the table (same modal as today).
  - `?error` → `toast.error(error)` once on mount; `?picker` → open `PickerModal(connectionId)`.
  - `PickerModal`: fetches `/api/ads/connections/{id}/accounts`; rows: checkbox (pre-ticked when `suggestedShopId` and not `alreadyConnected`; connected rows ticked + disabled with 'Connected' note), name + externalId + currency, shop `<select>` (value `suggestedShopId ?? shops[0]`); Save → POST `/api/ad-accounts/bulk` with the ticked rows → toast (`Connected N account(s)…`) + `router.replace('/settings/ad-accounts')` + refresh; server error → toast, modal stays.
  - `Platform setup` section: two cards (Meta app / Google app) each showing the exact redirect URI (`${window.location.origin}/api/ads/oauth/meta/callback` etc. with a note to paste it into the app), inputs (Meta: App ID, App secret; Google: Client ID, Client secret, Developer token; secrets password-typed, placeholder 'saved, leave blank to keep' when `hasSecret`), Save → PUT → toast + refresh. Short help line under each (from the spec's "what the client does" steps).
  - Table row shows `via {connectionLabel}` under the name when connected by OAuth.
- [ ] `MarketingStats` cards: AD SPEND, PURCHASE ROAS (`platformRoas`, hint 'Attributed conversion value divided by spend, as the platform reports it'), COST PER PURCHASE, CONV. VALUE.
- [ ] `MarketingTable`: columns become (order) Shop, Ad spend, Purchases (`conversions`, 1 decimal when fractional), Conv. value, P. ROAS, Cost/purchase, Store ROAS (`roas`), Gross revenue, Orders, CPA, Meta, Google, CPM, Cost/link click, Link CTR, CPC, CTR, Hold rate, 3s plays, ThruPlays, Clicks — with a visibility dropdown copied from CompareTable's idiom (localStorage `marketing-columns`; default hidden = everything after CPA). Kinds extend with `plays`/`decimal` as needed.
- [ ] Update/extend component tests: stats show PURCHASE ROAS and dashes; table default columns + toggling one hidden column on; AdAccountsClient: connect buttons disabled without apps and live with them, platform setup save flow (PUT called, blank secret kept), picker happy path (mocked listing → pre-ticked suggestion → bulk POST body correct) and error path keeps the modal.
- [ ] Commit `feat: connect with Facebook or Google, pick accounts, and the client's Meta metrics on the page`.

### Task 7: E2E + full green + deploy

**Files:** Modify `e2e/marketing.spec.ts`.

- [ ] Marketing spec: stat card assertions → `AD SPEND` + `PURCHASE ROAS`; table assertions unchanged plus `P. ROAS` header visible. Ad-accounts spec: `Platform setup` heading visible, `Connect with Facebook` link enabled (seeded app), manual modal now behind `Advanced: paste credentials manually` (update the modal-opening steps), picker NOT exercised end-to-end (no real platform); seeded `via` label visible.
- [ ] Full: `npx tsc --noEmit`, full `npx vitest run`, full `npx playwright test`, `npx next build` — all green (pg in-call each time).
- [ ] Push, poll `gh api …/commits/<sha>/status` to success, `Invoke-RestMethod /api/version` equals sha.
- [ ] Client message: one-time 5-minute setup per platform (with my walkthrough), then log in and tick accounts exactly like his screenshots; new metrics listed; frequency + average play time honestly deferred.

## Execution notes

- Local DB only; start pg inside the same tool call. Edit files ONLY with the Edit/Write tools (PS 5.1 rewrite mojibake).
- Existing manual-credential routes/tests must stay green untouched apart from the widened `DailyRow` literals.
- `credentials` nullable: `readCredentials` callers guard null first.
- Never echo a secret in any response body, redirect, or test fixture assertion.
