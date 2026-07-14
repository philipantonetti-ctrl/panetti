# ecom-analytics

Analytics for our WooCommerce shops: sales, true net profit, and ambassador tracking.

## Running it

```bash
npm install
npm run db:push     # create the database
npm run db:seed     # fill it with sample data
npm run dev         # http://localhost:3000
```

Sign in with:
- Admin: `admin@ecom.test` / `password123`
- Ambassador: `emma@ambassador.test` / `password123`

## How the money is calculated

Every revenue figure **excludes VAT** — VAT was never our money.

```
  Gross sales        line value before discount     (excl VAT)
- Discounts
= NET SALES          <- ambassadors earn 10% of this
+ Shipping charged                                  (excl VAT)
= NET REVENUE
- COGS               qty x (cost + handling), at the cost in effect ON THE ORDER'S DATE
- Operational expenses   spread across the days of the period you are viewing
- Ambassador commission
= NET PROFIT
```

Refunded and cancelled orders count for nothing — no revenue, no commission.

## Where things live

- `src/lib/metrics/` — all the money maths. Pure functions, heavily tested. **Start here.**
- `src/lib/woo/` — talking to WooCommerce.
- `src/lib/auth/` — logins and the rule that an ambassador only ever sees their own data.
- `src/app/` — the pages and API routes. Thin: they just call the above.

## Connecting a real shop

Settings → Shops → Connect. You need the store URL and a WooCommerce REST API key
(WordPress → WooCommerce → Settings → Advanced → REST API → Add key, Read access).
Then press "Sync all". Until a shop is connected it shows seeded sample data.

## Tests

```bash
npm test          # unit + integration
npm run test:e2e  # browser tests
```
