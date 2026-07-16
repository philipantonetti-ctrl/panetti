# ecom-analytics — Ambassador Onboarding Design

**Date:** 2026-07-16
**Status:** Approved for implementation
**Scope:** Creating and managing ambassadors, and the invite flow that gives them a login

---

## 1. Purpose

The owner asked for "two different interfaces — admin sees the whole company, ambassadors see only
their own sales — and some kind of onboarding where they create a user, and then we link the
discount code to their user."

Three of those four things already ship. This spec covers the fourth, which does not exist at all.

---

## 2. What already exists

Verified against the code on 2026-07-16:

| Requirement | Status |
|---|---|
| Two interfaces — admin vs ambassador | **Built.** `/admin` is the staff door, `/login` the ambassador door. `login/route.ts` routes on role: `ADMIN → /dashboard`, otherwise `→ /portal`. |
| Ambassadors see only their own data | **Built and audited.** `portal/route.ts` scopes every query to `user.ambassadorId` taken from the signed session, never from the request. No `ambassadorId` query parameter is parsed anywhere in the repo. |
| Discount code links to the ambassador | **Built.** `AmbassadorCode.code` maps to an ambassador; `sync.ts` resolves it **at sync time** and freezes `Order.ambassadorId`, so re-issuing a code never rewrites past commissions. |
| **Onboarding — creating the user** | **Missing entirely.** There is no `/api/ambassadors` route, no admin screen, and no signup. Every ambassador in local dev came from `prisma/seed.ts`. Production has zero. |

**The gap is bigger than "no self-signup":** there is no way to create an ambassador *at all*, not
even as an admin.

---

## 3. Guiding constraint

The owner's standing rule is that this project stays simple and adds no confusing state. This design
therefore adds **no database tables, no columns, and no new dependencies**. Every guard reads a fact
the system already holds.

---

## 4. Architecture

No schema change. The design rests on one property the schema already has:

```prisma
model Ambassador {
  // ...
  user User?   // OPTIONAL — an ambassador can exist with no login
}
```

Because `user` is optional, an ambassador and their discount code can exist and **earn commission
from the very next sync**, long before they have ever logged in. Onboarding is therefore a separate,
later step — not a prerequisite. This is what makes an invite flow natural rather than bolted on.

### New modules

| File | Purpose | Depends on |
|---|---|---|
| `src/lib/auth/invite.ts` | `signInvite` / `verifyInvite` | `jose`, `AUTH_SECRET` |
| `src/app/api/ambassadors/route.ts` | `GET` list · `POST` create | guard, db |
| `src/app/api/ambassadors/[id]/route.ts` | `PATCH` name, rate, active | guard, db |
| `src/app/api/ambassadors/[id]/codes/route.ts` | `POST` add · `DELETE` remove | guard, db |
| `src/app/api/invite/route.ts` | `POST` redeem — the only public route | invite, db, session |
| `src/app/settings/ambassadors/` | Admin screen | — |
| `src/app/invite/[token]/` | Set-password page | — |

`src/lib/auth/invite.ts` mirrors `session.ts` deliberately: same library, same secret, same shape.
Anyone who understands one understands the other.

---

## 5. The invite token

```
signInvite(ambassadorId) -> JWT, HS256, signed with AUTH_SECRET, 7-day expiry
verifyInvite(token)      -> ambassadorId | null   (null on tamper, expiry, or garbage)
```

Stateless by choice. No token is stored, so no token can drift out of step with reality.

**Rejected alternatives.** Storing the token on the `Ambassador` row (two columns) buys per-link
revocation; a dedicated `AmbassadorInvite` table buys an audit trail. Both were rejected as state we
would have to keep correct in exchange for capabilities a 24-person roster does not need. Option 2
remains a small upgrade path if per-link revocation is ever wanted: same link format, same endpoint,
backed by a column.

---

## 6. Behaviour

### 6.1 Creating an ambassador

Admin submits name, email, commission rate, and a first discount code. One `POST /api/ambassadors`
creates the `Ambassador` and its `AmbassadorCode` together. Codes are stored uppercase, matching
`sync.ts`, which uppercases the coupon before lookup.

Attribution begins at the next sync. No login required.

### 6.2 The invite link

`GET /api/ambassadors` returns each ambassador with an `inviteUrl` **only when they have no login
yet**. "Copy invite link" therefore copies data already on the page — no extra endpoint, no extra
round-trip, and no link is ever minted for someone already onboarded.

The admin sends the link over whatever channel they already use. No email service is added.

### 6.3 Redemption guards

`POST /api/invite` accepts `{ token, password }` and refuses unless **all four** hold:

| # | Guard | Rejects |
|---|---|---|
| 1 | `verifyInvite(token)` returns an id | Tampered, expired, or forged links |
| 2 | The ambassador exists | Deleted ambassadors |
| 3 | `ambassador.active` is true | **Revocation** — deactivating kills the link instantly |
| 4 | The ambassador has no `user` | **Single use** — a redeemed link is dead |

Guards 3 and 4 are the load-bearing ones, and neither needs stored state: they read `active` and
`user`, which already describe reality.

On success: create `User` with `role: 'AMBASSADOR'` and `ambassadorId` set, hash the password with
`hashPassword` (bcrypt, cost 10 — the existing helper), sign a session with `signSession`, set the
`ecom_session` cookie exactly as `login/route.ts` does, and return `{ redirectTo: '/portal' }`.

Password minimum: 8 characters. Enforced with `zod`, matching how every other route validates.

### 6.4 Commission rate is a FRACTION, not a percent

`Ambassador.commissionRate` is a `Float` holding **0.10 to mean 10%**. `pct()` multiplies net sales
by it directly, and `PortalClient.tsx` renders it as `commissionRate * 100`.

The admin types a **percent** (`10`), and the API stores a **fraction** (`0.1`). The conversion
happens **once, at the API boundary**, mirroring how `toMinor()` converts money exactly once on the
way in:

```
UI input "10"  ->  POST { commissionRate: 10 }  ->  stored 0.1
```

`zod` validates `0 <= commissionRate <= 100` on the way in and the route divides by 100. Storing a
percent by mistake would make commission **1000% of net sales** — the same class of defect as the
minor-units convention, and it must be pinned by a test asserting that posting `10` yields a stored
`0.1`.

### 6.5 Management

- **Commission rate** — `PATCH`. `Order.commissionRate` is hydrated from the ambassador at read time
  (`load.ts`), so a rate change applies to future reports while attribution stays frozen. This is
  existing, tested behaviour; this spec only exposes it to the UI.
- **Deactivate** — `PATCH { active: false }`. This kills any outstanding invite via guard 3.
  It deliberately does **not** remove them from the admin leaderboard: `ambassadors.ts` never reads
  `active`, and that is correct — sales they made in a past period genuinely happened, and a
  historical report must not rewrite itself when someone leaves.
- **Partial updates.** `PATCH` accepts any subset of `{ name, commissionRate, active }`. Absent
  fields are left untouched; it is never a full replace.
- **Codes** — `POST { code }` adds one; `DELETE { codeId }` (id in the JSON body, matching how the
  other routes take their payload) removes one. Removing a code never alters past orders, because
  `Order.ambassadorId` was frozen at sync. An ambassador must keep **at least one** code: the API
  refuses to delete the last one, since an ambassador with no code can never earn again.

---

## 7. Screens

`/settings/ambassadors`, matching the existing `/settings/shops` layout and design system.

- **List:** name, email, commission rate, codes, and status — **Active**, or **Not set up yet** when
  they have no login.
- **Add ambassador:** name, email, commission rate **entered as a percent** with a `%` suffix on the
  field (defaults to `10`), first discount code. See 6.4 — the field is a percent, the column is a
  fraction.
- **Row actions:** Copy invite link (only when not set up), edit rate, add/remove code, deactivate.

`/invite/[token]`: the ambassador's set-password page. Shows their name so they know the link is for
them, one password field, one confirm field. On success they land in `/portal`, already signed in.

---

## 8. Error handling

Every fetch checks `res.ok`, renders a real error, and uses `try`/`finally` so a button can never
stick on "Saving…".

This is called out explicitly because the existing cost modal does the opposite:
`CostsClient.tsx:283-294` never inspects `res.ok` and has no `catch`, so a rejected save closes the
modal, reloads the old value, and shows **no error at all**. That defect must not be reproduced here.

Redemption failures each get a distinct message, except where distinguishing them would leak
information:

| Cause | Message |
|---|---|
| Expired or invalid token | "This invite link has expired. Ask for a new one." |
| Already redeemed (guard 4) | "You already have a login. Sign in instead." |
| Deactivated (guard 3) | "This invite is no longer valid." — deliberately generic |
| Duplicate email or code on create | 409 naming the conflicting field |

---

## 9. Testing

- **Unit** (`invite.test.ts`): sign/verify round-trip; a tampered token returns null; an expired
  token returns null; a token signed with a different secret returns null.
- **Security** (`api/invite/security.test.ts`): each of the four guards rejects. Specifically: a
  redeemed token cannot be reused; a token for ambassador A cannot create a login for B; a
  deactivated ambassador's token is refused.
- **Percent/fraction** (`api/ambassadors/rate.test.ts`): posting `commissionRate: 10` stores `0.1`,
  and a stored `0.1` renders as `10%`. Pins the convention in 6.4 against a 100× regression.
- **E2E** (`e2e/ambassador-onboarding.spec.ts`): admin creates an ambassador → copies the invite link
  → opens it → sets a password → lands on `/portal` → **sees only their own figures**.

### Required fix: deactivation makes an existing rank bug reachable

`portal/route.ts:68-81` computes an ambassador's rank from two **different populations**:

```ts
const everyone = await db.order.groupBy({ by: ['ambassadorId'], ... })   // ALL who have orders
const better   = everyone.filter((row) => ...).length                    // ranks against ALL
const totalAmbassadors = await db.ambassador.count({ where: { active: true } })  // counts ACTIVE only
```

Nothing can deactivate anyone today, so the two populations always agree and the bug is unreachable.
**Adding the deactivate button makes it live:** deactivate an ambassador who has sales, and another
ambassador's portal reads **"#9 of 8"**.

This ships with the deactivate button or not at all. The fix: compute both sides over the **same**
population — ambassadors with at least one attributed, non-excluded order in the range — so the rank
reads "#3 of 8 who sold this period" and stops depending on `active` entirely. A test must assert
that deactivating an ambassador with sales never makes `rank > totalAmbassadors`.

### Targeted fix to existing tests

`src/app/api/portal/security.test.ts` states it guards "the single most important rule in the
system", but the functions it exercises — `canViewAmbassador` and `assertAmbassadorAccess` in
`guard.ts` — have **zero production callers**. The real check lives at `portal/route.ts:37`. A
regression there would pass every test in that file green.

Since this work adds ambassador authentication, the new security tests will exercise the **real
routes**, not helpers. `guard.ts`'s unused helpers are left alone — deleting them is out of scope.

---

## 10. Explicitly out of scope

No email delivery (the admin sends the link themselves). No self-signup. No password reset. No
per-link revocation. No audit trail of who invited whom. No bulk import. No per-ambassador payout
currency. Ambassadors cannot edit their own commission rate or codes.

---

## 11. Risks

- **Invite links are bearer tokens.** Anyone holding the link for 7 days can claim that login. The
  blast radius is one ambassador's own sales figures — they cannot see company data or another
  ambassador's numbers. Mitigated by the 7-day expiry and by guard 3 (deactivate to revoke).
- **`AUTH_SECRET` rotation invalidates outstanding invites.** Acceptable: rotation already logs
  everyone out, and re-copying a link is trivial.
- **`Ambassador.email` and `User.email` are separate unique columns** holding the same value, per the
  existing seed pattern. This design follows that pattern rather than changing it. A future
  divergence (contact email vs login email) would need a decision; it is not one today.
