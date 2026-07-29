# The Meta app registers this site by itself, and the connect button refuses dead ends

Date: 2026-07-29
Status: approved for implementation. Follows 2026-07-29-meta-app-validation-design.md.

## What happened

Save-time validation shipped this morning and the client met the same wall
again: press Connect with Facebook, Facebook answers "Can't load URL: the
domain of this URL isn't included in the app's domains." The warning names
every click, but the clicks live inside developers.facebook.com, and they
keep not happening. Three designs in, the lesson is plain: any fix that ends
with "and then the client edits four Facebook settings" is not a fix.

Meta's own API closes the loop. The Application node is writable with the
app access token the save already mints: `app_domains` and `website_url` are
both updatable fields (verified against the current Graph API reference,
which also spells out that subdomains of a listed domain count as covered).
The system can do the clicking itself.

## Design

**The app heals itself.** `ensureMetaApp` (née `validateMetaApp`) keeps the
pair check, then reads `app_domains,website_url`. When the domain is missing
it no longer stops at words: it POSTs the app node with the existing domains
plus ours, and sets `website_url` to `https://<domain>/` when none exists —
a website is what makes App Domains valid at all. A successful write means
no warning and nothing for the client to do. Only a refused write falls back
to the warning, still naming the two pastes with their exact values.

**Facebook's matching, not ours.** Meta counts subdomains of every listed
domain as covered, so the check does too: `panetti.com` in the list covers
`www.panetti.com`. No false warnings, no needless writes.

**The button checks before it walks.** /start runs the same ensure for Meta
before redirecting. A wrong pair bounces back to the settings page with
Facebook's words; a domain that could not be written bounces back with the
paste-this-here warning; an unreachable Meta lets the login proceed — our
own courtesy check must never be the blocker. The client meets instructions
where they can act, never Facebook's dead end. Every click heals drift too:
whatever host the site is on that day gets registered before Facebook sees
it.

**The card sheds two steps.** App Domains and the Website platform are no
longer the client's job; the card now says saving adds this site to the app
for you, and the App Domains copy box goes away. The Facebook Login redirect
paste stays — that field has no public API — with the callback URL still
shown copyable.

## Testing

Unit (stubbed fetch): a listed domain and a listed parent domain both stay
quiet without a write; a missing domain writes the merged domain list and
keeps an existing website_url; an app with no website_url gets one; a
refused write warns with both links and both values; an unreadable settings
answer or a network error after the pair check stays quiet; a wrong pair
still throws Facebook's words. Route: /start with a healthy app stamps the
state cookie and redirects to Facebook; /start writes a missing domain and
then redirects; a refused write bounces to the settings page with the
warning; an unreachable Meta still redirects to Facebook; a wrong pair
bounces with Facebook's words. The save route keeps its warning passthrough,
now via a refused write. Component: the card keeps showing a returned
warning. Everything else stays green.
