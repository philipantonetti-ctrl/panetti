# Editing, voiding and deleting a B2B order

2026-08-04

## Why

B2B orders are entered by hand, so they can be typed wrong: a quantity out by
one, the wrong price, the wrong customer, the same order twice. Today nothing
in the app can correct one. `PATCH` and `DELETE` on `/api/b2b/orders/[id]`
exist, are guarded and are tested - but no screen reaches them, so a mistyped
order needs a database fix.

Confirmed with the client: three actions, because they mean three different
things.

| Action | Meaning | Mechanism |
|---|---|---|
| **Edit** | The order happened, these details were wrong | `PATCH` with corrected lines |
| **Void** | The order happened and earns nothing - refunded or cancelled | `PATCH` with a new `status` |
| **Delete** | The order never happened - a double entry, the wrong customer | `DELETE` |

Void is not a nicety. `EXCLUDED_STATUSES` already makes a refunded order earn
nothing, and the Orders page already shows refunded webshop orders - deleting
a refunded B2B order instead would make B2B behave unlike the rest of the app
and lose the record that the sale ever happened.

## The gap this uncovers

Re-opening an order for editing needs, per line, its `productId`,
`discountValue` and `discountKind`, plus the order's `fulfillmentCost` and
`customerId`.

**No endpoint returns those.** `/api/orders` returns display fields - product
*names*, not ids, and no discount breakdown (`route.ts`'s `products` mapping).
That is correct for a paged list and should not change: bloating a list
endpoint with edit-only fields would cost every row of every page.

So this design adds one endpoint.

## What changes

### `GET /api/b2b/orders/[id]`

Added to the file that already holds `PATCH` and `DELETE`, reusing the
`ownB2bOrder` guard already there - a WooCommerce order 404s, exactly as it
does for the other two verbs.

Returns the order in the shape the **form** speaks, not the shape the database
holds:

```ts
{
  order: {
    id, number, status, placedAt,        // placedAt as 'YYYY-MM-DD'
    customerId, customerName, currency,  // currency for labelling
    shippingCharged,                     // minor units, customer currency
    fulfillmentCost,                     // minor units, SHOP currency
    lines: [{ productId, quantity, unitPrice, discountValue, discountKind }],
  }
}
```

Money in minor units; the form converts with `toMajor`, the same direction
`CustomerModal` already handles. `discountValue` is returned as stored: a plain
number for `PERCENT`, minor units for `AMOUNT` - so the form must convert only
the `AMOUNT` case back to major, mirroring the split that already exists on the
way in.

Admin-only, `private, no-store`, like every other money endpoint.

### `OrderModal` gains an optional `order` prop

Absent → creates, exactly as today. Present → loads that order via the new GET,
pre-fills every field, and saves with `PATCH` instead of `POST`.

The same component, the same live totals from the same `orderTotals`, so an
edited order's preview cannot drift from what gets stored - the property the
create path already has.

**The customer picker locks when editing.** `PATCH` refuses moving an order to
a customer on another shop (400, added in the last branch), and the UI must not
offer what the server will reject. Same rule the shop select already follows on
`CustomerModal`.

### Void reuses `PATCH`

`PATCH`'s contract takes the whole order plus a status. So *Mark refunded*
loads the order and re-sends it unchanged with `status: 'refunded'`.

Two round trips where one would do. Deliberate: the alternative is making
`status` a partial update, which changes a contract that is already tested and
reviewed. The GET exists for editing anyway, so the load costs nothing new.

### The orders card

`B2bClient.tsx`'s B2B orders card gains an actions column: an `Edit` button and
a `⋯` menu holding *Mark refunded*, *Mark cancelled* and *Delete order* -
following the menu pattern `ExpensesClient` already uses.

Voided rows need no new rendering: `figures` comes back `null` for an excluded
status and the card already prints `-` rather than a confident zero. A refunded
B2B order will look exactly like a refunded webshop one.

### Delete confirms first

Nothing else in this app confirms a delete - expenses and B2B customers go
straight from the menu. Those do not move money that has already been reported.

Deleting an order silently changes the Dashboard, so this one action gets a
confirmation naming the order. Edit and void do not: both are reversible by
editing again.

## Scope

Only orders belonging to a B2B customer are touched. `ownB2bOrder` is the
single gate on all three verbs, so a synced WooCommerce order cannot be edited,
voided or deleted through any of them - it would come back on the next sync, or
worse, not come back at all.

## Testing

| What | Proves |
|---|---|
| `GET` returns the form shape; 404s a webshop order | the new endpoint |
| Edit round-trip keeps `number` and `externalId` | an edit is the same order, not a new one |
| Edit recomputes totals server-side | the browser's figures stay advisory |
| Void sets the status and the order then earns nothing | the engine drops it via `EXCLUDED_STATUSES` |
| Delete removes the order and its lines | cascade works |
| The card's menu reaches each action | the wiring |

Each proven by reverting the code under test and watching it fail - the
standard the previous branch settled on after nine tests shipped that would
have passed against broken code.

## Out of scope

- Bulk actions on several orders at once
- An audit trail of who edited what
- Editing from the Orders page - that page browses everything; the B2B page is
  where these orders are worked on
