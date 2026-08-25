# One-click ad account connecting (OAuth) + the client's Meta metrics

Date: 2026-07-29
Status: approved for implementation. Builds on 2026-07-29-ad-platforms-design.md.

## Why

Pasting a system-user token proved too hard for the client. He showed BeProfit's flow:
press "Connect with Google", log in, tick the ad accounts (several at once), done. He
also listed the Meta metrics he wants: amount spent, purchases conversion value, cost
per result, purchase ROAS, CPM, cost per unique link click, unique CTR, video plays,
15-second hold, average play time, frequency.

## Approaches considered for the login flow

1. **Our own verified platform apps** (what BeProfit has). Needs Meta App Review and
   Google OAuth verification: weeks, and an app owner organisation. Rejected for now.
2. **Keep manual tokens, write a better guide.** The client already said no. Rejected.
3. **Client-owned apps + standard OAuth (chosen).** A Meta app in development mode
   grants any permission to its own admins without App Review - and the only person
   who will ever log in IS the app admin (Philip). A Google OAuth client set to
   "In production" (unverified) shows a one-time warning screen he can click through,
   and its refresh tokens do not expire the way "Testing" ones do (7 days). Each is a
   one-time five-minute setup; after that, connecting is exactly his screenshots:
   log in, tick accounts, save. The Google Ads developer token (from his manager
   account's API Center) is still required by Google regardless of approach.

## Data model changes

```prisma
// The client's own Meta app / Google OAuth client, entered once in settings.
model AdPlatformApp {
  id             String   @id @default(cuid())
  provider       String   @unique // "meta" | "google"
  clientId       String   // Meta App ID / Google client ID
  clientSecret   String   // encrypted
  developerToken String?  // Google only, encrypted
  createdAt      DateTime @default(now())
}

// One "Logged in with Facebook/Google" session; many ad accounts can hang off it.
model AdConnection {
  id        String      @id @default(cuid())
  provider  String      // "meta" | "google"
  label     String      // who logged in, from /me or the OAuth id token
  secret    String      // encrypted: Meta long-lived user token / Google refresh token
  expiresAt DateTime?   // Meta tokens live ~60 days; null for Google
  createdAt DateTime    @default(now())
  accounts  AdAccount[]
}
```

`AdAccount` gains `connectionId String?` (`AdConnection` relation, `onDelete: SetNull`)
and `credentials` becomes nullable. Resolution order in the sync: a connection wins;
otherwise the stored manual credentials; neither → the account errors visibly. The
manual paste path stays as an "Advanced" fallback, so nothing existing breaks.

`AdSpend` gains the additive daily metrics behind the client's list (defaults 0, so
`db push` is safe): `linkClicks Int`, `conversions Float` (Google reports fractions),
`conversionValue Int` (minor units, account currency), `videoViews3s Int`,
`thruplays Int`, `reach Int`.

## OAuth plumbing

- `GET /api/ads/oauth/[provider]/start` (admin): random state into an httpOnly
  10-minute cookie, then redirect to the provider's dialog.
  - Meta: `facebook.com/v25.0/dialog/oauth` with `scope=ads_read,business_management`.
  - Google: `accounts.google.com/o/oauth2/v2/auth` with `scope=…/auth/adwords`,
    `access_type=offline`, `prompt=consent` (so a refresh token always comes back).
  - Redirect URI is `${origin}/api/ads/oauth/[provider]/callback`; the settings page
    shows this exact URL so the client can paste it into his app config.
- `GET /api/ads/oauth/[provider]/callback` (admin): state must match the cookie.
  - Meta: exchange code → short token → `fb_exchange_token` → long-lived (~60 days);
    `GET /me?fields=name` for the label; store connection with `expiresAt`.
  - Google: exchange code at `oauth2.googleapis.com/token` → refresh token (+ label
    via the userinfo endpoint with the fresh access token; fall back to "Google Ads").
  - Then redirect to `/settings/ad-accounts?picker=<connectionId>` - the page opens
    the account picker by itself. Errors redirect with `?error=<message>`.
- Reconnect = run the same flow again; the callback updates the existing connection
  for that provider+label rather than piling up rows (match on provider+label, else
  create). Meta connections nearing expiry show a "Reconnect" hint; an expired token
  surfaces as the account's lastError with plain words.

## Account picking

- `GET /api/ads/connections/[id]/accounts` (admin): the choosable ad accounts.
  - Meta: `GET /me/adaccounts?fields=name,account_id,currency` (follows paging).
  - Google: `customers:listAccessibleCustomers`, then per accessible customer a
    `customer_client` GAQL query (level <= 1, with that customer as
    login-customer-id) to flatten manager trees into leaf accounts; each leaf
    remembers which manager id it was reached through.
  - Every entry: `{ externalId, name, currency, alreadyConnected, suggestedShopId }`.
- Shop suggestion: normalised token match between account name and shop names with a
  small Nordic alias table (danmark=denmark, norge=norway, sverige=sweden,
  suomi=finland, and the country codes no/se/dk/fi/de). "Mazzetti NO" → Mazzetti.no,
  "Panetti Danmark" → Panetti Denmark. Pure helper, unit tested; a wrong guess is one
  dropdown away from fixed.
- `POST /api/ad-accounts/bulk` (admin): `{ connectionId, accounts: [{ externalId,
  shopId, loginCustomerId? }] }`. Creates each account bound to the connection (name
  and currency from the listing), skips ones already connected, then backfills each
  a year of daily rows sequentially, best-effort per account. Returns per-account
  results for the settings page message line.

## Wider Meta/Google fetches

Meta insights adds `inline_link_clicks, reach, actions, action_values,
video_thruplay_watched_actions` to the daily query. Parsing: `omni_purchase` in
`actions` → conversions, in `action_values` → conversionValue (toMinor);
`video_view` in `actions` → videoViews3s; first value of
`video_thruplay_watched_actions` → thruplays. Google adds `metrics.conversions,
metrics.conversions_value` (value in whole currency units → toMinor); Google's
clicks double as linkClicks (that is what a search/shopping click is).

## Marketing page

- Row/total additions (converted like spend where money): `conversions`,
  `conversionValue`, `platformRoas` (= conversionValue / spend),
  `costPerPurchase` (= spend / conversions), `avgPurchaseValue`
  (= conversionValue / conversions), `cpm` (= spend / impressions × 1000),
  `costPerLinkClick`, `linkCtr` (= linkClicks / impressions), `holdRate`
  (= thruplays / videoViews3s), `videoViews3s`, `thruplays`. Null with a dash when
  the denominator is zero, as everywhere.
- Two ROAS numbers exist and are labelled so they cannot be confused: **P. ROAS**
  (what the platform attributes: conversion value ÷ spend - matches Ads Manager) and
  **Store ROAS** (whole-store gross revenue ÷ spend - matches the dashboard).
- Stat cards become: AD SPEND, PURCHASE ROAS, COST PER PURCHASE, CONV. VALUE.
- The table adopts CompareTable's column-visibility toggle (localStorage key
  `marketing-columns`). Default visible: Shop, Ad spend, Purchases, Conv. value,
  P. ROAS, Cost/purchase, Store ROAS, Gross revenue, Orders, CPA. Hidden until
  ticked: Meta, Google, CPM, Cost/link click, Link CTR, CPC, CTR, Hold rate,
  3s plays, ThruPlays, Clicks.
- Deferred with a note, not silently dropped: **frequency** and **average play
  time** are not additive across days (summing daily reach overstates uniques), so
  an honest number needs a range-level live call to Meta; they come later if the
  client still wants them.

## Settings page

- New "Platform setup" section, one card per provider: shows the exact redirect URI
  to paste, fields for App ID/secret (Meta) and client ID/secret/developer token
  (Google), secrets write-only (saved state shows "saved"). PUT
  `/api/ad-platform-apps`, admin, encrypted at rest, never echoed back.
- "Connect with Facebook" / "Connect with Google" buttons (enabled once the matching
  platform setup exists) linking to the start route. On return with `?picker=`, the
  account picker modal opens: checkbox rows (name, id, currency), a shop dropdown per
  row prefilled by the suggester, already-connected rows shown ticked and locked.
- The old paste-credentials modal remains behind an "Advanced: paste credentials
  manually" link. Existing accounts, routes, and tests keep working unchanged.

## Security

State-checked OAuth, all new routes admin-only, every secret through
`encryptSecret`, no secret ever serialised into a response, callback errors carry
the provider's words in the redirect message rather than a stack trace.

## Testing

- Unit: shop suggester (Nordic aliases), Meta action/value parsing, Google
  conversions parsing, expiry maths for connections, ratio maths for the new columns.
- Integration (mocked fetch, real DB): callback route stores an encrypted
  connection and updates rather than duplicates on reconnect; accounts listing
  flattens a Google manager tree; bulk connect creates + backfills + skips
  duplicates; marketing route returns the new fields; sync resolves connection
  credentials before manual ones and errors visibly with neither.
- Component: platform setup card save flow, picker modal (suggestions prefilled,
  bulk save, error keeps modal open), stats cards, table toggles.
- E2E: settings page shows Platform setup and Connect buttons; marketing page shows
  the new stat cards and columns from seeded data (seed gains metric values and one
  seeded connection).

## What the client does, once per platform

- **Meta (5 min):** developers.facebook.com → Create app (type Business) → note App
  ID + App secret → App settings → add the shown redirect URI under Facebook Login →
  keep the app in Development mode → paste ID + secret into Platform setup. Because
  he is the app's admin, no App Review is ever needed.
- **Google (10 min):** console.cloud.google.com → OAuth client (Web application)
  with the shown redirect URI → OAuth consent screen set to "In production" (the
  one-time "unverified app" warning is expected; press Advanced → continue) → paste
  client ID + secret. Plus the developer token from Google Ads → manager account →
  API Center (apply for Basic access if not already granted).

After that, forever: press Connect, log in, tick accounts, save.
