# Meta connects by system user token, and the Facebook login dialog goes away

Date: 2026-07-29
Status: approved in session. Supersedes the Meta half of
2026-07-29-ads-oauth-connect-design.md and all of
2026-07-29-meta-app-self-registration-design.md and
2026-07-29-meta-app-validation-design.md. Google's OAuth is untouched.

## What happened

Four designs tried to make "Connect with Facebook" work. Every one ended at
the same screen: *"Can't load URL: the domain of this URL isn't included in
the app's domains."* The last design let the app write its own `app_domains`
over the Graph API so the client would have nothing left to click. He still
met the wall.

Two findings from this session explain why, and both say the same thing:
stop using the dialog.

**The handshake does not match the app.** The card tells the client to
create a **Business type** app. Meta's own documentation for Facebook Login
for Business states that `config_id` **has replaced** `scope`, "which should
not be used" — and a Business type app is served Facebook Login for
Business. `buildMetaAuthUrl` sends `scope=ads_read,business_management` and
no `config_id`. So our instructions and our code disagree, and following the
instructions perfectly still produces that screen. The error text names App
Domains because that is the legacy check the dialog falls back to when it
cannot resolve a login configuration; it is not the real gap. That is why
every fix landed back in the same place.

**The self-healing rests on an unconfirmed API.** The previous design's
premise was that the Application node is writable with an app access token.
That could not be reconfirmed against Meta's current reference. If the write
returns success without persisting, `ensureMetaApp` reports `healed` forever
and `/start` answers "press Connect with Facebook again" forever. That is a
literal loop in our own code, and it is the one the client reported.

**The honest reading:** the connect button was never one paste away from
working. It needed a login product, a configuration, a redirect URI and a
code change, all of which live inside developers.facebook.com or inside a
handshake we would have to rewrite. A system user token needs none of them.

## Why the token path failed before, and what is different now

`2026-07-29-ads-oauth-connect-design.md` records the reason OAuth was built:
"Pasting a system-user token proved too hard for the client." That objection
was fair and it is the thing this design has to answer, or we simply loop
the other way.

What was actually hard was never the token. It was that the old path asked
for the token **once per ad account**, inside a modal reached through a link
labelled "Advanced", with the steps living in a chat message rather than on
the screen, and with no check that told him which part he got wrong. A bad
token failed at the first sync, as a red badge, days later.

This design changes all four:

- **Paste once, not per account.** The token becomes a connection; the
  existing picker lists every account it can see and connects them together.
- **The steps live on the page**, numbered, with direct links, next to the
  field they belong to. Not in a message he has to keep.
- **The token is checked while he watches**, and the answer names the exact
  thing to fix.
- **It is the main path**, not an Advanced link behind a broken button.

## Design

**The token becomes an `AdConnection`.** No schema change: `secret` already
holds an encrypted credential and `expiresAt` is already nullable, which is
exactly "never expires". `resolveCredentials` already prefers a connection
over pasted credentials and only checks expiry when `expiresAt` is set, so a
non-expiring token flows through the existing sync untouched. The picker,
`POST /api/ad-accounts/bulk`, the per-account backfill and the "via {label}"
column in the accounts table all keep working with no changes at all.

**`POST /api/ads/connections/meta` (admin).** Body `{ token }`. In order:
the Meta `AdPlatformApp` is loaded (missing → 400, fill in the app first);
an app access token is minted by `client_credentials` — the same call
`ensureMetaApp` already makes, extracted as `metaAppToken()`; then
`GET /debug_token` inspects the pasted token; then `GET /me?fields=name`
proves it and supplies the label; then the connection is upserted on
provider + label, the same de-dupe rule the OAuth callback uses, so
re-pasting refreshes instead of piling up rows. Answers
`{ connectionId, label, expiresAt }`, and the page opens the existing
picker with it.

**What `debug_token` decides.** `is_valid: false` → "Facebook says this
token is not valid. Generate it again." A `scopes` array that is present and
lacks `ads_read` → "This token has no ads_read permission. Generate it again
and tick ads_read." An `app_id` that disagrees with our client id → "This
token belongs to a different Facebook app." A falsy, zero or absent
`expires_at` → `expiresAt: null`, never expires; otherwise the date, shown
back to him so a 60-day token is a known fact rather than a surprise.

**The check is strict only where Meta is explicit.** Neither `expires_at: 0`
meaning never, nor a `SYSTEM_USER` token type, is documented in the current
reference; both are folklore. So absence proves nothing: a `debug_token`
call that fails, or answers without the field, blocks nothing and falls
through to the `/me` check. Only `/me` is fatal, because only `/me` proves
the token actually works. Over-strictness here would just build a new wall
in place of the one being removed, which is the whole mistake this design
exists to undo.

**The page stops pointing at a dead button.** The Meta `ConnectButton` goes,
along with the subtitle and empty-state lines that tell him to press it.
"Connect with Google" and "Sync now" stay exactly as they are. In its place
a Meta card in the house style: the numbered steps with direct links, one
write-only token field, Save. The App ID and secret stay on the setup card,
now earning their keep by proving the token and by naming the app he must
pick when he generates it.

**The empty list is a real answer, not an empty table.** A token whose
system user was never assigned any assets lists nothing, and that is the
most likely stumble by far. The picker says so plainly and says what to do:
open the system user in Business settings, press Add assets, choose Ad
accounts, tick them, turn on View performance.

**Dead code goes.** `ensureMetaApp`, `exchangeMetaCode`, `buildMetaAuthUrl`
and the Meta branches of the OAuth start and callback routes are removed,
which is what deletes the "press Connect again" loop. `sync.ts`'s expiry
message loses its instruction to press a button that no longer exists and
becomes "Facebook token expired. Paste a new system user token." The
per-account "Advanced: paste credentials manually" modal stays exactly as it
is: it works today, it is the fallback for a single odd account, and nothing
about it needs to change.

**Migration: none.** Production has no Meta ad accounts connected — the
settings page reads "Nothing connected yet" — so there is nothing to move.

## Testing

Unit, stubbed fetch, on the verdict logic alone: a never-expiring token
gives a null expiry; a dated `expires_at` gives that date; a `scopes` array
without `ads_read` is refused by name; a foreign `app_id` is refused by
name; an invalid token is refused with Facebook's words; an unreadable or
failed `debug_token` answer yields no opinion and blocks nothing.

Route, mocked fetch against the real database: a good token creates an
encrypted connection and returns its id; pasting again under the same label
updates that row rather than adding one; a token Meta rejects at `/me`
answers 400 carrying Meta's own message; a missing platform app answers 400;
a non-admin session answers 403; the stored secret is never echoed back in
any response.

Component: the Meta card posts the token and opens the picker on success,
keeps the card open and shows the message on failure, and the page no longer
renders a "Connect with Facebook" button. The picker renders the assets
message when the account list comes back empty.

No new e2e: it needs a live Meta login. Four existing places assert the
behaviour being deleted and must come with it, or the suite goes red for the
right reason and gets "fixed" the wrong way:

- `AdAccountsClient.test.tsx:80-95` asserts the Meta connect button is a
  disabled span before setup and a live link after. The Meta half goes; the
  Google half stays exactly as it is.
- `AdAccountsClient.test.tsx:185-187` asserts the "The Facebook app was just
  fixed. Press Connect with Facebook again." notice renders. That notice is
  the loop. The test goes with it.
- `e2e/marketing.spec.ts:63-65` asserts a visible "Connect with Facebook"
  link. It becomes an assertion that the Meta token card is on the page and
  that no such link exists.
- `src/app/api/ads/oauth.test.ts` covers `ensureMetaApp` and the Meta start
  and callback branches. Every Meta case goes; the Google cases stay and the
  file keeps its name.

## What the client does, once

1. Open https://business.facebook.com/settings/system-users
2. Press Add, name it "panetti analytics", role Admin, create it.
3. Press Add assets, choose Ad accounts, tick the ad accounts, turn on
   "View performance", save. Skipping this is what makes the list empty.
4. Press Generate token, choose the app, set expiration to Never, tick
   ads_read, generate, copy it. If the app is not in the list, add it at
   https://business.facebook.com/settings/apps first.
5. Open https://panetti.vercel.app/settings/ad-accounts, paste the token,
   press Save.
6. Tick the ad accounts, pick the shop for each, press Connect.

One preflight that has nothing to do with our code and breaks everything if
it is wrong: **"Require app secret proof for server API calls" must be off**
in the app's Advanced settings. Our Graph calls do not send
`appsecret_proof`, so with it on, every call fails whichever path we build.
