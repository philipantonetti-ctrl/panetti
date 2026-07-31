# Campaign Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the single-store Marketing view, show a store's campaigns and let each expand into its ad sets and then its ads, for Meta or Google, with a switcher between them.

**Architecture:** Read live from the platform, store nothing. One route resolves
the shop's ad accounts through the existing credential path and calls a
per-platform driver; both drivers return one row shape; the table derives ROAS
and CTR once at render.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 6 + PostgreSQL, Vitest
(jsdom component / DB-backed route / stubbed-fetch unit), Playwright.

**Spec:** `docs/superpowers/specs/2026-07-31-campaign-breakdown-design.md`

## Global Constraints

- **Never run `git stash`, `git checkout -- `, `git reset`, `git clean`, or `git restore`.** Another session shares this working directory; those commands silently destroy its work.
- **Edit files with the Edit/Write tools only.** PowerShell 5.1 `Get-Content`/`Set-Content` corrupts UTF-8 in this repo and these files contain `…`, `—` and `ø`.
- **Never point anything at the live database.** `DATABASE_URL` is a local Postgres. Neon is production.
- **If a suite goes red in the hundreds with no code change**, another checkout ran `prisma db push` and dropped columns. Introspect with `npx prisma db pull --print` before debugging, then `npx prisma db push` from here.
- **Nothing in this plan adds a table, a column or a migration.** If a task seems to need one, stop and report — the design is deliberately storage-free.
- **No caching layer either.** An in-process cache was considered and rejected: on Vercel each request may land on a fresh instance, so a `Map` would mostly miss while still adding a TTL and a staleness question. One request per expansion is cheap. If latency ever grates the answer is Next's data cache, added deliberately and measured.
- **Read only.** No task may request `ads_management`, write to a platform, or add a control that mutates a campaign.
- Money is **minor units, integer, in the ad account's own currency**, matching the rest of `src/lib/ads`. Google returns micros and converts at the boundary.
- Run tests with `npx vitest run <path>`. Type-check `npx tsc --noEmit`. Lint `npx eslint <paths>`. E2E `npx playwright test`.
- Comments explain **why**, not what. Match the surrounding voice — `src/lib/ads/meta.ts` is the reference.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/ads/types.ts` | `BreakdownLevel`, `BreakdownEntry` | 1 |
| `src/lib/ads/meta.ts` | `fetchMetaBreakdown`; shared purchase extraction | 1 |
| `src/lib/ads/meta.test.ts` | URL, level, parent object, mapping | 1 |
| `src/lib/ads/google.ts` | `fetchGoogleBreakdown` | 2 |
| `src/lib/ads/google.test.ts` | GAQL string, micros, mapping | 2 |
| `src/lib/ads/breakdown.ts` | picks the driver, enriches with our account | 3 |
| `src/app/api/marketing/breakdown/route.ts` | the endpoint | 3 |
| `src/app/api/marketing/breakdown/route.test.ts` | gate, scoping, provider, errors | 3 |
| `src/app/marketing/BreakdownTable.tsx` | expandable table | 4 |
| `src/app/marketing/BreakdownTable.test.tsx` | expansion, labels, states | 4 |
| `src/app/marketing/MarketingClient.tsx` | switcher, single-store gate | 5 |
| `e2e/marketing-breakdown.spec.ts` | end to end | 6 |

Tasks build in order. Tasks 1 and 2 are independent of each other.

---

### Task 1: The Meta driver

Meta lets insights hang off any object id, so drilling needs no filter syntax:
campaigns come off `act_{id}`, ad sets off a campaign id, ads off an ad set id.
Aggregated over the range — no `time_increment` — each response is one row per
entity.

`parseMetaInsights` cannot be reused: it keys on `date_start` and returns a
dated row. But the purchase extraction inside it **must** be shared, or
"purchases" would mean one thing on the Marketing page and another in this
table.

**Files:**
- Modify: `src/lib/ads/types.ts`
- Modify: `src/lib/ads/meta.ts`
- Test: `src/lib/ads/meta.test.ts`

**Interfaces:**
- Consumes: `metaJson`, `day`, `action`, `count`, `toMinor` — all already in `meta.ts`
- Produces:
  - `BreakdownLevel = 'campaign' | 'adset' | 'ad'`
  - `BreakdownEntry` (below)
  - `fetchMetaBreakdown(creds, target, from, to): Promise<BreakdownEntry[]>`

- [ ] **Step 1: Add the shared types**

In `src/lib/ads/types.ts`:

```ts
/**
 * The three levels both platforms happen to share. Meta calls the middle one an
 * ad set and Google an ad group; the API speaks one vocabulary and the screen
 * translates, so a client never reads the wrong platform's word.
 */
export type BreakdownLevel = 'campaign' | 'adset' | 'ad'

/**
 * What a platform driver returns: the platform's own figures for one entity and
 * nothing of ours. The route adds which of OUR accounts it came from.
 *
 * No ROAS and no CTR. Both are derived once, at render, from these numbers —
 * carrying a derived figure alongside its inputs is how two numbers on one
 * screen come to disagree.
 */
export type BreakdownEntry = {
  id: string
  name: string
  spend: number // minor units, the ad account's own currency
  purchases: number
  purchaseValue: number // minor units
  impressions: number
  clicks: number
}
```

- [ ] **Step 2: Write the failing tests**

Append to `src/lib/ads/meta.test.ts`:

```ts
describe('fetchMetaBreakdown', () => {
  const CREDS = { accessToken: 'tok' }
  const FROM = new Date('2026-07-01T00:00:00Z')
  const TO = new Date('2026-07-31T00:00:00Z')

  const page = (rows: unknown[]) =>
    new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  it('hangs campaign insights off the ad account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaBreakdown(CREDS, { level: 'campaign', accountExternalId: '123' }, FROM, TO)

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/act_123/insights')
    expect(url).toContain('level=campaign')
    expect(url).toContain('campaign_id')
    // Aggregated over the range: a per-day breakdown would be a different table.
    expect(url).not.toContain('time_increment')
  })

  it('hangs ad sets off the campaign they belong to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaBreakdown(
      CREDS,
      { level: 'adset', accountExternalId: '123', parentId: '777' },
      FROM,
      TO,
    )

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/777/insights')
    expect(url).toContain('level=adset')
    expect(url).not.toContain('act_123')
  })

  it('hangs ads off the ad set they belong to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaBreakdown(
      CREDS,
      { level: 'ad', accountExternalId: '123', parentId: '888' },
      FROM,
      TO,
    )

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/888/insights')
    // Read the parsed value, not a substring: 'level=ad' is a prefix of
    // 'level=adset', so `toContain` here would pass for the wrong level and the
    // test would exist without being able to fail.
    expect(new URL(url).searchParams.get('level')).toBe('ad')
  })

  it('asks for exactly the range it was given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaBreakdown(CREDS, { level: 'campaign', accountExternalId: '123' }, FROM, TO)

    const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]))
    expect(url).toContain('"since":"2026-07-01"')
    expect(url).toContain('"until":"2026-07-31"')
  })

  it('maps a row, taking purchases the same way the daily sync does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        page([
          {
            campaign_id: '777',
            campaign_name: 'KS - Pizzetta Pro UGC',
            spend: '2116.61',
            impressions: '12000',
            clicks: '216',
            actions: [{ action_type: 'omni_purchase', value: '284' }],
            action_values: [{ action_type: 'omni_purchase', value: '13482.79' }],
          },
        ]),
      ),
    )

    const [row] = await fetchMetaBreakdown(
      CREDS,
      { level: 'campaign', accountExternalId: '123' },
      FROM,
      TO,
    )

    expect(row).toEqual({
      id: '777',
      name: 'KS - Pizzetta Pro UGC',
      spend: 211661,
      purchases: 284,
      purchaseValue: 1348279,
      impressions: 12000,
      clicks: 216,
    })
  })

  // Older accounts report `purchase` where newer ones report `omni_purchase`.
  // The daily sync already handles both; this must not diverge from it.
  it('falls back to the older purchase action, as the daily sync does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        page([
          {
            campaign_id: '1',
            campaign_name: 'Old',
            spend: '10.00',
            actions: [{ action_type: 'purchase', value: '3' }],
            action_values: [{ action_type: 'purchase', value: '99.00' }],
          },
        ]),
      ),
    )

    const [row] = await fetchMetaBreakdown(
      CREDS,
      { level: 'campaign', accountExternalId: '1' },
      FROM,
      TO,
    )
    expect(row.purchases).toBe(3)
    expect(row.purchaseValue).toBe(9900)
  })

  it('follows paging', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ campaign_id: '1', campaign_name: 'A', spend: '1.00' }],
            paging: { next: 'https://graph.facebook.com/v25.0/next-page' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(page([{ campaign_id: '2', campaign_name: 'B', spend: '2.00' }]))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchMetaBreakdown(
      CREDS,
      { level: 'campaign', accountExternalId: '1' },
      FROM,
      TO,
    )
    expect(rows.map((r) => r.name)).toEqual(['A', 'B'])
  })

  it('turns a refusal into the platform’s own words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid OAuth token' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(
      fetchMetaBreakdown(CREDS, { level: 'campaign', accountExternalId: '1' }, FROM, TO),
    ).rejects.toThrow(/Invalid OAuth token/)
  })
})
```

Add `fetchMetaBreakdown` to the file's import from `./meta`.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/lib/ads/meta.test.ts -t "fetchMetaBreakdown"`
Expected: FAIL — `fetchMetaBreakdown` is not exported.

- [ ] **Step 4: Share the purchase extraction**

In `src/lib/ads/meta.ts`, directly above `parseMetaInsights`, add:

```ts
/**
 * Purchases and their value, from Meta's action lists.
 *
 * Shared by the daily sync and the breakdown table on purpose. If these drifted
 * apart, one screen would say a campaign made 284 purchases and another would
 * say something else, and both would be citing Meta.
 */
export function purchasesFrom(row: {
  actions?: ActionEntry[]
  action_values?: ActionEntry[]
}): { purchases: number; purchaseValue: number } {
  // omni_purchase spans web + app + shop; older accounts only report purchase.
  return {
    purchases: action(row.actions, 'omni_purchase') || action(row.actions, 'purchase'),
    purchaseValue: toMinor(
      String(action(row.action_values, 'omni_purchase') || action(row.action_values, 'purchase')),
    ),
  }
}
```

Then use it inside `parseMetaInsights`, replacing the local `conversions` and
`value` calculation, so the two paths cannot diverge:

```ts
    const { purchases, purchaseValue } = purchasesFrom(row)
```

and set `conversions: purchases, conversionValue: purchaseValue` in the pushed
object. Leave every other field of `parseMetaInsights` exactly as it is.

- [ ] **Step 5: Add the driver**

In `src/lib/ads/meta.ts`, after `fetchMetaDaily`:

```ts
/** Which id and name field each level reports itself under. */
const BREAKDOWN_FIELDS: Record<BreakdownLevel, { id: string; name: string }> = {
  campaign: { id: 'campaign_id', name: 'campaign_name' },
  adset: { id: 'adset_id', name: 'adset_name' },
  ad: { id: 'ad_id', name: 'ad_name' },
}

/**
 * One row per campaign, ad set or ad, totalled over the range.
 *
 * Meta serves insights off any object id, so a drill-down needs no filter
 * syntax: ad sets are asked of the campaign, ads of the ad set. Deliberately no
 * `time_increment` — this table shows a total for the chosen period, and asking
 * per day would return entities × days and page for a very long time.
 */
export async function fetchMetaBreakdown(
  creds: MetaCredentials,
  target: { level: BreakdownLevel; accountExternalId: string; parentId?: string },
  from: Date,
  to: Date,
): Promise<BreakdownEntry[]> {
  const fields = BREAKDOWN_FIELDS[target.level]
  const params = new URLSearchParams({
    level: target.level,
    time_range: JSON.stringify({ since: day(from), until: day(to) }),
    fields: `${fields.id},${fields.name},spend,impressions,clicks,actions,action_values`,
    limit: String(PAGE_LIMIT),
  })

  // Campaigns hang off the account; everything deeper hangs off its parent.
  const object = target.parentId ? target.parentId : `act_${target.accountExternalId}`

  let url: string | undefined = `${GRAPH}/${object}/insights?${params}`
  const rows: BreakdownEntry[] = []
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body: { data?: BreakdownInsightRow[]; paging?: { next?: string } } = await metaJson(
      url,
      creds.accessToken,
    )
    for (const row of body.data ?? []) {
      const id = row[fields.id as keyof BreakdownInsightRow]
      if (typeof id !== 'string') continue // a total row, not an entity
      rows.push({
        id,
        name: String(row[fields.name as keyof BreakdownInsightRow] ?? id),
        spend: toMinor(row.spend ?? '0'),
        impressions: count(row.impressions),
        clicks: count(row.clicks),
        ...purchasesFrom(row),
      })
    }
    url = body.paging?.next
  }
  return rows
}
```

with the row type beside the existing `InsightRow`:

```ts
type BreakdownInsightRow = InsightRow & {
  campaign_id?: string
  campaign_name?: string
  adset_id?: string
  adset_name?: string
  ad_id?: string
  ad_name?: string
}
```

Import `BreakdownEntry` and `BreakdownLevel` from `./types` at the top.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run src/lib/ads/meta.test.ts`
Expected: PASS, including every pre-existing test — `parseMetaInsights` changed
shape internally and its existing tests prove it still behaves identically.

- [ ] **Step 7: Type-check and commit**

```bash
npx tsc --noEmit
git add src/lib/ads/types.ts src/lib/ads/meta.ts src/lib/ads/meta.test.ts
git commit -m "feat: Meta insights per campaign, ad set and ad"
```

---

### Task 2: The Google driver

Google's three levels are the same shape under different names, and GAQL
aggregates over the `WHERE` range as long as `segments.date` stays out of the
`SELECT` — putting it in would segment by day and produce the table we
explicitly do not want.

**Files:**
- Modify: `src/lib/ads/google.ts`
- Test: `src/lib/ads/google.test.ts`

**Interfaces:**
- Consumes: `BreakdownLevel`, `BreakdownEntry` (Task 1); the existing GAQL runner in `google.ts`
- Produces: `fetchGoogleBreakdown(creds, target, from, to): Promise<BreakdownEntry[]>`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/ads/google.test.ts`:

```ts
describe('fetchGoogleBreakdown', () => {
  const FROM = new Date('2026-07-01T00:00:00Z')
  const TO = new Date('2026-07-31T00:00:00Z')

  const reply = (results: unknown[]) =>
    new Response(JSON.stringify([{ results }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  /**
   * The GAQL actually sent — from the SECOND call, not the first.
   *
   * `searchStream` calls `googleAccessToken` before it queries anything, so
   * call 0 is the token exchange and call 1 is the query. Every pre-existing
   * test in this file already indexes `calls[1]` for the same reason
   * (`google.test.ts:121,140,176`). Reading `calls[0]` fails with "Google
   * sign-in failed" rather than an assertion error, which is a confusing way
   * to learn this.
   */
  const sentQuery = (fetchMock: { mock: { calls: unknown[][] } }) =>
    JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body)).query as string

  it('reads campaigns from the campaign resource', async () => {
    // A Response body reads once, so chain the two calls rather than sharing
    // one resolved value: first the token exchange, then the query.
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reply([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleBreakdown(CREDS, { level: 'campaign', customerId: '111' }, FROM, TO)

    const q = sentQuery(fetchMock)
    expect(q).toContain('FROM campaign')
    expect(q).toContain("segments.date BETWEEN '2026-07-01' AND '2026-07-31'")
    // In SELECT it would segment by day and give us entities x days.
    expect(q).not.toContain('SELECT segments.date')
  })

  it('reads ad groups belonging to one campaign', async () => {
    // A Response body reads once, so chain the two calls rather than sharing
    // one resolved value: first the token exchange, then the query.
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reply([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleBreakdown(
      CREDS,
      { level: 'adset', customerId: '111', parentId: '777' },
      FROM,
      TO,
    )

    const q = sentQuery(fetchMock)
    // 'FROM ad_group' is a prefix of 'FROM ad_group_ad', so the bare substring
    // would pass even if this level wrongly used the ad resource — a plausible
    // copy-paste between adjacent rows of BREAKDOWN_GAQL. The WHERE pins it.
    expect(q).toContain('FROM ad_group WHERE')
    expect(q).toContain('campaign.id = 777')
  })

  it('reads ads belonging to one ad group', async () => {
    // A Response body reads once, so chain the two calls rather than sharing
    // one resolved value: first the token exchange, then the query.
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reply([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleBreakdown(CREDS, { level: 'ad', customerId: '111', parentId: '888' }, FROM, TO)

    const q = sentQuery(fetchMock)
    expect(q).toContain('FROM ad_group_ad')
    expect(q).toContain('ad_group.id = 888')
  })

  it('converts micros to minor units', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        reply([
          {
            campaign: { id: '777', name: 'Brand' },
            metrics: {
              costMicros: '2116610000',
              conversions: 284,
              conversionsValue: 13482.79,
              impressions: '12000',
              clicks: '216',
            },
          },
        ]),
      ),
    )

    const [row] = await fetchGoogleBreakdown(CREDS, { level: 'campaign', customerId: '1' }, FROM, TO)

    expect(row).toEqual({
      id: '777',
      name: 'Brand',
      spend: 211661,
      purchases: 284,
      purchaseValue: 1348279,
      impressions: 12000,
      clicks: 216,
    })
  })
})
```

Use whatever `CREDS` fixture the file already defines for Google, and add
`fetchGoogleBreakdown` to its import.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/ads/google.test.ts -t "fetchGoogleBreakdown"`
Expected: FAIL — not exported.

- [ ] **Step 3: Add the driver**

In `src/lib/ads/google.ts`:

```ts
/** Resource, id/name columns and parent column for each level. */
const BREAKDOWN_GAQL: Record<
  BreakdownLevel,
  { from: string; id: string; name: string; parent?: string }
> = {
  campaign: { from: 'campaign', id: 'campaign.id', name: 'campaign.name' },
  adset: { from: 'ad_group', id: 'ad_group.id', name: 'ad_group.name', parent: 'campaign.id' },
  ad: {
    from: 'ad_group_ad',
    id: 'ad_group_ad.ad.id',
    name: 'ad_group_ad.ad.name',
    parent: 'ad_group.id',
  },
}

/**
 * One row per campaign, ad group or ad, totalled over the range.
 *
 * `segments.date` appears in the WHERE and never in the SELECT: in the SELECT it
 * segments the result by day, which is a different table and a far larger one.
 */
export async function fetchGoogleBreakdown(
  creds: GoogleCredentials,
  target: { level: BreakdownLevel; customerId: string; parentId?: string },
  from: Date,
  to: Date,
): Promise<BreakdownEntry[]> {
  const shape = BREAKDOWN_GAQL[target.level]
  const where = [
    `segments.date BETWEEN '${day(from)}' AND '${day(to)}'`,
    ...(shape.parent && target.parentId ? [`${shape.parent} = ${target.parentId}`] : []),
  ].join(' AND ')

  const query =
    `SELECT ${shape.id}, ${shape.name}, metrics.cost_micros, metrics.conversions, ` +
    `metrics.conversions_value, metrics.impressions, metrics.clicks ` +
    `FROM ${shape.from} WHERE ${where}`

  const rows = await searchStream(creds, target.customerId, query)
  return rows.map((r) => mapBreakdownRow(target.level, r))
}
```

`searchStream` is the existing GAQL runner in this file (it POSTs the query and
returns `results`) — reuse it rather than adding a second HTTP path. `day` is
already defined there too.

Write `mapBreakdownRow` beside it. Read the level's id and name out of the
nested result — `r.campaign`, `r.adGroup`, `r.adGroupAd.ad` — and convert cost
with the file's existing **`microsToMinor`**. Google reports both `costMicros`
and `cost_micros`, and `fetchGoogleDaily` already tolerates both at
`google.ts:63`; do the same here rather than picking one and being surprised
later.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/lib/ads/google.test.ts`
Expected: PASS, pre-existing tests included.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
git add src/lib/ads/google.ts src/lib/ads/google.test.ts
git commit -m "feat: Google metrics per campaign, ad group and ad"
```

---

### Task 3: The route

One endpoint, both platforms. It resolves the shop's accounts through the
existing credential path so a login connection keeps winning over pasted
credentials and an expired token keeps producing the sentence it already
produces everywhere else.

**Files:**
- Create: `src/lib/ads/breakdown.ts`
- Create: `src/app/api/marketing/breakdown/route.ts`
- Test: `src/app/api/marketing/breakdown/route.test.ts`

**Interfaces:**
- Consumes: `fetchMetaBreakdown` (Task 1), `fetchGoogleBreakdown` (Task 2), `resolveCredentials` from `src/lib/ads/sync.ts`
- Produces:

```ts
export type BreakdownRow = BreakdownEntry & {
  accountId: string
  accountName: string
  currency: string
}

/**
 * One account failing must not lose the others, for the same reason
 * `syncAllShops` does not let one store cost the rest their turn. So a failure
 * is data, not a status code: the response is 200 with whatever rows worked and
 * a named reason for each account that did not.
 */
export type BreakdownResponse = {
  rows: BreakdownRow[]
  errors: { accountId: string; accountName: string; message: string }[]
}
```

A 400 is reserved for a request that is wrong before any platform is called: an
unknown `level` or `provider`, or a missing `shopId`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/marketing/breakdown/route.test.ts`. Mock the drivers so no
test ever reaches a platform:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const metaBreakdown = vi.fn()
const googleBreakdown = vi.fn()
vi.mock('@/lib/ads/meta', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchMetaBreakdown: (...a: unknown[]) => metaBreakdown(...a),
}))
vi.mock('@/lib/ads/google', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchGoogleBreakdown: (...a: unknown[]) => googleBreakdown(...a),
}))
```

Then, following the DB-backed pattern in
`src/app/api/marketing/route.test.ts` for creating a shop, an ad account and an
admin session, assert:

1. **`refuses a non-admin`** — an ambassador session gets 403 and neither driver is called.
2. **`asks the platform for the level and parent it was given`** — `?level=adset&parentId=777` reaches `fetchMetaBreakdown` with `{ level: 'adset', parentId: '777' }` and the account's `externalId`.
3. **`switches driver on the provider`** — `?provider=google` calls `fetchGoogleBreakdown` and never `fetchMetaBreakdown`.
4. **`stamps each row with the account it came from`** — a driver returning one entry yields a row carrying that account's id, name and currency.
5. **`returns the union across a shop's accounts`** — two Meta accounts on one shop, each returning one entry, produce two rows, and the driver was called once per account.
6. **`says so when the store has no accounts on that provider`** — empty `rows`, and no driver call.
7. **`turns an expired token into readable text, not a crash`** — the driver rejects with `AdApiError('Facebook login expired. Press Connect with Facebook to renew it.')`. Assert the response status is **200**, `rows` is empty, and `errors[0].message` is that exact sentence.
8. **`one broken account does not lose the other`** — two Meta accounts, the first driver call rejects and the second returns one entry. Assert `rows` has length 1 and `errors` has length 1, both naming the right account. This is the property that matters most and the one a shortcut would quietly drop.
9. **`refuses an unknown level before calling anyone`** — `?level=banana` gives 400 and neither driver is called.

Write each as a real test with assertions; do not leave any as prose.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/app/api/marketing/breakdown/route.test.ts`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Write the resolver and the route**

`src/lib/ads/breakdown.ts` holds the part worth testing without HTTP:

```ts
/**
 * Every campaign, ad set or ad the shop's accounts on this provider report for
 * the range.
 *
 * One account failing does not lose the others: its reason is collected against
 * it and the rest still return, for the same reason `syncAllShops` does not let
 * one store cost the rest their turn. A caller that rejected wholesale would
 * turn one lapsed token into an empty screen for every account.
 */
export async function loadBreakdown(opts: {
  shopId: string
  provider: 'meta' | 'google'
  level: BreakdownLevel
  parentId?: string
  from: Date
  to: Date
}): Promise<BreakdownResponse> {
  const accounts = await db.adAccount.findMany({
    where: { active: true, shopId: opts.shopId, provider: opts.provider },
    include: { connection: { select: { provider: true, secret: true, expiresAt: true } } },
  })

  const rows: BreakdownRow[] = []
  const errors: BreakdownResponse['errors'] = []

  for (const account of accounts) {
    try {
      const creds = await resolveCredentials(account)
      const entries =
        opts.provider === 'meta'
          ? await fetchMetaBreakdown(
              creds as MetaCredentials,
              {
                level: opts.level,
                accountExternalId: account.externalId,
                ...(opts.parentId ? { parentId: opts.parentId } : {}),
              },
              opts.from,
              opts.to,
            )
          : await fetchGoogleBreakdown(
              creds as GoogleCredentials,
              {
                level: opts.level,
                customerId: account.externalId,
                ...(opts.parentId ? { parentId: opts.parentId } : {}),
              },
              opts.from,
              opts.to,
            )

      for (const entry of entries) {
        rows.push({
          ...entry,
          accountId: account.id,
          accountName: account.name,
          currency: account.currency,
        })
      }
    } catch (e) {
      errors.push({
        accountId: account.id,
        accountName: account.name,
        message: e instanceof Error ? e.message : 'Could not read this account.',
      })
    }
  }

  return { rows, errors }
}
```

`src/app/api/marketing/breakdown/route.ts` is thin:

```ts
const LEVELS = ['campaign', 'adset', 'ad'] as const
const PROVIDERS = ['meta', 'google'] as const

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const shopId = params.get('shopId')
    const level = params.get('level') ?? 'campaign'
    const provider = params.get('provider') ?? 'meta'

    // Validated before anything is called: a typo must not reach a platform.
    if (!shopId) return NextResponse.json({ error: 'Pick a shop' }, { status: 400 })
    if (!LEVELS.includes(level as never)) {
      return NextResponse.json({ error: 'Unknown level' }, { status: 400 })
    }
    if (!PROVIDERS.includes(provider as never)) {
      return NextResponse.json({ error: 'Unknown platform' }, { status: 400 })
    }

    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)

    return NextResponse.json(
      await loadBreakdown({
        shopId,
        provider: provider as (typeof PROVIDERS)[number],
        level: level as BreakdownLevel,
        ...(params.get('parentId') ? { parentId: params.get('parentId')! } : {}),
        from,
        to,
      }),
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the breakdown' }, { status: 500 })
  }
}
```

`rangeFromQuery` and `getSetting` come from the same places
`src/app/api/marketing/route.ts` uses them, so this table's dates mean exactly
what the figures above it mean. The `no-store` header matches the orders route:
financial figures are never cached by a browser.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/app/api/marketing/breakdown/route.test.ts`

- [ ] **Step 5: Type-check, lint and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/ads src/app/api/marketing
git add src/lib/ads/breakdown.ts src/app/api/marketing/breakdown/
git commit -m "feat: one endpoint serves the breakdown for both platforms"
```

---

### Task 4: The table

**Files:**
- Create: `src/app/marketing/BreakdownTable.tsx`
- Test: `src/app/marketing/BreakdownTable.test.tsx`

**Interfaces:**
- Consumes: `GET /api/marketing/breakdown` (Task 3)
- Produces: `<BreakdownTable shopId provider from to />`

- [ ] **Step 1: Write the failing tests**

Create `src/app/marketing/BreakdownTable.test.tsx` (`// @vitest-environment jsdom`, mocking `next/navigation` as the sibling test files do). Cover:

1. **`lists the campaigns it was given`** — one fetch on mount, rows rendered with name and formatted spend.
2. **`derives ROAS from spend and value`** — a row with `spend: 100000, purchaseValue: 637000` shows `6.37×`; assert the rendered text, not an internal. Period, and the `×`, matching `src/components/marketing/MarketingTable.tsx:104` which renders on the same page.
3. **`shows a dash rather than dividing by zero`** — `spend: 0` shows the em dash `—` for ROAS, never `Infinity` or `NaN`. Em dash, not en: `MarketingTable.tsx:99` uses `—` for an unknown value.
4. **`expands a campaign into its ad sets`** — pressing a row fetches `level=adset&parentId=<that row's id>` and renders the children indented beneath it.
5. **`expands an ad set into its ads`** — the same one level deeper.
6. **`does not refetch a row it has already expanded`** — collapse and re-expand issues no second request.
7. **`calls the middle level Ad set on Meta and Ad group on Google`** — the header text follows the provider.
8. **`says when nothing ran in the period`** — empty rows renders the empty sentence, not an empty table.
9. **`puts the reason under the row that failed`** — a failing expansion leaves the parent expanded and shows the platform's message.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/app/marketing/BreakdownTable.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Build the table**

A single component holding a map of expanded row id to its children. Each row
renders name, spend, ROAS, purchases, value and CTR, indented by depth. ROAS and
CTR are computed in one small helper each, used by every level, with a zero
guard returning a dash. Money uses the account currency on the row, through the
formatter this page already uses.

Do not fetch all three levels up front. A row's children are requested the first
time it is expanded and kept thereafter.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/app/marketing/BreakdownTable.test.tsx`

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit && npx eslint src/app/marketing
git add src/app/marketing/BreakdownTable.tsx src/app/marketing/BreakdownTable.test.tsx
git commit -m "feat: a table that opens a campaign into its ad sets and ads"
```

---

### Task 5: The switcher, and where the table lives

**Files:**
- Modify: `src/app/marketing/MarketingClient.tsx`
- Test: `src/app/marketing/MarketingClient.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/app/marketing/MarketingClient.test.tsx`:

1. **`shows the breakdown only for a single store`** — one shop selected renders the table; "all shops" renders neither the table nor the switcher, and instead the sentence explaining why.
2. **`switches the table between Meta and Google`** — pressing Google re-renders the table for that provider.
3. **`starts on Meta`** — the default selection.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/app/marketing/MarketingClient.test.tsx`

- [ ] **Step 3: Wire it in**

A segmented control with two options, not a dropdown — two options behind a
dropdown hides half of them. Below it, `<BreakdownTable>` for the selected
provider and the single selected shop.

With more than one shop selected, render neither, and say why in one sentence:
campaigns belong to one ad account, so stacking them across stores would produce
a table that looks meaningful and is not.

- [ ] **Step 4: Run the tests, type-check, lint**

Run: `npx vitest run src/app/marketing/ && npx tsc --noEmit && npx eslint src/app/marketing`

- [ ] **Step 5: Run the whole suite twice**

Run `npx vitest run`, then again. Identical counts both times. A count that moves
is a shared-database race, not flakiness — find the two tests that share a row.
Do **not** use `--no-file-parallelism`; it is 6.7× slower and hides the problem.

- [ ] **Step 6: Commit**

```bash
git add src/app/marketing/
git commit -m "feat: switch the Marketing breakdown between Meta and Google"
```

---

### Task 6: End to end

The user asked for this specifically. It proves the pieces work together, which
no unit test can.

**Files:**
- Create: `e2e/marketing-breakdown.spec.ts`

- [ ] **Step 1: Write the spec**

Following `e2e/orders.spec.ts` for login and navigation.

**Stub our own endpoint, not the platform's.** The first draft of this plan said
to intercept `**/graph.facebook.com/**`. That cannot work: the browser never
calls Meta. The browser calls `/api/marketing/breakdown`, and the **Next.js
server** calls Meta. `page.route` only sees browser traffic, so a route on
`graph.facebook.com` would never fire and the test would either reach the real
API or fail in a way that took an hour to understand.

So intercept `**/api/marketing/breakdown**` and answer from fixtures keyed on
the request's `level` and `provider` parameters.

What that does and does not prove, stated plainly so nobody mistakes its reach:

- **Proves** the journey — the page renders, a single store gates the table in,
  a campaign expands into ad sets, an ad set into ads, and the switcher moves to
  Google. That is the thing no unit test can show, and the thing the user asked
  for.
- **Does not prove** the route handler or the two drivers. Those already have
  DB-backed tests (Task 3) and stubbed-fetch unit tests (Tasks 1 and 2). The
  division is deliberate: this spec owns the browser, those own the server.

Then: sign in, open Marketing, choose one store, confirm campaigns are listed,
press a campaign and confirm its ad sets appear beneath it, press an ad set and
confirm its ads appear, press Google and confirm the table reloads for that
platform.

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/marketing-breakdown.spec.ts`
Expected: PASS.

- [ ] **Step 3: Run the whole e2e suite**

Run: `npx playwright test`
Expected: every spec passes, the new one included.

- [ ] **Step 4: Commit**

```bash
git add e2e/marketing-breakdown.spec.ts
git commit -m "test: the breakdown opens campaign to ad set to ad, end to end"
```

---

## After the last task

1. Merge and push. There is no schema change, so nothing happens to the database on deploy.
2. Confirm the deploy: `curl -s https://panetti.vercel.app/api/version` returns the pushed sha.
3. Open `/marketing`, choose one store, and check the acceptance criterion from the spec: campaigns listed, a campaign opens into ad sets, an ad set opens into ads, and the switcher moves to Google.

**The figures must match Ads Manager for the same range.** They come from the
same endpoint, so a mismatch means a bug in the range or the mapping, not a
rounding difference — investigate rather than explain it away.
