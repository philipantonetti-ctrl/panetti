# Posting Dintero payouts to Visma

**Revised 2026-10-15** to follow the bookkeeper's drawing (Abacus, sent by
Philip with Panetti DE as the example). It replaces the 2026-09-03 version,
which is in git history. Design only: nothing here is built, and nothing
writes to the real Visma company. Every write goes to the test company first,
and the accountant sees it work there before the real books are touched.

Facts are marked by source: **[code]** read from this repo on 2026-10-15,
**[live]** read from Philip's Visma company by the read-only probe,
**[portal]** seen in the Visma Developer Portal / App Store on 2026-10-15,
**[Abacus]** from the drawing or the bookkeeper's replies. Anything not yet
proven is marked **VERIFY IN TEST** and is the first thing the test company
is used for.

## What Abacus asked for

The drawing has two independent jobs that both read the same Dintero
settlement (payout), and one control account that ties them together.

```
                 Dintero settlement (one payout to the bank)
                 /                                     \
  Branch A: CompleteInvoiceFromDintero     Branch B: CreateCashTransactionFromDintero
  for each order line in the report:       once per payout:
    event_reference = the order number       read Capture, Amount (net) and Fee
    find the OPEN customer invoice of        one bank transaction (batch):
      the shop's webshop customer whose        Debit  bank      = Amount
      Customer order no. = event_reference     Debit  7770 fees = Fee
    found -> customer payment                  Credit Dintero   = Capture
      cash account = Dintero clearing
      payment method 5
      amount = capture, at most the invoice
      -> invoice closed
    not found -> no action

  Dintero clearing account (1509 for EUR): Branch A debits it, Branch B
  credits it. It nets to 0 when both have run and every order matched.
```

Their replies (relayed by Philip, 2026-10-15) **[Abacus]**:

- Nothing runs today. There is no Dintero to Visma integration yet; this is
  what we build.
- The old bank rule that posted the bank line is set inactive, so Branch B's
  bank line is not booked twice.
- Post the invoices that match. Do not wait for the whole payout to match.
  Abacus follows up whatever does not match. (This replaces the earlier
  "never post a payout that is 128 of 129".)

Still valid from the 29 Sept answers **[Abacus]**: one payment per invoice,
`paymentRef` = the Dintero reference, payment date = the bank date, credit
notes stay the accountant's job, chargebacks stay manual, start with payouts
landing from 1 Oct 2026, test company first. Superseded: "fees not booked"
and "transfer not booked" (Branch B now books both).

Philip's own asks that still apply: store the Visma document numbers on the
payout, show Ready / Posted / Error, and make posting the same payout twice
impossible. Match Dintero lines straight to Visma invoices by order number,
never through Panetti's order table.

## Open questions (sent to Abacus, waiting)

1. **Refunds.** The drawing has no refund step, and its Branch B only
   balances when a payout has no refund (see "Branch B", below). Proposed:
   Branch B credits the clearing account with Amount + Fee, and a refund line
   becomes a Refund document that applies the credit note with the same order
   number from the clearing account; no credit note, no action, Abacus
   follows up.
2. **Accounts and customers per shop.** Only Panetti DE is confirmed (1509,
   1940, 7770, customer 10859). Our guess from the live company: DKK 1512 +
   bank 1960, SEK 1513 + bank 1970, NOK 1514 + bank 1920, fees 7770 for all.
   Mazzetti Denmark's customer number is unknown.
3. **Payment date (not asked yet).** On 29 Sept Abacus asked for the bank
   date. We only have Dintero's settlement date (`settledAt`); the bank may
   book the money a day or two later. Proposed: use `settledAt`, and Abacus
   says whether that is acceptable.

Until they answer, only Panetti DE is configured and refund lines are left
alone. Nothing else in this design depends on the answers.

## What is already true

### Our side **[code]**

- `Payout` mirrors one Dintero settlement: `currency`, `capture`, `refund`,
  `fee`, `amount` (minor units, `capture + refund - fee = amount`, refund
  stored negative), `reference` (the bank transfer reference, e.g.
  `R17882-6311A9`), `settledAt`, `linesPending`, `reportVersion`.
- `PayoutLine` is one row of the settlement report: `capture`, `refund`,
  `fee`, `amount`, and `reference2`, which since report version 3 is read
  from the row's **`event_reference`** (falling back to
  `merchant_reference_2`). That is exactly the drawing's key. Branch A uses
  `reference2` directly and ignores `orderId`.
- Measured 2026-09-30 (read-only, production): `reference2` is numeric on
  97.9% of lines since 1 Aug. The gap is mostly Panetti Sweden Swish
  captures, whose report rows carry no order number; those become "no match"
  and Abacus follows them up.
- `Payout.settledAt` is Dintero's `settled_at`, not the day the bank booked
  the money. We have no bank feed, so the bank date is not available to us.
- The Visma client asks `connect.visma.com` for a client-credentials token
  with `scope=vismanet_erp_service_api:read` and `tenant_id` from
  `VISMA_TENANT_ID`; the API host is `https://api.finance.visma.net`. No code
  writes to Visma today.

### Philip's real company **[live, 2026-09-03 and 2026-09-30]**

- Cash accounts: Dintero clearing 1509 EUR, 1512 DKK, 1513 SEK, 1514 NOK;
  banks 1920 NOK, 1940 EUR, 1960 DKK, 1970 SEK. Payment method 5 Netthandel
  on every webshop document.
- Webshop customers: Panetti Norge 10421, Mazzetti Norge 10423, Panetti
  Sweden 10430, Panetti Denmark 10478, Panetti Finland 10504, Panetti
  Deutschland 10859, Mazzetti Finland 10892, Mazzetti Sweden 10706.
- The connector makes one invoice per webshop order. The invoice's
  `customerRefNumber` (shown as "Customer order no.") holds the webshop order
  number. The direct join `event_reference = customerRefNumber` was 82 of 82
  on Panetti Denmark's non-zero invoices, amounts equal to the øre.
- Order numbers repeat across shops (2,370 shared values), so the search is
  always scoped to the shop's own webshop customer.

### The test company **[portal, 2026-10-15]**

- "Test LEDENDE TEKNOLOGI AS", tenant `08058ec7-a375-11ec-b60b-0638767d04b5`,
  opened in the browser at `demo.finance.visma.net`. Our app is connected
  with **read + create**. The real company, tenant
  `83949a19-af32-11ec-b60b-0638767d04b5`, is still **read only**, so Visma
  itself refuses any write there.
- The app's `update` permission is deactivated. Releasing a document needs
  it, so until it is switched on every document we create stays **on hold**.
- The test company is a nearly empty standard company: 3 customers (10000,
  10001, 10002) and cash accounts 1520, 1900, 1910, 1920, 1930, 1940 EUR,
  1950, 2420. No webshop customer, no Dintero clearing account. It has to be
  filled before anything can be tested (see "Test plan").

## Branch A: settle each invoice

Run per payout, once it is Ready (see below).

1. Take the payout's lines with a capture. Group them by `reference2`, since
   one order can be captured in more than one line; the group's capture is
   the sum. Lines with no `reference2` are "no match".
2. Read the shop's webshop customer's open invoices from Visma, paged. The
   receivables import already reads `customerdocument?status=Open` live
   **[code]**, and `customerinvoice` filtered by customer and document date
   is proven **[live]**. Match in our code all the same: status open,
   customer, `customerRefNumber` equal to `reference2`, same currency as the
   payout. Filtering on `customerRefNumber` in the request has never been
   proven, and an unknown filter answers 200 with the wrong rows, so it is
   not relied on. Which of the two reads carries `customerRefNumber` and the
   open balance is **VERIFY IN TEST**.
3. For each order:
   - exactly one open invoice: create a customer payment (below);
   - none open (not invoiced yet, already paid, or a different customer):
     no action, recorded as "no open invoice";
   - more than one open invoice with that number: no action, recorded as
     "two invoices for order N". Paying the wrong one is worse than paying
     none.
4. The payment, one per invoice **[Abacus]**:

| field | value |
|---|---|
| `type` | `Payment` |
| `customer` | the shop's webshop customer (10859 for Panetti DE) |
| `cashAccount` | the currency's Dintero clearing account (1509 for EUR) |
| `paymentMethod` | `5` |
| `paymentRef` | the Dintero reference, `Payout.reference` |
| `applicationDate` | `Payout.settledAt` (open question 3) |
| `paymentAmount` | the order's capture, **at most** the invoice's open balance |
| `paymentLines` | one line: document type `Invoice`, the invoice number, the same amount |
| `invoiceText` | `Dintero <reference> order <number>` (50 characters max) |
| `hold` | `true` (until `update` is granted, then released) |

When the capture is lower than the invoice (a discount Dintero saw and Visma
did not), the invoice stays partly open and Abacus sees it. When the capture
is higher, the invoice is paid in full and the difference stays on the
clearing account. Both are visible, neither is guessed at.

## Branch B: book the payout

Once per payout, independent of how many orders matched.

| line | account | amount |
|---|---|---|
| debit | the currency's bank account (1940 for EUR) | `amount` (the net payout) |
| debit | 7770 Dintero fees | `fee` |
| credit | the currency's Dintero clearing account (1509 for EUR) | `amount + fee` |

`amount + fee` is the drawing's "Capture" whenever the payout has no refund,
so for those payouts this is the drawing to the cent. It also always
balances: with a refund, `amount + fee = capture - refund`, which is what
actually left the clearing account. This is open question 1.

Date `Payout.settledAt`, description and reference `Dintero <reference>`.

Which Visma document this is: the drawing says "bank transaction (batch)".
The candidates in the API are a journal transaction (`/v2/journaltransaction`,
three lines, one balanced entry) and a cash transaction on the bank account
(`/v1/cashTransaction`). The journal transaction is the first choice because it
holds all three lines in one document. Whether Visma accepts journal lines
directly on cash accounts 1940/1509, and in EUR on a NOK ledger, is
**VERIFY IN TEST**. If it refuses, we ask Abacus which document they meant
rather than invent one.

A payout whose header does not add up (`capture + refund - fee` differs from
`amount`, which is what a chargeback looks like: 28 of 641 payouts on
2026-09-03) still posts Branch B with `amount + fee`. The difference stays
on the clearing account, where Abacus sees it.

## Worked example

Panetti Denmark, settled 2026-09-01, reference `R17882-6311A9`, capture
DKK 73 147.00, fee DKK 525.28, net DKK 72 621.72, no refund, 23 orders.
Accounts are the unconfirmed DKK guess (open question 2).

- Branch A: one payment per order whose invoice is still open, into 1512,
  method 5, payment ref `R17882-6311A9`. Orders already paid by hand are not
  open, so they get no action.
- Branch B: debit 1960 72 621.72, debit 7770 525.28, credit 1512 73 147.00.
- Clearing account 1512 for this payout: Branch A (+ any earlier hand
  payments) debits 73 147.00, Branch B credits 73 147.00, net 0.

## When a payout is Ready

All of these, otherwise the payout shows the first one that fails:

1. `settledAt` is set and on or after the start date (1 Oct 2026).
2. The report is stored: `linesPending` is false and `reportVersion` is
   current.
3. The shop has a Visma mapping: webshop customer, clearing account, bank
   account, fee account. Only Panetti DE has one until Abacus confirms the
   rest.
4. No posting exists for it yet. A posting left in `posting` or `error` is
   resumed by the next run (see "Never twice"), never started again.

Unmatched orders do **not** stop a payout. They are recorded and shown, and
Abacus follows them up.

## Never twice

- One `VismaPosting` row per payout (unique `payoutId`), status
  `ready` → `posting` → `posted` or `error`.
- One `VismaPostingDocument` row per document, unique on
  `(payoutId, kind, key)`, where kind is `payment` (key = order number) or
  `payout` (key = the payout). The row is written **before** the POST with
  status `sending`, and gets the Visma document number from the response
  afterwards.
- A row left in `sending` (a crash between the POST and our write) is never
  re-sent blind. The next run reads Visma first: for a payment, is the
  invoice still open; for the payout entry, does a document with our
  description exist. Only when Visma shows nothing is it sent again.
- On top of that, Visma itself will not take a write to the real company:
  it is connected read only.

## What Philip sees in Panetti

`/finance/payouts` gets a Visma column per payout:

- `Waiting: before 1 Oct` / `Waiting: report pending` / `Waiting: no Visma setup for this shop`
- `Ready`
- `Posted: 21 of 23 orders settled, 2 left for Abacus` (click for the
  Visma document numbers and the reason per unmatched order)
- `Error: <Visma's message>`

This is Philip's view, not the accountant's tool: Abacus works only in Visma,
where every document carries the Dintero reference.

## Safety switches

- Writes use their own tenant setting, `VISMA_WRITE_TENANT_ID`, set to the
  test tenant. The code refuses to write when it equals the real tenant
  `83949a19-...` unless a second, explicit setting names the real tenant
  too. Moving to the real books is two deliberate steps, never one.
- The write token asks for exactly `read create` (plus `update` once it is
  switched on). Asking for a scope the company has not accepted fails the
  whole token request, so the read token used by the live site is never
  touched.
- Off by default: an admin switch turns posting on; until then the job only
  computes what it would send and shows it.

## Data model (new)

```
model VismaPosting {
  id        String   @id @default(cuid())
  payoutId  String   @unique
  tenantId  String          // which Visma company it was written to
  status    String          // ready | posting | posted | error
  matched   Int      @default(0)
  unmatched Int      @default(0)
  error     String?
  postedAt  DateTime?
  updatedAt DateTime @updatedAt
  documents VismaPostingDocument[]
}

model VismaPostingDocument {
  id          String  @id @default(cuid())
  postingId   String
  kind        String          // payment | payout
  key         String          // order number, or the payout id
  status      String          // sending | sent | skipped | error
  reason      String?         // "no open invoice", "two invoices for order N", Visma's error
  vismaNumber String?         // from the Location header of the 201
  amount      Int?
  @@unique([postingId, kind, key])
}

// per shop, on DinteroConfig: vismaCustomer, vismaClearingAccount,
// vismaBankAccount, vismaFeeAccount (all nullable; null = not set up)
```

## Test plan

In order. Nothing goes further until the step before it is shown to work.

1. **Connection.** One read through the test tenant: list the test company's
   customers and expect 10000, 10001, 10002. This also proves which API host
   serves the test company (`api.finance.visma.net` is assumed,
   **VERIFY IN TEST**). It runs through the scheduled probe, because the
   Visma secret only exists in production.
2. **Fill the test company** to mirror Panetti DE: the GL accounts and cash
   account 1509 (EUR, payment method 5), 7770 if missing, webshop customer
   10859, and a handful of open invoices whose Customer order no. equals the
   `event_reference` of a real Panetti DE payout's lines. Through the API
   where it allows creation, otherwise by hand in the test company with a
   guided click list.
3. **Dry run** against that real payout: the job computes every document it
   would send and shows it. Nothing is written.
4. **Write on hold** into the test company. Philip and Abacus open the
   documents in Visma and check them against the drawing.
5. **Release in test** once `update` is switched on for the app (test company
   only), and check that the clearing account nets to 0 for the payout.
6. Only then, and only with Abacus's sign-off: the real company accepts
   `create` (and `update`), the second safety setting is set, and the first
   real payouts post on hold for Abacus to release.

Automated tests, red first: grouping lines by order, the capped payment
amount, one / none / two open invoices, the Branch B lines balancing with and
without a refund and with a chargeback residual, the Ready rules, the
`sending` crash path (read Visma, then decide), and the refusal to write to
the real tenant. Route tests mock `@/lib/visma/*`; no test may reach the live
ERP.

## Out of scope

Creating or editing invoices or credit notes (the connector and the
accountant do), chargebacks (manual), bank statement import, B2B invoices,
and anything in the real company before the test steps above are done.
