# The app credentials stop being the client's problem

Date: 2026-07-30
Status: approved in session. Builds directly on
2026-07-30-meta-oauth-like-beprofit-design.md, which restored the login
buttons. This removes the setup that still sat under them.

## What happened

We restored "Connect with Facebook" and put a card under it asking the client
for a Meta App ID and secret, next to the Google card asking for a client ID,
a client secret and a developer token. The client sent one more screenshot of
BeProfit, and it settles the question we had not asked.

BeProfit's Google login dialog says **"Fortsett til BeProfit"**, carries
BeProfit's logo, and links BeProfit's privacy policy and terms. It is
BeProfit's own OAuth client. The merchant never registers an app, never
copies a secret, never applies for a developer token. He presses one button
and picks accounts from a list.

Four designs asked *"can the client's app do this?"* The question that
mattered was *"why is the client holding an app at all?"*

He is holding one because we put the credentials in a form. Credentials
belong in server configuration. Nothing else about this needs to change.

## The design

### One accessor, six call sites

```ts
export type PlatformApp = { clientId: string; clientSecret: string; developerToken?: string }

/** Env first, database row second. Returns null when neither is configured. */
export async function platformApp(provider: 'meta' | 'google'): Promise<PlatformApp | null>
```

Environment variables win. The database row remains as a fallback, and that
is deliberate rather than tidy: a mistyped variable name on Vercel would
otherwise take the live site dark, whereas falling back leaves it running on
the row the client already saved.

`decryptSecret` returns any value without the `enc:v1:` prefix unchanged
(`src/lib/secrets.ts:35`), so the accessor can run both paths through it - an
environment variable is plaintext and passes straight through, a database
value decrypts.

The six production readers of `db.adPlatformApp` all move to it:

| Site | Uses it for |
| --- | --- |
| `src/app/api/ads/oauth/[provider]/start/route.ts:30` | building the login URL |
| `src/app/api/ads/oauth/[provider]/callback/route.ts:42` | trading the code |
| `src/lib/ads/sync.ts:68` | Google's developer token |
| `src/app/api/ads/connections/[id]/accounts/route.ts:29` | listing Google accounts |
| `src/app/api/ads/connections/meta/route.ts:47` | the vestigial token path |
| `src/app/settings/ad-accounts/page.tsx:27` | telling the page what is configured |

### The variables

Five, holding the values the client already entered:

```
META_APP_ID
META_APP_SECRET
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_DEVELOPER_TOKEN
```

They join `.env.example` with the same explanatory tone as the entries
already there, noting that unset means "fall back to the database row".

### What the page is told

`PlatformSetup` narrows from credentials to a fact the client never types:

```ts
export type PlatformSetup = { meta: boolean; google: boolean }
```

`page.tsx` fills it by asking the accessor for each provider and reporting
whether it answered. No client ID, no `hasDeveloperToken`, and nothing
secret-shaped crosses to the browser - which is a small security improvement
on today, where the App ID and a `hasSecret` boolean both do.

### What leaves

- `PlatformSetupSection` and `PlatformCard` in `AdAccountsClient.tsx`.
- `GET` and `PUT /api/ad-platform-apps`, the whole route file. Nothing writes
  those rows once the form is gone.

Four tests die with them, and each dies because the thing it asserted no
longer exists rather than because it became inconvenient:

| Test | File | Why |
| --- | --- | --- |
| `'stores secrets encrypted and answers with booleans only'` | `src/app/api/ads/oauth.test.ts` | the route it exercises is gone |
| `'saves the platform setup and never demands a saved secret again'` | `AdAccountsClient.test.tsx` | there is no form to save |
| `'offers a one-time setup card for both platforms'` | `AdAccountsClient.test.tsx` | there is no card |
| `'walks you to the setup when the Google connect button is pressed too early'` | `AdAccountsClient.test.tsx` | there is no setup to walk to; replaced by the not-configured message test |

The `aria-label={`save ${provider} setup`}` added last branch goes with the
cards. It existed only to tell two Save buttons apart.

That last one is a door closing, and it was approved as such: rotating a
secret now means changing a Vercel variable and redeploying. That is ordinary
for server configuration and is how BeProfit works.

The `AdPlatformApp` model itself stays, unchanged, because the accessor still
reads it as the fallback.

### What the page becomes

Two buttons above the accounts table. Press one, log in, tick the ad accounts
you want, choose a shop for each, done.

The buttons stop being gated on user-entered fields. The server reports
whether each provider is configured, so the page can say
*"Facebook connect is not configured on the server"* instead of sending
somebody to a platform that will refuse them. That is an operator's message
on an admin-only page, not something the client is expected to act on.

### Error handling

| Case | What happens |
| --- | --- |
| Provider configured in neither env nor database | The button explains it is not configured on the server. No redirect. |
| Env set, no database row | Works. This is the intended production state and the case no existing test covers. |
| Env unset, database row present | Works, unchanged from today. |
| `AUTH_SECRET` rotated, so the fallback row cannot decrypt | `decryptSecret` throws, as it already does everywhere else - a visible failure, never a silent one. |

Everything downstream - the state cookie, the code exchange, the picker,
`/me/adaccounts`, bulk connect, the backfill - is untouched.

## Testing

- **Unit** - the accessor prefers env over the row, falls back to the row
  when env is absent, returns null when neither exists, passes a plaintext
  env secret through undecrypted, and decrypts an encrypted row value.
- **Route** - the start route reaches the platform dialog with env-only
  configuration and **no** database row. That is the new production shape and
  nothing tests it today.
- **Component** - no setup section, no App ID or developer token field
  anywhere, both buttons live, and the not-configured message when the server
  says a provider is missing.
- **E2E** - the page shows two connect links and no callback URL.

## What still has to happen once, and by whom

None of this is the client's recurring problem any more, but the first run
needs hands.

**Ours, on Vercel.** Set the five variables to the values already in the
database.

**In the client's Facebook app, once.** Add the *Facebook Login for Business*
product and paste
`https://panetti.vercel.app/api/ads/oauth/meta/callback` under Valid OAuth
Redirect URIs. Unchanged from the previous design, and still the one field no
API can set.

**Facebook roles.** The app is in Development mode, and Meta's App Modes
reference is explicit that such an app "can only request permissions from
role users". BeProfit shows the Facebook ad accounts under **Jacob Kjos
Hanssen**, not Philip, so Jacob needs a role on the app - Tester is enough -
or his login is refused no matter what else is right. This is the constraint
most likely to look like a bug.

**Google publishing status.** The client's OAuth client must be *In
production*. Unverified is fine: an unverified app shows one "Google hasn't
verified this app" screen the user clicks past, and is capped at 100 accounts
over the project's lifetime, which is not a limit that concerns us. But on
*Testing* status Google issues refresh tokens that **expire after seven
days**, so the sync would die every week for a reason nothing in our code
could explain. Worth checking before anyone presses the button.

**The legacy connection rename**, carried over from
2026-07-30-meta-oauth-like-beprofit.md.

## Why no App Review is needed

Recorded because four designs died on the assumption that it was.

Meta's Marketing API reference: *"If your app is only managing your ad
account, standard access to the `ads_read` and `ads_management` permissions
are sufficient"*, and *"Business apps are automatically approved for standard
access for all permissions and features available to the Business app type."*
Development mode then limits who may log in to people with a role on the app,
which is exactly the arrangement we want.

Advanced Access - App Review plus Business Verification - is what BeProfit
needs because it serves thousands of merchants who are strangers to it. We
serve one, and he is an admin on the app.
