# Campaign-to-store mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one ad account serve several stores by assigning each campaign to the store it advertises for.

**Architecture:** The account keeps its `shopId` as a default; campaigns optionally override it. Campaign-level daily spend is stored in a new `AdCampaignSpend` table, and the campaign→shop mapping is joined at **read time**, never written onto a spend row — which is what makes reassigning a campaign re-attribute a year of history in a single update. Splitting is opt-in per account, so the eight accounts connected today are untouched.

**Tech Stack:** Next.js 16 App Router, Prisma 6 / PostgreSQL, Vitest 4, TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-07-campaign-store-mapping-design.md`

## Global Constraints

- **Money is INTEGER MINOR UNITS everywhere.** Never floats. `AdCampaignSpend.spend` is minor units of the **account's** currency, converted only at read time.
- **A split account writes `AdCampaignSpend` and NEVER `AdSpend`.** A whole account does exactly the reverse. Both would silently double that account's ad cost.
- **Never write `shopId` onto a spend row.** Attribution is a read-time join. This is the whole point of the design.
- **Sync refreshes `AdCampaign.name` but never touches `AdCampaign.shopId`.** Renaming a campaign in Google must not unassign it.
- Repo default Vitest environment is `node`. DOM tests need `// @vitest-environment jsdom` as the first line.
- Tests run against the portable Postgres at `%LOCALAPPDATA%\panetti-pg`. **Never** against the live Neon DB. Start it with `pg_ctl -D "$LOCALAPPDATA/panetti-pg/data" start` if `PrismaClientInitializationError` appears.
- Never `git add -A` — it sweeps `next-env.d.ts`, which the build rewrites.
- Never run `git stash`, `git checkout`, `git reset`, `git restore`, or `git clean`.
- Edit files with the Edit/Write tools only. **Never** `Get-Content`/`Set-Content` — PowerShell 5.1 mojibakes UTF-8.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | `AdCampaign`, `AdCampaignSpend`, `AdAccount.splitByCampaign` |
| `src/lib/ads/windows.ts` (new) | `chunkRange` — split a date range into fetch-sized windows |
| `src/lib/ads/types.ts` | `CampaignDailyRow` |
| `src/lib/ads/google.ts` | `fetchGoogleCampaignDaily` |
| `src/lib/ads/meta.ts` | `fetchMetaCampaignDaily` + page-cap guard |
| `src/lib/ads/sync.ts` | Branch on `splitByCampaign` |
| `src/lib/ads/attribution.ts` (new) | Resolve stored spend to shops. **One** implementation, two callers |
| `src/lib/data/load.ts` | Use the resolver |
| `src/app/api/marketing/route.ts` | Use the resolver |
| `src/app/api/ad-accounts/[id]/campaigns/route.ts` (new) | List and assign campaigns |
| `src/app/settings/ad-accounts/AdAccountsClient.tsx` | Campaigns action + modal |

---

### Task 1: Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `src/lib/ads/campaign-schema.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: Prisma models `AdCampaign { id, accountId, externalId, name, shopId, createdAt }` and `AdCampaignSpend { id, campaignId, date, spend, impressions, clicks, linkClicks, conversions, conversionValue }`; `AdAccount.splitByCampaign: boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ads/campaign-schema.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'

const TAG = 'campaign-schema-test'

afterEach(async () => {
  await db.adCampaign.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.adAccount.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

async function shop(name: string) {
  return db.shop.create({ data: { name: `${TAG} ${name}`, currency: 'NOK' } })
}

describe('AdCampaign', () => {
  it('stores a campaign and its daily spend, and defaults to unassigned', async () => {
    const s = await shop('a')
    const account = await db.adAccount.create({
      data: {
        shopId: s.id,
        provider: 'google',
        externalId: '1112223334',
        name: `${TAG} acct`,
        currency: 'NOK',
      },
    })
    expect(account.splitByCampaign).toBe(false)

    const campaign = await db.adCampaign.create({
      data: { accountId: account.id, externalId: 'c1', name: `${TAG} camp` },
    })
    expect(campaign.shopId).toBeNull()

    await db.adCampaignSpend.create({
      data: {
        campaignId: campaign.id,
        date: new Date('2026-03-01T00:00:00Z'),
        spend: 12345,
        impressions: 10,
        clicks: 2,
      },
    })
    const rows = await db.adCampaignSpend.findMany({ where: { campaignId: campaign.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].spend).toBe(12345)
  })

  it('unassigns rather than deletes when a shop goes away', async () => {
    const s = await shop('b')
    const account = await db.adAccount.create({
      data: { shopId: s.id, provider: 'meta', externalId: '9998887776', name: `${TAG} m`, currency: 'NOK' },
    })
    const campaign = await db.adCampaign.create({
      data: { accountId: account.id, externalId: 'c2', name: `${TAG} c2`, shopId: s.id },
    })
    await db.shop.delete({ where: { id: s.id } })
    // The account cascades with its shop; the campaign row goes with the account.
    // What must NOT happen is a foreign-key error on delete.
    expect(await db.adCampaign.findUnique({ where: { id: campaign.id } })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ads/campaign-schema.test.ts`
Expected: FAIL — `db.adCampaign` is undefined.

- [ ] **Step 3: Add the models**

In `prisma/schema.prisma`, add `splitByCampaign` and the `campaigns` back-relation to `AdAccount` (inside the existing model, next to `dailyBudget` and `spend` respectively):

```prisma
  dailyBudget     Int?
  splitByCampaign Boolean   @default(false) // true = attribute per campaign, not per account
```

```prisma
  spend      AdSpend[]
  campaigns  AdCampaign[]
```

Add `adCampaigns AdCampaign[]` to `Shop`, after `adAccounts AdAccount[]`.

Then add both models after `AdSpend`:

```prisma
// Which store a campaign advertises for. The account's own shopId is the
// default; this overrides it. Never written by the sync — only by a person.
model AdCampaign {
  id         String   @id @default(cuid())
  accountId  String
  externalId String   // campaign id from the platform
  name       String   // snapshot, refreshed on each sync
  shopId     String?  // null = unassigned, falls back to account.shopId
  createdAt  DateTime @default(now())

  account AdAccount         @relation(fields: [accountId], references: [id], onDelete: Cascade)
  // SetNull, not Cascade: removing a shop must unassign its campaigns, never
  // delete the spend history that proves what was spent.
  shop    Shop?             @relation(fields: [shopId], references: [id], onDelete: SetNull)
  spend   AdCampaignSpend[]

  @@unique([accountId, externalId])
  @@index([shopId])
}

// One day of one campaign's delivery. Same units as AdSpend: minor units of
// the ACCOUNT's currency, converted at read time. Only day-additive numbers —
// reach does not sum across days, so it is deliberately absent.
model AdCampaignSpend {
  id              String   @id @default(cuid())
  campaignId      String
  date            DateTime // UTC midnight
  spend           Int
  impressions     Int
  clicks          Int
  linkClicks      Int      @default(0)
  conversions     Float    @default(0)
  conversionValue Int      @default(0)

  campaign AdCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

  @@unique([campaignId, date])
  @@index([date])
}
```

- [ ] **Step 4: Push the schema and regenerate**

Run: `npx prisma db push && npx prisma generate`
Expected: "Your database is now in sync with your Prisma schema."

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/ads/campaign-schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma src/lib/ads/campaign-schema.test.ts
git commit -m "feat: store which store each campaign advertises for"
```

---

### Task 2: Chunked date windows

**Files:**
- Create: `src/lib/ads/windows.ts`
- Test: `src/lib/ads/windows.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `chunkRange(from: Date, to: Date, days: number): { from: Date; to: Date }[]` and `CHUNK_DAYS = 90`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ads/windows.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CHUNK_DAYS, chunkRange } from './windows'

const d = (s: string) => new Date(`${s}T00:00:00Z`)
const iso = (x: Date) => x.toISOString().slice(0, 10)

describe('chunkRange', () => {
  it('returns one window when the range already fits', () => {
    expect(chunkRange(d('2026-01-01'), d('2026-02-04'), 90).map((w) => [iso(w.from), iso(w.to)])).toEqual([
      ['2026-01-01', '2026-02-04'],
    ])
  })

  it('splits a year into five 90-day windows', () => {
    const windows = chunkRange(d('2026-01-01'), d('2026-12-31'), 90)
    expect(windows).toHaveLength(5)
    expect(iso(windows[0].from)).toBe('2026-01-01')
    expect(iso(windows[4].to)).toBe('2026-12-31')
  })

  it('leaves no gap and no overlap at a boundary', () => {
    const windows = chunkRange(d('2026-01-01'), d('2026-12-31'), 90)
    for (let i = 1; i < windows.length; i++) {
      const previousEnd = windows[i - 1].to.getTime()
      const nextStart = windows[i].from.getTime()
      expect(nextStart - previousEnd).toBe(24 * 60 * 60 * 1000) // exactly one day on
    }
  })

  it('handles a single-day range', () => {
    expect(chunkRange(d('2026-05-05'), d('2026-05-05'), 90)).toHaveLength(1)
  })

  it('never returns a window when the range runs backwards', () => {
    expect(chunkRange(d('2026-05-05'), d('2026-05-01'), 90)).toEqual([])
  })

  it('uses 90 days as the shared default', () => {
    expect(CHUNK_DAYS).toBe(90)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ads/windows.test.ts`
Expected: FAIL — cannot resolve `./windows`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ads/windows.ts`:

```ts
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How many days one campaign-level fetch may cover.
 *
 * Meta caps a fetch at PAGE_LIMIT 500 x MAX_PAGES 10 = 5000 rows and returns
 * short WITHOUT erroring, so campaign x day over the 365-day backfill silently
 * truncates above fourteen campaigns. Ninety days stays under the cap up to
 * ~55 campaigns and turns the backfill into five requests rather than thirteen,
 * which matters because the connect route caps at maxDuration = 60.
 */
export const CHUNK_DAYS = 90

/**
 * Split an inclusive day range into windows of at most `days` days.
 *
 * Windows are contiguous and non-overlapping: each starts exactly one day after
 * the previous one ends, so no day is fetched twice (which would double a
 * campaign's spend on the upsert) and none is skipped.
 */
export function chunkRange(from: Date, to: Date, days: number): { from: Date; to: Date }[] {
  if (from.getTime() > to.getTime()) return []
  const windows: { from: Date; to: Date }[] = []
  let start = from
  while (start.getTime() <= to.getTime()) {
    const end = new Date(start.getTime() + (days - 1) * DAY_MS)
    windows.push({ from: start, to: end.getTime() > to.getTime() ? to : end })
    start = new Date(end.getTime() + DAY_MS)
  }
  return windows
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ads/windows.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/windows.ts src/lib/ads/windows.test.ts
git commit -m "feat: split a fetch range into windows that fit the page cap"
```

---

### Task 3: Google campaign-by-day fetcher

**Files:**
- Modify: `src/lib/ads/types.ts`
- Modify: `src/lib/ads/google.ts`
- Test: `src/lib/ads/google.test.ts` (append)

**Interfaces:**
- Consumes: `chunkRange`, `CHUNK_DAYS` from Task 2
- Produces: `CampaignDailyRow = DailyRow & { campaignId: string; campaignName: string }`; `fetchGoogleCampaignDaily(creds: GoogleCredentials, customerId: string, from: Date, to: Date): Promise<CampaignDailyRow[]>`; `toCampaignDailyRows(results: GoogleResult[]): CampaignDailyRow[]`

- [ ] **Step 1: Add the shared type**

In `src/lib/ads/types.ts`, after `DailyRow`:

```ts
/**
 * One day of ONE CAMPAIGN's delivery. Same units and same day-additive rule as
 * DailyRow; the campaign's own id and name ride along so the sync can keep the
 * AdCampaign row's name fresh without a second request.
 */
export type CampaignDailyRow = DailyRow & {
  campaignId: string
  campaignName: string
}
```

- [ ] **Step 2: Write the failing test**

Append to `src/lib/ads/google.test.ts`:

```ts
describe('fetchGoogleCampaignDaily', () => {
  it('returns one row per campaign per day', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        json([
          {
            results: [
              {
                campaign: { id: '111', name: 'Norway Brand' },
                segments: { date: '2026-03-01' },
                metrics: { costMicros: '1230000', impressions: '90', clicks: '4', conversions: 1.5, conversionsValue: '250.5' },
              },
              {
                campaign: { id: '222', name: 'Sweden Brand' },
                segments: { date: '2026-03-01' },
                metrics: { costMicros: '4560000', impressions: '10', clicks: '1' },
              },
            ],
          },
        ]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchGoogleCampaignDaily(CREDS, '123', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      campaignId: '111',
      campaignName: 'Norway Brand',
      spend: 123, // 1_230_000 micros / 10_000
      impressions: 90,
      clicks: 4,
      linkClicks: 4,
      conversions: 1.5,
      conversionValue: 25050,
    })
    expect(rows[1]).toMatchObject({ campaignId: '222', spend: 456 })
  })

  it('asks for segments.date in the SELECT, not only the WHERE', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleCampaignDaily(CREDS, '123', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'))

    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { query: string }
    expect(body.query).toContain('SELECT campaign.id, campaign.name, segments.date')
    expect(body.query).toContain("BETWEEN '2026-03-01' AND '2026-03-02'")
  })

  it('splits a long range into chunked requests and concatenates them', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('oauth2')
          ? json({ access_token: 'live-token' })
          : json([{ results: [{ campaign: { id: '1', name: 'C' }, segments: { date: '2026-01-01' }, metrics: { costMicros: '10000' } }] }]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchGoogleCampaignDaily(CREDS, '123', new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'))

    // 365 days / 90 = 5 windows, so 5 searchStream calls and 5 rows back.
    const searchCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('searchStream'))
    expect(searchCalls).toHaveLength(5)
    expect(rows).toHaveLength(5)
  })

  it('skips a row with no campaign id rather than inventing one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json([{ results: [{ segments: { date: '2026-03-01' }, metrics: { costMicros: '10000' } }] }]))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchGoogleCampaignDaily(CREDS, '123', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))).toEqual([])
  })
})
```

Add `fetchGoogleCampaignDaily` and `toCampaignDailyRows` to the import list at the top of the file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/ads/google.test.ts -t "fetchGoogleCampaignDaily"`
Expected: FAIL — `fetchGoogleCampaignDaily is not a function`.

- [ ] **Step 4: Write the implementation**

In `src/lib/ads/google.ts`, add to the imports:

```ts
import { CHUNK_DAYS, chunkRange } from './windows'
```

and add `type CampaignDailyRow` to the existing `./types` import.

Then append:

```ts
/**
 * One row per campaign per day, for a split account.
 *
 * `fetchGoogleBreakdown` keeps segments.date out of its SELECT on purpose — in
 * the SELECT it segments by day, "which is a different table and a far larger
 * one". Here that segmentation is exactly what is wanted, so it goes in both,
 * and the range is fetched in windows to keep any one answer small.
 */
export async function fetchGoogleCampaignDaily(
  creds: GoogleCredentials,
  customerId: string,
  from: Date,
  to: Date,
): Promise<CampaignDailyRow[]> {
  const rows: CampaignDailyRow[] = []
  for (const window of chunkRange(from, to, CHUNK_DAYS)) {
    const query =
      'SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, ' +
      'metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value ' +
      `FROM campaign WHERE segments.date BETWEEN '${day(window.from)}' AND '${day(window.to)}'`
    rows.push(...toCampaignDailyRows(await searchStream(creds, customerId, query)))
  }
  return rows
}

/**
 * Reuses toDailyRows for the metrics so a campaign's numbers can never disagree
 * with the same campaign's numbers elsewhere. A row with no campaign id is
 * skipped for the reason mapBreakdownRow gives: it has nothing to key on.
 */
export function toCampaignDailyRows(results: GoogleResult[]): CampaignDailyRow[] {
  const out: CampaignDailyRow[] = []
  for (const r of results) {
    const id = r.campaign?.id
    if (!id) continue
    const [daily] = toDailyRows([r])
    if (!daily) continue
    out.push({ ...daily, campaignId: id, campaignName: r.campaign?.name || id })
  }
  return out
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/ads/google.test.ts`
Expected: PASS — the four new tests plus every pre-existing one.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ads/types.ts src/lib/ads/google.ts src/lib/ads/google.test.ts
git commit -m "feat: read Google spend one campaign-day at a time"
```

---

### Task 4: Meta campaign-by-day fetcher, with the page-cap guard

**Files:**
- Modify: `src/lib/ads/meta.ts`
- Test: `src/lib/ads/meta.test.ts` (append)

**Interfaces:**
- Consumes: `CampaignDailyRow` (Task 3), `chunkRange`/`CHUNK_DAYS` (Task 2)
- Produces: `fetchMetaCampaignDaily(creds: MetaCredentials, externalId: string, from: Date, to: Date): Promise<CampaignDailyRow[]>`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/ads/meta.test.ts` (match the existing file's helper names; if it has no `json` helper, copy the one from `google.test.ts`):

```ts
describe('fetchMetaCampaignDaily', () => {
  const CREDS_M = { accessToken: 'tok' }

  it('returns one row per campaign per day', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json({
        data: [
          {
            campaign_id: '111',
            campaign_name: 'Norway Brand',
            date_start: '2026-03-01',
            spend: '12.34',
            impressions: '90',
            clicks: '4',
            inline_link_clicks: '3',
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchMetaCampaignDaily(CREDS_M, '999', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      campaignId: '111',
      campaignName: 'Norway Brand',
      spend: 1234,
      impressions: 90,
      clicks: 4,
      linkClicks: 3,
    })
  })

  it('asks for campaign level with a daily increment', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaCampaignDaily(CREDS_M, '999', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'))

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('level=campaign')
    expect(url).toContain('time_increment=1')
    expect(url).toContain('campaign_id')
  })

  it('throws rather than silently returning a short year when a window fills the page cap', async () => {
    // Every page hands back another `next`, so the loop can only stop on the cap.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        json({
          data: [{ campaign_id: '1', campaign_name: 'C', date_start: '2026-03-01', spend: '1.00' }],
          paging: { next: 'https://graph.facebook.com/v25.0/next-page' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchMetaCampaignDaily(CREDS_M, '999', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-05T00:00:00Z')),
    ).rejects.toThrow(/too many rows/i)
  })

  it('splits a long range into chunked requests', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ data: [] })))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaCampaignDaily(CREDS_M, '999', new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'))

    expect(fetchMock).toHaveBeenCalledTimes(5) // 365 days / 90
  })
})
```

Add `fetchMetaCampaignDaily` to the file's import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ads/meta.test.ts -t "fetchMetaCampaignDaily"`
Expected: FAIL — `fetchMetaCampaignDaily is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/lib/ads/meta.ts`, add to the imports:

```ts
import { CHUNK_DAYS, chunkRange } from './windows'
```

and add `type CampaignDailyRow` to the existing `./types` import. Then append:

```ts
/**
 * One row per campaign per day, for a split account.
 *
 * fetchMetaBreakdown warns that asking per day "would return entities x days
 * and page for a very long time". That warning is right, and it is why the
 * range is fetched in windows here. The cap is still real: PAGE_LIMIT 500 x
 * MAX_PAGES 10 = 5000 rows, and the loop below would otherwise stop at the cap
 * and return a short answer that looks complete. Chunking prevents that; the
 * throw makes any future surprise loud instead of silent.
 */
export async function fetchMetaCampaignDaily(
  creds: MetaCredentials,
  externalId: string,
  from: Date,
  to: Date,
): Promise<CampaignDailyRow[]> {
  const rows: CampaignDailyRow[] = []

  for (const window of chunkRange(from, to, CHUNK_DAYS)) {
    const params = new URLSearchParams({
      level: 'campaign',
      time_increment: '1',
      time_range: JSON.stringify({ since: day(window.from), until: day(window.to) }),
      fields:
        'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,action_values',
      limit: String(PAGE_LIMIT),
    })

    let url: string | undefined = `${GRAPH}/act_${externalId}/insights?${params}`
    let page = 0
    for (; url && page < MAX_PAGES; page++) {
      const body: { data?: BreakdownInsightRow[]; paging?: { next?: string } } = await metaJson(
        url,
        creds.accessToken,
      )
      for (const row of body.data ?? []) {
        if (!row.campaign_id) continue // nothing to key on, same as mapBreakdownRow
        const [daily] = parseMetaInsights([row])
        if (!daily) continue
        rows.push({ ...daily, campaignId: row.campaign_id, campaignName: row.campaign_name || row.campaign_id })
      }
      url = body.paging?.next
    }

    // Still a next link after MAX_PAGES means the answer was cut short. Meta
    // does not say so, and a short year that looks complete is worse than an
    // error, so say so here.
    if (url) {
      throw new AdApiError(
        'Too many rows for one request. This account has more campaigns than a 90-day window can carry.',
      )
    }
  }

  return rows
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ads/meta.test.ts`
Expected: PASS — the four new tests plus every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/meta.ts src/lib/ads/meta.test.ts
git commit -m "fix: refuse a truncated campaign fetch instead of reporting a short year"
```

---

### Task 5: Sync stores campaign rows for split accounts

**Files:**
- Modify: `src/lib/ads/sync.ts`
- Test: `src/lib/ads/sync-split.test.ts`

**Interfaces:**
- Consumes: `fetchGoogleCampaignDaily` (Task 3), `fetchMetaCampaignDaily` (Task 4)
- Produces: `syncAdAccount` honours `splitByCampaign`. `AdAccountRow` gains `splitByCampaign: boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ads/sync-split.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

const ROW = (campaignId: string, campaignName: string, spend: number) => ({
  campaignId,
  campaignName,
  date: new Date('2026-03-01T00:00:00Z'),
  spend,
  impressions: 5,
  clicks: 1,
  linkClicks: 1,
  conversions: 0,
  conversionValue: 0,
  videoViews3s: 0,
  thruplays: 0,
  reach: 0,
})

// vi.mock is HOISTED to the top of the module — it must never sit inside
// beforeEach or a describe block. Partial-mock so the rest of ./google is real.
vi.mock('./google', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./google')>()),
  fetchGoogleCampaignDaily: vi.fn(async () => [ROW('c1', 'Norway', 1000), ROW('c2', 'Sweden', 2000)]),
  fetchGoogleDailyBudget: vi.fn(async () => 0),
}))

const { db } = await import('@/lib/db')
const { syncAdAccount } = await import('./sync')
const { encryptSecret } = await import('@/lib/secrets')

const TAG = 'sync-split-test'

afterEach(async () => {
  await db.adAccount.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

/**
 * Real stored credentials rather than a spy on resolveCredentials: spying on an
 * ES module export is unreliable, and the credentials path is the one the sync
 * actually takes for a pasted account.
 */
async function splitAccount() {
  const shop = await db.shop.create({ data: { name: `${TAG} default`, currency: 'NOK' } })
  const account = await db.adAccount.create({
    data: {
      shopId: shop.id,
      provider: 'google',
      externalId: '5550001111',
      name: `${TAG} acct`,
      currency: 'NOK',
      splitByCampaign: true,
      credentials: encryptSecret(
        JSON.stringify({ developerToken: 'd', clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
      ),
    },
  })
  return { shop, account }
}

describe('syncAdAccount for a split account', () => {
  it('writes one AdCampaign and one AdCampaignSpend per campaign', async () => {
    const { account } = await splitAccount()

    const result = await syncAdAccount({ ...account, connection: null })
    expect(result.ok).toBe(true)

    const campaigns = await db.adCampaign.findMany({
      where: { accountId: account.id },
      orderBy: { externalId: 'asc' },
    })
    expect(campaigns.map((c) => c.externalId)).toEqual(['c1', 'c2'])
    expect(campaigns.every((c) => c.shopId === null)).toBe(true)

    const spend = await db.adCampaignSpend.findMany({
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
    })
    expect(spend.map((s) => s.spend).sort((a, b) => a - b)).toEqual([1000, 2000])
  })

  it('writes NO AdSpend row, so the account is never counted twice', async () => {
    const { account } = await splitAccount()

    await syncAdAccount({ ...account, connection: null })

    expect(await db.adSpend.count({ where: { accountId: account.id } })).toBe(0)
  })

  it('refreshes a renamed campaign without unassigning its store', async () => {
    const { shop, account } = await splitAccount()
    await db.adCampaign.create({
      data: { accountId: account.id, externalId: 'c1', name: 'Old name', shopId: shop.id },
    })

    await syncAdAccount({ ...account, connection: null })

    const c1 = await db.adCampaign.findFirst({ where: { accountId: account.id, externalId: 'c1' } })
    expect(c1?.name).toBe('Norway')   // refreshed from the platform
    expect(c1?.shopId).toBe(shop.id)  // the person's choice survived
  })

  it('still writes AdSpend and no campaign rows when the account is not split', async () => {
    const { account } = await splitAccount()
    await db.adAccount.update({ where: { id: account.id }, data: { splitByCampaign: false } })

    await syncAdAccount({ ...account, splitByCampaign: false, connection: null })

    expect(await db.adCampaign.count({ where: { accountId: account.id } })).toBe(0)
  })
})
```

**Note:** the fourth test needs `fetchGoogleDaily` to be mocked too, since a whole account takes that path. Add it to the same `vi.mock` factory above, returning `[]`:
`fetchGoogleDaily: vi.fn(async () => []),`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ads/sync-split.test.ts`
Expected: FAIL — no `AdCampaign` rows written; `splitByCampaign` is not read.

- [ ] **Step 3: Write the implementation**

In `src/lib/ads/sync.ts`, extend `AdAccountRow`:

```ts
export type AdAccountRow = {
  id: string
  provider: string
  externalId: string
  name: string
  credentials: string | null
  loginCustomerId?: string | null
  lastSyncAt: Date | null
  splitByCampaign?: boolean
  connection?: { provider: string; secret: string; expiresAt: Date | null } | null
}
```

Add to the imports:

```ts
import { fetchGoogleCampaignDaily } from './google'
import { fetchMetaCampaignDaily } from './meta'
import type { CampaignDailyRow } from './types'
```

Add these two functions above `syncAdAccount`:

```ts
function fetchCampaignDaily(
  account: AdAccountRow,
  creds: AdCredentials,
  from: Date,
  to: Date,
): Promise<CampaignDailyRow[]> {
  return account.provider === 'meta'
    ? fetchMetaCampaignDaily(creds as MetaCredentials, account.externalId, from, to)
    : fetchGoogleCampaignDaily(creds as GoogleCredentials, account.externalId, from, to)
}

/**
 * Campaign rows for a split account. The AdCampaign row is upserted for its
 * NAME only — shopId is a person's decision and the sync must never touch it,
 * or renaming a campaign in the platform would silently unassign its store.
 */
async function storeCampaignDaily(accountId: string, rows: CampaignDailyRow[]): Promise<number> {
  const idByExternal = new Map<string, string>()
  for (const externalId of new Set(rows.map((r) => r.campaignId))) {
    const name = rows.find((r) => r.campaignId === externalId)!.campaignName
    const campaign = await db.adCampaign.upsert({
      where: { accountId_externalId: { accountId, externalId } },
      create: { accountId, externalId, name },
      update: { name },
    })
    idByExternal.set(externalId, campaign.id)
  }

  await db.$transaction(
    rows.map((r) => {
      const metrics = {
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        linkClicks: r.linkClicks,
        conversions: r.conversions,
        conversionValue: r.conversionValue,
      }
      const campaignId = idByExternal.get(r.campaignId)!
      return db.adCampaignSpend.upsert({
        where: { campaignId_date: { campaignId, date: r.date } },
        create: { campaignId, date: r.date, ...metrics },
        update: metrics,
      })
    }),
  )
  return rows.length
}
```

Then in `syncAdAccount`, replace the single `storeDaily` line:

```ts
    const { from, to } = syncWindow(account.lastSyncAt, now)
    // A split account writes campaign rows and NEVER an AdSpend row. Both would
    // silently double this account's cost everywhere it is read.
    const days = account.splitByCampaign
      ? await storeCampaignDaily(account.id, await fetchCampaignDaily(account, creds, from, to))
      : await storeDaily(account.id, await fetchDaily(account, creds, from, to))
```

Finally, `syncAllAdAccounts` already uses `findMany` with no `select`, so `splitByCampaign` arrives automatically. No change needed there.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ads/sync-split.test.ts src/lib/ads/sync.test.ts`
Expected: PASS — new tests plus every pre-existing sync test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/sync.ts src/lib/ads/sync-split.test.ts
git commit -m "feat: sync a split account one campaign at a time"
```

---

### Task 6: Read-time attribution

**Files:**
- Create: `src/lib/ads/attribution.ts`
- Modify: `src/lib/data/load.ts:158-181`
- Test: `src/lib/ads/attribution.test.ts`

**Scope note (revised after reading the code):** the Marketing page is handled
separately in Task 6B. `buildMarketing` consumes account-keyed rows carrying ten
metric columns and resolves each row's shop *through its account*, so it needs a
different resolver from this one. Do NOT touch `src/app/api/marketing/route.ts`
in this task.

**Interfaces:**
- Consumes: the schema from Task 1
- Produces: `attributedSpend(shopIds: string[], from: Date, to: Date): Promise<AttributedSpend[]>` where `AttributedSpend = { shopId: string; date: Date; spend: number; currency: string }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ads/attribution.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { attributedSpend } from './attribution'

const TAG = 'attribution-test'
const DAY = new Date('2026-03-01T00:00:00Z')

afterEach(async () => {
  await db.adAccount.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

async function shop(name: string) {
  return db.shop.create({ data: { name: `${TAG} ${name}`, currency: 'NOK' } })
}

async function splitAccountWith(defaultShopId: string, campaigns: { externalId: string; shopId: string | null; spend: number }[]) {
  const account = await db.adAccount.create({
    data: { shopId: defaultShopId, provider: 'google', externalId: `${Date.now()}`, name: `${TAG} acct`, currency: 'NOK', splitByCampaign: true },
  })
  for (const c of campaigns) {
    const campaign = await db.adCampaign.create({
      data: { accountId: account.id, externalId: c.externalId, name: `${TAG} ${c.externalId}`, shopId: c.shopId },
    })
    await db.adCampaignSpend.create({
      data: { campaignId: campaign.id, date: DAY, spend: c.spend, impressions: 0, clicks: 0 },
    })
  }
  return account
}

const totalFor = (rows: { shopId: string; spend: number }[], shopId: string) =>
  rows.filter((r) => r.shopId === shopId).reduce((sum, r) => sum + r.spend, 0)

describe('attributedSpend', () => {
  it('sends each campaign to its own store', async () => {
    const [a, b, def] = [await shop('a'), await shop('b'), await shop('default')]
    await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: b.id, spend: 2000 },
    ])

    const rows = await attributedSpend([a.id, b.id, def.id], DAY, DAY)
    expect(totalFor(rows, a.id)).toBe(1000)
    expect(totalFor(rows, b.id)).toBe(2000)
    expect(totalFor(rows, def.id)).toBe(0)
  })

  it('falls back to the account default when a campaign is unassigned', async () => {
    const [a, def] = [await shop('a'), await shop('default')]
    await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: null, spend: 500 },
    ])

    const rows = await attributedSpend([a.id, def.id], DAY, DAY)
    expect(totalFor(rows, a.id)).toBe(1000)
    expect(totalFor(rows, def.id)).toBe(500)
  })

  it('moves history when a campaign is reassigned', async () => {
    const [a, b, def] = [await shop('a'), await shop('b'), await shop('default')]
    const account = await splitAccountWith(def.id, [{ externalId: 'c1', shopId: a.id, spend: 1000 }])

    expect(totalFor(await attributedSpend([a.id, b.id, def.id], DAY, DAY), a.id)).toBe(1000)

    await db.adCampaign.updateMany({ where: { accountId: account.id, externalId: 'c1' }, data: { shopId: b.id } })

    const after = await attributedSpend([a.id, b.id, def.id], DAY, DAY)
    expect(totalFor(after, a.id)).toBe(0)
    expect(totalFor(after, b.id)).toBe(1000) // the same past day, now on B
  })

  it('includes a campaign whose store is selected even when the account default is not', async () => {
    const [a, def] = [await shop('a'), await shop('default')]
    await splitAccountWith(def.id, [{ externalId: 'c1', shopId: a.id, spend: 1000 }])

    // Only shop A is selected. The account's own shopId is `def`, which is not.
    const rows = await attributedSpend([a.id], DAY, DAY)
    expect(totalFor(rows, a.id)).toBe(1000)
  })

  it('reads a whole account from AdSpend, unchanged', async () => {
    const s = await shop('whole')
    const account = await db.adAccount.create({
      data: { shopId: s.id, provider: 'meta', externalId: '4443332221', name: `${TAG} whole`, currency: 'NOK' },
    })
    await db.adSpend.create({
      data: { accountId: account.id, date: DAY, spend: 777, impressions: 0, clicks: 0 },
    })

    expect(totalFor(await attributedSpend([s.id], DAY, DAY), s.id)).toBe(777)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ads/attribution.test.ts`
Expected: FAIL — cannot resolve `./attribution`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ads/attribution.ts`:

```ts
import { db } from '../db'
import { utcDay } from '../dates'

/**
 * Stored ad spend, resolved to the shop that actually paid for it.
 *
 * `currency` is the AD ACCOUNT's, not the shop's — a Norwegian store can run a
 * EUR ad account — so the caller converts at read time like everything else.
 */
export type AttributedSpend = {
  shopId: string
  date: Date
  spend: number
  currency: string
}

/**
 * One implementation, two callers: the metrics loader and /api/marketing. Two
 * copies would drift and the Dashboard and the Marketing page would disagree
 * about the same money.
 *
 * A whole account reads AdSpend and takes the account's own shopId. A split
 * account reads AdCampaignSpend and takes the campaign's shopId, falling back
 * to the account's when the campaign has not been assigned yet. Nothing is ever
 * read from both tables, so no account can be counted twice.
 */
export async function attributedSpend(
  shopIds: string[],
  from: Date,
  to: Date,
): Promise<AttributedSpend[]> {
  if (!shopIds.length) return []
  const date = { gte: utcDay(from), lte: utcDay(to) }

  // --- whole accounts: exactly the query that lived in load.ts ---
  const wholeAccounts = await db.adAccount.findMany({
    where: { active: true, splitByCampaign: false, shopId: { in: shopIds } },
    select: { id: true, shopId: true, currency: true },
  })
  const wholeById = new Map(wholeAccounts.map((a) => [a.id, a]))
  const wholeRows = wholeAccounts.length
    ? await db.adSpend.findMany({
        where: { accountId: { in: wholeAccounts.map((a) => a.id) }, date },
        select: { accountId: true, date: true, spend: true },
        orderBy: { date: 'asc' },
      })
    : []

  // --- split accounts ---
  // Selected on where their CAMPAIGNS land, not on the account's own shopId: an
  // account whose default store sits outside the selection can still hold
  // campaigns that belong inside it. Filtering on the account would drop them.
  const campaigns = await db.adCampaign.findMany({
    where: {
      account: { active: true, splitByCampaign: true },
      OR: [
        { shopId: { in: shopIds } },
        { shopId: null, account: { shopId: { in: shopIds } } },
      ],
    },
    select: { id: true, shopId: true, account: { select: { shopId: true, currency: true } } },
  })
  const campaignById = new Map(campaigns.map((c) => [c.id, c]))
  const campaignRows = campaigns.length
    ? await db.adCampaignSpend.findMany({
        where: { campaignId: { in: campaigns.map((c) => c.id) }, date },
        select: { campaignId: true, date: true, spend: true },
        orderBy: { date: 'asc' },
      })
    : []

  return [
    ...wholeRows.map((r) => {
      const account = wholeById.get(r.accountId)!
      return { shopId: account.shopId, date: r.date, spend: r.spend, currency: account.currency }
    }),
    ...campaignRows.map((r) => {
      const campaign = campaignById.get(r.campaignId)!
      return {
        shopId: campaign.shopId ?? campaign.account.shopId,
        date: r.date,
        spend: r.spend,
        currency: campaign.account.currency,
      }
    }),
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ads/attribution.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Point `load.ts` at the resolver**

In `src/lib/data/load.ts`, add the import:

```ts
import { attributedSpend } from '../ads/attribution'
```

Replace the whole block from `const adAccounts = await db.adAccount.findMany({` down to the closing `})` of the `adSpend` map (currently lines 161-181) with:

```ts
  const adSpend: EngineAdSpend[] = await attributedSpend(shopIds, from, to)
```

`AttributedSpend` and `EngineAdSpend` have identical shapes, so no mapping is needed. Delete the now-unused `accountById` and `spendRows` locals.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS — every pre-existing test included. If `engine.test.ts` or the marketing route tests fail, the resolver's output shape does not match what they expect; fix the resolver, not the tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ads/attribution.ts src/lib/ads/attribution.test.ts src/lib/data/load.ts
git commit -m "feat: attribute ad spend to the store its campaign advertises for"
```

---

### Task 6B: The Marketing page must not zero out split accounts

**Files:**
- Modify: `prisma/schema.prisma` (two columns on `AdCampaignSpend`)
- Modify: `src/lib/ads/sync.ts` (carry the two new columns)
- Modify: `src/lib/ads/attribution.ts` (second resolver)
- Modify: `src/lib/ads/marketing.ts` (`SpendRow.shopId` override)
- Modify: `src/app/api/marketing/route.ts`
- Test: `src/lib/ads/attribution.test.ts`, `src/lib/ads/marketing.test.ts`

**Interfaces:**
- Consumes: `attributedSpend` and the campaign schema
- Produces: `accountSpendRows(accountIds: string[], from: Date, to: Date): Promise<SpendRow[]>` where `SpendRow` gains `shopId?: string`

**Why this task exists.** `buildMarketing` takes rows keyed by `accountId` carrying ten metric columns, and resolves each row's shop *through its account* (`marketing.ts:114`, `accountById`). Task 5 makes a split account write no `AdSpend` rows at all. So without this task the Marketing page shows **zero spend for exactly the accounts this feature is for**, while the Dashboard shows the real figure — the two screens disagreeing about the same money, which is the specific failure the shared-resolver rule exists to prevent.

- [ ] **Step 1: Add the two missing metric columns**

`AdCampaignSpend` omitted `videoViews3s` and `thruplays`. That was right when only profit consumed it; the Marketing page displays both for Meta, so a split Meta account would silently read zero. Add to `AdCampaignSpend` in `prisma/schema.prisma`, after `conversionValue`:

```prisma
  videoViews3s    Int      @default(0)
  thruplays       Int      @default(0)
```

`reach` stays out: it does not sum across days, which is why `AdSpend` documents it as non-additive.

Run: `npx prisma db push && npx prisma generate`

- [ ] **Step 2: Carry them through the sync**

In `storeCampaignDaily` in `src/lib/ads/sync.ts`, add both to the `metrics` object so they are written and updated like the rest:

```ts
        videoViews3s: r.videoViews3s,
        thruplays: r.thruplays,
```

- [ ] **Step 3: Write the failing tests**

Append to `src/lib/ads/attribution.test.ts`:

```ts
describe('accountSpendRows', () => {
  it('returns AdSpend rows unchanged for a whole account', async () => {
    const s = await shop('whole-ms')
    const account = await db.adAccount.create({
      data: { shopId: s.id, provider: 'meta', externalId: `${TAG}-5551110000`, name: `${TAG} whole`, currency: 'NOK' },
    })
    await db.adSpend.create({
      data: {
        accountId: account.id, date: DAY, spend: 500, impressions: 10, clicks: 2,
        linkClicks: 1, conversions: 1, conversionValue: 250, videoViews3s: 7, thruplays: 3,
      },
    })

    const rows = await accountSpendRows([account.id], DAY, DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ accountId: account.id, spend: 500, videoViews3s: 7, thruplays: 3 })
    expect(rows[0].shopId).toBeUndefined() // no override: buildMarketing uses the account's own shop
  })

  it('rolls a split account up per shop, carrying a shopId override', async () => {
    const [a, b, def] = [await shop('ms-a'), await shop('ms-b'), await shop('ms-def')]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: b.id, spend: 2000 },
    ])

    const rows = await accountSpendRows([account.id], DAY, DAY)
    expect(rows).toHaveLength(2) // one per shop, not one per campaign
    const byShop = Object.fromEntries(rows.map((r) => [r.shopId, r.spend]))
    expect(byShop[a.id]).toBe(1000)
    expect(byShop[b.id]).toBe(2000)
  })

  it('sums several campaigns that share a shop into one row', async () => {
    const [a, def] = [await shop('ms-sum'), await shop('ms-sumdef')]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: a.id, spend: 250 },
    ])

    const rows = await accountSpendRows([account.id], DAY, DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].spend).toBe(1250)
  })

  it('never returns a split account total that differs from its campaign total', async () => {
    const [a, def] = [await shop('ms-tot'), await shop('ms-totdef')]
    const account = await splitAccountWith(def.id, [
      { externalId: 'c1', shopId: a.id, spend: 1000 },
      { externalId: 'c2', shopId: null, spend: 750 },
    ])

    const rows = await accountSpendRows([account.id], DAY, DAY)
    expect(rows.reduce((sum, r) => sum + r.spend, 0)).toBe(1750) // nothing lost, nothing doubled
  })
})
```

Append to `src/lib/ads/marketing.test.ts` (match that file's existing fixture helpers):

```ts
it('honours a spend row shopId override instead of the account shop', () => {
  const accounts = [{ id: 'acct', shopId: 'default-shop', provider: 'google', currency: 'NOK', dailyBudget: null }]
  const spend = [
    { accountId: 'acct', shopId: 'other-shop', date: new Date('2026-03-01T00:00:00Z'), spend: 1000,
      impressions: 0, clicks: 0, linkClicks: 0, conversions: 0, conversionValue: 0, videoViews3s: 0, thruplays: 0 },
  ]
  const result = buildMarketing({ accounts, spend, engine: ENGINE, series: [], rates: RATES, to: new Date('2026-03-01T00:00:00Z') })

  expect(result.shops.find((s) => s.shopId === 'other-shop')?.spend).toBe(1000)
  expect(result.shops.find((s) => s.shopId === 'default-shop')?.spend ?? 0).toBe(0)
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/lib/ads/attribution.test.ts src/lib/ads/marketing.test.ts`
Expected: FAIL — `accountSpendRows` is not a function; the override test puts spend on the wrong shop.

- [ ] **Step 5: Implement**

In `src/lib/ads/marketing.ts`, add the optional field to `SpendRow`:

```ts
export type SpendRow = {
  accountId: string
  /** Set only by a split account: the shop this slice of the account's spend
   *  belongs to, overriding the account's own. Absent means "use the account's". */
  shopId?: string
  date: Date
  // ...existing fields unchanged
}
```

and inside `buildMarketing`, wherever a row's shop is currently taken as `account.shopId`, take `row.shopId ?? account.shopId` instead. Change nothing else — budgets still come from the accounts, not the rows.

In `src/lib/ads/attribution.ts`, add:

```ts
/**
 * Account-keyed rows for the Marketing page, which groups by account and shows
 * ten metric columns.
 *
 * A whole account's AdSpend rows pass through untouched. A split account has no
 * AdSpend rows at all, so its campaign rows are rolled up per (date, resolved
 * shop) and carry `shopId` so buildMarketing attributes them the same way the
 * Dashboard does. Without this the Marketing page would show zero for exactly
 * the accounts this feature exists for.
 */
export async function accountSpendRows(
  accountIds: string[],
  from: Date,
  to: Date,
): Promise<SpendRow[]> {
  if (!accountIds.length) return []
  const date = { gte: utcDay(from), lte: utcDay(to) }

  const [whole, campaigns] = await Promise.all([
    db.adSpend.findMany({
      where: { accountId: { in: accountIds }, date },
      select: {
        accountId: true, date: true, spend: true, impressions: true, clicks: true,
        linkClicks: true, conversions: true, conversionValue: true,
        videoViews3s: true, thruplays: true,
      },
    }),
    db.adCampaign.findMany({
      where: { accountId: { in: accountIds }, account: { splitByCampaign: true } },
      select: { id: true, shopId: true, accountId: true, account: { select: { shopId: true } } },
    }),
  ])

  const campaignById = new Map(campaigns.map((c) => [c.id, c]))
  const campaignRows = campaigns.length
    ? await db.adCampaignSpend.findMany({
        where: { campaignId: { in: campaigns.map((c) => c.id) }, date },
      })
    : []

  // Rolled up per account, day and resolved shop — the Marketing page groups by
  // account, so one row per campaign would multiply its row count for nothing.
  const rolled = new Map<string, SpendRow>()
  for (const r of campaignRows) {
    const campaign = campaignById.get(r.campaignId)!
    const shopId = campaign.shopId ?? campaign.account.shopId
    const key = `${campaign.accountId}|${shopId}|${r.date.toISOString()}`
    const existing = rolled.get(key)
    if (existing) {
      existing.spend += r.spend
      existing.impressions += r.impressions
      existing.clicks += r.clicks
      existing.linkClicks += r.linkClicks
      existing.conversions += r.conversions
      existing.conversionValue += r.conversionValue
      existing.videoViews3s += r.videoViews3s
      existing.thruplays += r.thruplays
    } else {
      rolled.set(key, {
        accountId: campaign.accountId,
        shopId,
        date: r.date,
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        linkClicks: r.linkClicks,
        conversions: r.conversions,
        conversionValue: r.conversionValue,
        videoViews3s: r.videoViews3s,
        thruplays: r.thruplays,
      })
    }
  }

  return [...whole, ...rolled.values()]
}
```

Import `type SpendRow` from `./marketing` at the top of `attribution.ts`.

In `src/app/api/marketing/route.ts`, replace the whole `const spend = await db.adSpend.findMany({...})` block (lines 44-61) with:

```ts
    const spend = await accountSpendRows(accounts.map((a) => a.id), from, to)
```

importing `accountSpendRows` from `@/lib/ads/attribution`. Remove the now-unused `utcDay` import if nothing else in the file uses it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/ads src/app/api/marketing`
Expected: PASS, including every pre-existing marketing test.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma src/lib/ads/sync.ts src/lib/ads/attribution.ts src/lib/ads/attribution.test.ts src/lib/ads/marketing.ts src/lib/ads/marketing.test.ts src/app/api/marketing/route.ts
git commit -m "fix: keep split accounts visible on the Marketing page"
```

---

### Task 7: Campaigns API

**Files:**
- Create: `src/app/api/ad-accounts/[id]/campaigns/route.ts`
- Test: `src/app/api/ad-accounts/campaigns.test.ts`

**Interfaces:**
- Consumes: the schema from Task 1
- Produces: `GET /api/ad-accounts/{id}/campaigns` → `{ splitByCampaign: boolean; defaultShopId: string; campaigns: { id, externalId, name, shopId }[] }`; `PATCH` accepts `{ splitByCampaign?: boolean; assignments?: { campaignId: string; shopId: string | null }[] }`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/ad-accounts/campaigns.test.ts`. The auth setup below is copied from the working pattern in `src/app/api/ads/connections/meta/route.test.ts`: mock `next/headers`, sign a real session into a mutable cookie holder, then call the route function directly. **`vi.mock` must come before the dynamic `await import` of the route**, which is why the imports are written this way.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, PATCH } = await import('@/app/api/ad-accounts/[id]/campaigns/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const TAG = 'campaigns-api-test'
const ME = 'campaigns-api-me@example.local'

async function wipe() {
  await db.adAccount.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.user.deleteMany({ where: { email: ME } })
}

beforeEach(async () => {
  await wipe()
  const me = await db.user.create({ data: { email: ME, passwordHash: 'x', role: 'ADMIN' } })
  cookieValue.current = await signSession({
    userId: me.id,
    email: ME,
    role: 'ADMIN',
    ambassadorId: null,
  })
})

afterEach(wipe)

/** Drop the session so the guard sees an anonymous caller. */
const asAnonymous = () => {
  cookieValue.current = undefined
}

async function fixture() {
  const shop = await db.shop.create({ data: { name: `${TAG} shop`, currency: 'NOK' } })
  const other = await db.shop.create({ data: { name: `${TAG} other`, currency: 'NOK' } })
  const account = await db.adAccount.create({
    data: { shopId: shop.id, provider: 'google', externalId: '7770001111', name: `${TAG} acct`, currency: 'NOK', splitByCampaign: true },
  })
  const campaign = await db.adCampaign.create({
    data: { accountId: account.id, externalId: 'c1', name: `${TAG} c1` },
  })
  return { shop, other, account, campaign }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const patch = (accountId: string, body: unknown) =>
  PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), params(accountId))

describe('campaigns API', () => {
  it('refuses anyone who is not an admin', async () => {
    const { account } = await fixture()
    asAnonymous()
    expect((await GET(new Request('http://x'), params(account.id))).status).toBe(403)
  })

  it('lists the account campaigns with their assignment', async () => {
    const { account, campaign } = await fixture()
    const body = await (await GET(new Request('http://x'), params(account.id))).json()
    expect(body.splitByCampaign).toBe(true)
    expect(body.campaigns).toEqual([
      expect.objectContaining({ id: campaign.id, externalId: 'c1', shopId: null }),
    ])
  })

  it('assigns a campaign to a shop', async () => {
    const { account, campaign, other } = await fixture()
    const res = await patch(account.id, { assignments: [{ campaignId: campaign.id, shopId: other.id }] })
    expect(res.status).toBe(200)
    expect((await db.adCampaign.findUnique({ where: { id: campaign.id } }))?.shopId).toBe(other.id)
  })

  it('refuses a campaign that belongs to another account', async () => {
    const { account } = await fixture()
    const foreignShop = await db.shop.create({ data: { name: `${TAG} f`, currency: 'NOK' } })
    const foreignAccount = await db.adAccount.create({
      data: { shopId: foreignShop.id, provider: 'meta', externalId: '1230009999', name: `${TAG} f`, currency: 'NOK' },
    })
    const foreign = await db.adCampaign.create({
      data: { accountId: foreignAccount.id, externalId: 'x', name: `${TAG} x` },
    })

    const res = await patch(account.id, { assignments: [{ campaignId: foreign.id, shopId: foreignShop.id }] })
    expect(res.status).toBe(400)
    expect((await db.adCampaign.findUnique({ where: { id: foreign.id } }))?.shopId).toBeNull()
  })

  it('refuses an unknown shop id', async () => {
    const { account, campaign } = await fixture()
    const res = await patch(account.id, { assignments: [{ campaignId: campaign.id, shopId: 'no-such-shop' }] })
    expect(res.status).toBe(400)
  })

  it('clears lastSyncAt when the account is switched to split, so it backfills', async () => {
    const { account } = await fixture()
    await db.adAccount.update({ where: { id: account.id }, data: { lastSyncAt: new Date() } })

    expect((await patch(account.id, { splitByCampaign: true })).status).toBe(200)
    expect((await db.adAccount.findUnique({ where: { id: account.id } }))?.lastSyncAt).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/ad-accounts/campaigns.test.ts`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Write the route**

Create `src/app/api/ad-accounts/[id]/campaigns/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

/** Which store each campaign advertises for. Admin-only: it moves real money
 *  between stores' profit figures. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const account = await db.adAccount.findUnique({
      where: { id },
      select: { shopId: true, splitByCampaign: true },
    })
    if (!account) return NextResponse.json({ error: 'No such account' }, { status: 404 })

    const campaigns = await db.adCampaign.findMany({
      where: { accountId: id },
      select: { id: true, externalId: true, name: true, shopId: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({
      splitByCampaign: account.splitByCampaign,
      defaultShopId: account.shopId,
      campaigns,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load campaigns' }, { status: 500 })
  }
}

const Body = z.object({
  splitByCampaign: z.boolean().optional(),
  assignments: z
    .array(z.object({ campaignId: z.string().min(1), shopId: z.string().min(1).nullable() }))
    .optional(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    const assignments = parsed.data.assignments ?? []
    if (assignments.length) {
      // Every campaign must belong to THIS account. A hand-typed id must never
      // reassign another account's campaign.
      const owned = await db.adCampaign.findMany({
        where: { accountId: id, id: { in: assignments.map((a) => a.campaignId) } },
        select: { id: true },
      })
      if (owned.length !== assignments.length) {
        return NextResponse.json({ error: 'That campaign is not on this account.' }, { status: 400 })
      }

      const shopIds = [...new Set(assignments.map((a) => a.shopId).filter((s): s is string => s !== null))]
      if (shopIds.length) {
        const found = await db.shop.count({ where: { id: { in: shopIds } } })
        if (found !== shopIds.length) {
          return NextResponse.json({ error: 'No such shop' }, { status: 400 })
        }
      }

      await db.$transaction(
        assignments.map((a) =>
          db.adCampaign.update({ where: { id: a.campaignId }, data: { shopId: a.shopId } }),
        ),
      )
    }

    if (parsed.data.splitByCampaign !== undefined) {
      await db.adAccount.update({
        where: { id },
        data: { splitByCampaign: parsed.data.splitByCampaign, lastSyncAt: null },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the assignments' }, { status: 500 })
  }
}
```

**Note the `lastSyncAt: null` on the toggle.** Flipping an account to split makes its stored `AdSpend` rows unreadable to the resolver, so the account must backfill campaign rows on the next sync. Clearing `lastSyncAt` is what makes `syncWindow` reach back the full year again.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/ad-accounts/campaigns.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ad-accounts/[id]/campaigns/route.ts src/app/api/ad-accounts/campaigns.test.ts
git commit -m "feat: let an admin say which store each campaign advertises for"
```

---

### Task 8: Campaigns modal

**Files:**
- Modify: `src/app/settings/ad-accounts/AdAccountsClient.tsx`
- Test: `src/app/settings/ad-accounts/CampaignsModal.test.tsx`

**Interfaces:**
- Consumes: the API from Task 7
- Produces: a `Campaigns` action per account row

- [ ] **Step 1: Write the failing test**

Create `src/app/settings/ad-accounts/CampaignsModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CampaignsModal } from './CampaignsModal'

// NOTE: this repo does NOT have @testing-library/user-event installed. Every
// existing DOM test drives the UI with fireEvent (see B2bClient.test.tsx).
// Do not add the dependency for this.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SHOPS = [
  { id: 's1', name: 'Panetti Norway' },
  { id: 's2', name: 'Panetti Sweden' },
]

const payload = {
  splitByCampaign: true,
  defaultShopId: 's1',
  campaigns: [
    { id: 'a', externalId: 'c1', name: 'Norway Brand', shopId: 's1' },
    { id: 'b', externalId: 'c2', name: 'Sweden Brand', shopId: null },
  ],
}

function stubFetch(saved: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        saved.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify(payload), { status: 200 })
    }),
  )
}

describe('CampaignsModal', () => {
  it('lists every campaign with its current store', async () => {
    stubFetch()
    render(<CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />)

    expect(await screen.findByText('Norway Brand')).toBeTruthy()
    expect(screen.getByText('Sweden Brand')).toBeTruthy()
  })

  it('shows an unassigned campaign as using the account store', async () => {
    stubFetch()
    render(<CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />)

    const select = (await screen.findByLabelText('Store for Sweden Brand')) as HTMLSelectElement
    expect(select.value).toBe('') // '' is the "Use the account's store" option
  })

  it('saves the assignments that were changed', async () => {
    const saved: unknown[] = []
    stubFetch(saved)
    render(<CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />)

    const select = (await screen.findByLabelText('Store for Sweden Brand')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 's2' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({
      assignments: expect.arrayContaining([{ campaignId: 'b', shopId: 's2' }]),
    })
  })

  it('says so when the account has no campaigns yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ splitByCampaign: false, defaultShopId: 's1', campaigns: [] }), { status: 200 }),
    ))
    render(<CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />)

    expect(await screen.findByText(/no campaigns yet/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/settings/ad-accounts/CampaignsModal.test.tsx`
Expected: FAIL — cannot resolve `./CampaignsModal`.

- [ ] **Step 3: Write the component**

Create `src/app/settings/ad-accounts/CampaignsModal.tsx`. Follow `PickerModal` in `AdAccountsClient.tsx` for the shell, spacing and button classes — the "list things from a platform and assign each to a shop" pattern already exists and must not be invented twice.

Requirements the tests pin down:
- Fetches `GET /api/ad-accounts/{accountId}/campaigns` on mount, aborting on unmount.
- Each row renders the campaign `name` and a `<select>` with `aria-label={`Store for ${name}`}`.
- The select's first option has `value=""` and the text `Use the account's store`, followed by one option per shop. An unassigned campaign selects `""`.
- A `Split this account by campaign` checkbox bound to `splitByCampaign`.
- **Save** sends a single `PATCH` with `{ splitByCampaign, assignments }`, mapping `""` back to `null`.
- Empty list renders `No campaigns yet. Press Sync now, then come back.`
- On success calls `onSaved()`.

Then in `AdAccountsClient.tsx`:
- Add `const [campaignsFor, setCampaignsFor] = useState<string | null>(null)`.
- Add a `Campaigns` button in each row's Action cell, beside `Edit`, calling `setCampaignsFor(a.id)`.
- Render `{campaignsFor && <CampaignsModal accountId={campaignsFor} shops={shops} onClose={() => setCampaignsFor(null)} onSaved={() => { setCampaignsFor(null); router.refresh() }} />}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/settings/ad-accounts/CampaignsModal.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Run every gate**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

Expected: all tests pass, `tsc` clean. Lint has 8 pre-existing errors on this repo — confirm the count has not risen and that none are in files this plan touched.

- [ ] **Step 6: Commit**

```bash
git add src/app/settings/ad-accounts/CampaignsModal.tsx src/app/settings/ad-accounts/CampaignsModal.test.tsx src/app/settings/ad-accounts/AdAccountsClient.tsx
git commit -m "feat: assign campaigns to stores from the ad accounts page"
```

---

## Self-review notes

**Spec coverage.** Schema → Task 1. Chunked windows and the page-cap guard → Tasks 2 and 4. Google and Meta campaign×day fetchers → Tasks 3 and 4. Sync branch and the never-both rule → Task 5. Read-time attribution, the fallback, history re-attribution and the `load.ts` selection trap → Task 6. Assignment API → Task 7. UI → Task 8.

**One spec item deliberately deferred:** the Marketing page's "N campaigns need a store" banner. It depends on the resolver and the API from Tasks 6 and 7 and is a display-only addition; it is a follow-up, not a gap in the mechanism. Everything that affects a number is covered here.

**Type consistency.** `CampaignDailyRow` is defined once in Task 3 and consumed by name in Tasks 4 and 5. `AttributedSpend` is defined in Task 6 and matches `EngineAdSpend` field for field, which is why Task 6 Step 5 needs no mapping function.
