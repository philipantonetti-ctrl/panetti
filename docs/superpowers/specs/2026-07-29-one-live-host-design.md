# One live host: stray deployment URLs walk themselves to the production domain

Date: 2026-07-29
Status: approved for implementation. Follows 2026-07-29-meta-app-self-registration-design.md.

## What happened

The client hit "Can't load URL" again - after the Meta app learned to
register its own domain. His address bar finally told the whole story: he
was browsing `panetti-729f33q4t-panetti-intelligence.vercel.app`, the frozen
URL of a three-deploys-old build. He is a member of the Vercel team, so the
SSO wall that stops everyone else waves him through, and nothing ever looks
wrong. Every deploy mints a fresh hashed URL; a Facebook app can be taught
one domain, not a treadmill of them. The OAuth redirect_uri inherited the
hashed host, and Facebook said no - correctly.

The production site has exactly one public door: `panetti.vercel.app`. The
system should make that the only host anyone ever stays on.

## Design

**A canonical-host redirect, first thing in the middleware.** When the
deployment is production (`VERCEL_ENV === 'production'`), the request's host
is compared with `VERCEL_PROJECT_PRODUCTION_URL` (Vercel's own name for the
project's production domain, no protocol). A stray host - an old deployment
URL, the team-scoped alias, any future drift - gets a 308 to the same path
and query on the canonical host. Preview deployments and local dev are left
alone; a missing env var means no verdict and no redirect.

**The matcher widens to everything but static assets.** The auth gate keeps
its exact behavior behind an explicit list of protected page prefixes; every
other matched path passes straight through after the host check. The
redirect must cover /login and the OAuth routes - the exact paths the old
matcher ignored.

**What this cannot fix, named honestly:** deployments are immutable, so the
client's existing old-URL tab still runs old middleware and will never
redirect itself. He switches to `panetti.vercel.app` once; from then on the
new middleware keeps every future stray visit on the one live host, and the
Meta app's self-registration only ever has one domain to hold.

## Testing

Unit (middleware, stubbed env): a stray host in production 308s to the
canonical host with path and query intact, before any auth logic; the
canonical host is untouched; no redirect outside production or without the
env var; the session gate still sends a guest on a protected page to /login
and leaves /login itself alone. E2e keeps running against localhost in dev
mode, where the redirect never fires. Everything else stays green.
