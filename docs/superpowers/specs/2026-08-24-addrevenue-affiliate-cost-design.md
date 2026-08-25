# Addrevenue Affiliate Cost - Design

**Date:** 2026-08-24
**Approved by:** the client, in conversation (cost basis, status rule and placement were each an explicit choice).

## What this is

The business pays affiliates (blogs, test sites, newspapers) through Addrevenue for the
Panetti and Mazzetti brands. That money is invisible to the dashboard today. This feature
imports every Addrevenue transaction, charges it to net profit as a new **Affiliate** cost
line, and shows it per shop and per affiliate channel.

## Decisions (made with the client, 2026-08-24)

1. **Cost basis: commission + brokerage fee.** Every transaction carries the affiliate's
   `commission` and Addrevenue's own `brokerageFee` (~15% markup on the commission).
   Both leave the bank account, so both count. Stored separately, summed at read time.
2. **Which sales count: all except denied.** A transaction costs money on its sale date
   the moment it appears (`new`), like the refund convention: recognise on the day it
   happened. If Addrevenue later denies one, the next sync removes the cost. The entire
   history (2,167 rows) contains zero denials, but the deny fields exist and are honoured.
3. **Placement: its own line.** A new `affiliate` figure - a Compare-table column and a
   Marketing-page section - subtracted in net profit. NOT folded into `marketing`, so
   ads ROAS stays purely Meta/Google.

## The API, as measured (not as documented)

Live-probed 2026-08-24 with both real tokens. The public docs page is thin and partly
wrong; everything below was observed.

- Base `https://addrevenue.io/api/v2`, header `Authorization: Bearer <token>`.
  One life-time token per brand account. These are **advertiser** accounts.
- Response envelope: `{ results: [...], meta: { totalCount, page, perPage: 5000,
  hasNextPage, ... }, links }`. The docs' `http_code`/`count` top-level fields do not exist.
- `GET /advertisers` → one advertiser per account: `id` (986851 Panetti, 987011 Mazzetti),
  `displayName`, `markets: { NO: { market, url, status, ... }, ... }`.
  Panetti markets: NO SE DK FI DE. Mazzetti: NO SE DK FI. Each market's `url` is the
  webshop (`https://www.panetti.de`) - the shop-mapping key.
- `GET /transactions?fromDate&toDate` → one row per tracked sale. Fields that matter:
  `id` (int), `date` ("2026-01-02", the sale day), `updated`, `channelId`,
  `channelName` ("Forbrukertesten.com"), `market` ("NO"), `currency` ("NOK"),
  `eventValue` ("855.64", string, major units), `commission` ("128.35", string, major
  units), `brokerageFee` (19.25, number, major units), `status`, `denyReason`,
  `denyReasonCategory`, `denyDate`, `eventOrderId` ("19101" - the Woo order number),
  `commissionPercent`, `untrackedSale`. A `currencies` map of their own FX conversions
  exists - **ignored**; we convert with our own rates like every other cost.
- Statuses observed: `new` → `invoiced` → `readyForPayout` → `paidOut`. Deny signal =
  the deny fields, not a status we have ever seen. Old rows change status in place
  (`updated` moves; 267 rows were touched in the four days before the probe).
- **Currency does not always match the market.** Real cases: FI sales in SEK (4),
  NO in SEK (1). Store the row's own `currency`; never assume the shop's.
- Volume: Panetti 2,097 rows since 2025-07-19; Mazzetti 70 since 2025-09-14. One page
  each at `perPage` 5000. Full-history refetch is a cheap, single request per brand.
- `eventOrderId` is NOT always a Woo order number: the live data contains the literal
  string `"DELETED"` where the order was removed from the shop. It is stored for audit
  and nothing joins on it - do not build one without handling that value.
- `updatedFromDate` filter works (incremental sync is possible; not needed at this volume).
- `GET /channels` and `/payouts` answer 403 for advertiser tokens - affiliate-side only.

## Storage - an exact mirror of their transactions

Chosen over daily pre-aggregation (loses channel/status/order detail, saves nothing at
2k rows) and over the `/stats` endpoint (their aggregation, no deny control).

```
AffiliateAccount        one row per brand token
  id, provider "addrevenue", name (displayName), externalId (advertiser id, unique
  with provider), token (encrypted, encryptSecret), active, lastSyncAt?, lastError?,
  createdAt

AffiliateTransaction    one row per Addrevenue transaction
  id, accountId, externalId (their int id, @@unique([accountId, externalId])),
  date (UTC midnight of their plain `date`), market, shopId? (null = unmatched),
  channelId, channelName, status, denyDate?, commission Int, brokerageFee Int,
  orderValue Int   - minor units in `currency`, house money rule -
  currency, eventOrderId?, @@index([shopId, date]), @@index([date])
```

Sync makes the table an **exact mirror**: fetch the full history (from 2025-07-01),
upsert every row, delete local rows for that account that the response no longer
contains - all in one `$transaction`. Restatement, denial and remote deletion are
the same operation. No windows, no watermarks.

Money parsing: `commission`/`eventValue` are decimal **strings**, `brokerageFee` a
**number**; all become integer minor units via the house `toMinor` conversion
(`src/lib/money.ts`), never float arithmetic.

## Shop mapping - by domain, refusing to guess

At sync time, build market → shopId from the advertiser's `markets[].url` host matched
against `Shop.wooUrl` host (both lowered, `www.` stripped). A market with no matching
shop leaves its transactions with `shopId: null`; they are excluded from per-shop
figures and the settings page shows the unmatched count loudly. Nothing is dropped
silently and nothing is guessed from names.

## Sync plumbing

`src/lib/affiliate/client.ts` - fetch + parse, typed `AffiliateApiError` so provider
wording reaches the UI. Follows `meta.hasNextPage` with `offset` even though today it
is always one page.

`src/lib/affiliate/sync.ts` - modeled on `src/lib/ads/sync.ts`: per-account errors are
stored to `lastError`, never thrown; accounts sync sequentially; skipped when synced
within the last 6 hours unless forced.

Cron: a best-effort `try{}catch{}` block in `src/app/api/cron/sync/route.ts` beside the
ads block, inside the existing deadline budget. Manual: `POST /api/affiliate/sync`
(admin-only, force) behind a "Sync now" button.

## Engine

- `MetricsInput.affiliate?: EngineAffiliateCost[]` where a row is
  `{ shopId, date, amount, currency }` and `amount = commission + brokerageFee`,
  already filtered to `denyDate: null` and matched shops by the loader.
- Grouped once per compute like `spendByShop`; ranged with `spendInRange` (plain UTC
  day, the platform-reported-date convention ad spend uses); converted with
  `crossConvert` at each row's own day.
- New `affiliate` key in `Figures`, `ZERO_FIGURES`, `totalOf()`; subtracted in the
  net-profit expression. `dailySeries` re-runs the engine, so charts inherit it.
- `loadMetricsInput` groups `AffiliateTransaction` by (shopId, date, currency) with
  summed amounts and **adds the distinct currencies to the FX `inPlay` set** so a
  rate always exists before the first foreign-currency row lands.

## UI

- **Compare table** (`CompareTable.tsx` COLUMNS): `affiliate` / "Affiliate", money,
  hint "Addrevenue commission + fee, converted at each day's own rate".
- **Marketing page**: an Affiliate section - range total, per-shop rows, per-channel
  table (channel, sales, order value, cost) - fed by a small admin-only endpoint that
  reads `AffiliateTransaction` directly (channel detail is not in the engine's world).
- **Settings → Affiliate** (`/settings/affiliate`, nav item beside Ad accounts):
  paste a token → the server verifies it live against `/advertisers` and shows the
  brand name + markets before anything is stored (encrypted) → account list with
  lastSyncAt / lastError / unmatched-market warnings, Sync now, deactivate, delete.
  The token itself is never returned to the browser.

## Security

Tokens are pasted in the settings UI and stored with `encryptSecret()` - the Woo/Bring
pattern. They exist in the DB and in this conversation only: **never in git, never in
`.env.example`, never echoed by any API response.**

## Testing

TDD, house conventions: colocated Vitest against the real local Postgres with a marker
string per file; HTTP stubbed with `vi.stubGlobal('fetch', ...)` using response bodies
copied from the live probes. Engine/load additions tested beside the existing suites.
Playwright spec seeds transactions and walks Dashboard column, Marketing section and
the settings page. Final acceptance: a real local sync with the live tokens, then the
dashboard inspected - measured numbers, not fixtures.

## Live verification of the client (2026-08-24, read-only)

The finished `src/lib/affiliate/client.ts` was run against both real tokens before any
UI was built on it: 2,169 transactions (Panetti 2,099, Mazzetti 70) parsed with **zero
malformed rows** - every commission, fee and order value an integer, every date valid,
every row carrying a currency and id. Both advertisers resolved with their market URLs.
The currency-is-not-the-market edge showed up in the live data exactly as designed for:
Mazzetti NO/SEK ×1, Panetti FI/SEK ×4. Still zero denials across the whole history.

## Noted edges (accepted)

- Addrevenue forbids coupon/cashback affiliates on these accounts, so overlap with
  ambassador coupon commissions should not occur. If one order ever carried both, it
  would count in both lines; revisit only if it happens.
- Amounts are used as the API states them (ex any invoice VAT), matching the
  "VAT was never our money" rule used for Bring costs.
