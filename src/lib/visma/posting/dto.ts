/**
 * Request bodies in Visma's own shape: every scalar wrapped as { value },
 * every array row with operation "Insert". Field names are copied from the
 * OpenAPI document (PaymentUpdateDto, PaymentLinesUpdateDto,
 * JournalTransactionUpdateDto, JournalTransactionLineUpdateDto). Pure.
 */

import { zonedDayStr } from '../../tz'
import type { EntryLine } from './plan'

const v = <T>(value: T) => ({ value })

/** Minor units to the decimal Visma wants. All four payout currencies have 2 decimals. */
export const decimal = (minor: number): number => Math.round(minor) / 100

/** The Oslo calendar day of an instant, as Visma writes dates. */
export const vismaDate = (d: Date): string => `${zonedDayStr(d, 'Europe/Oslo')}T00:00:00`

export type PaymentInput = {
  customer: string
  clearingAccount: string
  currency: string
  reference: string
  date: Date
  key: string
  invoiceNumber: string
  amount: number
}

export function paymentBody(i: PaymentInput): object {
  return {
    type: v('Payment'),
    hold: v(true),
    applicationDate: v(vismaDate(i.date)),
    paymentRef: v(i.reference),
    customer: v(i.customer),
    paymentMethod: v('5'),
    cashAccount: v(i.clearingAccount),
    currency: v(i.currency),
    paymentAmount: v(decimal(i.amount)),
    invoiceText: v(`Dintero ${i.reference} order ${i.key}`.slice(0, 50)),
    paymentLines: [
      { operation: 'Insert', documentType: v('Invoice'), refNbr: v(i.invoiceNumber), amountPaid: v(decimal(i.amount)) },
    ],
  }
}

export type JournalInput = { currency: string; reference: string; date: Date; lines: EntryLine[] }

export function journalBody(i: JournalInput): object {
  const text = `Dintero ${i.reference}`.slice(0, 50)
  return {
    hold: v(true),
    transactionDate: v(vismaDate(i.date)),
    currencyId: v(i.currency),
    description: v(text),
    journalTransactionLines: i.lines.map((l, n) => ({
      operation: 'Insert',
      lineNumber: v(n + 1),
      accountNumber: v(l.account),
      referenceNumber: v(i.reference),
      transactionDescription: v(text),
      debitAmountInCurrency: v(decimal(l.debit)),
      creditAmountInCurrency: v(decimal(l.credit)),
    })),
  }
}
