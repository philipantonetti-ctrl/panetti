import { crossFactor } from '../metrics/fx'
import { mulRate } from '../money'
import type { RateTable } from '../metrics/types'

/**
 * What a carrier billed in a month, as one figure in the currency on screen.
 *
 * This exists because the obvious design — a person types the monthly invoice
 * into a box — does not survive contact with the data. Measured against Bring's
 * live invoice archive on 2026-08-21, July 2026 alone is twelve invoices across
 * three Bring legal entities in two currencies. There is no single number for
 * anyone to type, and the box was quietly asking for one.
 *
 * So the invoices are added up here instead, each converted on its own date.
 */

/** One invoice, as much of it as this calculation needs. */
export type InvoiceAmount = {
  /** UTC midnight; the archive dates invoices to the day. */
  invoiceDate: Date
  /** Minor units of `currency`, excluding tax. */
  amountMinor: number
  currency: string
}

export type InvoicedMonth = {
  /** 'YYYY-MM'. */
  month: string
  /** Minor units of `currency`. */
  amountMinor: number
  currency: string
  /**
   * Currencies in this month that had no rate on file and were therefore left
   * out of the total. Present only when there were some, so the ordinary case
   * carries no field at all.
   */
  unconverted?: string[]
}

/**
 * Add up invoices by the month they are dated, in `displayCurrency`.
 *
 * `crossFactor`, not `crossConvert`: the strict one. crossConvert passes an
 * amount through UNCHANGED when it cannot find a rate, which is the right
 * behaviour for a number being read on a screen and the wrong one for a number
 * being stored — 500.00 DKK counted as 500.00 NOK is a wrong total that looks
 * perfectly reasonable, and it would then be divided by a parcel count and
 * quoted. fx.ts makes exactly this distinction in crossFactor's own comment.
 *
 * A month whose invoices ALL failed to convert is omitted rather than reported
 * as zero. Zero is a real answer here — "they billed us nothing" — and must
 * stay distinguishable from "we cannot say".
 */
export function monthlyInvoiceTotals(
  invoices: InvoiceAmount[],
  displayCurrency: string,
  rates: RateTable,
): InvoicedMonth[] {
  const months = new Map<string, { total: number; converted: boolean; missing: Set<string> }>()

  for (const invoice of invoices) {
    // Straight off the date. The archive dates to UTC midnight, so introducing
    // a timezone here could only move an invoice into the wrong month.
    const month = invoice.invoiceDate.toISOString().slice(0, 7)
    let entry = months.get(month)
    if (!entry) {
      entry = { total: 0, converted: false, missing: new Set() }
      months.set(month, entry)
    }

    const factor = crossFactor(invoice.currency, displayCurrency, invoice.invoiceDate, rates)
    if (factor === undefined) {
      entry.missing.add(invoice.currency)
      continue
    }

    // Rounded per invoice, matching how every other converted figure in this
    // product is stored, so a total here and a total elsewhere cannot drift.
    entry.total += mulRate(invoice.amountMinor, factor)
    entry.converted = true
  }

  return [...months]
    .filter(([, e]) => e.converted)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, e]) => ({
      month,
      amountMinor: e.total,
      currency: displayCurrency,
      ...(e.missing.size > 0 ? { unconverted: [...e.missing].sort() } : {}),
    }))
}
