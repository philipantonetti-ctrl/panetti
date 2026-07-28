# panetti-analytics

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

## How data stays current

Three layers, none of which run on the storefront:

1. **Webhooks (live).** After a completed sync the app registers order webhooks
   on each store (`order.created/updated/deleted/restored`), so new orders,
   refunds, cancellations and edits land seconds after they happen. WooCommerce
   delivers webhooks from its background queue — checkout never waits on us.
2. **Scheduled sync (safety net).** Vercel Cron pulls changes every 15 minutes,
   catching anything a webhook missed. Needs `CRON_SECRET` set.
3. **Sync now (on demand).** Buttons on the Orders and Shops pages.

The browser keeps up too: the Dashboard and Orders pages refetch when their
tab regains focus and once a minute while it stays visible, so a tab left
open overnight shows the current numbers, not the world as of when it loaded.

The webhook receiver needs the deployment's public URL (`APP_URL`, or on
Vercel the production URL is picked up automatically) and verifies every
delivery against a per-shop HMAC secret the app generates itself.

## Deploying

`npm run build` pushes the Prisma schema to the database first (additive
changes only — `db push` refuses anything destructive without an explicit
flag), then builds. So on Vercel a plain `git push` ships schema and code
together, in the right order.

## Tests

```bash
npm test          # unit + integration
npm run test:e2e  # browser tests
```
