# Support inbox — design

Approved 2026-08-24. Research dossier: the "Support Inbox Blueprint" artifact
(Postmark/threading/helpdesk-model facts, all sourced); this file is the
decision record.

## What it is

One inbox page inside the app where every brand's support email lands as
tickets, each auto-matched to its customer, orders and parcels, and answered
from the brand's own address without leaving the app. Replaces the third-party
helpdesk the client pays for today. Admin-only in v1.

## The one architecture decision

**Mail flows through Postmark, both ways — no new vendors.**

- In: each `support@…` mailbox auto-forwards to our Postmark inbound address
  (the identical motion the client already performs for their current
  helpdesk). Postmark parses the email to JSON and POSTs our webhook.
- Out: replies go through Postmark's Email API `From` the brand's own address.
  One-time DNS per brand domain (DKIM TXT + Return-Path CNAME) verifies the
  domain account-wide.

Rejected: IMAP (needs a held-open connection; Vercel can't), Gmail/Graph APIs
(host-specific OAuth machinery), keeping the third-party tool (the point is to
leave it).

## Threading — how a reply stays in the customer's thread

- Outbound: we mint our OWN RFC `Message-ID` before sending, and set
  `In-Reply-To` + `References` from the stored chain; subject is `Re:` +
  unchanged, plus a `[PA-1042]` ticket token.
- Inbound: match `In-Reply-To`/`References` against every stored message id
  (ours and theirs); fall back to the subject token; last resort, an open
  ticket from the same sender on the same mailbox. Never merge across brands.
- Idempotency: unique on the inbound RFC message id — a redelivered webhook is
  a no-op (the `ShipmentEvent` seam, applied to email).

## Matching cascade (ticket → customer/order)

1. Sender email → `Order.customerEmail`, case-insensitive, all shops.
2. Order number found in the text → `Order.number`, scoped to the mailbox's
   shops (Woo numbers repeat across stores); `B-\d+` is B2B, unambiguous.
3. Tracking number in the text → `Shipment.trackingNumber` (globally unique).
4. Phone → NEW `Order.customerPhone` (Woo sends `billing.phone`; we never
   stored it). Mapper line + backfill, same pattern as `backfillCustomers`.
5. Fuzzy name → suggestion only, never auto-link.

No match = say so and offer manual linking. A wrong confident match is the
one forbidden outcome.

## Sidebar

Customer name/email/phone, country + webshop, previous orders with products
and values, refund state (`Order.status` + `voidedAt` — worded as "refunded in
the shop"; we do not know the bank), tracking + the same `deliveryFor()`
verdict the Delivery page prints, and previous tickets by email.

## Tickets

- Status OPEN | PENDING | CLOSED (customer reply reopens a closed ticket).
- Assignee (a User), tags, priority, internal notes (a message row with
  direction NOTE — never sent), search, filters by mailbox/status/assignee.
- Brand + country come from the receiving mailbox. Language: mailbox default,
  lightweight detection may refine; null = undetected, rendered as default,
  never stored as a guess. Category (shipping/return/warranty/refund/other):
  per-language keyword rules on the ticket, replaceable by AI later without
  schema change.

## Macros

Per-language variants sharing a name; variables `{{customer_name}}`,
`{{order_number}}`, `{{tracking_number}}`, `{{product_name}}`,
`{{delivery_status}}` resolved from the matched ticket. A macro with
unresolvable variables inserts visible MISSING markers and blocks send —
the null-is-not-zero doctrine, against Gorgias's silent blank.

## Data (5 new tables + 1 column)

`Mailbox` (address, brand shops, language, signature) → `Ticket` (number
`PA-1042`, mailboxId, status, subject, customer fields, assignee, tags,
priority, category, language, matchedOrderId) → `TicketMessage` (direction
INBOUND|OUTBOUND|NOTE, rfcMessageId indexed, inReplyTo/references, bodies,
`strippedReply`, spamScore, postmarkId) → `TicketAttachment` (bytes in
Postgres, 10 MB cap — one database, as always). `Macro` (name, language,
body, optional mailbox scope). Plus `Order.customerPhone String?`.

Postmark retention is 45 days — our database is the system of record.

## Safety

- Loop prevention: never auto-process mail carrying `Auto-Submitted` or
  `Precedence: bulk` as a normal ticket; drop mail from our own support
  addresses; stamp `Auto-Submitted: auto-generated` on anything automated.
- Spam: `X-Spam-Score` above threshold lands in a quarantine filter, never
  deleted.
- Webhook answers 200 to almost everything (Postmark redelivers on non-2xx);
  failures are recorded, not retried into a loop — the delivery-intake
  pattern.
- Customer HTML: stored raw, rendered sanitized in a sandboxed iframe, remote
  images blocked behind a click. Default view is Postmark's
  `StrippedTextReply`.

## Sending — extend, don't fork

`sendEmail()` grows the fields replies need (from, headers, optional HTML)
with existing callers untouched. Replies are plain text + per-mailbox
signature in v1.

## Works before it's connected

Seeded sample mailboxes/tickets/macros make the page fully usable on day one
(the shop-connection precedent). Connecting real mail = a settings page
listing each mailbox's forwarding address + DNS records, with per-host notes
(Workspace routing / Gmail confirmation link / M365 admin toggle / domain-host
alias). Cutover per brand, original mailboxes keep copies.

## Explicitly out of v1

AI (summarise/draft/translate/classify — schema leaves room), SUPPORT role,
snooze/SLA, HTML-composed replies, attachment upload on replies.

## Testing contract

TDD. Vitest unit/integration: threading chain, matching cascade, macro
resolution incl. blocking, webhook idempotency + loop/spam gates, reply
header recipe. Playwright e2e on seeded data: inbox list → open ticket →
sidebar shows the right order → insert macro → reply recorded; assignment,
notes, status, search. All green before done; e2e runs --headed on this
machine.
