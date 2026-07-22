# Store-scoped ambassador codes + future-date locking

Date: 2026-07-22
Status: approved by client (Philip)

Two independent changes, shipped as separate commits.

## 1. Store-scoped ambassador discount codes (the priority)

### Problem
The client reuses the same discount code text across stores on purpose: a
Swedish store only sells to Swedish customers, a Norwegian store only to
Norwegian ones, so "JOHN10" can legitimately exist in several stores meaning
different things. Today a code is GLOBAL and globally unique:

- `AmbassadorCode.code` is `@unique` across the whole system, so the same code
  cannot exist twice, and
- the code is created with no `shopId` (route.ts), so it matches orders on
  EVERY store (`sync.ts` `!match.shopId` branch).

Result: Sweden's JOHN10 and Norway's JOHN10 would be summed together. Wrong.
Verified live: production has 0 ambassadors and 0 codes, so the model can
change with zero migration risk.

### Solution
A discount code belongs to one store.

- Schema: `AmbassadorCode.shopId` becomes REQUIRED, the global `@unique` on
  `code` is replaced by `@@unique([shopId, code])`. Same text allowed across
  stores, once per store.
- Sync: build the code lookup scoped to the store being synced
  (`where: { shopId: shop.id }`), so an order can only ever match a code from
  its own store. No cross-store contamination.
- API `POST /api/ambassadors` and `POST /api/ambassadors/[id]/codes` require a
  `shopId`; uniqueness errors now mean "already used on that store".
- API `GET /api/ambassadors` returns each code's `shopId` + shop name.
- New `GET /api/coupons?shopId=` (admin only): decrypts that store's keys and
  returns its live WooCommerce coupons, deduped and uppercased. One store down
  returns a clear error, never a crash.
- New `fetchCoupons()` in `src/lib/woo/client.ts`: reads `/wp-json/wc/v3/coupons`
  (read only, same creds as orders), paginated.
- UI (Add Ambassador form + Edit panel): a Store selector, then the discount
  code becomes a searchable dropdown of that store's coupons, still allowing a
  typed custom code. Each saved code shows its store.

### The proof test
A sync test with two stores, each holding the same code text scoped to a
different ambassador, asserts each store's orders attribute to the right
ambassador and never to the other. This is the client's exact scenario.

## 2. Future dates locked in the date picker

### Problem
The calendar lets you click future dates, which can only ever be empty.

### Solution
Past dates and today stay black and selectable. Any day after today renders in
a lighter gray and is not pressable (disabled). "Today" is the user's local
calendar date. A pure helper (`day <= today`) is unit-tested deterministically;
the `Month` button is disabled for future days.

## Testing (both)
Test first throughout. Unit (fetchCoupons, date helper), API route tests
(coupons, ambassadors, codes), component tests (Add form store+picker, calendar
future-day disabled), and a headed end-to-end pass. The live multi-store coupon
fetch is covered by unit tests, not end-to-end, so a browser run never hammers
the 8 live stores.
