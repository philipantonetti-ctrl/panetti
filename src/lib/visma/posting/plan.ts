/**
 * What one Dintero payout becomes in Visma, per the bookkeeper's drawing
 * (docs/superpowers/specs/2026-09-03-visma-payout-posting-design.md).
 * Pure: no database, no network. Amounts are minor units throughout.
 *
 * Branch A: each order's capture pays the ONE open invoice of the shop's
 * webshop customer whose Customer order no. is the Dintero event_reference,
 * never more than the invoice still owes. Anything else is skipped with a
 * reason, and the bookkeeper follows it up.
 * Branch B: one entry per payout - debit bank = net, debit fees = fee,
 * credit clearing = net + fee (the drawing's "Capture" whenever there is no
 * refund, and always balanced).
 */

export type PlanLine = { transactionId: string; reference2: string | null; capture: number }
export type PlanPayout = { currency: string; amount: number; fee: number }
export type PlanMapping = { customer: string; clearingAccount: string; bankAccount: string; feeAccount: string }
export type OpenInvoice = { number: string; customerRefNumber: string; currency: string; balance: number }
export type PlannedPayment = { key: string; invoiceNumber: string; amount: number }
export type PlannedSkip = { key: string; reason: string }
export type EntryLine = { account: string; debit: number; credit: number }
export type PostingPlan = { payments: PlannedPayment[]; skipped: PlannedSkip[]; entry: EntryLine[] }

export function planPosting(
  payout: PlanPayout,
  lines: PlanLine[],
  invoices: OpenInvoice[],
  mapping: PlanMapping,
): PostingPlan {
  const skipped: PlannedSkip[] = []
  // One order can be captured in more than one report line; it is still one invoice.
  const captureByOrder = new Map<string, number>()
  for (const l of lines) {
    if (l.capture <= 0) continue
    const key = (l.reference2 ?? '').trim()
    if (!key) {
      skipped.push({ key: `transaction ${l.transactionId}`, reason: 'no order number in the Dintero report' })
      continue
    }
    captureByOrder.set(key, (captureByOrder.get(key) ?? 0) + l.capture)
  }

  const payments: PlannedPayment[] = []
  for (const [key, capture] of captureByOrder) {
    const open = invoices.filter(
      (i) => i.customerRefNumber.trim() === key && i.currency === payout.currency && i.balance > 0,
    )
    if (open.length === 0) {
      skipped.push({ key, reason: 'no open invoice' })
      continue
    }
    if (open.length > 1) {
      // Paying the wrong one is worse than paying none.
      skipped.push({ key, reason: `${open.length} open invoices for order ${key}` })
      continue
    }
    payments.push({ key, invoiceNumber: open[0].number, amount: Math.min(capture, open[0].balance) })
  }

  return { payments, skipped, entry: payoutEntry(payout, mapping) }
}

export function payoutEntry(payout: PlanPayout, mapping: PlanMapping): EntryLine[] {
  // A signed amount on the debit side; a negative one is booked as a credit.
  const side = (account: string, signed: number): EntryLine =>
    signed >= 0 ? { account, debit: signed, credit: 0 } : { account, debit: 0, credit: -signed }
  return [
    side(mapping.bankAccount, payout.amount),
    side(mapping.feeAccount, payout.fee),
    side(mapping.clearingAccount, -(payout.amount + payout.fee)),
  ].filter((l) => l.debit !== 0 || l.credit !== 0)
}
