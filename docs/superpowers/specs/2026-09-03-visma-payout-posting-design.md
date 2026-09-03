# Posting Dintero payouts to Visma

2026-09-03. Design only. Nothing here is built, and nothing in this
document writes to Visma. The accountant confirms the accounts and the
choices marked **DECISION** before any posting code is switched on.

Every API fact below comes from the Visma.net ERP API's own OpenAPI
document (`https://integration.visma.net/API-index/doc/swagger`, 395 paths,
downloaded 2026-09-03). Every number about our side is from the production
database, read-only. Every fact about Philip's Visma company was read from
the live company on 2026-09-03 through a read-only probe that runs inside
the scheduled sync (`src/lib/visma/probe.ts`, PR #118) - the only place the
Visma credentials exist - and stored in `DiagnosticSnapshot`. Nothing below
is inferred from documentation alone.

## What the client asked for

For each Dintero payout: settle the individual webshop orders in Visma,
register the Dintero fee, handle refunds, reconcile the net amount against
the bank, carry the Dintero bank reference for the audit trail. Never post a
payout that is not fully matched. Store the Visma document id on the payout,
show Ready / Posted / Error, and make a double post impossible.

## What is already true

### On our side (production, 2026-09-03)

| | |
|---|---|
| payouts mirrored | 641, across 9 shops, all settled |
| fully matched | 584 |
| partially matched | 57 (these wait; never posted) |
| lines | 17 942, 17 866 matched |
| currencies | NOK (Panetti + Mazzetti Norway), SEK (both Sweden), DKK (both Denmark), EUR (Finland x2, Germany) |
| bank reference shape | `R17882-6311A9` - a weekly run id and a suffix, one per shop per week |

The example from the request is real: Panetti Denmark, settled 2026-09-01,
period 21-27 Aug, reference `R17882-6311A9`, capture DKK 73 147.00, fee
DKK 525.28, net DKK 72 621.72, 23 of 23 orders matched. Its 23 lines are
MobilePay and card payments with a fee on every line.

Three measured facts shape the accounting:

1. **Refunds are mostly partial.** 653 lines carry a refund. 486 are pure
   refund lines (no capture); of those, 263 belong to orders that are now
   refunded or cancelled, and 221 to orders still `completed` - a partial
   refund such as NOK 749.50 back on a NOK 1 499 order. 167 lines carry a
   capture and a refund of the same order in the same week.
2. **28 payouts do not satisfy `capture + refund - fee = net`.** The lines
   still sum to the net on all but one of them, so the difference lives in
   per-line fields we do not store yet - the report row carries `chargeback`
   and `vat` beside `capture`, `refund` and `fee`. The residuals are whole
   order amounts (NOK 5 999.00, SEK 4 999.00, ...), which is what a lost
   chargeback looks like. These payouts must never post as if they balanced.
3. **The lines balance to the header** on 640 of 641 payouts (the exception
   is a 2025-09-16 Mazzetti Norway payout whose report holds 3 lines against a
   larger net - an old partial report). That is the check the gate uses.

### In Philip's Visma company (read live, 2026-09-03)

**The company.** One branch (`1`, Ledende Teknologi AS), one actual ledger
(`1`, NOK). 32 cash accounts, of which these matter:

| cash account | currency | what it is |
|---|---|---|
| 1509 Dintero - EUR | EUR | Dintero clearing |
| 1512 Dintero - DKK | DKK | Dintero clearing |
| 1513 Dintero - SEK | SEK | Dintero clearing |
| 1514 Dintero NOK | NOK | Dintero clearing |
| 1920 Bank 1506.51.15155 | NOK | main bank |
| 1940 Bank EURO 1251.05.96798 | EUR | bank |
| 1960 Bank - DKK 1251.06.32328 | DKK | bank |
| 1970 Bank - SEK 1251.05.96828 | SEK | bank |

Payment method `5 Netthandel` is on every webshop document. The bank
accounts carry entry types `Gebyr` (Bankgebyr) and `3 Bankkostnader`; the
Dintero accounts carry only `1 Utbetaling` and `2 Innbetaling`.

**The webshop customers.** One house account per shop: Panetti Norge 10421,
Mazzetti Norge 10423, Panetti Sweden 10430, Panetti Denmark 10478, Panetti
Finland 10504, Panetti Deutschland 10859, Mazzetti Finland 10892, Mazzetti
Sweden 10706. Mazzetti Denmark has not appeared in any read yet.

**The invoices.** The webshop connector makes a sales order, a shipment and
an invoice per order. The invoice's **`customerRefNumber` and
`externalReference` both hold the webshop order number** (`14238`), its text
reads `Panetti.dk - Weborder`, its cash account is the currency's Dintero
clearing account. 85 Panetti Denmark invoices since 15 Aug against 85
Panetti Denmark orders in our database for the same window, amounts equal to
the øre (order 14238 = invoice 130474 = DKK 2 999.00). The join the whole
feature stands on is therefore `customerRefNumber` = `Order.number`, scoped
to the shop's house customer, and the API filters on it directly.

**How settlement is done today - by hand, in batches.** A closed webshop
invoice carries exactly one application: a customer payment for the full
amount, dated the invoice date, `paymentRef` = the invoice number, payment
method 5, cash account = the Dintero clearing account. All 97 Panetti
Denmark payments dated 2 Jan to 6 Feb 2026 were last modified on
**2026-02-22** - one sitting. On 3 Sep every webshop invoice from 26 Aug on
was still open (37 Denmark, 133 Panetti Norge, 16 Sweden, 7 Finland, 3
Germany, 2 Mazzetti Norge, 1 Mazzetti Finland: 199 invoices) because nobody
had sat down yet. Of the example payout's 23 orders, 17 are paid this way
and 6 (orders 14379 to 14420, invoiced 26-27 Aug) are still open. This
batch of one-payment-per-invoice is the manual matching the client wants
gone.

**How refunds are done today.** A credit note exists per refund - some from
the connector (`Refund and return of stock for Invoice 128868`,
`Cancellation of Invoice 129390 with return to stock.`), some typed
(`Panetti.dk - Webrefund of order #12006`, created 27 Aug for a refund
Dintero paid on 16 Jun). The accountant then creates a **Refund** document
(type `Refund`, payment method 5, cash account 1514, `paymentRef` = the
credit note number, one `CreditNote` line) which takes the money out of the
clearing account; the two Mazzetti Norge ones were made on 26 Aug. The two
Denmark credit notes were still open on 3 Sep, no Refund yet.

**Fees** do not appear in the customer ledger at all. The one trace of
reconciliation is a Denmark credit note of DKK 15 636 dated 28 Feb, text
`Avstemt januar og februar - panetti.dk` - a plug whose composition cannot
be seen (Denmark's Dintero fees for those two months were DKK 3 043.67).

**What this means.** Visma already has an object for every piece of the
payout: the invoice per order, the credit note per refund, the clearing
account per currency, the bank account per currency. What is missing is
the work of tying them together per payout, and it is done late, by hand,
without the Dintero reference. The design below does that work, per payout,
in the same documents the accountant uses today, so nothing about the
company's books changes shape.

## What the Visma API offers (from the OpenAPI document)

`POST /controller/api/v1/customerPayment` - body `PaymentUpdateDto`, every
scalar wrapped as `{ "value": … }`:

| field | meaning |
|---|---|
| `type` | `Payment` for money in, `Refund` for money out |
| `customer` | the shop's house customer number |
| `applicationDate` | the accounting date |
| `paymentRef` | mandatory on the screen ("Payment ref.*") - the audit-trail field |
| `paymentMethod`, `cashAccount` | `5` and the currency's Dintero clearing account, as today |
| `currency`, `paymentAmount` | the document currency and amount |
| `invoiceText` | free text, 50 characters |
| `paymentLines[]` | `documentType` `Invoice` or `CreditNote`, `refNbr`, `amountPaid` |
| `financeCharges[]` | charges deducted by the payment provider (`entryType`, `offsetAccount`, `amount`) - unused in the recommended variant |
| `hold` | `true` creates a draft the accountant can inspect before release |

Then `POST /customerPayment/{n}/action/release` posts it and
`POST …/action/void` reverses one. `GET /customerPayment` filters by
`customer`, `docDate` + `docDateCondition`, `status`, `invoiceRefNbr`.
`GET /customerinvoice` and `GET /customerCreditNote` filter by `customer`,
`documentDate` + `documentDateCondition`, `status`, `customerRefNumber`,
`externalReference`; `expandApplications=true` returns what is applied.
All of these were exercised live and returned the rows they claim to.

`POST /v1/cashTransaction` (+ release) books a receipt or disbursement on a
cash account against an offset account; `POST /v2/journaltransaction`
(+ release) is the general entry. There is no cash-transfer endpoint and
no bank-statement endpoint; the bank match stays in Visma's bank import,
and this design makes that match trivial.

## The proposal

Mirror the accountant's documents, one payout at a time, the day the money
lands, with the Dintero reference on every one of them.

For the example payout Visma receives:

```
1. One customer payment PER ORDER not yet paid (6 of 23 today; 0 once caught up)
     type Payment, customer 10478, method 5, cash account 1512 Dintero - DKK
     date        invoice date            (as today)          DECISION: or 2026-09-01, the bank date
     payment ref R17882-6311A9           (the Dintero reference)   DECISION: or the invoice number, as today
     text        Dintero R17882-6311A9 order 14379
     line        Invoice 130677  3 777.00

2. One Refund PER REFUND LINE, applying the credit note
     type Refund, customer, method 5, cash account 1512
     payment ref R17882-6311A9, text Dintero R17882-6311A9 refund order 12006
     line        CreditNote 130722  399.00
   (none in the example payout)

3. The fee, once per payout
     cash transaction on 1512, disbursement, entry type <Dintero fee>      DECISION: entry type + account
     amount 525.28, description Dintero fee R17882-6311A9

4. The transfer to the bank, once per payout
     Dr 1960 Bank - DKK  72 621.72  /  Cr 1512 Dintero - DKK  72 621.72
     date 2026-09-01, description Dintero R17882-6311A9
     (a cash transaction on 1960 with offset 1512, or a journal transaction)  DECISION
```

After the four steps the clearing account's movements for the payout net to
zero: + 73 147.00 in (1) - 0 in (2) - 525.28 in (3) - 72 621.72 in (4). The
bank statement line of DKK 72 621.72 on 1 Sep matches document (4) by
amount, date and reference.

**Orders already paid by the accountant** (the 17) are adopted, not paid
twice: the invoice's application is read live, and a closed invoice whose
single application equals the captured amount counts as settled. The
stored record notes the existing payment number.

**A refund whose credit note does not exist** holds the payout with the
reason `credit note missing for order 27606`, and the accountant creates it
as today. Creating credit notes from our side (`POST /v2/customerCreditNote`,
which needs an account and VAT code) is possible but is a **DECISION** for
later; the safe first version waits.

**A chargeback** (the 28 payouts above) is a held payout with the residual
shown - "DKK 5 999.00 not explained by capture, refund or fee" - and is
booked by hand, because a chargeback is a dispute and belongs to a person.

### The single-document alternative

The API can carry a whole payout in one customer payment: all invoices as
lines, the fee as a deducted charge (`financeCharges`), the payment amount
= the net, cash account = the bank account directly. One document, no
clearing account. It is fewer documents but it changes the shape of the
books the accountant has kept for two years (the per-invoice payments and
the clearing accounts), so it is offered, not recommended. **DECISION.**

### What "Ready" means

A payout is Ready only when every one of these holds; otherwise it shows the
first failing rule as its reason and is never posted:

1. Every line is matched to an order (`128 of 129` waits, as asked).
2. `settledAt` is set and is on or after the **start date** the accountant
   chooses. Older payouts show "before Visma start" and stay manual.
3. The lines sum to the header: `sum(line.amount) = payout.amount`, and each
   line's `capture + refund - fee` equals its net - no chargeback, no
   unexplained residual.
4. At posting time, live against Visma: each order resolves to exactly one
   invoice for the shop's house customer with `customerRefNumber` equal to
   the order number, in the payout currency, amount equal to the captured
   amount, and either open or already paid in full by one application; each
   refund resolves to a credit note of at least that balance. Anything else
   (two candidates, none, a different amount, a partial application) holds
   the payout with that sentence.
5. No `VismaPosting` row for this payout is Posted or Posting.

### Double posting cannot happen

- `VismaPosting` has a unique `payoutId`. Status moves Ready → Posting →
  Posted, or → Held / Error with a reason. Posting carries a timestamp so a
  crashed run is noticed and retried, never run twice at once.
- Every document we create carries the Dintero reference in `paymentRef` or
  the description. Before creating, the poster reads the customer's payments
  on that date and the invoice's applications; a document already carrying
  our reference, or an invoice already paid, is adopted - this covers a
  crash between a `POST` and our own write.
- The Visma reference numbers (from the `Location` header of each 201)
  are stored on the row with the request sent and the document as Visma
  returned it.

### Posting sequence, per payout

1. Build the documents from the stored lines (pure function, unit tested).
2. Live checks (rule 4). Any failure → Held, nothing written.
3. Create each document with `hold: true`, in the order above.
4. Read each back; verify amounts and applications equal what was sent.
   Any difference → Error, and the drafts are voided.
5. Release. Store Posted with the Visma numbers and time.
6. On the first payouts the release is left to the accountant: the drafts
   sit on hold in Visma where they can be opened and released by hand.
   Automatic release is switched on in settings once they are satisfied.

Paced like the read imports (the same rate limit applies): a payout with
23 orders is at most 23 + refunds + 2 creates plus the reads, so one payout
per cron tick, never more, and the reads are cached per tick.

### What the pages show

`/finance/payouts` gains a **Visma** column: `Ready` · `Waiting: 1 order
unmatched` · `Held: chargeback DKK 5 999.00` · `Held: credit note missing
for #27606` · `Before Visma start` · `Posted` (with the document numbers in
the row's detail) · `Error: <Visma's message>`. A Ready row has a **Post to
Visma** button (admin only). An "Auto-post ready payouts" switch lives in
`/settings/payouts` and is off until the accountant says otherwise.

`/settings/payouts` gains a Visma posting card: start date; per shop the
house customer number and clearing cash account (pre-filled from the live
lists above); the fee entry type and account; the transfer method; the
dry-run / hold / auto-release switches; and a **Test** button that runs the
live checks for the newest Ready payout and shows the documents it would
send without sending them.

### Data model

```
model VismaPosting {
  id            String   @id @default(cuid())
  payoutId      String   @unique
  status        String   // ready | held | posting | posted | error
  reason        String?
  documents     Json?    // [{kind, vismaRefNbr, amount, adopted}]
  request       Json?
  response      Json?
  postedAt      DateTime?
  releasedAt    DateTime?
  attempts      Int      @default(0)
  updatedAt     DateTime @updatedAt
}

model VismaPostingConfig {          // singleton, like DeliveryConfig
  startDate         DateTime?
  feeEntryType      String?
  feeAccount        String?
  transferMethod    String   @default("cash")   // cash | journal
  paymentRefStyle   String   @default("dintero") // dintero | invoice
  autoPost          Boolean  @default(false)
  autoRelease       Boolean  @default(false)
}

// per shop (on DinteroConfig): vismaCustomerNumber, vismaCashAccount,
// vismaBankAccount
// on PayoutLine: chargeback Int, vat Int (report fields, REPORT_VERSION 4)
```

### Credentials and scope

Every write needs the app to hold `vismanet_erp_service_api:create` (and
`update` for the release/void actions, to be confirmed on the first call).
Scopes are set per application in the Visma Developer Portal, the change is
approved by Visma, and then the company's Integration Administrator
approves the updated app again in the Visma App Store. The token request in
`src/lib/visma/client.ts` then asks for the read and create scopes together.
Until that is done the poster reports "Visma has not granted write access"
and does nothing. The credentials themselves stay where they are: in the
production environment only, which is why the live checks above were made
by the cron and not from a laptop.

## Testing

- **Pure builder**: payout → documents, red-first. Cases: the DKK example
  reproduces to the øre with 6 payments and 17 adoptions; a refund line
  becomes a Refund applying the credit note; a mixed capture+refund line
  becomes a payment and a refund; a chargeback residual holds; an unmatched
  line holds; a payout before the start date is skipped; lines that do not
  sum to the header hold.
- **Client**: request shape (`{value}` wrapping, `operation: Insert`),
  `Location` header parsing, ETag/412 handling, 429 backoff, the
  "adopt an existing document by reference" path, never logging a token.
- **Route tests** mock `@/lib/visma/*` exactly as the cron test does today.
- **Live, in order**: (1) the dry run in production through the cron, the
  way the probe already works - resolves every invoice for the newest Ready
  payouts, stores the documents it would send, sends nothing; (2) a test
  company if Philip's Visma has one; (3) the first production post on hold,
  inspected and released by the accountant; (4) three more the same way;
  (5) auto-release.

## Live checks: answered

| question | answer (2026-09-03) |
|---|---|
| which invoice field carries the order number | `customerRefNumber` and `externalReference`, both; filterable |
| the house customer numbers | eight found (table above); Mazzetti Denmark still to find |
| invoice amount and currency equal the capture | yes, 85 of 85 Denmark invoices since 15 Aug |
| refunds | credit notes exist per refund, then a `Refund` document by hand; two Denmark ones open |
| cash accounts, payment methods, entry types | Dintero clearing per currency, banks per currency, method 5, `Gebyr` on banks only |
| how settlements are booked today | one payment per invoice, by hand, in batches weeks later; 199 invoices waiting on 3 Sep |
| the write scope | still to grant; nothing has been written |

## Questions for the accountant

1. Keep the per-invoice payments into the Dintero clearing accounts as
   today (recommended), or one document per payout straight to the bank?
2. Payment ref on our payments: the Dintero reference (recommended, it is
   the audit trail asked for) or the invoice number as today?
3. Payment date: invoice date as today, or the bank date?
4. The fee: which expense account and VAT code, and may we add an entry
   type "Dintero gebyr" on the four Dintero cash accounts?
5. The transfer to the bank: a cash transaction on the bank account with
   the clearing account as offset, or a journal transaction?
6. Refunds: keep creating the credit notes as today and let the system
   apply them, or should the system create them too (account, VAT code)?
7. Chargebacks stay manual: confirm.
8. The start date. Everything settled before it stays as it is. The 199
   open invoices from 26 Aug would be the first batch.
9. Is there a test company we can post to first?

## Out of scope

Creating invoices in Visma (the connector does), B2B invoices, Klarna's
own settlements if any bypass Dintero, bank statement import, and anything
that edits an invoice.
