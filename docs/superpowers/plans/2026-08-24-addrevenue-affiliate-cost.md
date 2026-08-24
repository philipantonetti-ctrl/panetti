# Addrevenue Affiliate Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import every Addrevenue affiliate transaction for the Panetti and Mazzetti brands and charge it to net profit as a new **Affiliate** cost line — a Compare-table column, a Marketing-page section, and a settings page where the brand tokens are pasted.

**Architecture:** Two new tables mirror Addrevenue exactly: `AffiliateAccount` (one per brand token, encrypted) and `AffiliateTransaction` (one per tracked sale, upserted by their id). The sync refetches the FULL history every run (~2,200 rows, one page per brand) and makes our table an exact mirror — upsert present rows, delete vanished ones — so status restatements, denials and remote deletions are all one operation. A loader groups non-denied rows per (shop, day, currency) into flat `{shopId, date, amount, currency}` rows the metrics engine converts at each day's own FX rate and subtracts in net profit, exactly as ad spend already does.

**Tech Stack:** TypeScript, Next.js 16 App Router, Prisma 6 on PostgreSQL, Vitest 4, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-addrevenue-affiliate-cost-design.md` — read it first; it holds the measured API shapes and the client's three decisions (cost = commission + brokerageFee; count all except denied, on the sale's date; own `affiliate` figure, not merged into `marketing`).

## Global Constraints

- **Money is integer minor units.** Use `toMinor` from `src/lib/money.ts`. `commission`/`eventValue` arrive as decimal STRINGS ("128.35"), `brokerageFee` as a number (19.25) — `toMinor` accepts both. Never float arithmetic.
- **Store each row's own `currency`.** Real data has FI-market sales in SEK. Never assume the shop's currency.
- **The API tokens are secrets.** They are pasted in the settings UI and stored via `encryptSecret()` (`src/lib/secrets.ts`). They must NEVER appear in git — not in code, not in seeds, not in `.env.example`, not in test fixtures, not in commit messages. Tests and seeds use the literal string `'seed'` or `'plain-token'` (decryptSecret passes unprefixed values through).
- **Errors are stored, never thrown.** `lastError` on the account, shown in settings. One bad token must not fail the cron. Follow `src/lib/ads/sync.ts`.
- **Dates:** a transaction is dated by Addrevenue's plain `date` day at UTC midnight (`utcDay`), the platform-reported-day convention `AdSpend` uses (`spendInRange` in the engine, NOT the shop-calendar `inRange`).
- **Unmatched markets are visible, never guessed.** A market whose URL matches no shop's `wooUrl` host leaves `shopId: null`; the settings page and the Marketing section surface the count. Nothing name-parses.
- **Test data convention:** DB-backed unit tests run in parallel against the shared local Postgres. Each file defines a unique marker (e.g. `[affiliate-test]`), scopes every row to it, wipes in `beforeEach`/`afterEach`, and calls `vi.unstubAllGlobals()` after stubbing fetch. See `src/lib/ads/sync.test.ts`.
- **The `src/lib/data/load.affiliate.test.ts` file needs NO vitest.config change** — the serialized `load` project already includes `src/lib/data/load*.test.ts` and the `app` project excludes it. Everything else in this plan lands in the default `app` project on its own.
- **Commit after every task.** Conventional commits: `feat(affiliate): ...`, `test(affiliate): ...`.
- Run tests from the repo root with `npx vitest run <path>`; typecheck with `npx tsc --noEmit`.

---

### Task 1: Schema — the two tables

**Files:**
- Modify: `prisma/schema.prisma` (Shop relation list ~line 66-75; new models after `AdCampaignSpend` ~line 462)

- [ ] **Step 1: Add the relation to `Shop`.** In the relation block at the end of the Shop model, after `deliveryPromises DeliveryPromise[]`, add:

```prisma
  affiliateTransactions AffiliateTransaction[]
```

- [ ] **Step 2: Add the models** immediately after the `AdCampaignSpend` model (after its closing `}` around line 462):

```prisma
// One Addrevenue brand account (Panetti, Mazzetti), holding the API token the
// client pasted. `externalId` is Addrevenue's advertiser id; name and id come
// from their /advertisers answer at connect time, never typed by hand.
model AffiliateAccount {
  id         String    @id @default(cuid())
  provider   String    @default("addrevenue")
  externalId String // Addrevenue advertiser id, e.g. "986851"
  name       String // advertiser displayName from the platform
  token      String // encrypted
  active     Boolean   @default(true)
  lastSyncAt DateTime?
  lastError  String?
  createdAt  DateTime  @default(now())

  transactions AffiliateTransaction[]

  @@unique([provider, externalId])
}

// One tracked affiliate sale, an EXACT mirror of Addrevenue's transaction row.
// The sync refetches the full history and upserts by (account, externalId):
// restatement and denial arrive as changed rows, remote deletion as absence —
// all the same mirror operation. Money in minor units of `currency`, which is
// the ROW's own (a FI sale can be in SEK); converted at read time.
model AffiliateTransaction {
  id           String    @id @default(cuid())
  accountId    String
  externalId   String // Addrevenue transaction id, e.g. "1176373" — theirs to shape, so String like every platform id here
  date         DateTime // the sale's day, UTC midnight — the platform-reported day
  market       String // "NO" | "SE" | "DK" | "FI" | "DE"
  // Resolved from the advertiser's market URL matched against Shop.wooUrl at
  // sync time. Null = no shop matched; surfaced in settings, never guessed.
  shopId       String?
  channelId    String
  channelName  String // the affiliate site, e.g. "Forbrukertesten.com"
  status       String // new | invoiced | readyForPayout | paidOut
  // Set = Addrevenue denied this sale; it then costs nothing. Zero denials in
  // the entire history so far, but the field is the documented deny signal.
  denyDate     DateTime?
  commission   Int // what the affiliate earns, minor units of `currency`
  brokerageFee Int // Addrevenue's markup on top — also our money
  orderValue   Int // the sale the commission was earned on (their eventValue)
  currency     String
  eventOrderId String? // the Woo order number, for audit against /orders

  account AffiliateAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  // SetNull, not Cascade: removing a shop must not delete the record of what
  // affiliates were paid.
  shop    Shop?            @relation(fields: [shopId], references: [id], onDelete: SetNull)

  @@unique([accountId, externalId])
  @@index([shopId, date])
  @@index([date])
}
```

- [ ] **Step 3: Apply and generate.**

Run: `npx prisma db push --skip-generate` — expect "Your database is now in sync". Then `npx prisma generate`.

- [ ] **Step 4: Typecheck** — `npx tsc --noEmit` must stay clean.

- [ ] **Step 5: Commit** — `feat(affiliate): tables for Addrevenue accounts and their transactions`

---

### Task 2: API client — parse what was measured

**Files:**
- Create: `src/lib/affiliate/client.ts`
- Create: `src/lib/affiliate/client.test.ts`

The response shapes below are copied from live probes of both real accounts on 2026-08-24 (see the spec). The docs page's `http_code`/`count` top-level fields do NOT exist; the envelope is `{ results, meta: { totalCount, hasNextPage, ... } }`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AffiliateApiError, fetchAdvertiser, fetchTransactions } from './client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

// Trimmed from a real /advertisers answer (2026-08-24). The markets object is
// keyed by market code and carries the webshop URL — the shop-mapping key.
const advertisers = {
  results: [
    {
      id: 986851,
      displayName: 'Panetti',
      name: 'Ledende Teknologi AS',
      type: 'advertiser',
      markets: {
        NO: { market: 'NO', url: 'https://www.panetti.no', status: 'active' },
        DE: { market: 'DE', url: 'https://www.panetti.de', status: 'active' },
      },
    },
  ],
  meta: { totalCount: 1, hasNextPage: false },
}

// Trimmed from a real /transactions answer. commission/eventValue are STRINGS,
// brokerageFee is a NUMBER, and the `currencies` conversion map is ignored.
const tx = (over: Record<string, unknown> = {}) => ({
  id: 1176373,
  date: '2026-01-02',
  channelId: 3464435,
  channelName: 'Forbrukertesten.com',
  market: 'NO',
  currency: 'NOK',
  eventValue: '855.64',
  commission: '128.35',
  brokerageFee: 19.25,
  status: 'paidOut',
  denyDate: null,
  eventOrderId: '19101',
  ...over,
})

describe('fetchAdvertiser', () => {
  it('reads the advertiser id, name and market URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(advertisers)))
    const a = await fetchAdvertiser('token-1')
    expect(a.externalId).toBe('986851')
    expect(a.name).toBe('Panetti')
    expect(a.markets).toEqual([
      { market: 'NO', url: 'https://www.panetti.no' },
      { market: 'DE', url: 'https://www.panetti.de' },
    ])
  })

  it('sends the bearer token', async () => {
    const spy = vi.fn().mockResolvedValue(json(advertisers))
    vi.stubGlobal('fetch', spy)
    await fetchAdvertiser('token-1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('https://addrevenue.io/api/v2/advertisers')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
  })

  it('a rejected token is a plain-words error, not a stack trace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Invalid token' }, 403)))
    await expect(fetchAdvertiser('bad')).rejects.toThrow(AffiliateApiError)
    await expect(fetchAdvertiser('bad')).rejects.toThrow(/rejected the token/i)
  })
})

describe('fetchTransactions', () => {
  it('turns money strings into integer minor units and the date into UTC midnight', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ results: [tx()], meta: { totalCount: 1, hasNextPage: false } })),
    )
    const [row] = await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })
    expect(row).toEqual({
      externalId: '1176373',
      date: new Date('2026-01-02T00:00:00.000Z'),
      market: 'NO',
      channelId: '3464435',
      channelName: 'Forbrukertesten.com',
      status: 'paidOut',
      denyDate: null,
      commission: 12835,
      brokerageFee: 1925,
      orderValue: 85564,
      currency: 'NOK',
      eventOrderId: '19101',
    })
  })

  it('a null commission or brokerage is zero, and a denyDate becomes a Date', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          results: [tx({ commission: null, brokerageFee: null, denyDate: '2026-03-01 10:00:00', eventOrderId: null })],
          meta: { totalCount: 1, hasNextPage: false },
        }),
      ),
    )
    const [row] = await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })
    expect(row.commission).toBe(0)
    expect(row.brokerageFee).toBe(0)
    expect(row.denyDate).toEqual(new Date('2026-03-01T00:00:00.000Z'))
    expect(row.eventOrderId).toBeNull()
  })

  it('follows hasNextPage with an offset until the platform says done', async () => {
    const page = (id: number, hasNextPage: boolean) =>
      json({ results: [tx({ id })], meta: { totalCount: 2, hasNextPage } })
    const spy = vi
      .fn()
      .mockResolvedValueOnce(page(1, true))
      .mockResolvedValueOnce(page(2, false))
    vi.stubGlobal('fetch', spy)
    const rows = await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })
    expect(rows.map((r) => r.externalId)).toEqual(['1', '2'])
    expect(String(spy.mock.calls[1][0])).toContain('offset=1')
  })
})
```

- [ ] **Step 2: Run it** — `npx vitest run src/lib/affiliate/client.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/affiliate/client.ts`**

```ts
import { toMinor } from '../money'

/**
 * Addrevenue's v2 API, as MEASURED on 2026-08-24 — the public docs are thin
 * and partly wrong (they promise `http_code`/`count` at the top level; the
 * real envelope is `{ results, meta }`). One life-time token per brand
 * account; these are advertiser accounts, so /channels and /payouts answer
 * 403 and are not used.
 */

const BASE = 'https://addrevenue.io/api/v2'

/** Provider wording that can be shown on the settings page as-is. */
export class AffiliateApiError extends Error {}

export type AffiliateMarket = { market: string; url: string }

export type AffiliateAdvertiser = {
  externalId: string
  name: string
  markets: AffiliateMarket[]
}

/** One transaction, parsed: money in integer minor units of `currency`. */
export type AffiliateTxRow = {
  externalId: string // their numeric id, stringified — platform ids are Strings here
  date: Date // UTC midnight of the platform-reported sale day
  market: string
  channelId: string
  channelName: string
  status: string
  denyDate: Date | null
  commission: number
  brokerageFee: number
  orderValue: number
  currency: string
  eventOrderId: string | null
}

type Envelope = { results?: unknown[]; meta?: { hasNextPage?: boolean } }

async function get(token: string, path: string): Promise<Envelope> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
  } catch {
    throw new AffiliateApiError('Could not reach Addrevenue. Check the connection and try again.')
  }
  if (res.status === 403) {
    // Their 403 covers a missing header, an unknown token and an inactive
    // account alike — one message a person can act on.
    throw new AffiliateApiError('Addrevenue rejected the token. Check it in Addrevenue and paste it again.')
  }
  if (!res.ok) {
    throw new AffiliateApiError(`Addrevenue answered ${res.status}. Try again in a while.`)
  }
  return (await res.json()) as Envelope
}

/** "2026-01-02" (their plain sale day) -> UTC midnight. */
function utcDayOf(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`)
}

/**
 * The account's advertiser: id, display name, and each market's webshop URL —
 * the key the sync matches against Shop.wooUrl.
 */
export async function fetchAdvertiser(token: string): Promise<AffiliateAdvertiser> {
  const body = await get(token, '/advertisers')
  const first = (body.results ?? [])[0] as
    | { id: number; displayName?: string; name?: string; markets?: Record<string, { market: string; url: string }> }
    | undefined
  if (!first) {
    throw new AffiliateApiError('The token works, but no advertiser account is attached to it.')
  }
  return {
    externalId: String(first.id),
    name: first.displayName ?? first.name ?? String(first.id),
    markets: Object.values(first.markets ?? {}).map((m) => ({ market: m.market, url: m.url })),
  }
}

type RawTx = {
  id: number
  date: string
  channelId: number
  channelName?: string
  market?: string
  currency: string
  eventValue?: string | number | null
  commission?: string | number | null
  brokerageFee?: string | number | null
  status?: string
  denyDate?: string | null
  eventOrderId?: string | null
}

/**
 * Every transaction in the window, all pages. The whole history is ~2,200
 * rows against a 5,000-per-page cap, so today this is one request per brand —
 * the loop is for the day it is not.
 */
export async function fetchTransactions(
  token: string,
  window: { fromDate: string; toDate: string },
): Promise<AffiliateTxRow[]> {
  const rows: AffiliateTxRow[] = []
  let offset = 0
  for (;;) {
    const path =
      `/transactions?fromDate=${window.fromDate}&toDate=${window.toDate}` +
      (offset > 0 ? `&offset=${offset}` : '')
    const body = await get(token, path)
    const page = (body.results ?? []) as RawTx[]
    for (const r of page) {
      rows.push({
        externalId: String(r.id),
        date: utcDayOf(r.date),
        market: r.market ?? '',
        channelId: String(r.channelId),
        channelName: r.channelName ?? '',
        status: r.status ?? '',
        denyDate: r.denyDate ? utcDayOf(r.denyDate) : null,
        commission: toMinor(r.commission ?? 0),
        brokerageFee: toMinor(r.brokerageFee ?? 0),
        orderValue: toMinor(r.eventValue ?? 0),
        currency: r.currency,
        eventOrderId: r.eventOrderId ?? null,
      })
    }
    if (!body.meta?.hasNextPage || page.length === 0) return rows
    offset += page.length
  }
}
```

Note: `toMinor` takes `number | string`; the `?? 0` keeps `null` out of it (`toMinor(null)` would be 0 anyway via NaN — but say what you mean).

- [ ] **Step 4: Run it** — expect PASS.
- [ ] **Step 5: Commit** — `feat(affiliate): a client that reads Addrevenue as it actually answers`

---

### Task 3: Market → shop matching, by domain

**Files:**
- Create: `src/lib/affiliate/match.ts`
- Create: `src/lib/affiliate/match.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { hostOf, matchMarketsToShops } from './match'

describe('hostOf', () => {
  it('lowers the case and strips protocol and www', () => {
    expect(hostOf('https://www.Panetti.no')).toBe('panetti.no')
    expect(hostOf('http://panetti.de/')).toBe('panetti.de')
    expect(hostOf('panetti.se')).toBe('panetti.se') // Shop.wooUrl may be typed bare
  })
  it('nothing to parse is null, never a throw', () => {
    expect(hostOf(null)).toBeNull()
    expect(hostOf('')).toBeNull()
    expect(hostOf('not a url at all ???')).toBeNull()
  })
})

describe('matchMarketsToShops', () => {
  const shops = [
    { id: 's-no', wooUrl: 'https://www.panetti.no' },
    { id: 's-de', wooUrl: 'panetti.de' },
    { id: 's-none', wooUrl: null },
  ]
  it('maps each market to the shop whose wooUrl shares its host', () => {
    const { byMarket, unmatched } = matchMarketsToShops(
      [
        { market: 'NO', url: 'https://www.panetti.no' },
        { market: 'DE', url: 'https://www.panetti.de' },
      ],
      shops,
    )
    expect(byMarket.get('NO')).toBe('s-no')
    expect(byMarket.get('DE')).toBe('s-de')
    expect(unmatched).toEqual([])
  })
  it('an unknown domain is reported, never guessed', () => {
    const { byMarket, unmatched } = matchMarketsToShops(
      [{ market: 'FI', url: 'https://www.panetti.fi' }],
      shops,
    )
    expect(byMarket.has('FI')).toBe(false)
    expect(unmatched).toEqual(['FI'])
  })
})
```

- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Implement `src/lib/affiliate/match.ts`**

```ts
import type { AffiliateMarket } from './client'

/**
 * Which shop an Addrevenue market belongs to, decided by DOMAIN: the
 * advertiser's market URL against Shop.wooUrl. Exact or nothing — a market
 * with no matching shop is reported, never guessed from names. (Compare
 * src/lib/dhl/link.ts, which refuses unknown codes for the same reason.)
 */

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  const candidate = url.includes('://') ? url : `https://${url}`
  try {
    const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, '')
    return host || null
  } catch {
    return null
  }
}

export function matchMarketsToShops(
  markets: AffiliateMarket[],
  shops: { id: string; wooUrl: string | null }[],
): { byMarket: Map<string, string>; unmatched: string[] } {
  const shopByHost = new Map<string, string>()
  for (const s of shops) {
    const host = hostOf(s.wooUrl)
    if (host) shopByHost.set(host, s.id)
  }

  const byMarket = new Map<string, string>()
  const unmatched: string[] = []
  for (const m of markets) {
    const host = hostOf(m.url)
    const shopId = host ? shopByHost.get(host) : undefined
    if (shopId) byMarket.set(m.market, shopId)
    else unmatched.push(m.market)
  }
  return { byMarket, unmatched }
}
```

Wait — `hostOf('not a url at all ???')`: `new URL('https://not a url at all ???')` throws (spaces), returning null. Good.

- [ ] **Step 4: Run it** — expect PASS.
- [ ] **Step 5: Commit** — `feat(affiliate): match a market to its shop by domain, refusing to guess`

---

### Task 4: The mirror sync

**Files:**
- Create: `src/lib/affiliate/sync.ts`
- Create: `src/lib/affiliate/sync.test.ts`

- [ ] **Step 1: Write the failing test** (DB-backed, marker-scoped, fetch stubbed — the `ads/sync.test.ts` pattern)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { syncAffiliateAccount, syncAllAffiliateAccounts } from './sync'

const MARKER = '[affiliate-test]'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function wipe() {
  await db.affiliateAccount.deleteMany({ where: { name: { contains: MARKER } } })
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}

beforeEach(wipe)
afterEach(async () => {
  await wipe()
  vi.unstubAllGlobals()
})

async function makeAccount(over: Record<string, unknown> = {}) {
  return db.affiliateAccount.create({
    data: {
      externalId: `aff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `${MARKER} Panetti`,
      token: 'plain-token', // decryptSecret passes unprefixed values through
      ...over,
    },
  })
}

async function makeShop() {
  return db.shop.create({
    data: { name: `${MARKER} shop`, currency: 'NOK', wooUrl: 'https://www.affiliate-test.no' },
  })
}

const advertisers = (markets: Record<string, { market: string; url: string }>) =>
  json({
    results: [{ id: 986851, displayName: 'Panetti', markets }],
    meta: { totalCount: 1, hasNextPage: false },
  })

const tx = (over: Record<string, unknown> = {}) => ({
  id: 1,
  date: '2026-01-02',
  channelId: 3464435,
  channelName: 'Forbrukertesten.com',
  market: 'NO',
  currency: 'NOK',
  eventValue: '855.64',
  commission: '128.35',
  brokerageFee: 19.25,
  status: 'new',
  denyDate: null,
  eventOrderId: '19101',
  ...over,
})

function stub(markets: Record<string, { market: string; url: string }>, txs: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Only this file's token is answered. A foreign account swept up by a
      // syncAll test (another test file's row, or seeded sample data in the
      // shared dev DB) gets a 403 and stores its own lastError — its
      // transactions are never touched, because the mirror rewrite only runs
      // on success.
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      if (auth !== 'Bearer plain-token') return json({ message: 'Invalid token' }, 403)
      const url = String(input)
      if (url.includes('/advertisers')) return advertisers(markets)
      if (url.includes('/transactions'))
        return json({ results: txs, meta: { totalCount: txs.length, hasNextPage: false } })
      return json({ message: 'unexpected call' }, 500)
    }),
  )
}

const NO = (url: string) => ({ NO: { market: 'NO', url } })

describe('syncAffiliateAccount', () => {
  it('stores rows in minor units, resolved to the shop whose domain matches', async () => {
    const shop = await makeShop()
    const account = await makeAccount()
    stub(NO('https://www.affiliate-test.no'), [tx()])

    const result = await syncAffiliateAccount(account)
    expect(result).toMatchObject({ ok: true, rows: 1, unmatchedMarkets: [] })

    const rows = await db.affiliateTransaction.findMany({ where: { accountId: account.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      externalId: '1',
      shopId: shop.id,
      commission: 12835,
      brokerageFee: 1925,
      orderValue: 85564,
      currency: 'NOK',
      status: 'new',
    })

    const fresh = await db.affiliateAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.lastSyncAt).not.toBeNull()
    expect(fresh.lastError).toBeNull()
  })

  it('is an exact mirror: statuses overwrite in place and vanished rows are deleted', async () => {
    await makeShop()
    const account = await makeAccount()
    stub(NO('https://www.affiliate-test.no'), [tx({ id: 1 }), tx({ id: 2 })])
    await syncAffiliateAccount(account)

    // Next run: row 1 moved to paidOut, row 2 no longer exists on their side.
    stub(NO('https://www.affiliate-test.no'), [tx({ id: 1, status: 'paidOut' })])
    await syncAffiliateAccount(account)

    const rows = await db.affiliateTransaction.findMany({ where: { accountId: account.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ externalId: '1', status: 'paidOut' })
  })

  it('a market with no matching shop stays unmatched and is reported', async () => {
    await makeShop() // affiliate-test.no — deliberately not panetti.fi
    const account = await makeAccount()
    stub({ FI: { market: 'FI', url: 'https://www.panetti.fi' } }, [tx({ market: 'FI', currency: 'EUR' })])

    const result = await syncAffiliateAccount(account)
    expect(result.ok).toBe(true)
    expect(result.unmatchedMarkets).toEqual(['FI'])

    const rows = await db.affiliateTransaction.findMany({ where: { accountId: account.id } })
    expect(rows[0].shopId).toBeNull()
  })

  it('connecting the shop later heals historical rows on the next sync', async () => {
    const account = await makeAccount()
    stub(NO('https://www.affiliate-test.no'), [tx()])
    await syncAffiliateAccount(account) // no shop yet -> shopId null
    const shop = await makeShop()
    await syncAffiliateAccount(account)
    const rows = await db.affiliateTransaction.findMany({ where: { accountId: account.id } })
    expect(rows[0].shopId).toBe(shop.id)
  })

  it('an empty answer never wipes a mirror that holds history', async () => {
    await makeShop()
    const account = await makeAccount()
    stub(NO('https://www.affiliate-test.no'), [tx()])
    await syncAffiliateAccount(account)

    // The platform hiccups: a well-formed 200 with nothing in it.
    stub(NO('https://www.affiliate-test.no'), [])
    const result = await syncAffiliateAccount(account)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/keeping the mirror/)
    expect(await db.affiliateTransaction.count({ where: { accountId: account.id } })).toBe(1)
    const fresh = await db.affiliateAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.lastError).toMatch(/keeping the mirror/)
  })

  it('a genuinely new account with zero sales still syncs clean', async () => {
    await makeShop()
    const account = await makeAccount()
    stub(NO('https://www.affiliate-test.no'), [])
    const result = await syncAffiliateAccount(account)
    expect(result).toMatchObject({ ok: true, rows: 0 })
  })

  it('stores the failure on the account instead of throwing', async () => {
    const account = await makeAccount()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Invalid token' }, 403)))

    const result = await syncAffiliateAccount(account)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/rejected the token/i)

    const fresh = await db.affiliateAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.lastError).toMatch(/rejected the token/i)
    expect(await db.affiliateTransaction.count({ where: { accountId: account.id } })).toBe(0)
  })
})

describe('syncAllAffiliateAccounts', () => {
  // The shared dev database can hold affiliate accounts this file never made
  // (another test file's rows, seeded sample data), so every assertion here is
  // scoped to this file's marker — the same discipline ads/sync.test.ts uses.
  const mine = <T extends { name: string }>(results: T[]) => results.filter((r) => r.name.includes(MARKER))

  it('skips an account synced within six hours unless forced', async () => {
    await makeShop()
    const fresh = await makeAccount({ lastSyncAt: new Date() })
    stub(NO('https://www.affiliate-test.no'), [tx()])

    expect(mine(await syncAllAffiliateAccounts())).toHaveLength(0)

    const forced = mine(await syncAllAffiliateAccounts({ force: true }))
    expect(forced).toHaveLength(1)
    expect(forced[0].accountId).toBe(fresh.id)
  })

  it('leaves inactive accounts alone', async () => {
    await makeAccount({ active: false })
    stub(NO('https://www.affiliate-test.no'), [tx()])
    expect(mine(await syncAllAffiliateAccounts({ force: true }))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Implement `src/lib/affiliate/sync.ts`**

```ts
import { db } from '../db'
import { utcDay } from '../dates'
import { decryptSecret } from '../secrets'
import { AffiliateApiError, fetchAdvertiser, fetchTransactions } from './client'
import { matchMarketsToShops } from './match'

/**
 * The Addrevenue sync: refetch the WHOLE history and make our table an exact
 * mirror — upsert what they return, delete what they no longer do. The entire
 * history is ~2,200 rows in one page per brand, and old rows change status in
 * place months later, so a windowed fetch would buy nothing and cost the
 * restatement guarantee. No watermarks, no restate window.
 */

/** Panetti's first transaction is 2025-07-19; start the fetch before it. */
const FIRST_DATA_DATE = '2025-07-01'
/** Statuses settle over days, not minutes; more often is wasted calls. */
const MIN_HOURS_BETWEEN = 6

export type AffiliateAccountRow = {
  id: string
  name: string
  token: string
  lastSyncAt: Date | null
}

export type AffiliateSyncResult = {
  accountId: string
  name: string
  ok: boolean
  rows: number
  unmatchedMarkets: string[]
  error?: string
}

export async function syncAffiliateAccount(
  account: AffiliateAccountRow,
  now = new Date(),
): Promise<AffiliateSyncResult> {
  try {
    const token = decryptSecret(account.token)

    // The market map is rebuilt every run, so connecting a shop later heals
    // every historical row on the next sync — the mirror rewrite below writes
    // shopId afresh for all of them.
    const advertiser = await fetchAdvertiser(token)
    const shops = await db.shop.findMany({
      where: { active: true },
      select: { id: true, wooUrl: true },
    })
    const { byMarket, unmatched } = matchMarketsToShops(advertiser.markets, shops)

    const toDate = utcDay(now).toISOString().slice(0, 10)
    const rows = await fetchTransactions(token, { fromDate: FIRST_DATA_DATE, toDate })

    // Zero transactions for an account that HAS some is an outage answer, not
    // a truth — mirroring it would silently zero the affiliate cost on every
    // dashboard until the platform recovers (importVismaStock refuses the
    // same wipe, for the same reason). A genuinely new account has nothing
    // stored, so it still syncs clean.
    if (rows.length === 0) {
      const kept = await db.affiliateTransaction.count({ where: { accountId: account.id } })
      if (kept > 0) {
        throw new AffiliateApiError(
          `Addrevenue answered with zero transactions for an account holding ${kept} — keeping the mirror as it was.`,
        )
      }
    }

    await db.$transaction([
      ...rows.map((r) => {
        const data = {
          date: r.date,
          market: r.market,
          shopId: byMarket.get(r.market) ?? null,
          channelId: r.channelId,
          channelName: r.channelName,
          status: r.status,
          denyDate: r.denyDate,
          commission: r.commission,
          brokerageFee: r.brokerageFee,
          orderValue: r.orderValue,
          currency: r.currency,
          eventOrderId: r.eventOrderId,
        }
        return db.affiliateTransaction.upsert({
          where: { accountId_externalId: { accountId: account.id, externalId: r.externalId } },
          create: { accountId: account.id, externalId: r.externalId, ...data },
          update: data,
        })
      }),
      // The fetch covered the full history, so anything of ours it did not
      // return no longer exists on their side. Inside the same transaction:
      // the table is never caught between two truths.
      db.affiliateTransaction.deleteMany({
        where: { accountId: account.id, externalId: { notIn: rows.map((r) => r.externalId) } },
      }),
    ])

    await db.affiliateAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: now, lastError: null },
    })
    return { accountId: account.id, name: account.name, ok: true, rows: rows.length, unmatchedMarkets: unmatched }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Sync failed'
    // Shown on the settings page. Stored, never thrown: one broken token must
    // not stop the other brand — or the cron.
    await db.affiliateAccount
      .update({ where: { id: account.id }, data: { lastError: error } })
      .catch(() => {})
    return { accountId: account.id, name: account.name, ok: false, rows: 0, unmatchedMarkets: [], error }
  }
}

export async function syncAllAffiliateAccounts(
  opts: { force?: boolean } = {},
): Promise<AffiliateSyncResult[]> {
  const accounts = await db.affiliateAccount.findMany({ where: { active: true } })
  const now = new Date()
  const due = opts.force
    ? accounts
    : accounts.filter(
        (a) =>
          !a.lastSyncAt || now.getTime() - a.lastSyncAt.getTime() >= MIN_HOURS_BETWEEN * 3_600_000,
      )

  const results: AffiliateSyncResult[] = []
  for (const a of due) results.push(await syncAffiliateAccount(a, now))
  return results
}
```

- [ ] **Step 4: Run it** — expect PASS. Also re-run `src/lib/affiliate/client.test.ts` and `match.test.ts`.
- [ ] **Step 5: Commit** — `feat(affiliate): the sync mirrors Addrevenue's transactions exactly`

---

### Task 5: Cost loader — flat rows for the engine

**Files:**
- Create: `src/lib/affiliate/cost.ts`
- Create: `src/lib/affiliate/cost.test.ts`

- [ ] **Step 1: Write the failing test** (DB-backed, its own marker)

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { affiliateCosts, relevantAffiliateCurrencies } from './cost'

const MARKER = '[affiliate-cost-test]'

async function wipe() {
  await db.affiliateAccount.deleteMany({ where: { name: { contains: MARKER } } })
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}
beforeEach(wipe)
afterEach(wipe)

async function seed() {
  const shop = await db.shop.create({ data: { name: `${MARKER} shop`, currency: 'NOK' } })
  const account = await db.affiliateAccount.create({
    data: {
      externalId: `aff-cost-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `${MARKER} Panetti`,
      token: 'plain-token',
      // Inactive, so a parallel sync test's forced syncAll never sweeps this
      // row up. The cost loader reads transactions, not account activity.
      active: false,
    },
  })
  const base = {
    accountId: account.id,
    market: 'NO',
    shopId: shop.id,
    channelId: '1',
    channelName: 'Forbrukertesten.com',
    status: 'new',
    orderValue: 85564,
    currency: 'NOK',
  }
  await db.affiliateTransaction.createMany({
    data: [
      // Two sales on one day in one currency roll into one row: 128.35+19.25 and 59.88+8.98.
      { ...base, externalId: '1', date: new Date('2026-01-02'), commission: 12835, brokerageFee: 1925 },
      { ...base, externalId: '2', date: new Date('2026-01-02'), commission: 5988, brokerageFee: 898 },
      // A different currency the same day stays its own row.
      { ...base, externalId: '3', date: new Date('2026-01-02'), commission: 1000, brokerageFee: 100, currency: 'SEK' },
      // Denied costs nothing.
      { ...base, externalId: '4', date: new Date('2026-01-02'), commission: 99999, brokerageFee: 9999, denyDate: new Date('2026-02-01') },
      // Outside the asked range.
      { ...base, externalId: '5', date: new Date('2026-03-01'), commission: 7777, brokerageFee: 777 },
      // Unmatched market: no shop, so no per-shop cost.
      { ...base, externalId: '6', shopId: null, date: new Date('2026-01-02'), commission: 5555, brokerageFee: 555 },
    ],
  })
  return { shop, account }
}

describe('affiliateCosts', () => {
  it('groups commission + brokerage per shop, day and currency, skipping denied rows', async () => {
    const { shop } = await seed()
    const rows = await affiliateCosts([shop.id], new Date('2026-01-01'), new Date('2026-01-31'))
    expect(rows).toHaveLength(2)
    const nok = rows.find((r) => r.currency === 'NOK')!
    expect(nok).toMatchObject({ shopId: shop.id, amount: 12835 + 1925 + 5988 + 898 })
    expect(nok.date).toEqual(new Date('2026-01-02T00:00:00.000Z'))
    const sek = rows.find((r) => r.currency === 'SEK')!
    expect(sek.amount).toBe(1100)
  })

  it('asks for nothing when there are no shops', async () => {
    expect(await affiliateCosts([], new Date('2026-01-01'), new Date('2026-01-31'))).toEqual([])
  })
})

describe('relevantAffiliateCurrencies', () => {
  it('names every currency these shops have affiliate rows in', async () => {
    const { shop } = await seed()
    const currencies = await relevantAffiliateCurrencies([shop.id])
    expect(currencies.sort()).toEqual(['NOK', 'SEK'])
  })
})
```

- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Implement `src/lib/affiliate/cost.ts`**

```ts
import { db } from '../db'
import { utcDay } from '../dates'
import type { EngineAffiliateCost } from '../metrics/types'

/**
 * Affiliate cost as the engine eats it: one row per (shop, day, currency),
 * amount = commission + Addrevenue's brokerage fee — both leave the bank
 * account, so both count (the client's explicit decision, 2026-08-24).
 * Denied rows cost nothing; unmatched rows (shopId null) can belong to no
 * shop's figures and are surfaced elsewhere instead of summed here.
 *
 * One implementation for every caller, like ads/attribution.ts: a second
 * copy is how the Dashboard and the Marketing page come to disagree.
 */
export async function affiliateCosts(
  shopIds: string[],
  from: Date,
  to: Date,
): Promise<EngineAffiliateCost[]> {
  if (!shopIds.length) return []
  const grouped = await db.affiliateTransaction.groupBy({
    by: ['shopId', 'date', 'currency'],
    where: {
      shopId: { in: shopIds },
      denyDate: null,
      date: { gte: utcDay(from), lte: utcDay(to) },
    },
    _sum: { commission: true, brokerageFee: true },
  })
  return grouped.map((g) => ({
    shopId: g.shopId!,
    date: g.date,
    amount: (g._sum.commission ?? 0) + (g._sum.brokerageFee ?? 0),
    currency: g.currency,
  }))
}

/**
 * Every currency these shops hold affiliate rows in, so the FX loader has a
 * rate before the first conversion — real data has FI-market sales in SEK.
 */
export async function relevantAffiliateCurrencies(shopIds: string[]): Promise<string[]> {
  if (!shopIds.length) return []
  const rows = await db.affiliateTransaction.findMany({
    where: { shopId: { in: shopIds } },
    select: { currency: true },
    distinct: ['currency'],
  })
  return rows.map((r) => r.currency)
}
```

(`EngineAffiliateCost` does not exist yet — Task 6 Step 1 adds it. If working strictly in order, add the type first, or accept one red typecheck between the tasks' first steps; the commit lands after both are green.)

- [ ] **Step 4: Run it** — expect PASS (after Task 6's type exists; do Task 6 Step 1 first if the import blocks).
- [ ] **Step 5: Commit** — with Task 6 if interleaved, otherwise `feat(affiliate): affiliate cost rows in the engine's shape`

---

### Task 6: The `affiliate` figure in the engine

**Files:**
- Modify: `src/lib/metrics/types.ts` (EngineAdSpend area ~line 104; Figures ~124-143; ZERO_FIGURES ~153-172)
- Modify: `src/lib/metrics/engine.ts` (MetricsInput ~line 51; grouping ~158; per-shop figure ~256; netProfit ~292; return literal ~303-328; totalOf ~344-364)
- Modify: `src/lib/metrics/engine.test.ts` (new describe block, mirroring the ad-spend one at ~line 640-731)

- [ ] **Step 1: Add the type and Figures key** in `types.ts`. After the `EngineAdSpend` type:

```ts
/**
 * One day of one shop's affiliate cost (Addrevenue commission + their fee),
 * in the TRANSACTIONS' own currency — a FI sale can be in SEK. `date` is
 * plain UTC midnight, the platform-reported day, like ad spend.
 */
export type EngineAffiliateCost = {
  shopId: string
  date: Date
  amount: number
  currency: string
}
```

In `Figures`, after `marketing`:

```ts
  affiliate: number // Addrevenue commission + platform fee, at each day's own rate
```

In `ZERO_FIGURES`, after `marketing: 0,`:

```ts
  affiliate: 0,
```

- [ ] **Step 2: Write the failing engine test.** Append to `engine.test.ts` (self-contained describe, mirroring the neighbouring ad-spend block — same two-shop, two-rate shape):

```ts
describe('affiliate cost', () => {
  const affShops = [
    { id: 's1', name: 'One', currency: 'NOK' },
    { id: 's2', name: 'Two', currency: 'NOK' },
  ]
  // NOK -> USD: 0.10 on 1 July, 0.20 on 2 July.
  const affRates = new Map([
    ['2026-07-01', new Map([['NOK', 0.1], ['USD', 1]])],
    ['2026-07-02', new Map([['NOK', 0.2], ['USD', 1]])],
  ])
  const cost = (over: Partial<EngineAffiliateCost> = {}): EngineAffiliateCost => ({
    shopId: 's1',
    date: new Date('2026-07-01'),
    amount: 10000, // 100.00 kr of commission + fee
    currency: 'NOK',
    ...over,
  })
  const run = (affiliate?: EngineAffiliateCost[]) =>
    computeMetrics({
      shops: affShops,
      orders: [],
      expenses: [],
      costs: new Map(),
      rates: affRates,
      affiliate,
      displayCurrency: 'USD',
      from: new Date('2026-07-01'),
      to: new Date('2026-07-02'),
    })

  it('converts each day at that day’s own rate', () => {
    const res = run([cost(), cost({ date: new Date('2026-07-02') })])
    expect(res.byShop[0].affiliate).toBe(3000) // $10 + $20, never $20 or $40
  })

  it('takes affiliate straight out of net profit, separately from marketing', () => {
    const res = run([cost()])
    expect(res.total.affiliate).toBe(1000)
    expect(res.total.marketing).toBe(0)
    expect(res.total.netProfit).toBe(-1000)
  })

  it('ignores cost outside the range and never crosses shops', () => {
    const res = run([
      cost({ date: new Date('2026-06-30') }),
      cost(),
      cost({ shopId: 's2', amount: 50000 }),
    ])
    expect(res.byShop[0].affiliate).toBe(1000)
    expect(res.byShop[1].affiliate).toBe(10000 * 0.1)
    expect(res.total.affiliate).toBe(1000 + 5000)
  })

  it('is zero when absent — every existing caller’s profit must not move', () => {
    const res = run(undefined)
    expect(res.total.affiliate).toBe(0)
    expect(res.total.netProfit).toBe(0)
  })
})
```

Add `EngineAffiliateCost` to the existing type-import from `./types` at the top of the test file.

- [ ] **Step 3: Run it** — `npx vitest run src/lib/metrics/engine.test.ts` — expect FAIL (unknown input key / missing figure).

- [ ] **Step 4: Implement in `engine.ts`** — four edits, each next to its `adSpend` twin:

In `MetricsInput`, after the `adSpend?` member:

```ts
  /**
   * One row per shop per day per currency of affiliate cost (commission +
   * Addrevenue's fee, pre-summed). Absent means none, and profit is unmoved.
   */
  affiliate?: EngineAffiliateCost[]
```

(Add `EngineAffiliateCost` to the type import from `./types`.)

After the `spendByShop` grouping (~line 163), the same shape:

```ts
  const affiliateByShop = new Map<string, EngineAffiliateCost[]>()
  for (const row of input.affiliate ?? []) {
    const list = affiliateByShop.get(row.shopId)
    if (list) list.push(row)
    else affiliateByShop.set(row.shopId, [row])
  }
```

After the `marketing` computation (~line 260):

```ts
    // Affiliate commission and the platform's fee, dated and converted the
    // same way ad spend is: the platform-reported day, at that day's own rate.
    const affiliate = sum(
      (affiliateByShop.get(shop.id) ?? [])
        .filter((r) => spendInRange(r.date, from, to))
        .map((r) => crossConvert(r.amount, r.currency, displayCurrency, r.date, rates)),
    )
```

The net-profit line becomes:

```ts
    const netProfit =
      netRevenue - cogs - fulfillment - transactionFees - marketing - affiliate - operationalExpenses - commission
```

Add `affiliate,` to the per-shop return literal (after `marketing,`), and in `totalOf` add `affiliate: add((r) => r.affiliate),` after the `marketing` line.

- [ ] **Step 5: Run the tests** — engine tests PASS; then `npx tsc --noEmit` (this is what catches any other `Figures` literal in the codebase — fix any it names by adding the `affiliate` key the same way).
- [ ] **Step 6: Run the cost-loader test from Task 5** — now green. `npx vitest run src/lib/affiliate src/lib/metrics`.
- [ ] **Step 7: Commit** — `feat(affiliate): the engine charges affiliate cost to net profit`

---

### Task 7: Load it — `loadMetricsInput` wiring

**Files:**
- Modify: `src/lib/data/load.ts` (imports; after the `adSpend` load ~line 187; the `inPlay` set ~line 209; the return literal ~line 220)
- Create: `src/lib/data/load.affiliate.test.ts` (lands in the serialized `load` vitest project by its name — no config change)

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { loadMetricsInput } from './load'
import { computeMetrics } from '../metrics/engine'

const MARKER = '[load-affiliate-test]'

async function wipe() {
  await db.affiliateAccount.deleteMany({ where: { name: { contains: MARKER } } })
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}
beforeEach(wipe)
afterEach(wipe)

describe('loadMetricsInput affiliate', () => {
  it('hands the engine the grouped affiliate rows, and profit moves by them', async () => {
    const shop = await db.shop.create({ data: { name: `${MARKER} shop`, currency: 'NOK' } })
    const account = await db.affiliateAccount.create({
      data: {
        externalId: `load-aff-${Date.now()}`,
        name: `${MARKER} Panetti`,
        token: 'plain-token',
        // Inactive: invisible to any forced syncAll in parallel test files.
        active: false,
      },
    })
    await db.affiliateTransaction.create({
      data: {
        accountId: account.id,
        externalId: '1',
        date: new Date('2026-01-02'),
        market: 'NO',
        shopId: shop.id,
        channelId: '1',
        channelName: 'Forbrukertesten.com',
        status: 'new',
        commission: 12835,
        brokerageFee: 1925,
        orderValue: 85564,
        currency: 'NOK',
      },
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id],
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    })
    expect(input.affiliate).toEqual([
      { shopId: shop.id, date: new Date('2026-01-02T00:00:00.000Z'), amount: 14760, currency: 'NOK' },
    ])

    // One shop -> display currency is the shop's own NOK; no FX in the way.
    const result = computeMetrics(input)
    expect(result.total.affiliate).toBe(14760)
    expect(result.total.netProfit).toBe(-14760)
  })
})
```

- [ ] **Step 2: Run it** — `npx vitest run src/lib/data/load.affiliate.test.ts` — expect FAIL (`input.affiliate` undefined).
- [ ] **Step 3: Implement in `load.ts`.** Import at the top:

```ts
import { affiliateCosts, relevantAffiliateCurrencies } from '../affiliate/cost'
```

After the `adSpend` line (~187):

```ts
  // Affiliate cost, the same road ad spend travels: pre-attributed flat rows
  // the engine converts at each day's own rate.
  const affiliate = await affiliateCosts(shopIds, from, to)
```

In the `inPlay` set, after the `relevantAdCurrencies` spread:

```ts
    // Affiliate rows carry their own currency too — measured: FI sales in SEK.
    ...(await relevantAffiliateCurrencies(shopIds)),
```

In the return literal, after `adSpend,`:

```ts
    affiliate,
```

- [ ] **Step 4: Run it** — expect PASS. Also `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(affiliate): the dashboard loader carries affiliate cost to the engine`

---

### Task 8: The Compare-table column

**Files:**
- Modify: `src/components/dashboard/CompareTable.tsx` (COLUMNS, ~line 40-55)
- Modify: `src/components/dashboard/CompareTable.test.tsx`

- [ ] **Step 1: Extend the test.** In the first test's label loop (~line 37-41), the list becomes:

```ts
    for (const label of [
      'Orders', 'Gross revenue', 'Discounts', 'Net sales', 'Fulfillment', 'VAT',
      'Transaction fees', 'COGS', 'Marketing', 'Affiliate', 'Op. expenses', 'ROAS',
      'Commission', 'Net profit', 'Margin',
    ]) {
```

And give the `row` fixture a real figure so the money renders: add `affiliate: 5000,` to the `row` literal and adjust nothing else (`ZERO_FIGURES` already spreads the key in). Add one focused assertion in that test:

```ts
    // The affiliate line is its own money column, not folded into Marketing.
    const affiliateCell = formatMoney(5000, 'NOK')
    expect(screen.getAllByText((_t, el) => el?.textContent === affiliateCell).length).toBeGreaterThan(0)
```

(Note: `row.netProfit` in the fixture is a hand-written illustration, not engine output — leave it as is; the test renders, it does not recompute.)

- [ ] **Step 2: Run it** — `npx vitest run src/components/dashboard/CompareTable.test.tsx` — expect FAIL (no Affiliate column).
- [ ] **Step 3: Implement.** In `COLUMNS`, between `marketing` and `operationalExpenses`:

```ts
  { key: 'affiliate', label: 'Affiliate', money: true, hint: 'Addrevenue affiliate commission + platform fee, converted at each day’s own rate' },
```

(Everything else — metric picker, sorting, persistence — is COLUMNS-driven and needs nothing.)

- [ ] **Step 4: Run it** — expect PASS.
- [ ] **Step 5: Commit** — `feat(affiliate): an Affiliate column on the Dashboard compare table`

---

### Task 9: Marketing page — the Affiliate section and its endpoint

**Files:**
- Create: `src/app/api/affiliate/summary/route.ts`
- Create: `src/app/marketing/AffiliateSection.tsx`
- Modify: `src/app/marketing/MarketingClient.tsx` (render the section just before `</PageBody>`, OUTSIDE the `hasAccounts` ternary — affiliate must show even with no ad accounts)

No unit test for the thin route (house convention for read-shaping routes); the e2e spec in Task 12 walks the section against seeded data.

- [ ] **Step 1: The endpoint.** `src/app/api/affiliate/summary/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { resolvePreset, utcDay, type Preset, PRESET_LABELS } from '@/lib/dates'
import { buildRateTable, crossConvert } from '@/lib/metrics/fx'
import { ensureRates, loadRates } from '@/lib/fx/rates'
import { getSetting } from '@/lib/settings'

/**
 * The Marketing page's Affiliate section: totals, per shop and per channel.
 * Channel detail lives here rather than in the engine — the engine speaks in
 * per-shop figures, and "which blog earned what" is not one of them. The COST
 * figure follows the engine's exact conventions (non-denied rows, commission +
 * fee, each row at its own day's rate) so this section and the Dashboard's
 * Affiliate column can never disagree.
 */

type Slice = { sales: number; orderValue: number; cost: number }

function addTo(map: Map<string, Slice>, key: string, orderValue: number, cost: number) {
  const s = map.get(key) ?? { sales: 0, orderValue: 0, cost: 0 }
  s.sales += 1
  s.orderValue += orderValue
  s.cost += cost
  map.set(key, s)
}

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())
    const url = new URL(req.url)

    const presetParam = url.searchParams.get('preset')
    const fromParam = url.searchParams.get('from')
    const toParam = url.searchParams.get('to')
    let from: Date
    let to: Date
    if (fromParam && toParam) {
      from = new Date(fromParam)
      to = new Date(toParam)
    } else {
      const preset = (presetParam && presetParam in PRESET_LABELS ? presetParam : 'this_month') as Preset
      ;({ from, to } = resolvePreset(preset))
    }

    const shopsParam = url.searchParams.get('shops')
    const shopRows = await db.shop.findMany({
      where: { active: true, ...(shopsParam ? { id: { in: shopsParam.split(',') } } : {}) },
      select: { id: true, name: true, currency: true },
      orderBy: { name: 'asc' },
    })
    const shopIds = shopRows.map((s) => s.id)
    const nameById = new Map(shopRows.map((s) => [s.id, s.name]))

    const connected = (await db.affiliateAccount.count({ where: { active: true } })) > 0

    const setting = await getSetting()
    const displayCurrency = shopRows.length === 1 ? shopRows[0].currency : setting.displayCurrency

    const rows = await db.affiliateTransaction.findMany({
      where: {
        shopId: { in: shopIds },
        denyDate: null,
        date: { gte: utcDay(from), lte: utcDay(to) },
      },
      select: {
        shopId: true, date: true, channelName: true, currency: true,
        commission: true, brokerageFee: true, orderValue: true,
      },
    })

    const currencies = [...new Set([displayCurrency, ...rows.map((r) => r.currency)])]
    if (currencies.length > 1) await ensureRates(from, to, currencies)
    const rates = buildRateTable(await loadRates())

    const byShop = new Map<string, Slice>()
    const byChannel = new Map<string, Slice>()
    const total: Slice = { sales: 0, orderValue: 0, cost: 0 }
    for (const r of rows) {
      const cost = crossConvert(r.commission + r.brokerageFee, r.currency, displayCurrency, r.date, rates)
      const orderValue = crossConvert(r.orderValue, r.currency, displayCurrency, r.date, rates)
      addTo(byShop, r.shopId!, orderValue, cost)
      addTo(byChannel, r.channelName, orderValue, cost)
      total.sales += 1
      total.orderValue += orderValue
      total.cost += cost
    }

    // Loud, never silent: money that belongs to no shop is still money.
    const unmatched = await db.affiliateTransaction.count({
      where: { shopId: null, denyDate: null, date: { gte: utcDay(from), lte: utcDay(to) } },
    })

    return NextResponse.json({
      connected,
      displayCurrency,
      range: { from: utcDay(from).toISOString(), to: utcDay(to).toISOString() },
      total,
      byShop: [...byShop.entries()]
        .map(([shopId, s]) => ({ shopId, shopName: nameById.get(shopId) ?? shopId, ...s }))
        .sort((a, b) => b.cost - a.cost),
      byChannel: [...byChannel.entries()]
        .map(([channelName, s]) => ({ channelName, ...s }))
        .sort((a, b) => b.cost - a.cost),
      unmatched,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load affiliate figures' }, { status: 500 })
  }
}
```

Check the actual export names in `src/lib/metrics/fx.ts` before writing (`crossConvert`, `buildRateTable`) — both are imported elsewhere (`engine.ts`, `load.ts`), copy those import paths exactly.

- [ ] **Step 2: The section.** `src/app/marketing/AffiliateSection.tsx` (page-local, like `BreakdownTable.tsx`):

```tsx
'use client'

import { useEffect, useState } from 'react'
import { formatMoney } from '@/lib/money'
import type { Preset } from '@/lib/dates'

type Slice = { sales: number; orderValue: number; cost: number }
type Payload = {
  connected: boolean
  displayCurrency: string
  total: Slice
  byShop: (Slice & { shopId: string; shopName: string })[]
  byChannel: (Slice & { channelName: string })[]
  unmatched: number
}

const count = (n: number) => Math.round(n).toLocaleString('en-US')

/**
 * Affiliate commissions on the Marketing page. Fetches its own figures with
 * the page's own filter state, so it works even when no AD account exists —
 * the affiliate program is its own channel, not a subset of paid ads.
 */
export function AffiliateSection({
  preset,
  from,
  to,
  shops,
  tick,
}: {
  preset: Preset | 'custom'
  from: string
  to: string
  shops: string[]
  tick: number
}) {
  const [data, setData] = useState<Payload | null>(null)

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    if (shops.length) params.set('shops', shops.join(','))

    const ctrl = new AbortController()
    fetch(`/api/affiliate/summary?${params}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: Payload | null) => { if (json) setData(json) })
      .catch(() => {})
    return () => ctrl.abort()
  }, [preset, from, to, shops, tick])

  // Nothing connected and nothing recorded: the section does not exist.
  if (!data || (!data.connected && data.total.sales === 0)) return null

  const currency = data.displayCurrency
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-ink">Affiliate</h2>
        <p className="text-[12px] text-muted">
          Addrevenue commissions + platform fee — counted into net profit as their own cost line.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'AFFILIATE COST', value: formatMoney(data.total.cost, currency) },
          { label: 'TRACKED SALES', value: count(data.total.sales) },
          { label: 'TRACKED ORDER VALUE', value: formatMoney(data.total.orderValue, currency) },
        ].map((s) => (
          <div key={s.label} className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
            <p className="text-[11px] font-semibold tracking-wide text-faint">{s.label}</p>
            <p className="num mt-1 text-[20px] font-semibold text-ink">{s.value}</p>
          </div>
        ))}
      </div>

      {data.unmatched > 0 && (
        <p className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
          {data.unmatched} {data.unmatched === 1 ? 'sale' : 'sales'} belong to an Addrevenue market that
          matches none of the shops, so their cost is missing from every per-shop figure. Check the
          shops’ URLs on the Affiliate settings page.
        </p>
      )}

      {data.byChannel.length > 0 && (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-faint">
                  <th scope="col" className="px-5 py-3 text-left">CHANNEL</th>
                  <th scope="col" className="px-5 py-3 text-right">SALES</th>
                  <th scope="col" className="px-5 py-3 text-right">ORDER VALUE</th>
                  <th scope="col" className="px-5 py-3 text-right">COST</th>
                </tr>
              </thead>
              <tbody>
                {data.byChannel.map((r) => (
                  <tr key={r.channelName} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 text-ink">{r.channelName}</td>
                    <td className="num px-5 py-3 text-right text-muted">{count(r.sales)}</td>
                    <td className="num px-5 py-3 text-right text-muted">{formatMoney(r.orderValue, currency)}</td>
                    <td className="num px-5 py-3 text-right font-semibold text-ink">{formatMoney(r.cost, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.byShop.length > 1 && (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-faint">
                  <th scope="col" className="px-5 py-3 text-left">SHOP</th>
                  <th scope="col" className="px-5 py-3 text-right">SALES</th>
                  <th scope="col" className="px-5 py-3 text-right">ORDER VALUE</th>
                  <th scope="col" className="px-5 py-3 text-right">COST</th>
                </tr>
              </thead>
              <tbody>
                {data.byShop.map((r) => (
                  <tr key={r.shopId} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 text-ink">{r.shopName}</td>
                    <td className="num px-5 py-3 text-right text-muted">{count(r.sales)}</td>
                    <td className="num px-5 py-3 text-right text-muted">{formatMoney(r.orderValue, currency)}</td>
                    <td className="num px-5 py-3 text-right font-semibold text-ink">{formatMoney(r.cost, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 3: Mount it.** In `MarketingClient.tsx`: `import { AffiliateSection } from './AffiliateSection'`, and directly before the closing `</PageBody>` (AFTER the whole `!hasAccounts ? ... : ...` expression) add:

```tsx
        <div className="mt-4">
          <AffiliateSection preset={preset} from={from} to={to} shops={selected} tick={tick} />
        </div>
```

- [ ] **Step 4: Verify** — `npx tsc --noEmit`; `npm run dev`, sign in as the seeded admin, open /marketing: no affiliate data yet, so the section must NOT render (that's the `connected/sales===0` gate working). No console errors.
- [ ] **Step 5: Commit** — `feat(affiliate): the Marketing page shows affiliate cost per channel and shop`

---

### Task 10: Settings — connect a brand token

**Files:**
- Create: `src/app/api/affiliate/accounts/route.ts` (GET list, POST add)
- Create: `src/app/api/affiliate/accounts/[id]/route.ts` (PATCH active, DELETE)
- Create: `src/app/api/affiliate/sync/route.ts` (POST force-sync)
- Create: `src/app/settings/affiliate/page.tsx`
- Create: `src/app/settings/affiliate/AffiliateClient.tsx`
- Modify: `src/components/shell/AppShell.tsx` (Setup section, after the Ad accounts item ~line 193-202)

Follow the guard idiom of `src/app/api/ad-accounts/route.ts` exactly: `assertAdmin(await currentUser())`, `AuthError` → 403, zod body. The token is verified against the live platform BEFORE storing, and the stored value is `encryptSecret(token)`. **No API response ever contains the token.**

- [ ] **Step 1: `src/app/api/affiliate/accounts/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { AffiliateApiError, fetchAdvertiser } from '@/lib/affiliate/client'
import { syncAffiliateAccount } from '@/lib/affiliate/sync'

/** The first sync fetches the whole history before answering. */
export const maxDuration = 60

// The token itself never travels back to the browser.
async function toPublic(a: {
  id: string
  externalId: string
  name: string
  active: boolean
  lastSyncAt: Date | null
  lastError: string | null
}) {
  const [transactions, unmatched] = await Promise.all([
    db.affiliateTransaction.count({ where: { accountId: a.id } }),
    db.affiliateTransaction.count({ where: { accountId: a.id, shopId: null } }),
  ])
  return {
    id: a.id,
    externalId: a.externalId,
    name: a.name,
    active: a.active,
    lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
    lastError: a.lastError,
    transactions,
    unmatched,
  }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const accounts = await db.affiliateAccount.findMany({ orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ accounts: await Promise.all(accounts.map(toPublic)) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load affiliate accounts' }, { status: 500 })
  }
}

const Body = z.object({ token: z.string().trim().min(10, 'Paste the API token from Addrevenue') })

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

    // Prove the token against the live platform BEFORE storing anything, and
    // take the brand's real name and advertiser id from the answer.
    const advertiser = await fetchAdvertiser(parsed.data.token)

    const duplicate = await db.affiliateAccount.findUnique({
      where: { provider_externalId: { provider: 'addrevenue', externalId: advertiser.externalId } },
    })
    if (duplicate) {
      return NextResponse.json(
        { error: `${advertiser.name} is already connected.` },
        { status: 409 },
      )
    }

    const account = await db.affiliateAccount.create({
      data: {
        externalId: advertiser.externalId,
        name: advertiser.name,
        token: encryptSecret(parsed.data.token),
      },
    })

    // Pull the whole history right away so the dashboard has the cost the
    // moment the page refreshes.
    const sync = await syncAffiliateAccount(account)

    const fresh = await db.affiliateAccount.findUniqueOrThrow({ where: { id: account.id } })
    return NextResponse.json({ account: await toPublic(fresh), sync })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (e instanceof AffiliateApiError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error(e)
    return NextResponse.json({ error: 'Could not connect the Addrevenue account' }, { status: 500 })
  }
}
```

- [ ] **Step 2: `src/app/api/affiliate/accounts/[id]/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const Body = z.object({ active: z.boolean() })

/** Pause the sync without touching the history. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })
    const account = await db.affiliateAccount.update({ where: { id }, data: { active: parsed.data.active } })
    return NextResponse.json({ id: account.id, active: account.active })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not update the account' }, { status: 500 })
  }
}

/**
 * Remove the account AND its transactions (cascade) — which removes its cost
 * from every historical figure. The client confirms in the UI; pausing via
 * PATCH is the way to stop syncing while keeping the history.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    await db.affiliateAccount.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not remove the account' }, { status: 500 })
  }
}
```

(Check the house `params` idiom in an existing `[id]` route — e.g. `src/app/api/shops/[id]/route.ts` — and copy its exact signature; Next 16 makes `params` a Promise.)

- [ ] **Step 3: `src/app/api/affiliate/sync/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { syncAllAffiliateAccounts } from '@/lib/affiliate/sync'

export const maxDuration = 60

export async function POST() {
  try {
    assertAdmin(await currentUser())
    const results = await syncAllAffiliateAccounts({ force: true })
    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}
```

- [ ] **Step 4: The page.** `src/app/settings/affiliate/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { AffiliateClient } from './AffiliateClient'

export default async function AffiliatePage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const accounts = await db.affiliateAccount.findMany({ orderBy: { createdAt: 'asc' } })
  const withCounts = await Promise.all(
    accounts.map(async (a) => ({
      id: a.id,
      externalId: a.externalId,
      name: a.name,
      active: a.active,
      lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
      lastError: a.lastError,
      transactions: await db.affiliateTransaction.count({ where: { accountId: a.id } }),
      unmatched: await db.affiliateTransaction.count({ where: { accountId: a.id, shopId: null } }),
    })),
  )

  return <AffiliateClient email={user.email} initialAccounts={withCounts} />
}
```

- [ ] **Step 5: The client.** `src/app/settings/affiliate/AffiliateClient.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

type Account = {
  id: string
  externalId: string
  name: string
  active: boolean
  lastSyncAt: string | null
  lastError: string | null
  transactions: number
  unmatched: number
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

export function AffiliateClient({
  email,
  initialAccounts,
}: {
  email: string
  initialAccounts: Account[]
}) {
  const [accounts, setAccounts] = useState(initialAccounts)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const toast = useToast()

  async function reload() {
    const res = await fetch('/api/affiliate/accounts')
    if (res.ok) setAccounts((await res.json()).accounts)
  }

  async function add() {
    setBusy(true)
    try {
      const res = await fetch('/api/affiliate/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error ?? 'Could not connect')
        return
      }
      setToken('')
      toast.success(`${json.account.name} connected — ${json.sync.rows} sales imported`)
      await reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/affiliate/sync', { method: 'POST' })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Sync failed')
        return
      }
      toast.success('Affiliate sales refreshed')
      await reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSyncing(false)
    }
  }

  async function setActive(id: string, active: boolean) {
    const res = await fetch(`/api/affiliate/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    })
    if (res.ok) await reload()
    else toast.error('Could not update the account')
  }

  async function remove(id: string, name: string) {
    // Deleting removes the COST HISTORY from every dashboard figure — say so.
    if (!window.confirm(`Remove ${name}? Its imported sales and their cost disappear from every figure. To just stop syncing, pause it instead.`)) return
    const res = await fetch(`/api/affiliate/accounts/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(`${name} removed`)
      await reload()
    } else toast.error('Could not remove the account')
  }

  return (
    <AppShell email={email}>
      <PageHeader title="Affiliate" subtitle="Addrevenue — commissions imported as a cost, per shop and channel.">
        {accounts.length > 0 && (
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:border-faint disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </PageHeader>

      <PageBody>
        <div className="space-y-4">
          <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
            <h2 className="text-[14px] font-semibold text-ink">Connect a brand</h2>
            <p className="mt-1 text-[13px] text-muted">
              Paste the brand’s API token from Addrevenue (Settings → API). The token is checked
              against Addrevenue before anything is stored, then kept encrypted. Each brand —
              Panetti, Mazzetti — has its own token.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="API token"
                aria-label="API token"
                className="w-80 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[13px] text-ink"
              />
              <button
                type="button"
                onClick={add}
                disabled={busy || token.trim().length < 10}
                className="rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-contrast transition-colors duration-150 disabled:opacity-50"
              >
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </div>
          </section>

          {accounts.length > 0 && (
            <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-faint">
                      <th scope="col" className="px-5 py-3 text-left">BRAND</th>
                      <th scope="col" className="px-5 py-3 text-right">SALES IMPORTED</th>
                      <th scope="col" className="px-5 py-3 text-left">LAST SYNC</th>
                      <th scope="col" className="px-5 py-3 text-left">STATUS</th>
                      <th scope="col" className="px-5 py-3 text-right">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id} className="border-b border-line last:border-0">
                        <td className="px-5 py-3">
                          <span className="font-semibold text-ink">{a.name}</span>{' '}
                          <span className="text-faint">#{a.externalId}</span>
                        </td>
                        <td className="num px-5 py-3 text-right text-muted">{a.transactions.toLocaleString('en-US')}</td>
                        <td className="px-5 py-3 text-muted">{when(a.lastSyncAt)}</td>
                        <td className="px-5 py-3">
                          {a.lastError ? (
                            <span className="text-loss">{a.lastError}</span>
                          ) : !a.active ? (
                            <span className="text-muted">Paused</span>
                          ) : a.unmatched > 0 ? (
                            <span className="text-muted">
                              OK — {a.unmatched} sales match no shop (check the shops’ URLs)
                            </span>
                          ) : (
                            <span className="text-muted">OK</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setActive(a.id, !a.active)}
                            className="mr-3 text-[13px] font-semibold text-accent hover:underline"
                          >
                            {a.active ? 'Pause' : 'Resume'}
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(a.id, a.name)}
                            className="text-[13px] font-semibold text-loss hover:underline"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </PageBody>
    </AppShell>
  )
}
```

Before writing, glance at `src/app/settings/ad-accounts/AdAccountsClient.tsx` for the toast import path and the accent-button class names actually in use, and match them.

- [ ] **Step 6: Nav.** In `AppShell.tsx`, Setup section, right after the Ad accounts item:

```tsx
      {
        href: '/settings/affiliate',
        label: 'Affiliate',
        icon: icon(
          <>
            <path d="M9 15 15 9" />
            <path d="M10.5 6.5 12 5a4 4 0 0 1 5.7 5.7l-1.6 1.5" />
            <path d="M13.5 17.5 12 19a4 4 0 0 1-5.7-5.7l1.6-1.5" />
          </>,
        ),
      },
```

- [ ] **Step 7: Verify** — `npx tsc --noEmit`; `npm run dev`: /settings/affiliate renders, the connect form refuses a garbage token with Addrevenue's own wording (stub-free manual check is fine offline: a bad token gets the 403 message).
- [ ] **Step 8: Commit** — `feat(affiliate): a settings page that proves a brand token before storing it`

---

### Task 11: The cron rides along

**Files:**
- Modify: `src/app/api/cron/sync/route.ts`

- [ ] **Step 1: Import** (top of file, beside the ads import):

```ts
import { syncAllAffiliateAccounts, type AffiliateSyncResult } from '@/lib/affiliate/sync'
```

- [ ] **Step 2: The stage.** Immediately AFTER the ads best-effort block (`let ads: AdSyncResult[] = [] ... }` ~line 233-238) and BEFORE the rate top-up, insert:

```ts
  // Affiliate commissions from Addrevenue. Two bounded requests per brand and
  // a six-hour spacing inside syncAllAffiliateAccounts, so most runs cost
  // nothing; a due account is roughly five to ten seconds (a full-history
  // mirror rewrite against Neon), so a due run costs the budget ~20s — spent
  // here, with the money pulls, ahead of the greedy parcel poll. Best-effort
  // like the ads: a bad token keeps its own lastError on the settings page
  // and must never fail the shop sync.
  let affiliate: AffiliateSyncResult[] = []
  try {
    affiliate = await syncAllAffiliateAccounts()
  } catch {
    // Each account keeps its own lastError; the settings page tells the story.
  }
```

- [ ] **Step 3: Rates.** In the rate top-up's `currencies` array, after the ad-account line, add:

```ts
        // Affiliate rows carry their own currency (measured: FI sales in SEK).
        ...(
          await db.affiliateTransaction.findMany({ select: { currency: true }, distinct: ['currency'] })
        ).map((t) => t.currency),
```

- [ ] **Step 4: Report.** In the response JSON, after `adFailed`, add:

```ts
    affiliateAccounts: affiliate.length,
    affiliateFailed: affiliate.filter((r) => !r.ok).map((r) => r.name),
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit`; full test run `npx vitest run` stays green.
- [ ] **Step 6: Commit** — `feat(affiliate): the scheduled sync reads Addrevenue every six hours`

---

### Task 12: Seed data and the E2E walk

**Files:**
- Modify: `prisma/seed.ts` (deleteMany block ~line 82; new section after the AD_ACCOUNTS loop)
- Modify: `e2e/global-setup.ts` (warm list)
- Create: `e2e/affiliate.spec.ts`

- [ ] **Step 1: Seed.** In the clearing block at the top of `main()`, BEFORE `db.adSpend.deleteMany()`, add:

```ts
  await db.affiliateTransaction.deleteMany()
  await db.affiliateAccount.deleteMany()
```

After the AD_ACCOUNTS loop (where ad spend seeding ends), add — reusing the file's existing `between`/`rnd` helpers and `shops` array:

```ts
  // The affiliate program: one Addrevenue brand with tracked sales across
  // three shops, so the Affiliate column, the Marketing section and the
  // settings page all have something true to show. Token 'seed' works because
  // decryptSecret passes unprefixed values through.
  const affiliateAccount = await db.affiliateAccount.create({
    data: { externalId: '986851', name: 'Panetti (sample)', token: 'seed' },
  })
  const CHANNELS = [
    { id: 3464435, name: 'Forbrukertesten.com' },
    { id: 3464436, name: 'Hjem og Hage' },
    { id: 3464437, name: 'Testsieger.de' },
  ]
  const STATUSES = ['paidOut', 'paidOut', 'invoiced', 'new'] // roughly the real mix
  let affiliateId = 1
  for (let d = 0; d < 90; d += 2) {
    const shop = shops[d % 3] // Panetti Norway / Sweden / Denmark
    const channel = CHANNELS[d % CHANNELS.length]
    const orderValue = between(40000, 900000)
    const commission = Math.round(orderValue * 0.15)
    await db.affiliateTransaction.create({
      data: {
        accountId: affiliateAccount.id,
        externalId: String(affiliateId++),
        date: new Date(Date.UTC(2026, 6, 14) - d * 24 * 60 * 60 * 1000),
        market: ['NO', 'SE', 'DK'][d % 3],
        shopId: shop.id,
        channelId: String(channel.id),
        channelName: channel.name,
        status: STATUSES[d % STATUSES.length],
        commission,
        brokerageFee: Math.round(commission * 0.15),
        orderValue,
        currency: shop.currency,
        eventOrderId: String(19000 + d),
      },
    })
  }
```

(Confirm against the file that `shops[0..2]` are the three Panetti shops and that the ad-spend section uses the same `Date.UTC(2026, 6, 14)` anchor — copy whatever anchor it actually uses.)

Run: `npm run db:seed` (or the script the repo defines — check `package.json`) — expect it to finish green.

- [ ] **Step 2: Warm list.** In `e2e/global-setup.ts`, add `'/marketing'` and `'/settings/affiliate'` to the warmed paths.

- [ ] **Step 3: The spec.** `e2e/affiliate.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

test('the Dashboard compare table carries an Affiliate cost column', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()

  await expect(page.getByRole('button', { name: 'Sort by Affiliate' })).toBeVisible({ timeout: 15_000 })
  // It is a real money column: the seeded shops carry a non-zero figure.
  // (The engine subtracts it from net profit; the number itself is asserted
  // against the same seed by the unit suites.)
})

test('the Marketing page shows the affiliate section with channels', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/marketing')

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Affiliate' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('AFFILIATE COST', { exact: true })).toBeVisible()
  await expect(page.getByText('Forbrukertesten.com')).toBeVisible()
})

test('the settings page lists the seeded brand and offers Sync now', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await page.getByRole('link', { name: 'Affiliate' }).click()
  await expect(page).toHaveURL(/\/settings\/affiliate/)
  await expect(page.getByRole('heading', { name: 'Affiliate' })).toBeVisible()
  await expect(page.getByText('Panetti (sample)')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible()
  await expect(page.getByLabel('API token')).toBeVisible()
})
```

(If the nav link name 'Affiliate' collides with the Marketing-page heading in `getByRole('link', ...)`, scope it: `page.getByRole('navigation').getByRole('link', { name: 'Affiliate' })` — mirror how other specs disambiguate.)

- [ ] **Step 4: Run E2E** — `npx playwright test e2e/affiliate.spec.ts --headed` (this machine needs `--headed`; the config runs `workers: 1` and starts the dev server itself). Expect 3 passed.
- [ ] **Step 5: Run everything** — `npx vitest run` (all projects), `npx tsc --noEmit`, `npm run build` (the build runs db-push + next build). All green.
- [ ] **Step 6: Commit** — `feat(affiliate): seed affiliate sales and walk the three surfaces end to end`

---

### Task 13: Live verification with the real tokens (manual, with the user)

No code. This is the "no guessing" acceptance the client asked for.

- [ ] `npm run dev`, sign in locally, open **Settings → Affiliate**.
- [ ] Paste the **Mazzetti** token, then the **Panetti** token (the user has them; they are in the conversation — never commit them anywhere). Each connect must report its real name (Mazzetti / Panetti) and import its real history (~70 and ~2,097 sales as of 2026-08-24; more by now).
- [ ] The local shops table must have `wooUrl` set for the nine Panetti/Mazzetti shops for domain matching to land; if the local DB lacks them, the settings row will say how many sales match no shop — set the shops' URLs in /settings/shops to the real domains and press Sync now, and the mirror rewrite heals every row.
- [ ] Dashboard, Last 12 months: the Affiliate column shows real money per shop; net profit visibly shifts by it. Marketing page: the channel table names the real channels (Forbrukertesten.com, Hjem og Hage, Nettavisen, Testsieger.de…).
- [ ] Cross-check one number: pick one month and one brand, and compare the section's total against Addrevenue's own dashboard for that month (the user can open it). Small differences from THEIR currency table are expected when crossing currencies (we convert at our own daily rates, as everywhere else in the app); same-currency single-shop figures must match to the øre.
- [ ] Then merge to main and deploy; paste both tokens again in PROD settings (they live encrypted in Neon, never in git or Vercel env), and confirm the cron report starts carrying `affiliateAccounts: 2`.
