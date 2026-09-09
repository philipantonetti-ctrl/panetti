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

## Gorgias

Gorgias stays the inbox the agents work in; this software is the layer behind
it. The first piece is the sidebar: when an agent opens a ticket, Gorgias asks
us about that customer and shows what we know without the agent leaving
Gorgias.

Switching it on:

1. Set `GORGIAS_WIDGET_SECRET` to any long random string.
2. In Gorgias, Settings -> Integrations -> HTTP integration. URL:
   `https://panetti.vercel.app/api/gorgias/customer?email={{ticket.customer.email}}`,
   method GET, and one header `X-Panetti-Secret` holding the same string.
3. Add a widget on that integration and drag it into the ticket sidebar once.
   It then appears on every ticket.

The endpoint is read-only and reaches nothing in Gorgias. It answers 200 with
`found: false` for an address we have never sold to, because Gorgias hides an
empty widget and an error would read as a broken integration instead.

### The assistant on live chat

The support assistant (`src/lib/support/`) can answer a shop's Gorgias live
chats. Off for every shop until an admin sets a date on
Settings -> Support assistant -> Live chat, per shop. It answers chats
started from that date, under the same rules as email: draft mode leaves
suggestions as internal notes, auto mode answers the ticked categories by
itself and hands anything else to a person with a note and the tag
`ai-handover`. A person writing on a chat silences the assistant on that
chat for good.

Switching a shop on, once:

1. Set `GORGIAS_WEBHOOK_SECRET` in Vercel (any long random string) and
   redeploy.
2. Open Settings -> Support assistant, press Show setup beside the shop, and
   create the HTTP integration in Gorgias with exactly the URL and body shown
   (trigger: Ticket message created, method POST).
3. Add a Gorgias rule so that integration fires only for that shop's chat.
4. Practise first at Support -> Try the assistant in the sandbox: a wrong
   answer plus a correction becomes an example it uses from the next turn.
5. Set the shop's date. Start in draft mode and read the notes on real chats;
   switch the mode to auto when the drafts are right.

The webhook is `/api/gorgias/webhook?token=<secret>&shop=<shop id>`. Gorgias
does not retry a failed delivery, so the route answers 200 to everything it
has taken responsibility for and records the problem on the conversation.

The body that page prints carries only TICKET facts, and deliberately nothing
about the message. Gorgias documents template variables for the ticket
(`{{ticket.id}}`, `{{ticket.channel}}`, `{{ticket.created_datetime}}`,
`{{ticket.customer.email}}`, `{{ticket.customer.firstname}}`,
`{{ticket.subject}}`) but documents no `message` scope at all - their macro
reference says outright that it does not document `from_agent`, which is the
field that stops the assistant answering its own replies. So the webhook reads
the message from `GET /api/messages?ticket_id=...` instead, where `id`,
`body_text`, `from_agent` and `via` are documented fields of the
TicketMessage object. If a future Gorgias release documents a message scope,
the template can carry it and the extra API call can go.

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
