# The Marketing page drills into campaigns, ad sets and ads

Date: 2026-07-31
Status: approved in session. Adds one API route, two platform drivers, and an
expandable table plus a platform switcher on the single-store Marketing view.
Nothing about the existing account-level sync changes.

## What was asked for

> Is it possible to make the meta dashboard more like this when you view single
> store view? I want to be able to see each and one campaign, and when pressing
> a campaign, I can see each ad set inside of the campaign, and then when
> pressing the ad-set, I can see each of the ads inside of that adset. Also add
> a button like this where you can easily switch between Meta and Google.

Four Triple Whale screenshots came with it. They contain more than the words do,
and the difference matters, so it is written down rather than silently absorbed.

**In the screenshots but deliberately not built** (each confirmed with the human):

- **Status toggles and pencil-editable budgets.** Those are writes. Our Meta
  permission is `ads_read,business_management` — read only. Building them would
  need `ads_management`, a fresh consent from the person who logged in, and a
  mis-click would pause live spend. Ruled out: see-only.
- **Two ROAS columns, NCP, CV.** Triple Whale computes these by joining Meta to
  Shopify order-by-order through click IDs. We have no such tracking, so they
  are not reproducible, and inventing something adjacent and calling it ROAS
  would be worse than omitting it. We show Meta's own figures.

## What exists today

`AdSpend` is one row per ad account per day. There is nothing below account
level anywhere in the schema, and `fetchMetaDaily` asks Meta only for
`level=account`. This is a new read path, not a UI change over existing data.

Both platforms happen to share the same three levels, which is what makes one
design serve both:

| | Level 1 | Level 2 | Level 3 |
| --- | --- | --- | --- |
| Meta | campaign | ad set | ad |
| Google | campaign | ad group | ad |

## The decision: ask live, do not store

Storing this needs **daily** rows, or an arbitrary date range cannot be summed.
That is ads × days: fifty ads over a year is ~18,250 rows for a single account,
which at Meta's paging is roughly 180-730 requests to backfill — per account.
Across nine accounts, thousands of requests against a cron whose shops budget is
240 seconds. It would break the scheduled sync that was stabilised the same day.

Asking live costs one request per expansion. Aggregated over the chosen range
with no `time_increment`, one call returns one row per campaign; expanding a
campaign returns its ad sets; expanding an ad set returns its ads. Each response
is tens of rows.

The deciding argument is not size, though. **Meta refreshes insights every 3-6
hours** — the existing sync says so in `src/lib/ads/sync.ts:23` — so stored
figures are never fresher than live ones, only staler and capable of drifting.
Reading the same endpoint Ads Manager reads means the two screens agree
permanently, which removes a whole category of "why is your number different"
from a tool a client uses to judge spend.

**The cost, stated plainly:** about a second on first expansion, and no ability
to join a campaign to our own order data. If per-campaign profit is ever wanted,
that is when storing campaign rows earns its place — and nothing here blocks it.

**No cache in this version**, and that is a correction to the first draft of
this design. An in-process cache was proposed on the reasoning that it would
make repeat expansions instant. On Vercel that reasoning does not hold: each
request may land on a fresh instance, so an in-memory map would mostly miss
while still adding a mechanism, a TTL and a staleness question to argue about.
One request per expansion is genuinely cheap, and there is one admin using this.

If the latency ever grates, the honest fix is Next's data cache with an explicit
revalidate window, added deliberately and measured — not a Map that appears to
work in development and rarely fires in production.

## The route

```
GET /api/marketing/breakdown
      ?shopId=<id>
      &provider=meta|google
      &level=campaign|adset|ad
      &parentId=<campaign id, or ad set id>   (absent at campaign level)
      &from=<iso>&to=<iso>
```

Admin only, like every other figure on this page. It resolves the shop's ad
accounts for that provider through the existing `resolveCredentials`, so a login
connection continues to win over pasted credentials and an expired token
produces the same readable sentence it does everywhere else.

One row shape serves both platforms and all three levels:

```ts
export type BreakdownRow = {
  id: string            // platform's own id for the entity
  name: string
  accountId: string     // ours, not the platform's
  accountName: string
  currency: string      // the account's, not the shop's
  spend: number         // minor units, account currency
  purchases: number
  purchaseValue: number // minor units
  impressions: number
  clicks: number
}
```

ROAS and CTR are **derived once**, at render, from those figures. They are not
stored, not returned twice, and not computed in two places — the single most
likely way for two numbers on one screen to disagree.

The account fields are not decoration. A shop may have more than one ad account
on a provider, and the response is their union: without the account on the row,
two identically-named campaigns from different accounts would collapse into one
another, and `parentId` for the next level down would be ambiguous. The currency
belongs to the ad account rather than the shop for the same reason the rest of
this codebase keeps them apart — an account can bill in a currency the store
does not trade in.

### Meta

Insights can be requested off any object id, so drilling down needs no filter
syntax:

| Level | Request |
| --- | --- |
| campaign | `act_{accountId}/insights?level=campaign` |
| adset | `{campaignId}/insights?level=adset` |
| ad | `{adSetId}/insights?level=ad` |

with `time_range={"since":…,"until":…}` and the field list already used by
`fetchMetaDaily`, minus `time_increment`. `metaJson`, `day()` and the existing
action/action-value parsing are reused rather than rewritten — purchases and
purchase value are already extracted there and must keep meaning exactly what
they mean on the Marketing page today.

### Google

The same three levels, in GAQL:

| Level | Resource |
| --- | --- |
| campaign | `FROM campaign` |
| adset | `FROM ad_group WHERE campaign.id = …` |
| ad | `FROM ad_group_ad WHERE ad_group.id = …` |

with `metrics.cost_micros`, `metrics.conversions`, `metrics.conversions_value`,
`metrics.impressions`, `metrics.clicks` and a `segments.date BETWEEN` clause.
Costs arrive in micros and are converted at the boundary, as the existing Google
driver already does.

## The screen

The single-store Marketing view gains a platform switcher and an expandable
table. The switcher is a segmented control, not a dropdown: there are two
options and a dropdown would hide half of them.

```
[ Meta ][ Google ]

Campaign                     Spend        ROAS   Purch.   Value          CTR
────────────────────────────────────────────────────────────────────────────
▾ KS - Pizzetta Pro UGC     211 661 kr    6,37     284   1 348 279 kr   1,8%
   ▾ Brief 4 | Thomas        67 923 kr    7,44     104     426 260 kr   1,6%
        #3 - Brief 4         54 799 kr    8,71      71     305 411 kr   2,0%
        #1 - Brief 4         13 082 kr    2,15      28      28 129 kr   1,1%
▸ SALE Pizzetta statics      57 917 kr    7,70      95     445 961 kr   2,1%
```

- A row is expanded by pressing it. Children load on first expansion and stay
  loaded; collapsing does not discard them.
- The second level is labelled **Ad set** on Meta and **Ad group** on Google,
  because that is what each platform calls it and a client reading the wrong
  word will not trust the number beside it.
- **All shops** selected hides the breakdown entirely rather than summing across
  stores. Campaigns belong to one ad account; stacking them across stores would
  produce a table that looks meaningful and is not.

## Failure, honestly

Every failure lands as text in the table, never as a blank row or a crash.

| What happened | What it says |
| --- | --- |
| Token expired | The same sentence the sync uses: press Connect with Facebook to renew |
| Platform refused | The platform's own words, truncated, as `wooError` already does |
| No accounts for that provider | "No Meta ad accounts on this store yet." |
| No campaigns in range | "No campaigns ran in this period." |

An expansion that fails leaves the parent row expanded with the reason under it,
so it is obvious which one broke.

## Testing

Four layers, matching what the repo already does.

**Stubbed-fetch unit** — the built Meta URL asserted literally, including
`level`, the object id it hangs off, and the encoded `time_range`; the GAQL
string asserted literally including the `WHERE` clause; the row mapper for both
platforms, including micros conversion and the divide-by-zero case for ROAS on a
campaign that spent nothing.

**Route, DB-backed** — the admin gate; a shop with no accounts on the chosen
provider; parent id passed through to the driver; provider switching; and an
expired token surfacing as readable text rather than a 500.

**Component, jsdom** — expanding fetches the right level and parent; children
indent under their parent; a second expansion does not refetch; the label reads
Ad set on Meta and Ad group on Google; the empty and error states appear.

**End to end, Playwright** — open Marketing, choose one store, expand a
campaign, see its ad sets, expand one, see its ads, switch to Google. Platform
responses stubbed at the network layer so the run is deterministic and never
touches a real ad account.

## Acceptance

On `/marketing` with a single store chosen and Meta selected, campaigns for that
store's ad account appear with spend, ROAS, purchases, value and CTR. Pressing
one reveals its ad sets; pressing an ad set reveals its ads. The figures match
Ads Manager for the same date range, because they came from the same endpoint.
The switcher moves to Google and the same three levels work there.
