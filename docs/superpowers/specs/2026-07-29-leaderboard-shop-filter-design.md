# Top ambassadors follow the shop filter, and every name says its shop

Date: 2026-07-29
Status: approved (client request via chat; approach confirmed in session).

## What happened

The client filters the dashboard to one shop and still sees every
ambassador under Top ambassadors - people from the other stores, sitting on
zero rows. He asked for two things: the list should follow the shop filter,
and each name should say which shop the person belongs to - "Philip
(Panetti Norway)", the shop part in a quieter gray that is still readable.

The numbers already follow the filter; the roster does not. The metrics
route loads every active ambassador, because an ambassador has no shop
column - their store link lives in their discount codes, one code belonging
to exactly one store (the store-scoped codes design).

## Design

**Codes define membership.** An ambassador belongs to the shops where they
hold discount codes. With a shop filter on, the roster keeps only
ambassadors holding a code on a selected shop - zero-sellers included, as
ever: an empty row is information, a missing row looks like a bug. Without
a filter, everyone stays. An ambassador with no codes at all appears only
in the all-shops view; they cannot sell anywhere yet, and hiding them under
a specific shop is the truth, not a loss.

Rejected alternatives: filtering by sales-in-period hides the zero-sellers
the roster rule exists to show, and makes the roster shift with the date
range; a home-shop column on Ambassador duplicates what the codes already
say and goes stale as codes move.

**The row carries its shops.** The metrics route selects each ambassador's
code shops alongside id and name; the leaderboard passes them through as
`shops: string[]` - deduped, sorted, empty for a codeless ambassador. The
component renders the name as `Philip (Panetti Norway)` - several shops
join with commas - with the parenthesis part in `text-muted`, normal
weight: the middle gray, readable but clearly second to the name. Rows with
no shops render the name alone, no empty parentheses.

## Testing

Unit: the leaderboard carries shops through to the row untouched. Route
(DB-backed): with a shop selected, an ambassador whose only code lives on
another shop is absent, and present again when their own shop is selected;
each row names its shops. Component: a new Leaderboard test renders the
name with the gray shop suffix and leaves codeless rows bare. The existing
zero-seller route test keeps passing - the quiet ambassador holds a code on
the filtered shop. E2e asserts header and rank only; untouched.
