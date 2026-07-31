# Recording products when the ambassador is first added

Date: 2026-07-31
Status: approved (full ledger fields, revealed by a toggle, confirmed in session)

## What was asked

> I want you to add this at the beginning process on the ambassador, not only
> when pressing edit.

Today a gift can only be recorded through the Edit modal, which means every new
ambassador is created and then immediately re-opened to say what we sent them.
The same four fields belong in the "Add an ambassador" card.

## One request, not two

`POST /api/ambassadors` gains an optional `products[]`, and the ambassador and
their gifts are created in **one nested Prisma write**.

The alternative — create the ambassador, then POST each gift — can strand a
half-made ambassador when the second call fails. It also gets the failure order
wrong: a duplicate code already returns 409, and gifts written before that point
would survive an ambassador who was never created.

```ts
products: z
  .array(
    z.object({
      sku: z.string().trim().min(1),
      name: z.string().trim().min(1),
      quantity: z.number().int().min(1, 'Quantity must be at least 1'),
      receivedAt: z.string().min(1),
      note: z.string().trim().max(200).optional(),
    }),
  )
  .max(50)
  .optional()
```

Identical rules to `POST /api/ambassador-products`, so both doors into the
ledger accept and refuse exactly the same things. `receivedAt` is stored through
`utcDay()`, the convention every dated value here follows. The 50 cap is a
sanity bound on a form you fill by hand, not a business rule.

`assertStaff` already guards the route, so marketing keeps the same reach it has
everywhere else in the ambassador program.

## Shared fields, not a second copy

The four inputs live inside `ProductLedger` today. They move into
`GiftFields`, which both callers render:

| Caller | What `onAdd` does |
|---|---|
| Edit modal (`ProductLedger`) | POSTs immediately, as it does now |
| Add an ambassador | appends to a local list, sent with the create |

`onAdd` returns a boolean: true clears the fields, false leaves them alone so a
refused request does not also lose what was typed.

`GiftFields` takes an `idPrefix`, because the modal can be open above the create
form and two elements may not share an id.

Without this extraction the two forms drift, and the second one silently stops
matching the first the next time either is touched.

## UI

Collapsed by default: a `+ Add products they got from us` toggle under the
existing row, so the card stays one line for the common case of a name and a
code. Expanded, it shows `GiftFields` above the pending list; each pending gift
is a chip with a remove button. On success the list clears and it collapses.

Nothing is written until "Add ambassador" is pressed. This is the one place in
the ambassador program where a product is **not** saved the moment you press
add, because the ambassador it belongs to does not exist yet. The button says
"Add to list" rather than "Add product" to say so.

## Testing

- **Route** — products stored on create; a bad quantity is refused; a create
  with no products still works; and the atomic case: **a duplicate code returns
  409 with zero `AmbassadorProduct` rows left behind**.
- **Component** — the toggle reveals the fields, adding appends a chip,
  removing drops it, and submitting sends `products` in the body.
- **End to end** — create an ambassador with two products, see the chips on the
  roster and the count in the overview, then delete them so the spec re-runs.

## Deliberately not built

- **Editing a pending gift in place.** Remove and re-add is enough for a list
  assembled in one sitting.
- **A schema change.** `AmbassadorProduct` already fits; this only adds a second
  way to write one.
