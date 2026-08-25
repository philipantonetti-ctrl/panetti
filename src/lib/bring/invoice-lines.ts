import { toMinor } from '../money'
import type { BringInvoice } from './invoice-map'

/** One charge on one parcel. Money in minor units of `currency`, ex tax. */
export type SpecifiedLine = {
  waybillNumber: string
  amountMinor: number
  currency: string
  chargedAt: Date
  itemNumber: string
  description: string
}

export type SpecifiedInvoice = {
  invoiceNumber: string
  customerNumber: string
  lines: SpecifiedLine[]
  /**
   * `<Line>` blocks present in the report but missing WAYBILL_NUMBER,
   * TRX_DATE or INVOICE_CURRENCY_CODE, so not added to `lines`. Surfaced so a
   * reconciliation failure can say which cause it was: a truncated download
   * drops trailing lines outright and leaves this at 0, while one unparseable
   * line - an invoice-level charge carrying no waybill, say - drops a single
   * line from the middle and leaves this non-zero. The two must not read
   * identically in an error a person has to act on.
   */
  skipped: number
}

const tag = (body: string, name: string): string => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
  return m ? m[1].trim() : ''
}

function ddmmyyyy(value: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!m) return null
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])))
}

/**
 * The specified invoice report, as lines.
 *
 * Regex rather than an XML parser: no XML dependency exists in this repo, the
 * document is machine-generated and flat, and a gateway's HTML error page must
 * come back as null rather than as a parse exception.
 *
 * Every line is kept, duplicates included. The report carries NO line
 * identifier - TRX_NUMBER, the only candidate, is the invoice number repeated
 * on every row - so two identical charges on one parcel are two real charges
 * and merging them loses money that was really billed.
 */
export function parseSpecifiedInvoice(xml: string): SpecifiedInvoice | null {
  if (!xml.includes('<Line>')) return null

  const invoiceNumber = tag(xml, 'InvoiceNumber')
  const customerNumber = tag(xml, 'CustomerId')
  if (!invoiceNumber) return null

  const lines: SpecifiedLine[] = []
  let skipped = 0
  for (const m of xml.matchAll(/<Line>([\s\S]*?)<\/Line>/g)) {
    const body = m[1]
    const waybillNumber = tag(body, 'WAYBILL_NUMBER')
    const chargedAt = ddmmyyyy(tag(body, 'TRX_DATE'))
    const currency = tag(body, 'INVOICE_CURRENCY_CODE')
    if (!waybillNumber || !chargedAt || !currency) {
      skipped += 1
      continue
    }

    lines.push({
      waybillNumber,
      // AMOUNT, deliberately. GrossPrice is documented as the price and is
      // 0.00 on all 144 lines of the real report.
      amountMinor: toMinor(tag(body, 'AMOUNT')),
      currency,
      chargedAt,
      itemNumber: tag(body, 'ITEM_NUMBER'),
      description: tag(body, 'ITEM_DESCRIPTION'),
    })
  }

  return { invoiceNumber, customerNumber, lines, skipped }
}

/**
 * Do these lines account for the whole invoice?
 *
 * Measured on the real report: the 144 line AMOUNTs sum to 84 786.85, exactly
 * the header's `amount`. So exact equality is the right test, and a mismatch
 * means a truncated download, a changed format, or an invoice we half-read -
 * all of which look identical to a cheap month once stored.
 */
export function linesReconcile(parsed: SpecifiedInvoice, header: BringInvoice): boolean {
  if (parsed.lines.length === 0) return false
  if (parsed.lines.some((l) => l.currency !== header.currency)) return false
  return parsed.lines.reduce((n, l) => n + l.amountMinor, 0) === header.amountMinor
}
