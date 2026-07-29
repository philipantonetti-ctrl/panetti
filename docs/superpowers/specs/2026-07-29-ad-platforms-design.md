# Meta Ads + Google Ads integration: ad spend, ROAS, CPA per shop

Date: 2026-07-29
Status: approved for implementation

## Goal

The client wants his Meta (Facebook/Instagram) and Google ad accounts connected so the
dashboard can show ad spend, ROAS, and CPA per shop. The system already holds the other
half of the equation (orders and revenue per shop), so once daily spend flows in, the
ratios come for free and stay consistent with the rest of the app.

## Approaches considered

1. **Third-party aggregator** (Supermetrics, Windsor.ai). Fast, but a monthly fee and an
   external dependency forever. Rejected.
2. **Full in-app OAuth flows** (Meta Login, Google consent screen). The nicest connect
   experience, but requires Meta App Review for `ads_read` and Google OAuth verification:
   weeks of approval before anything works. Rejected for v1; can be layered on later
   without changing the data model.
3. **Direct API integration with pasted credentials** (chosen). The client pastes a Meta
   system-user token and Google API credentials, exactly the way WooCommerce stores are
   already connected with pasted REST keys. Zero external approvals, encrypted at rest,
   fully testable with mocked HTTP.

## Data sources (verified against current docs, July 2026)

**Meta Marketing API, Graph v25.0.**
`GET https://graph.facebook.com/v25.0/act_{id}/insights` with `level=account`,
`time_increment=1`, `time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}`,
`fields=spend,impressions,clicks`, `limit=500`, `access_token=...`.
Response: `data: [{ spend: "5339.5", impressions: "...", clicks: "...", date_start,
date_stop }]` plus `paging.next` when more pages exist (followed, capped defensively).
Spend arrives as a decimal string in the ad account's own currency. Auth: a system-user
access token with `ads_read` (generated in Business settings, does not expire).
Lookback limit is 37 months; we backfill 12.

**Google Ads API v25 (REST).**
`POST https://googleads.googleapis.com/v25/customers/{customerId}/googleAds:searchStream`
with headers `Authorization: Bearer <access token>`, `developer-token`, and
`login-customer-id` when access goes through a manager (MCC) account. Body:
`{"query": "SELECT segments.date, metrics.cost_micros, metrics.impressions,
metrics.clicks FROM customer WHERE segments.date BETWEEN '...' AND '...'"}`.
The access token is minted per sync from a stored OAuth refresh token via
`POST https://oauth2.googleapis.com/token`. `cost_micros` is micros of the account
currency: minor units = round(micros / 10 000). The REST response is an array of chunks,
each with `results`; field names may arrive camelCase (`costMicros`) so the parser
accepts both spellings.

**Connect-time verification.** Saving an account calls the platform immediately:
Meta `GET /act_{id}?fields=name,currency`, Google
`SELECT customer.descriptive_name, customer.currency_code FROM customer`. Bad
credentials are a 400 with the provider's message and nothing is stored. The account's
display name and currency come from the platform, never typed by hand.

## Schema

```prisma
model AdAccount {
  id          String    @id @default(cuid())
  shopId      String
  provider    String    // 'meta' | 'google'
  externalId  String    // Meta: ad account id digits (no act_); Google: customer id (no dashes)
  name        String    // from the platform at connect time
  currency    String    // from the platform at connect time
  credentials String    // encrypted JSON, provider-specific shape
  active      Boolean   @default(true)
  lastSyncAt  DateTime?
  lastError   String?
  createdAt   DateTime  @default(now())
  shop        Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  spend       AdSpend[]
  @@unique([provider, externalId])
  @@index([shopId])
}

model AdSpend {
  id          String    @id @default(cuid())
  accountId   String
  date        DateTime  // UTC midnight
  spend       Int       // minor units, in the account's currency
  impressions Int
  clicks      Int
  account     AdAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  @@unique([accountId, date])
  @@index([date])
}
```

Credentials JSON: Meta `{ accessToken }`; Google `{ developerToken, clientId,
clientSecret, refreshToken, loginCustomerId? }`. The whole JSON string is encrypted with
the existing `encryptSecret` (AES-256-GCM keyed from AUTH_SECRET, same as Woo keys) and
never leaves the server. Every ad account maps to exactly one shop; that mapping is what
makes per-shop ROAS possible.

## Sync

New module `src/lib/ads/`:

- `meta.ts`: pure parser + fetcher for the insights endpoint (follows `paging.next`,
  page cap as a runaway guard), plus `verifyMeta`.
- `google.ts`: refresh-token exchange, searchStream fetcher, chunk parser tolerant of
  camelCase and snake_case, plus `verifyGoogle`.
- `sync.ts`: `syncAdAccount` picks the window: first sync backfills 365 days, later
  syncs re-fetch the last 35 days because platforms restate recent spend inside their
  attribution windows. Rows upsert on `(accountId, date)` so re-fetching is idempotent.
  Success sets `lastSyncAt` and clears `lastError`; failure stores the message on the
  account and never throws out of `syncAllAdAccounts`.

Triggers: the existing 15-minute Vercel cron (`/api/cron/sync`) calls
`syncAllAdAccounts()` best-effort after the Woo sync, with a 6-hour per-account
throttle (Meta refreshes insights every 3-6 hours; more often is wasted quota). A
manual `POST /api/ads/sync` (admin, `force`) backs the "Sync now" button. Connecting an
account runs its initial backfill synchronously so data appears immediately.

`ensureRates` gains the ad-account currencies alongside shop currencies wherever the
marketing metrics are computed, so an account billed in EUR or USD converts exactly like
everything else: at each day's ECB rate, with the nearest-earlier fallback.

## Metrics

New route `GET /api/marketing` (admin only, same `preset|from,to` and `shops` params as
`/api/metrics`, same `private, no-store` headers). It reuses `loadMetricsInput` +
`computeMetrics` for the order side, so "orders" and "gross revenue" mean exactly what
the dashboard means by them (paid orders only, VAT included in gross revenue), then lays
converted daily spend over it:

Per shop row: `spend`, `metaSpend`, `googleSpend`, `impressions`, `clicks`, `orders`,
`grossRevenue`, and the ratios:

- **ROAS** = gross revenue / ad spend (what the platforms themselves call purchase
  ROAS: revenue including VAT over spend). Null when spend is zero.
- **CPA** = ad spend / paid orders. Uses the store's own paid orders as the source of
  truth, not platform-reported conversions, so it can never disagree with the Orders
  page. Null when orders are zero.
- **CPC** = spend / clicks; **CTR** = clicks / impressions. Null when the denominator
  is zero. Nulls render as dashes.

Plus a `total` row, a daily `series` of spend vs gross revenue for the chart, and the
`displayCurrency` rule the dashboard already uses (one shop selected: its currency;
otherwise USD).

Deliberately **not** in v1: ad spend does not enter net profit. The client may already
book ad spend under operational expenses; auto-importing it into profit as well would
double-count. Folding it into net profit (and retiring the manual entry) is a one-line
follow-up once the client confirms.

## UI

- **Marketing page** (`/marketing`, nav under Analytics after Orders): DateFilter +
  ShopFilter + live tick, four stat cards (Ad spend, ROAS, CPA, CPC), a spend-vs-revenue
  daily chart, and a per-shop table (sticky first column, money formatting, sortable by
  the existing CompareTable idiom). Empty state when no accounts are connected links to
  the settings page.
- **Ad accounts page** (`/settings/ad-accounts`, nav under Setup after Shops): table of
  accounts (name, provider, shop, currency, status badge from lastError/lastSyncAt, last
  sync), "Connect account" modal (provider toggle switches the credential fields, shop
  dropdown, inline help pointing at where each credential lives), "Sync now" button with
  per-account results, edit (blank field = keep current, like the Woo modal) and delete
  (cascades spend rows).

## Security

Credentials are encrypted at rest with the existing AES-256-GCM helper and are never
included in any API response. All new routes are admin-gated. No new environment
variables; nothing to configure on Vercel.

## Testing

- Unit: both parsers (including Meta paging and Google camel/snake tolerance),
  micros-to-minor rounding, sync window selection, ratio math with zero denominators.
- Integration (local DB, mocked fetch): sync upserts idempotently; connect route
  verifies live, stores encrypted (asserted `enc:v1:` prefix), backfills, 400s cleanly
  on bad credentials with nothing stored; list route never leaks credentials; delete
  cascades; `/api/marketing` returns exact hand-computed ROAS/CPA on a fixture and
  respects the shops filter.
- Component: MarketingClient (stats, table, empty state), AdAccountsClient (list, add
  flow, error keeps modal open, sync results).
- E2E (Playwright, seeded DB): marketing page renders seeded spend with KPIs and table,
  shop filter narrows, settings page lists seeded accounts. No external HTTP anywhere in
  tests.
- Seed: a few ad accounts across shops with plaintext dummy credentials (never called)
  and ~90 days of realistic AdSpend rows.

## What the client must provide

- **Meta**: the ad account ID, and a system-user access token with `ads_read` from
  Business settings (does not expire).
- **Google**: the customer ID, a developer token (API Center of their manager account,
  Basic access), an OAuth client ID + secret, a refresh token, and the manager account
  ID if access goes through one. Generating the refresh token is fiddly; we offer to
  walk through it with them.
