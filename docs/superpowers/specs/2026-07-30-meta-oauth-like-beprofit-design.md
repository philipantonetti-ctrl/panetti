# Connect with Facebook comes back, because BeProfit proves it works

Date: 2026-07-30
Status: approved in session. Supersedes
2026-07-29-meta-system-user-token-design.md, and restores the Meta half of
2026-07-29-ads-oauth-connect-design.md. Google's OAuth is untouched.

## What happened

The client showed us BeProfit, the analytics tool he already uses, doing the
exact thing we gave up on. Three screenshots settle it:

- **Google:** a modal headed *"Connecting Google Ad Accounts"*, "Philip
  Antonetti — Logged in with Google ads", then a searchable checkbox list of
  five ad accounts. Tick, Save.
- **Facebook:** the same modal, *"Connecting Facebook Ad Accounts"*, "Jacob
  Kjos Hanssen — Logged in with Facebook", then a checkbox list of five
  accounts with `act_` ids.
- **The popup mid-login**, with its URL visible:
  `https://www.facebook.com/v25.0/dialog/oauth?encrypted_query_s...`

That last one is the finding. Our deleted `buildMetaAuthUrl` built
`https://www.facebook.com/v25.0/dialog/oauth?...` — the same endpoint, the
same Graph version. BeProfit is not doing anything exotic, and neither were
we.

A person's name in both modals means both store a **user access token** and
read `/me/adaccounts`, which is already what `src/lib/ads/listing.ts:28`
calls. Our Google path already behaves this way end to end. Meta had the same
code and we deleted it in `fb4686d`.

## The previous diagnosis was half wrong

2026-07-29-meta-system-user-token-design.md claimed the handshake did not
match the app: that a Business type app is served Facebook Login for
Business, where `config_id` has replaced `scope`, so sending `scope` could
never load the dialog. The first half is right. The conclusion is not.

Meta's Facebook Login for Business reference, on user access tokens:

> `config_id` has replaced `scope` (although **`scope` can still be
> included**, we recommend that you do not use it)

and on the manual login flow:

> include your configuration ID as an **optional** parameter

So `scope=ads_read,business_management` was always going to work. It was
never the cause.

**The only cause was that no login product had been added to the app.** With
no product there is nowhere for a Valid OAuth Redirect URI to live, so
Facebook fell back to its legacy App Domains check and printed *"Can't load
URL: the domain of this URL isn't included in the app's domains"* — a message
that names the wrong field. Four designs chased App Domains because the error
told them to.

The correction that matters for the client: the product to add is **Facebook
Login for Business**, not "Facebook Login". Business type apps only get the
former.

## What was actually over-engineered

`ensureMetaApp` — eighty lines that proved the App ID and secret, read the
app's `app_domains` over the Graph API, wrote our domain into them when
missing, and returned `healed`. `start/route.ts` then told the admin to
"press Connect with Facebook again", and `ensureMetaApp` could return
`healed` forever. That was a literal loop, built to automate a field that was
never the problem.

BeProfit has no equivalent. It stays deleted, along with its `covered`
helper.

## App review is not required

Meta's Marketing API authorization reference:

> If your app is only managing your ad account, standard access to the
> `ads_read` and `ads_management` permissions are sufficient.

> Business apps are automatically approved for standard access for all
> permissions and features available to the Business app type.

Philip owns his ad accounts, and the app is his. Standard Access covers it.
BeProfit needs Advanced Access — App Review plus Business Verification —
only because it serves thousands of merchants who are strangers to it.

This is also why we cannot use *our own* Meta app to hide the App ID and
secret the way BeProfit does: reading someone else's ad accounts through our
app is exactly the case that requires review. Using the client's app is what
keeps this a two-minute setup instead of a multi-week one.

## The one manual step

Registering a redirect URI has no API. It is the same wall as before, and it
is one field:

1. Open `https://developers.facebook.com/apps/1526277315425302/` and add the
   **Facebook Login for Business** product.
2. Paste `https://panetti.vercel.app/api/ads/oauth/meta/callback` under Valid
   OAuth Redirect URIs. Save changes.

Done once, never again. The setup card will display that exact URL, the way
Google's card already does, so the invisible wall becomes a visible
instruction.

## Design

### Restored from `fb4686d^`, unchanged

It was already correct.

- `buildMetaAuthUrl(clientId, redirectUri, state)` — builds
  `https://www.facebook.com/v25.0/dialog/oauth` with
  `scope=ads_read,business_management`. No `config_id`: it is optional, and
  requiring one would mean the client creating a configuration and pasting a
  second id into our app, which buys nothing when we read `/me/adaccounts`
  regardless.
- `exchangeMetaCode(app, redirectUri, code)` — code to short-lived token, then
  `grant_type=fb_exchange_token` for the ~60-day token, then `/me?fields=name`
  for the label. Falls back to the short token if the exchange is silent.
- `META_TOKEN_DAYS = 60` and the `readJson` helper.

### Changed

1. `start/route.ts` and `callback/route.ts` — the `provider !== 'google'`
   gate becomes `provider !== 'meta' && provider !== 'google'`, branching to
   the right builder and exchange. Both routes were always provider-generic;
   the gate was bolted on.
2. Meta connections store a real `expiresAt` (~60 days from the exchange).
   Google keeps `null`.
3. `AdAccountsClient.tsx` — Meta gets its `ConnectButton` back;
   `MetaTokenCard` is deleted; "Google setup" returns to "Platform setup"
   with both provider cards, Meta's showing its callback URL.
4. `sync.ts` — the expiry message points at the button again.

### Kept

The per-account "Advanced: paste credentials manually" path stays, unchanged,
for both providers — it already exists, it costs nothing, and it is the only
recovery route if a platform login breaks or a login cannot see an account.

`inspectMetaToken` and `POST /api/ads/connections/meta` also stay, and this
needs saying plainly: **once `MetaTokenCard` is deleted, nothing in the UI
calls that route.** It is unreachable code, which is normally reason to delete
it.

It survives this change on purpose, for one release. The wall it exists to
route around has stopped us four times, and it is the only path that reaches
the account picker without a redirect URI. Deleting the working fallback the
day before we first test the login it replaces is a bad trade. Its tests keep
running, so it cannot rot silently.

Once Connect with Facebook is confirmed working against the live app, a
follow-up deletes the route, `inspectMetaToken`, and their tests. That is a
tracked debt, not an accident.

### Removed

The `MetaTokenCard` on the ad accounts page. The page becomes one button per
platform, which is what the client asked for.

### The App ID and secret card returns

OAuth cannot run without them, so the card we removed on 2026-07-29 comes
back for Meta. This reverses that decision knowingly: it is the price of the
BeProfit experience, it is identical to Google's card which the client
already filled in, and the `AdPlatformApp` row he saved earlier is likely
still in the database, so the card should come back pre-filled.

## Data flow

Press Connect with Facebook, and:

1. `GET /api/ads/oauth/meta/start` — `assertAdmin`, stamp the state cookie,
   redirect to Facebook's dialog.
2. Facebook asks whoever is logged in to approve `ads_read`.
3. `GET /api/ads/oauth/meta/callback?code=&state=` — verify the cookie,
   `exchangeMetaCode`, upsert `AdConnection` by provider plus label.
4. Redirect to `?picker=<connectionId>`.
5. The picker calls `/api/ads/connections/<id>/accounts`, which calls
   `/me/adaccounts`, and renders the checkbox list.
6. Tick accounts, choose a shop for each, `POST /api/ad-accounts/bulk`,
   365-day backfill.

Steps 4 through 6 already exist and are tested. That is why this change is
small.

A full-page redirect, not BeProfit's popup. Their own troubleshooting panel
lists *"Enable Pop-ups", "Disable ad blockers", "Exit Incognito"* — warnings
that exist because popups get blocked. The redirect lands in the same place
with none of those failure modes.

## Error handling

Existing messages all still apply:

| Case | Message |
| --- | --- |
| No `AdPlatformApp` row | "Fill in the platform setup below first." |
| State cookie mismatch | "The login came back wrong. Try again." |
| User cancelled | "The login was cancelled." |
| Facebook refuses the code | Facebook's own words, via `AdApiError` |
| Token expired at sync time | "Facebook token expired." |

The unregistered redirect URI is the one failure we cannot catch: Facebook
shows its own screen before our code runs. The setup card showing the exact
callback URL is the mitigation.

`/me/adaccounts` returning an empty list is not an error. It means the person
who logged in has no ad accounts, which is real information — the picker
already says so.

## Testing

- **Unit** — the auth URL's shape; `exchangeMetaCode` on success, on a silent
  exchange falling back to the short token, and on a refusal carrying
  Facebook's message.
- **Route** — start redirects to `facebook.com` and sets the state cookie;
  callback upserts the connection and redirects to the picker; a mismatched
  state is rejected; a second login with the same label refreshes rather than
  duplicates.
- **Component** — Meta links to `/api/ads/oauth/meta/start` when set up and
  warns when not; `MetaTokenCard` is gone; the Advanced modal still works.
- **E2E** — `marketing.spec.ts` expects Connect with Facebook and the Meta
  callback URL again.

## Open question, not a blocker

Google's modal says Philip Antonetti; Facebook's says Jacob Kjos Hanssen. So
the Facebook ad accounts sit under Jacob's login. Whoever presses Connect
with Facebook must be the person who can see those accounts. This changes who
clicks, not what we build: `/me/adaccounts` returns whatever that person can
see.
