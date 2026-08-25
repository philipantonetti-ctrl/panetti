# A refund lands on the day it happens

2026-08-04

## Why

Two things the client asked for. One is a constant; the other changes how the
product accounts for money.

**The B2B orders card shows 90 days.** It should show twelve months.

**A refund silently rewrites the past.** Today `EXCLUDED_STATUSES` makes a
voided order contribute nothing, filtered at its own `placedAt`. So refunding
last week's order today does two wrong things at once: last week's figure
quietly drops - a number the client has already read and may have reported -
and today shows nothing at all, even though today is when the money actually
went back.

What they want, and what their previous tool did: the reversal lands on the day
the refund happened, as a negative.

## What reverses

Confirmed with the client: **the whole order.** Net sales, shipping, VAT, COGS,
fulfillment, the gateway fee and the ambassador's commission all reverse
together.

That is the version that balances. A sale and its refund cancel to exactly zero
across any period covering both, and profit returns to where it was. Reversing
revenue alone would leave a permanent loss on the books equal to the order's
costs, for every refund ever taken.

| | 28 Jul | 4 Aug | Net |
|---|---|---|---|
| Net sales | 4,713.00 | −4,713.00 | 0.00 |
| COGS | 1,890.00 | −1,890.00 | 0.00 |
| Fulfillment | 45.00 | −45.00 | 0.00 |
| Commission | 471.30 | −471.30 | 0.00 |
| **Net profit** | **2,306.70** | **−2,306.70** | **0.00** |

## The column

`Order.voidedAt DateTime?` - when the order entered a refunded or cancelled
state. Null means either never voided, or voided before this shipped.

### The stamping rule, and why it is a transition

`voidedAt` is set **only when an order we already hold as live becomes voided.**

`storeOrder()` in `src/lib/woo/sync.ts` is the single write path for both the
webhook and the scheduled sync, so the check lives there: if the incoming
status is in `VOIDED_STATUSES` **and the row already in the database is not**,
stamp the moment.

An order that arrives already refunded - a first sync, a backfill, a store we
have only just connected - is **not** stamped. We genuinely do not know when it
was refunded, and an approximate date in a profit figure is worse than an
honest gap. Confirmed with the client: existing refunds stay exactly as they
are today.

A B2B order stamps in `PATCH /api/b2b/orders/[id]` when the status is set by
hand, and **clears** `voidedAt` when an order is set back to `completed` - the
edit form can un-void, so the reversal must be able to disappear with it.

## The engine

`counts()` in `src/lib/metrics/engine.ts` currently discards every order in
`EXCLUDED_STATUSES`. It is replaced by a three-way split:

| Order | Contributes |
|---|---|
| Live | positive, on `placedAt` - unchanged |
| Voided **with** a `voidedAt` | positive on `placedAt` **and** negative on `voidedAt` |
| Voided **without** a `voidedAt` | nothing, ever - exactly today's behaviour |

Every money figure negates together. The reversal is the same order run through
the same arithmetic with its sign flipped, not a second set of rules - so a
change to how COGS or the gateway fee is computed cannot make the two halves
disagree.

### Past reports become more stable, not less

This is worth stating plainly because it reads backwards at first.

Today, refunding last week's order rewrites last week: the sale vanishes from a
figure the client already read. Under this model last week keeps saying
4,713 - it really did happen - and today says −4,713.

For an order refunded *before* this ships, `voidedAt` is null, it contributes
nothing anywhere, and every existing figure is untouched.

### Two deliberate limits

**`pending` and `on-hold` do not reverse.** `EXCLUDED_STATUSES` is
`VOIDED_STATUSES` plus `UNPAID_STATUSES`, and the two mean different things:
unpaid is "the money has not arrived yet", not "it arrived and went back".
An unpaid order simply does not count until it is paid. Only
`VOIDED_STATUSES` - `refunded`, `cancelled`, `failed`, `trash` - reverse.

**The negative entry adds 0 to the order count, not −1.** You did not un-place
an order. This matches the client's own screenshot, where the refund day shows
Order Count 0 alongside the negative sales figure. `avgOrderValue` already
guards division by zero, so a reversal-only day reports 0 rather than dividing
by a negative count.

## What does not change

- **The Orders page** keeps showing `figures: null` for a voided order. It is a
  browser: seeing *that an order was refunded* is the point, and its per-order
  contribution genuinely is nothing on net.
- **The B2B card** keeps rendering `-` for a voided row, for the same reason.
- **`EXCLUDED_STATUSES` itself** keeps its current members and meaning. Only the
  engine's use of it splits.

## Testing

| What | Proves |
|---|---|
| A voided order with a date contributes positive at `placedAt` | the past stops being rewritten |
| ...and negative at `voidedAt` | the reversal lands on the right day |
| A range covering both nets to exactly zero across every figure | the two halves agree |
| A voided order with **no** date contributes nothing, anywhere | existing refunds are untouched |
| An unpaid order still contributes nothing and does not reverse | the two exclusions stay distinct |
| The reversal day's order count is 0, not −1 | matches the client's expectation |
| `storeOrder` stamps on live→voided, and **not** on a first sight of a refunded order | the honest-gap rule |
| The B2B `PATCH` stamps on void and clears on un-void | the edit form can undo |

Each proven by reverting the code under test and watching it fail - the standard
this project settled on after ten tests shipped that would have passed against
broken code.

## Out of scope

- Partial refunds. WooCommerce can refund part of an order; this design treats a
  refund as all-or-nothing, which is what the `status` column can express.
- Backfilling a refund date from WooCommerce's `date_modified_gmt`. It moves on
  any edit, so it would put reversals on wrong days.
- Any change to how the Orders page or the B2B card display a voided order.
