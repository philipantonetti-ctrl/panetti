import { describe, expect, it } from 'vitest'
import { decimal, journalBody, paymentBody, vismaDate } from './dto'

describe('decimal and vismaDate', () => {
  it('converts minor units without float noise', () => {
    expect(decimal(7314700)).toBe(73147)
    expect(decimal(52528)).toBe(525.28)
    expect(decimal(1)).toBe(0.01)
  })
  it('sends the Oslo calendar day', () => {
    // 23:30 UTC on 30 Sep is 1 Oct in Oslo.
    expect(vismaDate(new Date('2026-09-30T23:30:00Z'))).toBe('2026-10-01T00:00:00')
  })
})

describe('paymentBody', () => {
  it('is one on-hold Payment with one Invoice line, in Visma field names', () => {
    expect(
      paymentBody({
        customer: '10859', clearingAccount: '1509', currency: 'EUR', reference: 'R17882-6311A9',
        date: new Date('2026-10-06T10:00:00Z'), key: '14238', invoiceNumber: '130474', amount: 299900,
      }),
    ).toEqual({
      type: { value: 'Payment' },
      hold: { value: true },
      applicationDate: { value: '2026-10-06T00:00:00' },
      paymentRef: { value: 'R17882-6311A9' },
      customer: { value: '10859' },
      paymentMethod: { value: '5' },
      cashAccount: { value: '1509' },
      currency: { value: 'EUR' },
      paymentAmount: { value: 2999 },
      invoiceText: { value: 'Dintero R17882-6311A9 order 14238' },
      paymentLines: [
        { operation: 'Insert', documentType: { value: 'Invoice' }, refNbr: { value: '130474' }, amountPaid: { value: 2999 } },
      ],
    })
  })
  it('keeps invoiceText within 50 characters', () => {
    const body = paymentBody({
      customer: '1', clearingAccount: '1509', currency: 'EUR', reference: 'R'.repeat(40),
      date: new Date('2026-10-06T10:00:00Z'), key: '123456789', invoiceNumber: '1', amount: 1,
    }) as { invoiceText: { value: string } }
    expect(body.invoiceText.value.length).toBeLessThanOrEqual(50)
  })
})

describe('journalBody', () => {
  it('is one on-hold journal with numbered lines in the payout currency', () => {
    expect(
      journalBody({
        currency: 'DKK', reference: 'R17882-6311A9', date: new Date('2026-09-01T08:00:00Z'),
        lines: [
          { account: '1960', debit: 7262172, credit: 0 },
          { account: '7770', debit: 52528, credit: 0 },
          { account: '1512', debit: 0, credit: 7314700 },
        ],
      }),
    ).toEqual({
      hold: { value: true },
      transactionDate: { value: '2026-09-01T00:00:00' },
      currencyId: { value: 'DKK' },
      description: { value: 'Dintero R17882-6311A9' },
      journalTransactionLines: [
        { operation: 'Insert', lineNumber: { value: 1 }, accountNumber: { value: '1960' }, referenceNumber: { value: 'R17882-6311A9' }, transactionDescription: { value: 'Dintero R17882-6311A9' }, debitAmountInCurrency: { value: 72621.72 }, creditAmountInCurrency: { value: 0 } },
        { operation: 'Insert', lineNumber: { value: 2 }, accountNumber: { value: '7770' }, referenceNumber: { value: 'R17882-6311A9' }, transactionDescription: { value: 'Dintero R17882-6311A9' }, debitAmountInCurrency: { value: 525.28 }, creditAmountInCurrency: { value: 0 } },
        { operation: 'Insert', lineNumber: { value: 3 }, accountNumber: { value: '1512' }, referenceNumber: { value: 'R17882-6311A9' }, transactionDescription: { value: 'Dintero R17882-6311A9' }, debitAmountInCurrency: { value: 0 }, creditAmountInCurrency: { value: 73147 } },
      ],
    })
  })
})
