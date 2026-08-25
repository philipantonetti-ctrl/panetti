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

Every revenue figure **excludes VAT** - VAT was never our money.

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

Refunded and cancelled orders count for nothing - no revenue, no commission.

Orders from business customers are entered by hand under **B2B**. They are
ordinary orders - same revenue, same COGS, same profit - with three
differences: they are invoiced, so they pay no payment-gateway fee; they carry
the shipping cost you type rather than the shop's per-order rate; and they are
priced and invoiced in the customer's own currency, which need not be the
shop's. Their order numbers are their own sequence (B-0001), so nothing can
collide with WooCommerce.

## Where things live

- `src/lib/metrics/` - all the money maths. Pure functions, heavily tested. **Start here.**
- `src/lib/woo/` - talking to WooCommerce.
- `src/lib/auth/` - logins and the rule that an ambassador only ever sees their own data.
- `src/lib/advisor/` - the morning briefing and the chat. The facts are computed
  by the engine; the model only ranks and explains them.
- `src/app/` - the pages and API routes. Thin: they just call the above.

## Connecting a real shop

Settings → Shops → Connect. You need the store URL and a WooCommerce REST API key
(WordPress → WooCommerce → Settings → Advanced → REST API → Add key, Read access).
Then press "Sync all". Until a shop is connected it shows seeded sample data.

## How data stays current

Three layers, none of which run on the storefront:

1. **Webhooks (live).** After a completed sync the app registers order webhooks
   on each store (`order.created/updated/deleted/restored`), so new orders,
   refunds, cancellations and edits land seconds after they happen. WooCommerce
   delivers webhooks from its background queue - checkout never waits on us.
2. **Scheduled sync (safety net).** Vercel Cron pulls changes every 15 minutes,
   catching anything a webhook missed. Needs `CRON_SECRET` set.
3. **Sync now (on demand).** Buttons on the Orders and Shops pages.

The browser keeps up too: the Dashboard and Orders pages refetch when their
tab regains focus and once a minute while it stays visible, so a tab left
open overnight shows the current numbers, not the world as of when it loaded.
And when a new version of the app is deployed, every open tab notices within
a minute (comparing its build against `/api/version`) and reloads itself, so
nobody keeps running last week's page.

The webhook receiver needs the deployment's public URL (`APP_URL`, or on
Vercel the production URL is picked up automatically) and verifies every
delivery against a per-shop HMAC secret the app generates itself.

## The support inbox

Every brand's support address in one queue, under Inbox. Each email becomes a
ticket (or continues one, by its mail headers and our [PA-n] subject token),
is matched to the customer's orders and parcels, and is answered from the
brand's own address without leaving the app.

Connecting it:

1. Set `INBOX_INBOUND_SECRET` (any long random string) and point the Postmark
   server's inbound webhook at `/api/inbox/inbound?token=<that secret>`.
2. Set `POSTMARK_INBOUND_ADDRESS` to the server's inbound address, so
   Settings -> Support inbox can show where to forward.
3. Add each address on Settings -> Support inbox and forward the real mailbox
   to the inbound address (the page has per-host notes).
4. Verify each brand domain in Postmark (DKIM + Return-Path) so replies leave
   from `support@panetti.no` and friends, threaded into the customer's own
   conversation.

Until an address is connected the inbox runs on the seeded sample tickets, the
same way shops show sample data until they are connected.

## The advisor

Every morning a briefing is written from the last seven days against the seven
before them, and stored. The figures are computed by `src/lib/metrics/` - the same
code every other page uses - and Claude is given them and asked only what deserves
attention and why. It never calculates: an item citing a figure that was not
computed is discarded, and the page prints numbers from the facts rather than from
the model's words.

Needs `ANTHROPIC_API_KEY`. Without it the page says so and shows the facts alone.

## Deploying

`npm run build` pushes the Prisma schema to the database first (additive
changes only - `db push` refuses anything destructive without an explicit
flag), then builds. So on Vercel a plain `git push` ships schema and code
together, in the right order.

## Tests

```bash
npm test          # unit + integration
npm run test:e2e  # browser tests
```
