# Gorgias, phase 1: our data inside their sidebar

Approved 2026-08-28.

## The arrangement

Gorgias stays the inbox the agents work in. Our software becomes the layer
behind it: customer knowledge now, the AI brain and the analytics later.

    Customer -> Gorgias -> our software -> Gorgias -> customer

Phase 1 builds only the first arrow's worth of value: when an agent opens a
ticket in Gorgias, our data is already on the screen beside it. No webhook, no
AI, no second inbox.

## What it is

One read-only endpoint. Gorgias calls it with the customer's email address and
renders the JSON we return as cards in the agent's sidebar: who they are, their
recent orders with products and values, whether anything was refunded, the
tracking number, where the parcel is right now, and how many times they have
written to us before.

Every one of those figures already exists. `customerContext()` in
`src/lib/inbox/context.ts` computes them today for our own inbox, reusing the
same `deliveryFor()` verdict the Delivery page prints. This endpoint is a
translation of that shape into the one Gorgias widgets read - not a second
implementation of it. Support and the owner therefore cannot be told different
stories about the same parcel.

## Authentication

A secret we generate, sent by Gorgias as a header and compared in constant
time. The same arrangement the Postmark intake already runs on, and for the
same reason: the caller is a machine with no session.

Missing or wrong secret is 401 and nothing is read. An email we have never seen
is 200 with `found: false` - Gorgias hides a widget whose response carries
nothing, and an error there would read to the agent as a broken integration
rather than as a customer with no orders.

## What Philip does

Creates one HTTP integration and one widget in Gorgias settings, pasting the URL
and secret we hand him, and drags the widget into the sidebar once. Nothing is
installed on our side beyond an environment variable.

## Testing

An integration test against the real database with tagged rows, cleaned up
after: a customer with an order and a parcel comes back with the right fields,
an unknown address comes back `found: false`, a wrong secret is refused. No
Gorgias account is needed to prove any of that.

## Not in this phase

No webhook, no ticket storage, no AI, no analytics. The channel adapter that
keeps the AI independent of Gorgias arrives in phase 2, which is the first time
we SEND anything - that is the seam where independence is real rather than
decorative.

Phase 2: webhook in, one channel-agnostic conversation history, AI drafts as an
internal note and never sends. Phase 3: auto-answer the safe categories under
rules editable in the dashboard. Phase 4: the support dashboard, and the ticket
data made available to the Executive AI alongside sales, delivery and marketing.

## Still needed from Philip to switch it on

The Gorgias account domain and an admin API key. Phase 1 is built and tested
without them.
