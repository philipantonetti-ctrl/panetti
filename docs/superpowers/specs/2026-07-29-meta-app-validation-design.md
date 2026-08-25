# Save-time validation of the Meta app, and instructions that name every click

Date: 2026-07-29
Status: approved for implementation. Follows 2026-07-29-budget-and-connect-ux-design.md.

## What happened

The client saved his App ID and secret, pressed Connect with Facebook, and
Facebook answered "Can't load URL: the domain of this URL isn't included in
the app's domains." His screenshot proves our side sent the right client_id
and the exact right redirect_uri - the missing piece is inside his Meta app's
settings (App Domains and the Facebook Login redirect URL), which only he can
edit. Today the system lets that half-finished setup save silently and lets
Facebook deliver the bad news later. It should be caught at save.

## Design

**Validate the pair.** Saving the Meta platform setup now proves the App ID +
secret against Meta first: `GET /oauth/access_token?grant_type=
client_credentials` mints the app access token. A wrong pair is a 400 with
Facebook's own words and nothing saved - a typo dies at the keyboard, not at
the login dialog.

**Read the app's own settings (best-effort).** With that token,
`GET /{app-id}?fields=app_domains,website_url` (verified: an app access token
may read all its own fields). If `app_domains` does not contain our domain,
the save still succeeds but returns a `warning` naming the exact two values to
paste: the domain into App Domains, the callback URL into Facebook Login →
Valid OAuth Redirect URIs. If the read fails for any reason, no warning - the
check is a courtesy, never a blocker.

**Show it where it happened.** The Meta setup card renders the warning as a
persistent amber note under the Save button (not a vanishing toast), and its
help text becomes numbered steps: 1) Settings → Basic → App Domains: add the
domain (shown, copyable). 2) Same page, Add platform → Website → Site URL:
https://<domain>. 3) Add the Facebook Login product, then Facebook Login →
Settings → Valid OAuth Redirect URIs: the callback URL (shown, copyable).
4) Keep the app in Development mode. The card shows both values, domain and
callback URL, each in its own copy-friendly box.

Google saves stay as they are: Google offers no silent way to prove a client
id + secret without a user login, and pretending otherwise would be theater.

## Testing

Unit (`validateMetaApp`, stubbed fetch): wrong pair throws with Facebook's
message; good pair with the domain present returns no warning; good pair with
the domain absent returns a warning naming the domain; unreadable fields
return no warning. Route: PUT meta with a bad secret is a 400 and stores
nothing; a good save passes the warning through; the existing save test gains
the stubbed happy path. Component: the card shows the returned warning and
keeps showing it. Everything else stays green.
