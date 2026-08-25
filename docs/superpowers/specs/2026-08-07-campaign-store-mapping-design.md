# One ad account, several stores - design

**Date:** 2026-08-07
**Status:** approved, ready for an implementation plan

## The ask

Some Google Ads accounts run campaigns for more than one store. Today every
account belongs to exactly one store, so all of that account's spend lands on
one shop: that shop's ad cost is inflated, every other shop reads zero, and both
profit and ROAS are wrong on all of them.

The client wants to connect one ad account to several stores and then say which
campaign advertises for which store.

## Why the current model cannot do this

`AdAccount.shopId` is a single column, and attribution happens on one line in
`load.ts:180`:

```ts
return { shopId: account.shopId, date: r.date, spend: r.spend, currency: account.currency }
```

`engine.ts:148` groups `spendByShop` from that, and the Dashboard, the Marketing
page and every profit figure follow. Change what feeds that line and everything
downstream is correct automatically.

The deeper blocker is storage. `AdSpend` is keyed `(accountId, date)` and holds
account-level daily totals only - `fetchGoogleDaily` queries `FROM customer`, so
there is no campaign dimension in the database at all. An account's daily total
cannot be split across stores without knowing which campaign spent what.
**Campaign-level storage is unavoidable for an honest answer.**

What already exists and is reused: `fetchGoogleBreakdown` (`google.ts:253`) and
`fetchMetaBreakdown` (`meta.ts:154`) already query campaign level correctly for
the Marketing breakdown table. The API shape is proven; only the daily
segmentation is new.

## Decisions

### The campaign carries the store, not the account

The account keeps its single `shopId` and it becomes the account's **default**
store. A campaign may override it. There is no many-to-many between accounts and
shops, `@@unique([provider, externalId])` is untouched, and no account is ever
duplicated.

Rejected: **one `AdAccount` row per store**, each owning a list of campaigns.
It reuses the existing plumbing untouched, but the same account gets fetched
from the API once per store, `dailyBudget` double-counts across the duplicates,
and the settings page would list "Panetti Google Ads" four times.

Rejected: **a percentage split per store**. Half a day's work and it is an
estimate dressed as a number, for the same reason
`2026-08-05-product-analytics-design.md` refuses to copy BeProfit's
Contribution Profit.

### The mapping is applied at read time, never stored on a spend row

Assigning a campaign re-attributes **all** of its history. The campaign always
did belong to that store; assigning corrects our knowledge, not the facts. This
matches [[order-belongs-to-its-placed-day]] - the record lands where it always
belonged.

If sync wrote `shopId` onto each spend row, a reassignment would mean rewriting a
year of history. Joining at read time makes reassignment a one-row update, and
history follows for free. **This is the reason for the whole shape of the
design.**

### Splitting is opt-in per account

`AdAccount.splitByCampaign` defaults to false. The eight accounts connected today
keep using `AdSpend` and behave byte-for-byte as they do now. Nothing about this
feature can regress an account that does not use it.

### An account is split or whole, never both

**The double-counting rule, stated once:** a split account writes
`AdCampaignSpend` and never `AdSpend`. A whole account does exactly the reverse.
Both tables holding rows for the same account and date would silently double that
account's ad cost, which is the single most dangerous failure available here, so
the sync enforces it at the point of writing and a test asserts it.

### Unassigned campaign spend falls back to the default store, loudly

A campaign with `shopId: null` - a brand new one, or one nobody has got to yet -
attributes to the account's default store, and the Marketing page carries a
count of how many campaigns still need one, linking to the assignment screen.

Money is never silently dropped. Excluding unassigned spend would understate ad
cost, which makes profit look *better* than reality; flattering errors are the
ones nobody catches. This mirrors the Products page, which shows uncosted
products rather than hiding them (`2026-08-05-product-analytics-design.md`).

### Both providers, one mechanism

His eight Meta accounts are 1:1 with stores today, so Meta has no problem right
now. The storage and attribution layer is shared regardless, and building it
provider-agnostic costs little more than Google alone. The alternative is
rebuilding this the first time a Meta account covers two stores, with the two
paths drifting in between.

## Architecture

### Schema

```prisma
model AdCampaign {
  id         String   @id @default(cuid())
  accountId  String
  externalId String   // campaign id from the platform
  name       String   // snapshot, refreshed on each sync
  shopId     String?  // null = unassigned, falls back to account.shopId
  createdAt  DateTime @default(now())

  account AdAccount         @relation(fields: [accountId], references: [id], onDelete: Cascade)
  shop    Shop?             @relation(fields: [shopId], references: [id], onDelete: SetNull)
  spend   AdCampaignSpend[]

  @@unique([accountId, externalId])
  @@index([shopId])
}

// One day of one campaign's delivery. Same columns and same units as AdSpend:
// minor units of the ACCOUNT's currency, conversion at read time. Only
// day-additive numbers, for the reason AdSpend gives.
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

`AdAccount` gains `splitByCampaign Boolean @default(false)` and a
`campaigns AdCampaign[]` back-relation. `Shop` gains `adCampaigns AdCampaign[]`.

`shopId` is `onDelete: SetNull`, not Cascade: deleting a shop must unassign its
campaigns, not delete the spend history that proves what was spent.

`AdCampaignSpend` deliberately omits `videoViews3s`, `thruplays` and `reach`.
Reach does not sum across days (`AdSpend`'s own comment says so), and nothing
reads the video columns per campaign. They can be added the day something needs
them.

### `src/lib/ads/google.ts` and `meta.ts` - one new fetcher each

```ts
fetchGoogleCampaignDaily(creds, customerId, from, to): Promise<CampaignDailyRow[]>
fetchMetaCampaignDaily(creds, externalId, from, to): Promise<CampaignDailyRow[]>
```

`CampaignDailyRow` is a `DailyRow` plus `campaignId` and `campaignName`.

Google: `fetchGoogleBreakdown` keeps `segments.date` in the WHERE and out of the
SELECT on purpose - in the SELECT it segments by day, "which is a different table
and a far larger one" (`google.ts:250`). Here that segmentation is exactly what
is wanted, so the new query puts it in both.

Meta: `level: 'campaign'` with `time_increment: 1`, which is the daily fetcher's
`time_increment` and the breakdown's `level` in one call.

Both parse through the existing shared row mappers so a campaign's numbers can
never disagree with the same campaign's numbers on the breakdown table - the
reason `meta.ts:60` gives for sharing them in the first place.

### The paging trap, and why the range is fetched in chunks

`meta.ts:150` warns against exactly this query: *"Deliberately no
`time_increment` - asking per day would return entities × days and page for a
very long time."* That warning is correct and it is load-bearing.

Meta caps a fetch at `PAGE_LIMIT` 500 × `MAX_PAGES` 10 = **5 000 rows**, and
`fetchMetaDaily`'s loop simply stops at `page < MAX_PAGES` and returns what it
has. There is no error. Over the 365-day backfill (`sync.ts:17`):

| Campaigns | Rows for 365 days | Result |
| --- | --- | --- |
| 13 | 4 745 | fits |
| 14 | 5 110 | **silently truncated** |

An account worth splitting across stores is precisely the kind that has more
than fourteen campaigns, so the naive version would drop most of a year of spend
and report the remainder as if it were complete. That is the same class of bug
as the four commits that already exist about spend and counts reporting fiction.

**Both providers therefore fetch the range in 90-day chunks** and concatenate.
Ninety days stays under 5 000 rows up to ~55 campaigns, and the 365-day backfill
becomes five requests rather than thirteen, which matters because
`api/ad-accounts/route.ts:14` caps that request at `maxDuration = 60`. A routine
sync re-fetches `RESTATE_DAYS` 35 and is a single chunk.

**Belt and braces:** if any single chunk still fills `MAX_PAGES`, the fetcher
throws rather than returning a short answer. Chunking prevents the truncation;
the guard makes a future surprise loud instead of silent. A test asserts the
throw, because a cap that is never exercised is a cap nobody knows is broken.

Google's `searchStream` has no equivalent page cap in our code, but it uses the
same chunked windowing so both providers share one code path and one test.

### `src/lib/ads/sync.ts`

`syncAdAccount` branches once on `account.splitByCampaign`:

- **false** - exactly what it does today. Untouched.
- **true** - fetch campaign×day, upsert an `AdCampaign` per campaign id seen
  (refreshing `name`, never touching `shopId`), then upsert `AdCampaignSpend` on
  `(campaignId, date)`. **Writes no `AdSpend` row.**

Refreshing `name` but never `shopId` matters: renaming a campaign in Google must
not silently unassign it from its store.

`dailyBudget` is unchanged and stays account-level. A per-store daily budget
would need campaign budgets apportioned, and nothing asks for it.

### `src/lib/data/load.ts`

The one line becomes a join. Whole accounts read `AdSpend` as today; split
accounts read `AdCampaignSpend` and resolve the shop as:

```ts
shopId: campaign.shopId ?? account.shopId
```

The fallback decision falls out of that `??` with no branch of its own.

Note the existing query filters `shopId: { in: shopIds }` on the ACCOUNT
(`load.ts:162`). For a split account that is wrong: an account whose default
store is outside the selection can still hold campaigns that belong inside it.
Split accounts are therefore selected on **the shops their campaigns resolve to**,
not on the account's own `shopId`. This is the one subtle correctness trap in the
change and it gets its own test.

`src/app/api/marketing/route.ts:44` reads `adSpend` directly and needs the same
treatment, so the resolution lives in one shared helper rather than being written
twice - two copies would drift and the two screens would disagree.

### `src/app/api/ad-accounts/[id]/campaigns/route.ts` (new)

`GET` lists the account's campaigns with their current assignment. `PATCH`
accepts `{ campaignId, shopId | null }` pairs. Admin-only, the same boundary as
every other ad route. Rejects a `shopId` that is not a real shop, and a
`campaignId` that does not belong to that account - a hand-typed id must not
reassign someone else's campaign.

### UI

On the Ad accounts page, each account gains a **Campaigns** action. It opens a
modal listing every campaign with a store dropdown, defaulting to "Use the
account's store". Toggling `splitByCampaign` lives in the same modal, so the flag
and the assignments are set in one place.

The modal follows `PickerModal`'s existing shape - the pattern for "list things
from a platform and assign each to a shop" already exists and should not be
invented twice.

## Testing

Written first, RED confirmed before GREEN.

| Test | Proves |
| --- | --- |
| Split account, 3 campaigns, 3 shops | Each shop gets its own campaigns' spend and nothing else |
| Campaign with `shopId: null` | Lands on the account's default shop |
| Reassign, then re-read a past month | History moves with the assignment |
| Split account writes no `AdSpend` row | The double-counting rule holds |
| Whole account, before and after | Byte-identical to today's behaviour |
| Campaign in-selection, account's default shop out of selection | The `load.ts:162` filter trap |
| Google and Meta campaign×day parsers | Real response shapes map correctly, snake_case and camelCase |
| A 365-day backfill | Splits into four 90-day chunks and concatenates, losing no day at a boundary |
| A chunk that fills `MAX_PAGES` | Throws, rather than silently returning a short year |
| Renaming a campaign in the platform | `name` refreshes, `shopId` survives |
| `PATCH` campaigns | Admin-only; rejects a foreign campaign id and an unknown shop id |
| Existing `engine.test.ts`, `marketing` routes | Unchanged and still passing |

## Known follow-ups

Recorded by the final whole-branch review after implementation. None is a
correctness regression in the money; all were triaged as non-blocking.

- **`attribution.test.ts` "ignores a whole account…" cannot fail.** Its fixture
  account has no `AdCampaign` rows, so the unassigned count is 0 whether or not
  the `account: { splitByCampaign: true }` predicate exists. That predicate is
  the real guard - an account flipped back to whole KEEPS its campaign rows -
  and nothing exercises it. The correct fixture is a whole account that still
  carries `shopId: null` campaigns.
- **The breakdown drill-down can list another shop's campaigns.** Scoping it via
  `accountIdsForShops` fixed the empty/over-totalled row, but the provider still
  answers per account, so a shop-A drill-down on a split account can show its
  shop-B campaigns. A pre-existing leak class, now reachable more often. The fix
  is to filter the returned entities by the campaign→shop map.
- **The unassigned-campaign notice is range-independent.** It counts unassigned
  campaigns on in-scope split accounts even when their fallback shop sits outside
  the current filter, so it can name campaigns whose spend is not on screen.
  Defensible - it is an admin call to action, not a figure - but it is not
  scoped the way the numbers beside it are.
- **The notice's singular branch ("1 campaign has") is untested.**
- **`load.ts` runs `attributedSpend` and `relevantAdCurrencies` separately**, so
  the same two helper queries execute twice on every dashboard load: six queries
  where four would do. No N+1 and no correctness effect.
- **The campaigns modal posts every row on save**, not only the edited ones, so
  two admins editing the same account between load and save is last-write-wins.
  The API already accepts a partial `assignments` array, so this is a one-line
  UI change if it ever matters.

## Out of scope

- Per-store daily budgets
- Ad-set and ad level assignment. Campaign is the level the client thinks in;
  finer granularity is its own spec if it is ever wanted
- Splitting a single campaign across two stores by percentage. That is approach C,
  rejected above, and it would reintroduce the estimate this design removes
- Automatic assignment by campaign name. `listing.ts` already guesses a shop from
  an account name; guessing here would quietly attribute real money on a string
  match, and the client can assign once in a minute
