# Posting Dintero payouts to Visma

2026-09-03. Design only. Nothing here is built, and nothing in this
document writes to Visma. The accountant confirms the accounts and the
choices marked **DECISION** before any posting code is switched on.

Every API fact below comes from the Visma.net ERP API's own OpenAPI
document (`https://integration.visma.net/API-index/doc/swagger`, 395 paths,
downloaded 2026-09-03) or from the production database, read-only. Facts
that still need a live read of Philip's Visma company are listed under
"What must be checked live before building" - they are not guessed here.

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

### In Visma (measured 2026-08-18, see the finance design of that date)

- Visma already raises **an invoice for every webshop order**, against one
  house customer per shop named `… - Webkunde` (994 of the first 1 000 open
  documents). Those invoices sit **open**: 993 of 994 had a due date equal
  to the document date and a median age of 113 days. Nobody is settling them
  today. That open ledger is the thing this feature closes, one payout at a
  time.
- The company is Ledende Teknologi AS, one Visma tenant; the app is
  `isv_panetti_inventory_forecast`, granted `vismanet_erp_service_api:read`
  only.
- The API ignores unknown query parameters and returns 200 with the wrong
  rows; it rate-limits after roughly ten quick calls. Both rules from the
  read-side integration carry over unchanged.

## What the Visma API offers (from the OpenAPI document)

The customer payment is the document Visma uses for "money arrived, apply it
to these invoices". It is the only object that settles invoices per order.

`POST /controller/api/v1/customerPayment` - body `PaymentUpdateDto`, every
scalar wrapped as `{ "value": … }`:

| field | meaning |
|---|---|
| `type` | `Payment` |
| `customer` | the shop's `- Webkunde` customer number |
| `applicationDate` | the day the money reached the bank (`settledAt`) |
| `paymentRef` | **the Dintero bank reference**, e.g. `R17882-6311A9`. Mandatory on the screen ("Payment ref.*"), which is exactly the audit trail the client asked for |
| `paymentMethod`, `cashAccount` | which bank/clearing account received the money - **DECISION** |
| `currency` | the payout currency (DKK for the example) |
| `paymentAmount` | the amount that hit the cash account |
| `invoiceText` | free text, 50 characters: `Dintero R17882-6311A9 21-27 Aug` |
| `paymentLines[]` | one per document applied: `documentType` `Invoice` or `CreditNote`, `refNbr` the Visma invoice number, `amountPaid` |
| `financeCharges[]` | **charges the payment provider deducted**: `entryType`, `offsetAccount`, `offsetSubAccount`, `description`, `amount`. The read model calls its total `deductedCharges`: "the total amount of bank charges deducted by bank from the payment" |
| `hold` | `true` creates a draft the accountant can inspect on screen before it is released |

Then `POST /customerPayment/{paymentNumber}/action/release` posts it, and
`POST …/action/void` reverses one that was wrong. `GET /customerPayment`
filters by `customer`, `docDate` + `docDateCondition`, `status`,
`invoiceRefNbr` - enough to find a payment we created but failed to record.

Other objects that exist and where they fit:

- `GET /v1/customerinvoice` filtered by `customer`, `documentDate` +
  `documentDateCondition`, `status`, `customerRefNumber`, `externalReference`
  - finds the webshop invoice for an order; each invoice carries `balance`,
  `currencyId`, `status`, `customerRefNumber`, `externalReference`,
  `invoiceText`, `note`, and its `applications[]` (what has been applied so
  far).
- `GET /v1/customerCreditNote` with the same filters - the credit notes that
  a refund applies to. `POST /v2/customerCreditNote` + release can create one
  when none exists (lines with `accountNumber`, `vatCodeId`, amount).
- `GET /v1/cashaccount` (number, currency, GL account, entry types with their
  offset accounts), `GET /v1/paymentmethod`, `GET /v1/branch`,
  `GET /v1/ledger` - the configuration lists the accountant chooses from.
- `POST /v1/cashTransaction` (+ release) and `POST /v2/journaltransaction`
  (+ release) - general entries, used only in the clearing-account variant
  below.

There is no cash-transfer endpoint, and no endpoint reconciles bank
statements. Bank matching stays where it is today (the bank import in
Visma); this design makes that matching trivial by giving each bank line a
Visma payment with the same amount and the same reference.

## The proposal

### One Visma customer payment per payout

For the example payout Visma receives one document:

```
Customer payment, type Payment, customer "Panetti Danmark - Webkunde"
  date            2026-09-01           (settledAt)
  payment ref     R17882-6311A9        (Dintero bank reference)
  currency        DKK
  cash account    <DKK bank or clearing account>      DECISION
  payment amount  72 621.72            (net, the bank figure)
  invoice text    Dintero R17882-6311A9 21-27 Aug

  Documents to apply (23 lines)
    Invoice  <Visma no. for order 14238>   2 999.00
    Invoice  <Visma no. for order 14233>   3 747.00
    …                                      ---------
                                           73 147.00   = captured

  Charges (1 line)
    entry type <Dintero fee>, account <fee account>    525.28   DECISION
```

Payment 72 621.72 + charges 525.28 = applied 73 147.00. The 23 invoices
close, the fee lands on the fee account, the cash account shows one
receipt of DKK 72 621.72 dated 2026-09-01 carrying `R17882-6311A9`, which
is the line on the bank statement. One document, one reference, everything
the client listed.

**A refund** in the payout becomes a `CreditNote` line in the same document,
applied for the refunded amount, which reduces the payment amount by that
much. A partial refund (NOK 749.50 on a NOK 1 499 order) needs a credit note
of NOK 749.50 to exist in Visma. Whether the webshop-to-Visma connector
creates those today is one of the live checks below; if it does not, the
options are (a) our system creates the credit note through
`POST /v2/customerCreditNote` with an account and VAT code the accountant
names, or (b) the payout is held with the reason "credit note missing for
order 27606" until someone creates it. **DECISION**, and (b) is the safe
first version.

**A chargeback** (the 28 payouts above) is a held payout with the residual
shown - "DKK 5 999.00 not explained by capture, refund or fee" - and is
booked by hand, because a chargeback is a dispute and belongs to a person.

### The clearing-account variant

If the accountant prefers an intermediate "Dintero" account (a settlement
account that shows the gross, the fee and the bank transfer as three
movements), the same data posts as three documents: the customer payment
above with payment amount = captured and no charges, into the clearing cash
account; a cash transaction on the clearing account for the fee; and a
journal transaction moving the net from clearing to the bank account with
the Dintero reference in its description. Each carries the same reference.
The code is the same document builder with three outputs instead of one.
**DECISION**: single-document (recommended) or clearing-account.

### What "Ready" means

A payout is Ready only when every one of these holds; otherwise it shows the
first failing rule as its reason and is never posted:

1. Every line is matched to an order (`128 of 129` waits, as asked).
2. `settledAt` is set and is on or after the **start date** the accountant
   chooses. Older payouts show "before Visma start" and stay manual - most of
   the 641 predate any automation and may already be booked by hand.
3. The lines sum to the header: `sum(line.amount) = payout.amount`, and each
   line's `capture + refund - fee` equals its net - no chargeback, no
   unexplained residual.
4. At posting time, live against Visma: each matched order resolves to
   exactly one open invoice for the shop's Webkunde customer in the payout
   currency with a balance equal to the captured amount; each refund resolves
   to a credit note with at least that balance. A mismatch (invoice already
   paid, amount differs, two candidates, none) holds the payout with that
   sentence.
5. No `VismaPosting` row for this payout is Posted or Posting.

### Double posting cannot happen

- `VismaPosting` has a unique `payoutId`. Status moves Ready → Posting →
  Posted, or → Error / Held with a reason. Posting is taken with a timestamp
  so a crashed run can be noticed and retried, never run twice at once.
- Before creating, the poster asks Visma for payments to the same customer
  on the same date and compares `paymentRef`. A payment carrying our Dintero
  reference is adopted, not duplicated - this covers a crash between the
  `POST` and our own write.
- The Visma reference number (`refNbr`, from the `Location` header of the
  201 response) is stored on the row together with the request we sent and
  the document as Visma returned it.

### Posting sequence, per payout

1. Build the document from the stored lines (pure function, fully unit
   tested).
2. Live checks (rule 4). Any failure → Held, nothing written.
3. `POST` with `hold: true`.
4. `GET` the created payment; verify `appliedToDocuments`, `financeCharges`
   and `availableBalance == 0` equal what we sent. Any difference → Error,
   and the draft is voided.
5. Release. Store Posted with the Visma number and time.
6. On the first payouts the release step is left to the accountant: the
   document sits on hold in Visma where they can open it (AR302000), read
   every line, and release it themselves. Automatic release is switched on
   in settings once they are satisfied.

One payout at a time, one document per call, paced like the read imports
(the same rate limit applies). Nine payouts a week is ninety calls at most.

### What the pages show

`/finance/payouts` gains a **Visma** column: `Ready` · `Waiting: 1 order
unmatched` · `Held: chargeback DKK 5 999.00` · `Held: credit note missing
for #27606` · `Before Visma start` · `Posted 000123` · `Error: <Visma's
message>`. A Ready row has a **Post to Visma** button (admin only). An
"Auto-post ready payouts" switch lives in `/settings/payouts` and is off
until the accountant says otherwise.

`/settings/payouts` gains a Visma posting card: start date; per shop the
Webkunde customer number, cash account and payment method; the fee entry
type and account; the dry-run / hold / auto-release switches; and a
**Test** button that runs the live checks for the newest Ready payout and
shows the document it would send without sending it.

### Data model

```
model VismaPosting {
  id            String   @id @default(cuid())
  payoutId      String   @unique
  status        String   // ready | held | posting | posted | error
  reason        String?  // why held / the error text
  vismaRefNbr   String?  // Visma's payment number
  request       Json?    // what we sent
  response      Json?    // what Visma returned on the verification GET
  postedAt      DateTime?
  releasedAt    DateTime?
  attempts      Int      @default(0)
  updatedAt     DateTime @updatedAt
}

model VismaPostingConfig {          // singleton, like DeliveryConfig
  startDate         DateTime?
  feeEntryType      String?
  feeAccount        String?
  autoPost          Boolean @default(false)
  autoRelease       Boolean @default(false)
  createCreditNotes Boolean @default(false)
  creditNoteAccount String?
  creditNoteVatCode String?
}

// per shop (on DinteroConfig): vismaCustomerNumber, vismaCashAccount,
// vismaPaymentMethod
// on PayoutLine: chargeback Int, vat Int (report fields, REPORT_VERSION 4)
// on Order: vismaInvoiceRef String? (cached once resolved, never trusted
// over the live check)
```

### Credentials and scope

Every write needs the app to hold `vismanet_erp_service_api:create` (and
`update` for the release/void actions is to be confirmed on the first
call). Scopes are set per application in the Visma Developer Portal, the
change is approved by Visma, and then the company's Integration
Administrator must approve the updated app again in the Visma App Store.
The token request in `src/lib/visma/client.ts` then asks for the read and
create scopes together. Until that is done the poster reports "Visma has
not granted write access" and does nothing.

## Testing

- **Pure builder**: payout → document, red-first. Cases: the DKK example
  reproduces to the øre; a refund line becomes a credit-note application
  and lowers the payment amount; a mixed capture+refund line becomes two
  applications; a chargeback residual holds; an unmatched line holds; a
  payout before the start date is skipped; lines that do not sum to the
  header hold.
- **Client**: request shape (`{value}` wrapping, `operation: Insert`),
  `Location` header parsing, ETag/412 handling, 429 backoff, the
  "adopt an existing payment by paymentRef" path, never logging a token.
- **Route tests** mock `@/lib/visma/*` exactly as the cron test does today -
  a route test that reaches the live ERP once wrote 62 rows (see the Visma
  memory); a route test that reaches a live *write* endpoint would be worse.
- **Live, in order**: (1) read-only dry run against the real company with
  the real newest payouts - resolves invoices, prints the document, sends
  nothing; (2) a test company if Philip's Visma has one - a full post and
  release there; (3) the first production post on hold, inspected and
  released by the accountant; (4) three more the same way; (5) auto-release.

## What must be checked live before building

These need a token for Philip's company. The Visma client secret is not on
this machine and the Vercel project is under Philip's team, so either the
secret or `vercel env pull` from that team is needed. Each check is one or
two GETs, paced.

1. **Which invoice field carries the webshop order number.** Candidates:
   `customerRefNumber`, `externalReference`, `invoiceText`, `note`, and the
   `customerOrder` the payment screen shows. Read three real Panetti Denmark
   invoices from the 21-27 Aug window and compare with orders 14238, 14233,
   14244.
2. **The Webkunde customer numbers** for all nine shops, and whether each
   shop has exactly one.
3. **Invoice amount and currency** equal the captured amount (an invoice
   raised in DKK for a DKK order; VAT included).
4. **Refunds**: is there a credit note for order 27606 (NOK 749.50 back on
   2026-08-29), for 13580 (full refund 2026-08-24), and how is it linked to
   the invoice.
5. **Cash accounts, payment methods, entry types, branches, ledger** - the
   lists the accountant picks from, and whether a Dintero-specific one
   already exists.
6. **How settlements are booked today**: the newest customer payments to a
   Webkunde customer - their cash account, payment ref and applied invoices
   - so the start date does not double-book a week someone has already
   entered.
7. **The write scope**: after the App Store approval, one `POST` with
   `hold: true` and an immediate void, in the test company if one exists.

## Questions for the accountant

1. Single document with the fee as a deducted charge, or a Dintero clearing
   account with three movements?
2. Which cash account receives each currency (one bank account per
   currency, or one clearing account per currency)?
3. Fee account and VAT treatment of Dintero fees; the entry type to use.
4. Refunds: do credit notes already exist for webshop refunds? If not, may
   the system create them, on which account and VAT code, or should those
   payouts wait for a manually created credit note?
5. Chargebacks: confirm they stay manual.
6. The start date. Everything settled before it stays as it is.
7. Is there a test company we can post to first?
8. Payment date: the bank date (`settledAt`, recommended) or the period end?

## Out of scope

Creating invoices in Visma (they already exist), B2B invoices, Klarna's own
settlements if any bypass Dintero, bank statement import, and anything that
edits an invoice.
