import { toMinor } from '../money'

/** One invoice as the archive reports it. Money in minor units of `currency`. */
export type BringInvoice = {
  customerNumber: string
  invoiceNumber: string
  invoiceDate: Date
  amountMinor: number // ex tax
  taxMinor: number
  totalMinor: number
  currency: string
  /**
   * False means this invoice can never be broken into lines. Recorded rather
   * than retried: invoice 4070009812 (MANUAL_ORDER_OM) is one, measured.
   */
  specificationAvailable: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * `dd.mm.yyyy` at UTC midnight.
 *
 * The archive uses this for `invoiceDate` and ISO for `dueDate`, in the same
 * object. Reading one as the other silently yields month 31.
 */
function ddmmyyyy(value: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!m) return null
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])))
}

export function mapInvoices(raw: unknown): BringInvoice[] {
  const rows = (raw as { invoices?: unknown })?.invoices
  if (!Array.isArray(rows)) return []

  const out: BringInvoice[] = []
  for (const row of rows as Record<string, unknown>[]) {
    const invoiceNumber = str(row.invoiceNumber)
    const invoiceDate = ddmmyyyy(str(row.invoiceDate))
    const currency = str(row.currency)
    // A row we cannot identify or date is not a row we can act on.
    if (!invoiceNumber || !invoiceDate || !currency) continue

    out.push({
      customerNumber: str(row.customerNumber),
      invoiceNumber,
      invoiceDate,
      amountMinor: toMinor(str(row.amount)),
      taxMinor: toMinor(str(row.taxAmount)),
      totalMinor: toMinor(str(row.totalAmount)),
      currency,
      specificationAvailable: row.invoiceSpecificationAvailable === true,
    })
  }
  return out
}
