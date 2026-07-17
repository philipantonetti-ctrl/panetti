# Shop connection completion — design

**Date:** 2026-07-17
**Status:** Approved (key storage: encrypted with a key derived from AUTH_SECRET — no new setup)

## Why

The sync machinery is built and tested (`src/lib/woo/client.ts`, `map.ts`, `sync.ts`,
the Connect modal, the Sync all button) — but production has zero shops and there is
**no way to create one**: no Add-shop button, no `POST /api/shops`. Shops only ever
came from the demo seed, which we deliberately do not run in production. This one
missing front door is why the client cannot track real sales yet.

Two safety bugs must also die before real keys are stored:

1. `PATCH /api/shops/[id]` writes `wooKey || null` — saving the form with blank key
   fields **erases the stored keys**.
2. `ShopsClient.syncAll()` reads `data.results ?? []` without checking `res.ok` — a
   completely failed sync reports **"Synced 0 orders from 0 shop(s)"** as if it worked.

## 1. Add shop

- **UI:** an "Add shop" button in the Shops page header next to "Sync all". Modal with
  two fields: **Name** (e.g. "Panetti Norway") and **Currency** (the same
  `SearchableSelect` + `allCurrencies()` picker the expenses form uses; USD/EUR/NOK/
  SEK/DKK/GBP listed first; no default — the currency must be chosen).
  Save → toast success, close, `router.refresh()`. Failure → toast error, modal stays
  open. Client-side check before submit: both fields filled.
- **API:** `POST /api/shops`, admin-only (`assertAdmin`), zod body:
  `name` trimmed, 1–60 chars; `currency` uppercased, must match `/^[A-Z]{3}$/`.
  Creates the shop with `active: true` and no credentials. `400` with a plain-language
  error on bad input, `403` non-admin, `500` fallback — same shape as every route.

## 2. Saving must never wipe keys

New `PATCH` semantics, one rule: **an empty string means "leave the stored value
unchanged"** — for all three of `wooUrl`, `wooKey`, `wooSecret`. A non-empty value
replaces (keys get encrypted first — see §3). There is no disconnect feature (out of
scope), so no field ever needs "set me to nothing".

Modal affordance: when the shop is connected, the key and secret fields show the
placeholder **"saved — leave blank to keep"**. First-time connect validates that URL,
key and secret are all filled before submitting.

## 3. Keys encrypted at rest

New module `src/lib/secrets.ts`, Node's built-in `crypto` only — **no new dependency**:

- `encryptSecret(plain)` → `enc:v1:<base64 iv>:<base64 ciphertext+tag>`
  AES-256-GCM; key = HKDF-SHA256 of `AUTH_SECRET` (salt `"shop-credentials"`,
  info `"v1"`); fresh random 12-byte IV each call.
- `decryptSecret(stored)` → plain. A value **without** the `enc:v1:` prefix is
  returned as-is (covers local dev rows that predate this). Tampered or
  wrong-key values throw.

Used in exactly two places: `PATCH` encrypts before writing; `syncShop` decrypts
before calling WooCommerce. On decrypt failure the shop's sync result is
`ok: false` with **"Saved keys can't be read — reconnect this shop."** — a visible,
safe failure (happens only if AUTH_SECRET is changed after shops were connected).

Keys never reach the browser: `settings/shops/page.tsx` already sends only a derived
`connected` boolean (verified, line 21). Deploy needs nothing new — `AUTH_SECRET`
is already on Vercel, and the columns are already `String?` so **no schema change**.

## 4. Sync must tell the truth

- `syncAll()` in `ShopsClient` checks `res.ok` (and catches network failure): on
  failure, toast the server's error and show no fake summary. The existing per-shop
  summary line stays for successful responses — it already names failed shops.
- `fetchOrders` currently stops silently at 50 pages × 100 orders. New behaviour: if
  page 50 comes back full (more pages exist), **throw before anything is stored** —
  message: *"This store returned over 5,000 orders in one pull. Sync stopped so
  nothing is skipped silently — this store needs a staged first sync."* The watermark
  (`lastSyncAt`) is untouched, so nothing is ever half-marked as done. At the
  client's scale (tens of orders per month per shop) this should never fire; if a
  store really holds 5,000+ orders, we build staged backfill then.

## 5. Honest labels

- Badge for an unconnected shop: **"Not connected"** (was "Sample data" — on live, an
  unconnected shop has *no* data, sample or otherwise).
- Page subtitle: **"Connect each WooCommerce store with its API keys — synced orders
  update every screen."** (was "…Until a store is connected it shows sample data.")

## The client's end-to-end flow after this ships

Settings → Shops → **Add shop** (name + currency) → **Connect** (paste the two keys
from WordPress: WooCommerce → Settings → Advanced → REST API → Add key, Read) →
**Sync all** → real orders land, ambassador codes attribute automatically, dashboards
fill with real figures.

## Testing

- `secrets`: round-trip; two encryptions of the same value differ (fresh IV);
  tampered value throws; non-prefixed value passes through unchanged.
- `POST /api/shops`: creates; rejects empty/long name and bad currency; 403 for
  non-admin.
- `PATCH`: blank key/secret keeps the stored (encrypted) values; typed values
  replace and are stored with the `enc:v1:` prefix; blank URL keeps the stored URL.
- `syncShop`: decrypt failure → `ok: false` with the reconnect message; capped fetch
  (50 full pages, mocked) → `ok: false`, watermark untouched, nothing stored.
- `ShopsClient`: failed sync response → error toast, no "Synced 0 orders" message.
- Full suite, `tsc`, `next build`, Playwright E2E before deploy.

## Out of scope

- Disconnect / delete / rename shop.
- Staged backfill for 5,000+-order stores (built when actually needed).
- Automatic scheduled sync (button-triggered only for now; a Vercel cron can come
  later).
- Rotating AUTH_SECRET migration tooling — if it rotates, shops are re-connected by
  hand, and the sync error says exactly that.
