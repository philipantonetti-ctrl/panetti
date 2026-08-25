# A Marketing role, an Ambassadors page for staff, and a Users page for admins

Date: 2026-07-29
Status: approved (design and both forks confirmed in session: full ambassador
management for Marketing; starter-password login creation).

## What the client asked

Admin accounts he can create himself, and a Marketing account that logs in
through the staff door but sees ONLY ambassador statistics and ambassador
management - nothing else. Today neither exists: admin logins come from the
seed alone, and the only roles are ADMIN and AMBASSADOR.

## Design

**A third role, no migration.** `User.role` is a plain string column;
`MARKETING` joins `ADMIN` and `AMBASSADOR`. The `Role` union in
`lib/auth/session.ts` widens, and the login route stops narrowing the role
with a cast.

**Allow-listed in, never blocked out.** A new guard `assertStaff` (ADMIN or
MARKETING) replaces `assertAdmin` ONLY on: `/api/ambassadors` (list,
create), `/api/ambassadors/[id]` (edit, delete), `/api/ambassadors/[id]/codes`,
and the new stats endpoint. `canViewAmbassador`'s first clause widens from
admin to staff, which also opens the ambassador portal view (`/api/portal`
with `ambassadorId`) - that is ambassador statistics too. Every other route
keeps `assertAdmin` untouched: a Marketing session on `/api/metrics`,
orders, marketing, settings, shops, sync, or ads APIs gets the same 403 a
stranger would, and tests assert that explicitly.

**`/api/ambassadors/stats` (staff).** Query: the usual `preset`/`from`/`to`
and `shops`. Loads the range like the dashboard does, but answers with the
leaderboard rows (rank, name, shops, orders, sales, commission), the shop
options for the filter (id and name), the resolved range, and the display
currency - and nothing else. Revenue, profit, series, and spend are never
computed here, so nothing needs hiding.

**`/ambassadors` (staff page, top level).** Header carries the same shop
filter and date presets the dashboard uses. Body: the Top ambassadors table
(the existing Leaderboard component, shop labels included) above the
existing roster management (AmbassadorsClient moves here unchanged: create,
invite link, rates, codes, deactivate). `/settings/ambassadors` becomes a
redirect to `/ambassadors` so old links keep working. Admins see this page
too; the admin nav gains an Ambassadors item under Analytics, and the
Settings hub card for Ambassadors points at the new path.

**`/settings/users` (admin page).** A table of staff logins (email, role -
ambassador logins stay out; they are managed by invites) and a create form:
email, role ADMIN or MARKETING, starter password of at least 8 characters.
The admin hands the password over; the person changes it under Your
account, which already exists. Backing API `/api/users` (GET, POST,
DELETE `[id]`), all assertAdmin. Rules: emails are unique - a taken email
is a friendly 409, not a 500; you cannot delete your own login; deleting a
login revokes access at once (the session dies at the middleware's next
look... sessions are stateless JWTs, so truthfully: access ends when the
7-day session expires or they sign out - the page says so in a quiet note).

**Fences and landings.** The middleware's role map gains MARKETING:
allowed prefixes `/ambassadors` and `/account`; anything else bounces to
`/ambassadors`, exactly as ambassadors bounce to `/portal`. The login route
lands MARKETING on `/ambassadors` from either door; the `/admin` door page
and the root landing redirect MARKETING the same way. AppShell learns the
role: MARKETING gets a nav with just Ambassadors (wordmark links there
too); ADMIN sees today's nav plus the Ambassadors item.

## Testing

Guard units: assertStaff accepts both staff roles, rejects ambassadors and
guests; canViewAmbassador for marketing. Users API: create both roles,
duplicate email 409, short password 400, self-delete 409, non-admin 403.
Stats API: marketing gets leaderboard + shop options; the body never
carries revenue or profit fields; ambassador role 403. Explicit marketing
403s on /api/metrics, /api/orders, /api/settings. Middleware: marketing on
/dashboard bounces to /ambassadors, on /ambassadors passes; admin
untouched. Components: the Users page creates and lists logins; the
Ambassadors page shows stats and roster. E2e: a seeded marketing user logs
in via /admin, lands on Ambassadors, sees the leaderboard and creates an
ambassador, and typing /dashboard into the URL bounces them back. Existing
suites stay green; settings/ambassadors e2e paths follow the redirect.
