# Meta + Google Ads Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Meta and Google ad accounts, sync daily spend, and show ad spend, ROAS, CPA, CPC and CTR per shop on a new Marketing page.

**Architecture:** New `src/lib/ads/` module (pure parsers + fetchers per provider, a sync engine, a pure marketing-metrics builder), two new Prisma models (`AdAccount`, `AdSpend`), four new API routes, cron integration, a `/marketing` page and a `/settings/ad-accounts` management page. Credentials are an encrypted JSON blob per account using the existing `encryptSecret`. Order-side numbers reuse `loadMetricsInput` + `computeMetrics` so revenue/orders can never disagree with the dashboard.

**Tech Stack:** Next.js 16 App Router, Prisma 6 (Postgres), zod, Vitest 4 (`vi.stubGlobal('fetch', ...)` for HTTP), Playwright, recharts. Local test DB at `%LOCALAPPDATA%\panetti-pg` - start it inside the same tool call as the command (`& pg_ctl -w start 2>$null; <cmd>`), NEVER against Neon.

**Verified API facts (July 2026):**
- Meta Graph v25.0: `GET https://graph.facebook.com/v25.0/act_{id}/insights?level=account&time_increment=1&time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}&fields=spend,impressions,clicks&limit=500`, auth via `Authorization: Bearer <token>` header (keeps the token out of URLs and of `paging.next`). Response `{ data: [{ date_start, spend: "5339.5", impressions: "..", clicks: ".." }], paging: { next } }`. Errors: `{ error: { message } }`. Verify: `GET /act_{id}?fields=name,currency`.
- Google Ads v25 REST: `POST https://googleads.googleapis.com/v25/customers/{cid}/googleAds:searchStream` with headers `Authorization: Bearer`, `developer-token`, optional `login-customer-id`; body `{"query": "SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM customer WHERE segments.date BETWEEN 'A' AND 'B'"}`. Response: JSON array of chunks `[{ results: [...] }]`, field names camelCase (`costMicros`) - parser tolerates snake_case too. Access token minted per call: `POST https://oauth2.googleapis.com/token` form-encoded `{client_id, client_secret, refresh_token, grant_type: 'refresh_token'}`. `cost_micros` → minor units = `round(micros / 10_000)`. Verify: `SELECT customer.descriptive_name, customer.currency_code FROM customer`.

---

### Task 1: Schema + seed

**Files:**
- Modify: `prisma/schema.prisma` (append models, add Shop relation)
- Modify: `prisma/seed.ts` (ad accounts + ~90 days of spend)

- [ ] **Step 1:** Append to `prisma/schema.prisma` and add `adAccounts AdAccount[]` to the Shop relation list:

```prisma
// One connected ad platform account, mapped to the shop it advertises for.
// That mapping is what makes per-shop ROAS possible.
model AdAccount {
  id          String    @id @default(cuid())
  shopId      String
  provider    String    // "meta" | "google"
  externalId  String    // Meta: ad account id digits (no act_); Google: customer id (no dashes)
  name        String    // from the platform at connect time, never typed by hand
  currency    String    // from the platform at connect time
  credentials String    // encrypted JSON, provider-specific shape
  active      Boolean   @default(true)
  lastSyncAt  DateTime?
  lastError   String?
  createdAt   DateTime  @default(now())

  shop  Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  spend AdSpend[]

  @@unique([provider, externalId])
  @@index([shopId])
}

// One day of one account's delivery. Minor units in the ACCOUNT's currency;
// conversion happens at read time like everything else.
model AdSpend {
  id          String   @id @default(cuid())
  accountId   String
  date        DateTime // UTC midnight
  spend       Int
  impressions Int
  clicks      Int

  account AdAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@unique([accountId, date])
  @@index([date])
}
```

- [ ] **Step 2:** Run `npx prisma generate`, then push to the LOCAL test DB inside one call: `& "$env:LOCALAPPDATA\panetti-pg\pgsql\bin\pg_ctl" -D "$env:LOCALAPPDATA\panetti-pg\data" -w start 2>$null; npx prisma db push` (read `.env`/`.env.local` handling as before - DATABASE_URL must point at the local DB for this shell).
- [ ] **Step 3:** In `prisma/seed.ts`, following the file's existing style and wipe order: create 3 ad accounts on the first two shops (meta+google on shop[0], meta on shop[1]) with `credentials: JSON.stringify({ accessToken: 'seed' })` (plaintext passes `decryptSecret` through), `currency` = shop currency, `lastSyncAt` set; then daily `AdSpend` rows for the last 90 days with the seed's deterministic random idiom (spend 20000-150000 minor, impressions ≈ spend/3, clicks ≈ impressions/40). Re-seed local DB and eyeball counts.
- [ ] **Step 4:** Commit `feat: AdAccount and AdSpend tables with seed data`.

### Task 2: Provider fetchers (`meta.ts`, `google.ts`) - TDD

**Files:**
- Create: `src/lib/ads/types.ts`, `src/lib/ads/meta.ts`, `src/lib/ads/google.ts`
- Test: `src/lib/ads/meta.test.ts`, `src/lib/ads/google.test.ts`

- [ ] **Step 1:** `types.ts`:

```ts
export const AD_PROVIDERS = ['meta', 'google'] as const
export type AdProvider = (typeof AD_PROVIDERS)[number]

export type MetaCredentials = { accessToken: string }
export type GoogleCredentials = {
  developerToken: string
  clientId: string
  clientSecret: string
  refreshToken: string
  loginCustomerId?: string
}
export type AdCredentials = MetaCredentials | GoogleCredentials

/** One day of one account's delivery, minor units in the ACCOUNT's currency. */
export type DailyRow = { date: Date; spend: number; impressions: number; clicks: number }

export type VerifiedAccount = { name: string; currency: string }

/** A provider's own words, surfaced to the UI - never an HTML dump. */
export class AdApiError extends Error {}
```

- [ ] **Step 2:** Write failing tests for `meta.ts`: `parseMetaInsights` maps `{date_start:'2026-07-01', spend:'123.45', impressions:'1000', clicks:'50'}` → `{date: 2026-07-01T00:00:00Z, spend: 12345, impressions: 1000, clicks: 50}`, skips rows without `date_start`, tolerates missing fields (0). `fetchMetaDaily` (stub fetch): sends `Authorization: Bearer` header, level=account, time_increment=1, follows `paging.next` exactly once when present, concatenates rows. Non-ok response with `{error:{message:'Invalid OAuth access token'}}` throws `AdApiError` with that message. `verifyMeta` returns `{name, currency}`; missing currency throws AdApiError.
- [ ] **Step 3:** Implement `meta.ts`:

```ts
import { toMinor } from '../money'
import { utcDay } from '../dates'
import { AdApiError, type DailyRow, type MetaCredentials, type VerifiedAccount } from './types'

const GRAPH = 'https://graph.facebook.com/v25.0'
/** 12 months of daily rows fits one page; the cap is a runaway guard. */
const PAGE_LIMIT = 500
const MAX_PAGES = 10

type InsightRow = { date_start?: string; spend?: string; impressions?: string; clicks?: string }

export function parseMetaInsights(rows: InsightRow[]): DailyRow[] {
  const out: DailyRow[] = []
  for (const row of rows) {
    if (!row.date_start) continue
    out.push({
      date: utcDay(new Date(row.date_start + 'T00:00:00Z')),
      spend: toMinor(row.spend ?? '0'),
      impressions: parseInt(row.impressions ?? '0', 10) || 0,
      clicks: parseInt(row.clicks ?? '0', 10) || 0,
    })
  }
  return out
}

/** The token travels in a header, so paging.next URLs never contain it. */
async function metaJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) throw new AdApiError(body.error?.message ?? `Meta answered ${res.status}`)
  return body
}

const day = (d: Date) => utcDay(d).toISOString().slice(0, 10)

export async function fetchMetaDaily(
  creds: MetaCredentials, externalId: string, from: Date, to: Date,
): Promise<DailyRow[]> {
  const params = new URLSearchParams({
    level: 'account',
    time_increment: '1',
    time_range: JSON.stringify({ since: day(from), until: day(to) }),
    fields: 'spend,impressions,clicks',
    limit: String(PAGE_LIMIT),
  })
  let url: string | undefined = `${GRAPH}/act_${externalId}/insights?${params}`
  const rows: DailyRow[] = []
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body = await metaJson<{ data?: InsightRow[]; paging?: { next?: string } }>(url, creds.accessToken)
    rows.push(...parseMetaInsights(body.data ?? []))
    url = body.paging?.next
  }
  return rows
}

export async function verifyMeta(creds: MetaCredentials, externalId: string): Promise<VerifiedAccount> {
  const body = await metaJson<{ name?: string; currency?: string }>(
    `${GRAPH}/act_${externalId}?${new URLSearchParams({ fields: 'name,currency' })}`,
    creds.accessToken,
  )
  if (!body.currency) throw new AdApiError('Meta did not return the account currency')
  return { name: body.name ?? `Meta ${externalId}`, currency: body.currency }
}
```

- [ ] **Step 4:** Tests green (`npx vitest run src/lib/ads/meta.test.ts` - no DB needed).
- [ ] **Step 5:** Same TDD loop for `google.ts`: tests cover `microsToMinor('1234560000') === 123456`, camelCase AND snake_case results, chunk array AND single-object body, token exchange posts the right form fields and throws AdApiError with `error_description` on failure, `fetchGoogleDaily` sends all three headers (+ `login-customer-id` only when set) and the GAQL BETWEEN query, `verifyGoogle` reads `descriptiveName`/`currencyCode` (name falls back to `Google Ads {cid}`, missing currency throws).

```ts
import { utcDay } from '../dates'
import { AdApiError, type DailyRow, type GoogleCredentials, type VerifiedAccount } from './types'

const API = 'https://googleads.googleapis.com/v25'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** REST protobuf JSON is camelCase; tolerate snake_case anyway. */
type GoogleResult = {
  segments?: { date?: string }
  metrics?: { costMicros?: string; cost_micros?: string; impressions?: string; clicks?: string }
  customer?: { descriptiveName?: string; descriptive_name?: string; currencyCode?: string; currency_code?: string }
}
type Chunk = { results?: GoogleResult[] }

export function parseGoogleChunks(body: unknown): GoogleResult[] {
  const chunks: Chunk[] = Array.isArray(body) ? body : body ? [body as Chunk] : []
  return chunks.flatMap((c) => c.results ?? [])
}

/** Micros -> minor units: 1 cent/øre = 10 000 micros. */
export function microsToMinor(micros: string | number | undefined): number {
  const n = typeof micros === 'string' ? parseInt(micros, 10) : (micros ?? 0)
  return Number.isFinite(n) ? Math.round(n / 10_000) : 0
}

export function toDailyRows(results: GoogleResult[]): DailyRow[] {
  const out: DailyRow[] = []
  for (const r of results) {
    if (!r.segments?.date) continue
    out.push({
      date: utcDay(new Date(r.segments.date + 'T00:00:00Z')),
      spend: microsToMinor(r.metrics?.costMicros ?? r.metrics?.cost_micros),
      impressions: parseInt(String(r.metrics?.impressions ?? '0'), 10) || 0,
      clicks: parseInt(String(r.metrics?.clicks ?? '0'), 10) || 0,
    })
  }
  return out
}

export async function googleAccessToken(creds: GoogleCredentials): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string }
  if (!res.ok || !body.access_token)
    throw new AdApiError(body.error_description ?? body.error ?? 'Google sign-in failed')
  return body.access_token
}

function errorMessage(body: unknown): string | undefined {
  const first = Array.isArray(body) ? body[0] : body
  return (first as { error?: { message?: string } } | null)?.error?.message
}

async function searchStream(creds: GoogleCredentials, customerId: string, query: string): Promise<GoogleResult[]> {
  const token = await googleAccessToken(creds)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': creds.developerToken,
    'Content-Type': 'application/json',
  }
  if (creds.loginCustomerId) headers['login-customer-id'] = creds.loginCustomerId
  const res = await fetch(`${API}/customers/${customerId}/googleAds:searchStream`, {
    method: 'POST', headers, body: JSON.stringify({ query }),
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new AdApiError(errorMessage(body) ?? `Google answered ${res.status}`)
  return parseGoogleChunks(body)
}

const day = (d: Date) => utcDay(d).toISOString().slice(0, 10)

export async function fetchGoogleDaily(
  creds: GoogleCredentials, customerId: string, from: Date, to: Date,
): Promise<DailyRow[]> {
  const query =
    'SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks ' +
    `FROM customer WHERE segments.date BETWEEN '${day(from)}' AND '${day(to)}'`
  return toDailyRows(await searchStream(creds, customerId, query))
}

export async function verifyGoogle(creds: GoogleCredentials, customerId: string): Promise<VerifiedAccount> {
  const results = await searchStream(creds, customerId,
    'SELECT customer.descriptive_name, customer.currency_code FROM customer')
  const c = results[0]?.customer
  const currency = c?.currencyCode ?? c?.currency_code
  if (!currency) throw new AdApiError('Google did not return the account currency')
  return { name: c?.descriptiveName ?? c?.descriptive_name ?? `Google Ads ${customerId}`, currency }
}
```

- [ ] **Step 6:** All ads unit tests green. Commit `feat: Meta and Google ad platform fetchers`.

### Task 3: Sync engine - TDD (DB-backed)

**Files:**
- Create: `src/lib/ads/sync.ts`
- Test: `src/lib/ads/sync.test.ts` (marker `[ads-test]`, mirrors `src/lib/woo/sync.test.ts` cleanup + fetch stubbing)

- [ ] **Step 1:** Failing tests: `syncWindow(null, now)` spans 365 days back; with a lastSyncAt it spans 35. `syncAdAccount` (meta account, stubbed fetch): stores rows, re-running with changed numbers UPDATES the same `(accountId, date)` rows (idempotent), sets `lastSyncAt` and clears `lastError`. A fetch that rejects → result `ok:false`, `lastError` stored, nothing thrown. `syncAllAdAccounts` skips an account synced 1h ago, includes it with `{force: true}`.
- [ ] **Step 2:** Implement:

```ts
import { db } from '../db'
import { utcDay } from '../dates'
import { decryptSecret } from '../secrets'
import { fetchMetaDaily } from './meta'
import { fetchGoogleDaily } from './google'
import type { AdCredentials, DailyRow, GoogleCredentials, MetaCredentials } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
/** First sync reaches back a year of history. */
const BACKFILL_DAYS = 365
/** Platforms restate recent days inside their attribution windows, so every
 * later sync re-fetches the last 35 and the upsert overwrites in place. */
const RESTATE_DAYS = 35
/** Meta refreshes insights every 3-6 hours; asking more often is wasted quota. */
const MIN_HOURS_BETWEEN = 6

export type AdAccountRow = {
  id: string
  provider: string
  externalId: string
  name: string
  credentials: string
  lastSyncAt: Date | null
}

export type AdSyncResult = { accountId: string; name: string; ok: boolean; days: number; error?: string }

export function syncWindow(lastSyncAt: Date | null, now: Date): { from: Date; to: Date } {
  const to = utcDay(now)
  const back = lastSyncAt ? RESTATE_DAYS : BACKFILL_DAYS
  return { from: new Date(to.getTime() - back * DAY_MS), to }
}

export function readCredentials(stored: string): AdCredentials {
  return JSON.parse(decryptSecret(stored)) as AdCredentials
}

async function fetchDaily(account: AdAccountRow, from: Date, to: Date): Promise<DailyRow[]> {
  const creds = readCredentials(account.credentials)
  return account.provider === 'meta'
    ? fetchMetaDaily(creds as MetaCredentials, account.externalId, from, to)
    : fetchGoogleDaily(creds as GoogleCredentials, account.externalId, from, to)
}

async function storeDaily(accountId: string, rows: DailyRow[]): Promise<number> {
  await db.$transaction(rows.map((r) => db.adSpend.upsert({
    where: { accountId_date: { accountId, date: r.date } },
    create: { accountId, date: r.date, spend: r.spend, impressions: r.impressions, clicks: r.clicks },
    update: { spend: r.spend, impressions: r.impressions, clicks: r.clicks },
  })))
  return rows.length
}

export async function syncAdAccount(account: AdAccountRow, now = new Date()): Promise<AdSyncResult> {
  try {
    const { from, to } = syncWindow(account.lastSyncAt, now)
    const days = await storeDaily(account.id, await fetchDaily(account, from, to))
    await db.adAccount.update({ where: { id: account.id }, data: { lastSyncAt: now, lastError: null } })
    return { accountId: account.id, name: account.name, ok: true, days }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Sync failed'
    // Shown as the status badge on the settings page. Stored, never thrown:
    // one broken account must not stop the others.
    await db.adAccount.update({ where: { id: account.id }, data: { lastError: error } }).catch(() => {})
    return { accountId: account.id, name: account.name, ok: false, days: 0, error }
  }
}

export async function syncAllAdAccounts(opts: { force?: boolean } = {}): Promise<AdSyncResult[]> {
  const accounts = await db.adAccount.findMany({ where: { active: true } })
  const now = new Date()
  const due = opts.force ? accounts : accounts.filter(
    (a) => !a.lastSyncAt || now.getTime() - a.lastSyncAt.getTime() >= MIN_HOURS_BETWEEN * 3_600_000,
  )
  const results: AdSyncResult[] = []
  for (const a of due) results.push(await syncAdAccount(a, now))
  return results
}
```

- [ ] **Step 3:** Tests green (DB running in same call). Commit `feat: ad spend sync engine with restatement window`.

### Task 4: Marketing metrics builder - TDD (pure)

**Files:**
- Create: `src/lib/ads/marketing.ts`
- Modify: `src/lib/metrics/trend.ts` - add `grossRevenue: number` to `SeriesPoint` and to the object `dailySeries` returns (`grossRevenue: total.grossRevenue`)
- Test: `src/lib/ads/marketing.test.ts`

- [ ] **Step 1:** Failing tests: fixture with 2 shops (NOK + SEK), engine result byShop rows carrying orders/grossRevenue, one meta NOK account + one google EUR account, spend rows on known dates, hand-built RateTable. Assert: per-shop converted spend (EUR spend converts at that DAY's rate), meta/google split, ROAS = grossRevenue/spend (float, null when spend 0), CPA = round(spend/orders) (null when either 0), CPC (null when clicks 0), CTR, a shop with no accounts appears with spend 0 and null ratios, total row sums, series merges spend into the daily grossRevenue series by date.
- [ ] **Step 2:** Implement:

```ts
import { convert } from '../metrics/fx'
import type { EngineResult, RateTable } from '../metrics/types'
import type { SeriesPoint } from '../metrics/trend'

export type MarketingAccount = { id: string; shopId: string; provider: string; currency: string }
export type SpendRow = { accountId: string; date: Date; spend: number; impressions: number; clicks: number }

export type MarketingShopRow = {
  shopId: string
  shopName: string
  spend: number        // display currency minor units
  metaSpend: number
  googleSpend: number
  impressions: number
  clicks: number
  orders: number
  grossRevenue: number
  roas: number | null  // gross revenue per unit of spend, e.g. 4.2
  cpa: number | null   // spend per paid order, minor units
  cpc: number | null   // spend per click, minor units
  ctr: number | null   // clicks / impressions, e.g. 0.019
}

export type MarketingSeriesPoint = { date: string; spend: number; grossRevenue: number }

export type MarketingResult = {
  displayCurrency: string
  byShop: MarketingShopRow[]
  total: MarketingShopRow
  series: MarketingSeriesPoint[]
}

const ratios = (row: Omit<MarketingShopRow, 'roas' | 'cpa' | 'cpc' | 'ctr'>) => ({
  ...row,
  // A ratio with a zero denominator is not a number, and printing one would lie.
  roas: row.spend > 0 ? row.grossRevenue / row.spend : null,
  cpa: row.spend > 0 && row.orders > 0 ? Math.round(row.spend / row.orders) : null,
  cpc: row.spend > 0 && row.clicks > 0 ? Math.round(row.spend / row.clicks) : null,
  ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
})

export function buildMarketing(args: {
  accounts: MarketingAccount[]
  spend: SpendRow[]
  engine: EngineResult
  series: SeriesPoint[]
  rates: RateTable
}): MarketingResult {
  const display = args.engine.displayCurrency
  const accountById = new Map(args.accounts.map((a) => [a.id, a]))

  type Acc = { spend: number; metaSpend: number; googleSpend: number; impressions: number; clicks: number }
  const zero = (): Acc => ({ spend: 0, metaSpend: 0, googleSpend: 0, impressions: 0, clicks: 0 })
  const byShop = new Map<string, Acc>()
  const byDay = new Map<string, number>()

  for (const row of args.spend) {
    const account = accountById.get(row.accountId)
    if (!account) continue
    const minor = convert(row.spend, account.currency, row.date, display, args.rates)
    const acc = byShop.get(account.shopId) ?? zero()
    acc.spend += minor
    if (account.provider === 'meta') acc.metaSpend += minor
    else acc.googleSpend += minor
    acc.impressions += row.impressions
    acc.clicks += row.clicks
    byShop.set(account.shopId, acc)
    const day = row.date.toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + minor)
  }

  const rows = args.engine.byShop.map((shop) => {
    const acc = byShop.get(shop.shopId) ?? zero()
    return ratios({
      shopId: shop.shopId,
      shopName: shop.shopName,
      ...acc,
      orders: shop.orders,
      grossRevenue: shop.grossRevenue,
    })
  })

  const total = ratios({
    shopId: '',
    shopName: 'Total',
    spend: rows.reduce((n, r) => n + r.spend, 0),
    metaSpend: rows.reduce((n, r) => n + r.metaSpend, 0),
    googleSpend: rows.reduce((n, r) => n + r.googleSpend, 0),
    impressions: rows.reduce((n, r) => n + r.impressions, 0),
    clicks: rows.reduce((n, r) => n + r.clicks, 0),
    orders: args.engine.total.orders,
    grossRevenue: args.engine.total.grossRevenue,
  })

  const series = args.series.map((p) => ({
    date: p.date,
    spend: byDay.get(p.date) ?? 0,
    grossRevenue: p.grossRevenue,
  }))

  return { displayCurrency: display, byShop: rows, total, series }
}
```

- [ ] **Step 3:** Tests green, plus the existing trend/dashboard tests still green after the `SeriesPoint` addition (`npx vitest run src/lib/metrics`). Commit `feat: marketing metrics builder (ROAS, CPA, CPC, CTR per shop)`.

### Task 5: API routes - TDD (DB-backed; mirror `src/app/api/orders/route.test.ts` auth mocking and marker scoping)

**Files:**
- Create: `src/app/api/ad-accounts/route.ts` (GET list, POST connect+verify+backfill)
- Create: `src/app/api/ad-accounts/[id]/route.ts` (PATCH, DELETE)
- Create: `src/app/api/ads/sync/route.ts` (POST manual, `force`)
- Create: `src/app/api/marketing/route.ts` (GET metrics)
- Modify: `src/app/api/cron/sync/route.ts`
- Tests: `src/app/api/ad-accounts/route.test.ts`, `src/app/api/marketing/route.test.ts`

Key behaviors (write tests first for each):
- **POST /api/ad-accounts** validates with zod base schema `{ shopId, provider: z.enum(['meta','google']) }` plus explicit per-provider field checks with readable messages; normalizes `externalId` (strip `act_`, strip dashes, digits only); 404-checks the shop; calls `verifyMeta`/`verifyGoogle` - an `AdApiError` becomes `400 { error: e.message }` and NOTHING is stored; on success creates the row with `name`/`currency` from the platform and `credentials: encryptSecret(JSON.stringify(creds))`; a duplicate `(provider, externalId)` → `409 { error: 'This ad account is already connected.' }`; then runs the initial backfill via `syncAdAccount` and returns `{ account: {…public fields}, sync: result }` with `maxDuration = 60`. Tests assert: stored credentials start with `enc:v1:` and do NOT contain the pasted token; AdSpend rows exist after connect; the 400 path stores nothing.
- **GET /api/ad-accounts** returns `{ accounts: [{ id, provider, externalId, name, currency, shopId, shopName, active, lastSyncAt, lastError, createdAt }] }` - test asserts `JSON.stringify(body)` contains neither `credentials` nor the token value.
- **PATCH /api/ad-accounts/[id]**: body may carry `shopId` and/or credential fields; blank/absent credential fields keep the stored value (merge into the decrypted JSON, Woo-modal style); if ANY credential field changed, re-verify before saving and refresh `name`/`currency`; unknown id → 404.
- **DELETE /api/ad-accounts/[id]**: deletes; test asserts the account's AdSpend rows are gone (cascade).
- **POST /api/ads/sync**: admin-only, `const results = await syncAllAdAccounts({ force: true })`, returns `{ results }`, `maxDuration = 60`.
- **GET /api/marketing**: mirrors `/api/metrics` exactly (assertAdmin, `getSetting` timezone, `rangeFromQuery`, `shopIdsFromQuery`, NO_STORE headers, AuthError→403, catch→500 with `console.error`). Flow: `loadMetricsInput` → load active accounts scoped to `input.shops` → `ensureRates(from, to, [account currencies])` in a try/catch when any differ from display → `buildRateTable(await loadRates())` for spend conversion → load AdSpend `{ accountId in, date gte utcDay(from) lte utcDay(to) }` → `computeMetrics(input)` + `dailySeries(input)` → `buildMarketing` → JSON `{ …result, connected: (await db.adAccount.count({ where: { active: true } })) > 0, range }`. Test fixture: marker-scoped shop, 2 paid + 1 pending order, 1 meta account, spend rows; assert exact spend, ROAS uses grossRevenue of PAID orders only, `shops=` param scoping works, response has no credentials.
- **Cron route**: after the FX block, add a best-effort `try { ads = await syncAllAdAccounts() } catch {}` and fold `adAccount` currencies into the `ensureRates` currency list; extend the JSON with `adAccounts: ads.length, adFailed: ads.filter(r => !r.ok).map(r => r.name)`.
- [ ] Commit `feat: ad account routes, marketing metrics API, cron ad sync`.

### Task 6: Marketing page UI

**Files:**
- Modify: `src/components/shell/AppShell.tsx` - NAV: `{ href: '/marketing', label: 'Marketing', icon: <megaphone svg matching existing icon idiom> }` after Orders in Analytics; `{ href: '/settings/ad-accounts', label: 'Ad accounts', icon: <plug svg> }` after Shops in Setup.
- Modify: `src/middleware.ts` - add `/marketing/:path*` to the matcher and to the admin-gated set (mirror how `/dashboard` is treated).
- Create: `src/app/marketing/page.tsx` (mirror `src/app/dashboard/page.tsx` server wrapper: currentUser → redirects, load shops + `db.adAccount.count({ where: { active: true } })`, pass `hasAccounts`).
- Create: `src/app/marketing/MarketingClient.tsx` - state/fetch idiom copied from DashboardClient (`preset/from/to/selected`, `useLiveTick`, AbortController, `shops` param with NO_SHOPS untouched). If `!hasAccounts`: render a single card "No ad accounts connected yet" + explainer + `<Link href="/settings/ad-accounts">Connect your first account</Link>` and skip fetching. Else: stats, chart, table, plus the "Converted to USD…" subtitle rule from DashboardClient.
- Create: `src/components/marketing/MarketingStats.tsx` - one hairline-divided strip (StatStrip idiom, no deltas): AD SPEND `formatMoney`, ROAS `x.xx×` (- when null, hint "Gross revenue divided by ad spend"), CPA `formatMoney` (- when null, hint "Ad spend per paid order"), CPC `formatMoney` (- when null).
- Create: `src/components/marketing/MarketingChart.tsx` - TrendChart clone: dataKeys `spend` ("Ad spend") and `grossRevenue` ("Gross revenue"), same colors/empty-state pattern ("No ad spend in this period." when all zero).
- Create: `src/components/marketing/MarketingTable.tsx` - CompareTable-style (sticky first column, striping, sortable headers, default sort spend desc, localStorage NOT needed): columns Shop, Ad spend, Meta, Google, Gross revenue, ROAS (`4.20×`), CPA, Orders, CPC, CTR (`1.9%`); null → `-`; footer Total row.
- Test: `src/components/marketing/MarketingTable.test.tsx` (headers, money cells, dashes for nulls, total row), `src/app/marketing/MarketingClient.test.tsx` (jsdom + stubbed fetch: renders stats+table from payload; `hasAccounts:false` renders the connect CTA and does not fetch).
- [ ] Commit `feat: Marketing page with ad spend, ROAS, CPA per shop`.

### Task 7: Ad accounts settings UI

**Files:**
- Create: `src/app/settings/ad-accounts/page.tsx` - server wrapper (mirror shops page): load accounts with shop include, map to rows `{ id, provider, externalId, name, currency, shopId, shopName, lastSyncAt: iso|null, lastError, connectedOk: !lastError }`, plus active shops for the modal dropdown.
- Create: `src/app/settings/ad-accounts/AdAccountsClient.tsx` - ShopsClient idiom: PageHeader ("Ad accounts", subtitle explaining Meta + Google spend syncs itself every few hours) with "Connect account" + "Sync now" buttons; result message line; table Account | Provider ("Meta"/"Google" badge) | Shop | Currency | Status (green "Connected" / red "Error" with `title={lastError}` / muted "Never synced") | Last sync | Edit / Delete (window.confirm). `ConnectAccountModal`: provider segmented toggle; shop `<select>`; Meta fields: Ad account ID, System user access token (with help text "Meta Business settings → System users → Generate token with ads_read"); Google fields: Customer ID, Developer token, OAuth client ID, OAuth client secret, Refresh token, Manager account ID (optional); POST `/api/ad-accounts`; server error → toast + modal stays open; success → toast + `router.refresh()`. Edit reuses the modal with `saved, leave blank to keep` placeholders and PATCH.
- Test: `src/app/settings/ad-accounts/AdAccountsClient.test.tsx` - renders rows + status badges; opening the modal and switching provider swaps the fields; a 400 from POST shows the server's message and keeps the modal open; Sync now renders per-account results line.
- [ ] Commit `feat: connect and manage Meta and Google ad accounts`.

### Task 8: E2E + full green + deploy

**Files:**
- Create: `e2e/marketing.spec.ts` - sign in as `admin@ecom.test` (reuse the `signIn` helper idiom): `/marketing` shows the stats strip (AD SPEND label), the chart or table with a seeded shop name and a nonzero money cell; shop filter narrows rows; `/settings/ad-accounts` lists 3 seeded accounts with provider badges.

- [ ] **Step 1:** e2e spec written, seeded local DB, full Playwright run green (`workers: 1`, DB started in the same tool call).
- [ ] **Step 2:** Full vitest suite green (all files), `npx tsc --noEmit` green, `npx next build` green.
- [ ] **Step 3:** Commit, push, poll `gh api repos/philipantonetti-ctrl/panetti/commits/<sha>/status` until success; spot-check `/api/version` returns the new sha.

## Execution notes

- Local DB only. Every DB-touching command: `& pg_ctl -w start 2>$null; <command>` in ONE tool call.
- `AUTH_SECRET` must be set for encryption tests - mirror however the shops route tests handle it.
- Do not touch `Figures`/net profit: ad spend intentionally stays out of profit until the client confirms retiring manual ad expense entries (documented in the spec).
- Zod: use the base-object + explicit per-provider checks (version-proof, readable errors).
- After schema change: `npx prisma generate` before typechecking.
