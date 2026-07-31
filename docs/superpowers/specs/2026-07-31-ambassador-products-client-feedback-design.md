# Client feedback on ambassador products

Date: 2026-07-31
Status: approved (tick-list at creation, same rules in Edit, confirmed in session)

## What the client asked

> Can this please now be hidden as standard, this needs to be obligated, product
> needs to be picked before you can save ambassador. Also, when choosing store,
> only the products from that store should show, not from all stores. Also,
> quantity is not needed, it's always 1 as standard, but should be option to
> choose multiple products, because some ambassadors get also accessories etc
> for their product.

Four changes: stop hiding the section, make a product required, filter the list
by the chosen store, and replace quantity with picking several products.

## The catalogue learns where each product is sold

`GET /api/ambassador-products` returned `catalogue: { sku, name }[]`, deduped
across shops. It now returns:

```ts
catalogue: { sku: string; name: string; shopIds: string[] }[]
```

One row per SKU, carrying every shop that sells it. Both screens filter that one
payload locally, so changing the store in the form costs no request, and the
name a duplicated SKU ends up with is still decided the same way (rows read
`orderBy: name asc`, first name seen for a SKU wins).

`shopIds`, not a shop-scoped endpoint, because the ledger still keys on **SKU**.
The overview must keep counting "4 ambassadors have the Advanced Comfort" as one
honest row across eleven stores. Filtering is a question about the picker, not
about what a gift is.

## Add form

- Always visible. The toggle is gone.
- Before a store is chosen: "Pick a store first to see its products", because
  the list is a function of the store.
- A tick-list of that store's products. Each tick is one product at quantity 1.
- One date (today by default) and one optional note for the whole batch, which
  is right at creation because it all goes out together.
- **Changing the store clears the ticks.** A Norwegian selection is meaningless
  once the store is Sweden, and carrying it silently would attach products the
  ambassador's store does not sell.
- "Add ambassador" stays disabled until at least one product is ticked.

## Edit window

- The quantity box is gone.
- The picker shows only products sold on the stores that ambassador's codes
  live on, which is the same rule as the form, applied where the store is
  already known rather than chosen.
- It stays one gift at a time, each with its own date and note. It is a ledger:
  a chair sent in March and an accessory sent in June are two facts with two
  dates. The tick-list is a convenience for the moment of creation, not a
  replacement for that.

## Quantity

Removed from both forms; every new record is 1. The column stays and `×N` still
renders **when N is greater than 1**, so records already carrying 2 keep reading
correctly rather than quietly becoming wrong. The portal's Quantity column folds
into the product name for the same reason: a column of 1s is noise, but a 2 that
exists must still be visible.

Both routes now take `quantity` as optional, defaulting to 1, so every existing
caller keeps working.

## Where "obligated" is enforced

The Save button, not the API.

Products are discovered from order lines, so a store that has never sold
anything has an empty list. Under a server-side rule, **no ambassador could ever
be created for such a store**, with no way around it. Enforcing at the button
keeps the client's requirement (you cannot save without picking) while leaving
the door open, and the form says plainly why a list is empty rather than sitting
there disabled with no explanation.

## Testing

- **Route** — the catalogue reports `shopIds` per SKU; a SKU sold in two shops
  appears once with both; `quantity` defaults to 1 when omitted.
- **Component** — the list narrows to the chosen store; switching stores clears
  the ticks; submit is blocked with nothing ticked; two ticks send two records
  at quantity 1; Edit's picker is filtered and has no quantity box.
- **End to end** — create an ambassador with two ticked products, see both on
  the roster, then delete so the spec re-runs.
