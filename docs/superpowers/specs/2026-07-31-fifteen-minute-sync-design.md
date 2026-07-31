# Auto-sync stops because the cron gives itself 60 of its 300 seconds

Date: 2026-07-31
Status: approved in session. Changes `src/lib/woo/sync.ts`,
`src/lib/woo/client.ts`, `src/app/api/cron/sync/route.ts`, the `Shop` model and
the shops settings page. The webhook path and the ads sync are untouched.

## The symptom

Both pages promise the same thing. `/settings/shops`:

> From then on it syncs itself: changes stream in as they happen, with a full
> re-check every 15 minutes.

`/orders` says it too. On the shops page, **some stores showed a Last sync
within the last few minutes and others were frozen days back**, and pressing
Sync all fixed it until it drifted again.

## What we ruled out first

Three probes against the live site, none of which needed a login:

| Probe | Result | Rules out |
| --- | --- | --- |
| `GET /api/version` | `200`, `3d2c0a2` | production is not running stale code |
| `GET /api/cron/sync` unauthenticated | **`401 "Not allowed"`** | `CRON_SECRET` missing |
| Deployment exists at all with `*/15 * * * *` | it does | a plan that forbids the schedule |

The 401 is the useful one. `src/app/api/cron/sync/route.ts:25` returns `503`
with `"Scheduled sync is not configured"` when `CRON_SECRET` is unset, and
`401` only once it is set and the bearer token does not match. So the secret
exists in production and the endpoint is guarded, not broken.

The third row matters because Hobby accounts cannot deploy a sub-daily cron at
all — the build fails with "Hobby accounts are limited to daily cron jobs".
This project deploys `*/15 * * * *` successfully, so the schedule is registered.

And *some stores being fresh* proves the last thing: Vercel really is calling
the endpoint every 15 minutes, and it really is authorised. Everything below
happens inside `syncAllShops()`.

## The cause

`src/app/api/cron/sync/route.ts:12`:

```ts
/**
 * Pulling eight stores takes well over the default budget, so ask for the
 * headroom explicitly. ...
 */
export const maxDuration = 60
```

The comment was true when it was written. It is not true now. **Vercel's
default maximum duration is 300 seconds on every plan today**, so that line no
longer asks for headroom — it discards 240 seconds of it.

`/api/sync`, the manual Sync all button, declares no `maxDuration` and
therefore gets the full 300.

| Path | Budget |
| --- | --- |
| Cron, every 15 minutes | **60s** |
| Sync all button | **300s** |

`syncAllShops` (`src/lib/woo/sync.ts:321`) walks stores strictly sequentially:

```ts
const shops = await db.shop.findMany({ where: { active: true, wooUrl: { not: null } } })
for (const shop of shops) results.push(await syncShop(shop.id))
```

There is **no `orderBy`**, so the row order is unspecified, and — this is the
part that matters — **nothing gives a store that missed out last time any
priority on the next run**. Once the work exceeds 60 seconds the invocation is
killed part-way through, and whichever stores were not reached have no better
chance the next time. Meanwhile the button with five times the budget reaches
all of them, which is exactly why pressing it appears to fix the problem.

(Do not read more into the missing `orderBy` than that. Postgres may return an
unordered scan in a different sequence over time, especially since every
successful sync updates the row. The defensible claim is the absence of
fairness, not a fixed victim.)

## Two more defects that freeze a store on their own

Fixing the budget alone would leave two ways for a single store to stay frozen.

**No timeout anywhere.** Not one `fetch()` in `src/lib/woo/client.ts` sets a
`signal` or `AbortSignal.timeout`. One unresponsive store consumes whatever
budget remains, taking every store behind it in the loop down with it.

**The 5,000-order deadlock.** `src/lib/woo/sync.ts:241`:

```ts
if (!firstSync && hasMore) {
  // lastSyncAt is deliberately NOT updated, so the next run retries this window.
  return { ...base, ok: false, ordersSynced: 0, error: '...over 5,000 changed orders...' }
}
```

The intent is right — never skip silently. The consequence is not. The next run
asks for *the same window, now larger*. It can only grow. That store is stuck
permanently, and Sync all hits the identical wall.

The reason the author had to refuse rather than resume is visible in
`client.ts:47`: the pull sorts by `orderby: 'date'` — creation date — even when
filtering on `modified_after`. Cut a modified-filtered list at an arbitrary
point in creation order and there is genuinely no safe place to resume from.

**A window wider than intended.** `client.ts:50` sends
`modified_after=<UTC>` with no `dates_are_gmt`, so the store compares it
against local time. A Nordic store in UTC+2 therefore pulls a two-hour-wider
window on every sync — inflating the very count that trips the cap above.

**And none of it is visible.** `AdAccount` has a `lastError` column that the
settings page shows. `Shop` has none, and `src/app/settings/shops/page.tsx:19`
passes only `lastSyncAt`. A failing store shows a frozen date and no reason at
all, which is why "why did it stop" had no answer on the page.

## The design

One invocation, made fair and bounded.

```
cron (every 900s)
  └─ maxDuration 300s
       └─ syncAllShops(deadline = now + 240s)
            ├─ stores ordered by lastRunAt ASC NULLS FIRST  ← longest-ignored first
            ├─ each store: sync until done, or until the deadline, then move on
            └─ start no new store once the deadline has passed
       └─ ~60s left over for syncAllAdAccounts and ensureRates, which follow
```

Concrete numbers, so nothing is left to the implementer's judgement:

| Constant | Value | Why |
| --- | --- | --- |
| `maxDuration` (cron route) | `300` | the platform default; stop discarding it |
| shops deadline | `240_000` ms | leaves ~60s for the ads sync and rates that run after |
| per-request timeout | `30_000` ms | clamped down to whatever is left of the deadline |

The deadline is a **parameter of `syncAllShops`, not a constant inside it**, so
`/api/sync` (the Sync all button) passes its own and both callers share one
mechanism. A caller that passes no deadline gets the current unbounded
behaviour, which keeps every existing test meaningful.

A 300-second budget under a 900-second cadence means **two runs can never
overlap**, so no per-store locking is needed.

The guarantee follows from the ordering: if a run serves K stores, every store
is served within ⌈N/K⌉ runs, for any N. That holds without knowing the store
count.

### Rotate on `lastRunAt`, not `lastSyncAt`

The schema conflates two different facts, which is why a stuck store and an
idle store look identical on the page.

| Field | Means | Read by |
| --- | --- | --- |
| `lastSyncAt` | how far through the store's change stream we have read | the next query's window |
| `lastRunAt` *(new)* | when we last gave this store attention | rotation order, and the UI |
| `lastError` *(new)* | why the last attempt failed; null on success | the UI |

Separating them becomes necessary once catch-up exists. A backlogged store
draining gradually moves `lastSyncAt` to a deliberately *old* timestamp, so a
page showing that column alone would read "19/07" immediately after a
completely successful run. With the split, the page can say **"Checked 2
minutes ago, 12 days behind, catching up"**, which is both true and
unmistakable.

Ordering on `lastRunAt` is also what keeps a broken store cheap: see the rule
below.

### Draining replaces refusing

On an incremental pull, sort by `orderby=modified&order=asc` and send
`dates_are_gmt=true`. When the page cap or the deadline stops us early, store
what arrived and set `lastSyncAt` to the last stored order's
`date_modified_gmt`. The window shrinks every run instead of growing forever.

The existing five-minute `OVERLAP` subtracted on read already covers the
boundary, so orders sharing a modified timestamp at the cut point cannot be
skipped.

**If nothing was stored, nothing moves.** A deadline that expires before the
first page returns leaves `orders` empty, and there is then no last order to
advance to. `lastSyncAt` stays untouched and the run counts as progress-free:
`lastRunAt` still moves, so the store rotates to the back and gets a full slot
next run rather than being retried immediately with the same tiny remainder.

**The watermark moves forward or not at all.** Found during Task 5's review, and
it qualifies the claim above: the window does *not* shrink every run
unconditionally. Net progress per run is `resumeFrom - previousWatermark`, and
the next window starts an `OVERLAP` behind the new watermark. So if more orders
share `date_modified_gmt` values than one run can carry inside that five-minute
band — a WooCommerce bulk status change over thousands of orders does exactly
this — the resume point lands at or *behind* the current watermark. Writing it
would pin the window, or rewind it, and the same page would be fetched forever.

Nothing is skipped in that case: the watermark never passes an order that was
not stored, so the safety property holds. What fails is the drain, and worse,
it fails *silently* — the run reports success and the operator sees only "more
history to fetch", indistinguishable from a legitimately large backfill.

So the advance is conditional on strict forward progress. When there is none,
`lastSyncAt` is left alone and `lastError` says the store changed more at once
than one sync can work through. The old code was wrong to refuse, but it was at
least loud; this keeps the loudness for the one case that still deserves it.

The deadline applies to both paths. A first sync already stops early and
resumes by design, so it needs no new semantics — only the extra reason to
stop.

`WooOrder` in `src/lib/woo/map.ts:14` carries `date_created_gmt` but not
`date_modified_gmt`; the field is added to the type. Woo returns GMT timestamps
without a suffix, so it is parsed as `new Date(o.date_modified_gmt + 'Z')`,
matching how `mapOrder` already handles `date_created_gmt`.

### Known limitation: offset paging over a mutable sort key

Found by the whole-branch review, deliberately deferred, recorded here so nobody
rediscovers it as a mystery.

Sorting on `modified` sorts on a key that **changes while we page**. The pull
uses offset pagination (`page=N&per_page=100`). If an order on page 1 is edited
during the second or so between two page fetches, its `modified` becomes now and
it moves to the end of the ascending order — every later row shifts down one, and
the row that was first on page 2 is never returned. The monotonicity guard cannot
see it, because the sequence it does receive is still non-decreasing. The
watermark then advances past that row's stamp and the order is missed until
something modifies it again.

`orderby=date` was immune to this by accident: creation date never changes, so a
re-modified order re-enters the filtered set at an early position and produces a
harmless duplicate rather than a skip. We traded a safe failure mode for an
unsafe one, and that qualifies the claim above that draining never skips.

Why it is deferred rather than fixed: it needs a modification landing inside the
gap between two page fetches of a **multi-page** pull, and most incremental
windows are a single page — multi-page pulls happen during catch-up. The missed
row is also, by construction, an order that was just modified, so the webhook
stream carries it at that moment. That last point is reassuring but circular
(the scheduled sync is documented as the webhooks' safety net), so this is a
real exposure, not a non-issue.

The fix, when it is wanted: keyset paging on the incremental path. Instead of
incrementing `page`, re-issue with `modified_after = <last stamp> - 1s` and
`page=1`. A re-modified row then simply reappears later and the idempotent
upsert absorbs it. The one-second step handles ties, and more than 100 orders
sharing one second is already the stalled-store condition above.

### The drain validates its own precondition

Advancing to the last row is only safe if the store honoured
`orderby=modified`. If a WooCommerce version or plugin ignores it, rows arrive
in another order and advancing would silently skip orders — precisely the harm
the "refuse loudly" code exists to prevent.

So while paging we assert `date_modified_gmt` is non-decreasing. If it is not,
we do not advance, and `lastError` says the store did not sort by modified
date. This keeps the author's safety property *more* strictly than the current
code — draining never skips, it stops exactly where it got to — while removing
the permanent deadlock.

### Timeouts clamped to the deadline

A per-request `AbortSignal.timeout` bounds one HTTP call. The deadline bounds
pagination. Neither is sufficient alone: a 30-second request starting with 10
seconds of budget left still overruns. Each request therefore gets
`min(requestTimeout, timeLeftUntilDeadline)`, bounding the store in both
dimensions.

One "we stopped early, here is how far we got" signal now serves the page cap,
the deadline and the request timeout identically — and the first-sync backfill
path already speaks it.

## Error handling

**Every attempt moves `lastRunAt`, including failures.** This rule is
load-bearing. A permanently broken store whose `lastRunAt` never moved would
stay at the front of the queue forever and burn a slot on every run. Moving it
on failure costs a broken store at most one slot per run before it rotates to
the back.

| Outcome | `lastSyncAt` | `lastRunAt` | `lastError` |
| --- | --- | --- | --- |
| Caught up | `fetchStartedAt` | now | cleared |
| Stopped early (cap or deadline) | last order's `date_modified_gmt` | now | cleared |
| Stopped early, nothing stored | **untouched** | now | cleared |
| Store refused or unreachable | **untouched** | now | the reason |
| Keys unreadable | **untouched** | now | "Reconnect this shop" |
| Store ignored `orderby=modified` | **untouched** | now | the ordering explanation |

A failing store never stops the loop; the next store is attempted regardless.
`wooError` already truncates response bodies to 300 characters, which is what
`lastError` stores.

## Schema change

There is no migrations directory. `package.json` builds with
`prisma db push --skip-generate`, so the schema is reconciled at deploy time.
Two nullable columns are purely additive and need nothing else:

```prisma
lastRunAt DateTime?
lastError String?
```

**No data backfill**, and none is wanted. `lastRunAt` is null for every store on
the first run, so that one run visits them in arbitrary order. Every store it
reaches gets a timestamp, and `NULLS FIRST` puts the ones it missed at the very
front of the next run. Rotation is exact from the second run onward, which is a
better starting state than copying `lastSyncAt` across would have produced —
a store frozen for a fortnight and a store synced a minute ago both start equal,
and one run sorts them.

## Testing

Matching the three flavours already in the repo. Vitest runs against the local
portable Postgres, never the live database.

**Stubbed-fetch unit — `fetchOrders`**
- incremental URLs carry `orderby=modified`, `order=asc`, `dates_are_gmt=true`
- first-sync URLs keep `orderby=date`
- a deadline already passed returns `hasMore: true` without fetching
- the request timeout clamps to the remaining budget
- a non-monotonic `date_modified_gmt` sequence is flagged on the result

**DB-backed — `syncShop`**
- an early stop sets `lastSyncAt` to the last order's `date_modified_gmt`
- a complete pull sets `lastSyncAt` to `fetchStartedAt`
- a `401` leaves `lastSyncAt` untouched, sets `lastRunAt` and `lastError`
- a non-monotonic response refuses to advance and explains why

**DB-backed — `syncAllShops`**
- stores are visited in `lastRunAt ASC NULLS FIRST`
- a failing store does not stop later stores, **and its `lastRunAt` still
  moves**, so it rotates to the back
- no new store is started once the deadline has passed

**jsdom component — shops page**
- a failed store shows its reason
- a catching-up store reads "checked 2 minutes ago, 12 days behind" rather than
  a bare stale date

**Regression guard — cron route**
- assert `maxDuration === 300`. One constant caused this outage; a test stops
  anyone re-capping it.

## Deliberately not done

**Fan-out, one invocation per store.** Better isolation, and it would guarantee
the cadence at any store count. It also needs a per-store lock so a slow run is
not re-entered, multiplies Neon connections by the store count, and **still
requires every fix above** — a deadlocked store stays deadlocked, just in its
own invocation. Not earned while the observed cause is one wrong constant.

**An external queue (QStash, Inngest, Vercel Queues).** Durable retries and
real observability, at the cost of a new dependency, a new secret and a new
failure mode. Not justified yet.

Both stay available, and the design tells us when to reach for them: if
`lastRunAt` still lags several runs behind on some stores after this ships,
one invocation genuinely cannot cover the store count, and that is the evidence
that justifies fan-out.

## Acceptance

Within two runs after deploy, **every** store's `lastRunAt` is recent on
`/settings/shops`. Any store that is not shows a reason next to it instead of a
silent stale date.

## Notes for whoever reads this next

`/orders` never syncs anything. Its "live" behaviour is `useLiveTick`
(`src/lib/use-live-tick.ts`), a 60-second client-side refetch of our own
database. It can look perfectly healthy while showing nothing new, so sync
health cannot be judged from it.

Webhook deliveries call `storeOrder` but never touch `lastSyncAt`, so orders
can be arriving live while that column looks frozen. `lastRunAt` does not fix
that either; if distinguishing the two mechanisms on the page ever matters, a
`lastWebhookAt` column is the way, and it is out of scope here.
