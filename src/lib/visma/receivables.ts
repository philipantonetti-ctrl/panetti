import { unwrap } from './purchase-orders'
import type { VismaCustomerDocument } from './types'

export type MappedReceivable = {
  referenceNumber: string
  customerNumber: string
  customerName: string
  documentType: string
  documentDate: Date
  dueDate: Date | null
  currency: string
  /** Minor units, in `currency`. */
  amount: number
  balance: number
}

/**
 * Is this one of the collective accounts the webshops are booked against?
 *
 * Visma raises an invoice for every webshop order and books it to a per-country
 * house account — "Panetti Norge - Webkunde", "Mazzetti Norge - Webkunde" and
 * six more. Those invoices are paid at the checkout by card, and this ledger is
 * never reconciled for them: 994 of the first 1000 open documents were one,
 * 993 of them with a due date equal to their document date and a median age of
 * 113 days. Treated as debt they would be 4 million NOK of pure noise, and the
 * six real overdue invoices would be unfindable underneath.
 *
 * The test is the SUFFIX, not the word: a real company called "Webkunde
 * Logistics" is a customer like any other.
 *
 * This is a name test, and a name test is fragile if the accounts are ever
 * renamed. It is chosen anyway because the robust alternative — reading
 * `creditTerms`, which is absent from the list form — costs one HTTP request
 * per document against an API that refuses after roughly ten. The importer logs
 * how many rows this excludes on every run, so a rename shows up as a sudden
 * jump rather than as silence.
 */
export function isWebshopAccount(name: string): boolean {
  return /-\s*webkunde$/i.test(String(name ?? '').trim())
}

const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()

const money = (v: unknown): number => {
  const raw = unwrap<unknown>(v)
  // Rounded, not truncated. Visma really does send fractions — 9257.5 DKK on a
  // live open credit note — and `Math.trunc` would quietly lose 50 øre a row.
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw * 100) : 0
}

const date = (v: unknown): Date | null => {
  const raw = unwrap<string>(v)
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Visma's open customer ledger, reduced to what we are actually owed.
 *
 * Deliberately NOT every open document. Three things are dropped, each for its
 * own reason: a webshop house account is not a debtor, a zero balance is not a
 * debt, and a document Visma has closed is settled whatever else it says. What
 * survives is the handful a person can act on — six, when this was written.
 *
 * Keyed by reference number, last reading wins, so a page overlapping another
 * cannot produce two rows for one invoice.
 */
export function mapReceivables(docs: VismaCustomerDocument[]): MappedReceivable[] {
  const byRef = new Map<string, MappedReceivable>()

  for (const d of Array.isArray(docs) ? docs : []) {
    const status = str(d?.status)
    if (status !== '' && status.toLowerCase() !== 'open') continue

    const customerName = str(d?.customer?.name)
    if (isWebshopAccount(customerName)) continue

    const referenceNumber = str(d?.referenceNumber)
    if (referenceNumber === '') continue

    const balance = money(d?.balanceInCurrency)
    if (balance === 0) continue

    const documentDate = date(d?.documentDate)
    if (!documentDate) continue

    byRef.set(referenceNumber, {
      referenceNumber,
      customerNumber: str(d?.customer?.number),
      customerName,
      documentType: str(d?.documentType) || 'Invoice',
      documentDate,
      dueDate: date(d?.documentDueDate),
      currency: str(d?.currencyId),
      amount: money(d?.amountInCurrency),
      balance,
    })
  }

  return [...byRef.values()]
}
