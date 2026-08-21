import { describe, expect, it } from 'vitest'
import { buildRateTable } from '@/lib/metrics/fx'
import { monthlyInvoiceTotals } from './invoiced-cost'

/**
 * A rate is "1 unit of this currency = rate USD", as buildRateTable documents.
 * SEK moves between the two days on purpose, so a test can prove each invoice
 * is converted on its OWN date rather than all of them on one.
 */
const rates = buildRateTable([
  { date: new Date('2026-07-31T00:00:00Z'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-07-31T00:00:00Z'), currency: 'SEK', rate: 0.09 },
  { date: new Date('2026-08-16T00:00:00Z'), currency: 'NOK', rate: 0.1 },
  { date: new Date('2026-08-16T00:00:00Z'), currency: 'SEK', rate: 0.05 },
])

const inv = (date: string, amountMinor: number, currency: string) => ({
  invoiceDate: new Date(`${date}T00:00:00Z`),
  amountMinor,
  currency,
})

describe('monthlyInvoiceTotals', () => {
  it('has nothing to say about no invoices', () => {
    expect(monthlyInvoiceTotals([], 'NOK', rates)).toEqual([])
  })

  it('adds up every invoice a month carries', () => {
    const out = monthlyInvoiceTotals(
      [inv('2026-07-31', 214_550, 'NOK'), inv('2026-07-16', 104_119, 'NOK')],
      'NOK',
      rates,
    )
    expect(out).toEqual([{ month: '2026-07', amountMinor: 318_669, currency: 'NOK' }])
  })

  /**
   * The reason this exists rather than one number in a box. Measured against
   * the live archive on 2026-08-21: July 2026 alone is four NOK invoices and
   * eight SEK ones across three Bring companies. There is no single figure to
   * type, which is why asking a person to type one was never going to work.
   */
  it('converts a foreign invoice into the currency on screen', () => {
    // 1 SEK = 0.09 USD and 1 NOK = 0.10 USD on 31 July, so 100.00 SEK is
    // 90.00 NOK.
    const out = monthlyInvoiceTotals([inv('2026-07-31', 10_000, 'SEK')], 'NOK', rates)
    expect(out).toEqual([{ month: '2026-07', amountMinor: 9_000, currency: 'NOK' }])
  })

  it('adds invoices in different currencies together, once converted', () => {
    const out = monthlyInvoiceTotals(
      [inv('2026-07-31', 10_000, 'NOK'), inv('2026-07-31', 10_000, 'SEK')],
      'NOK',
      rates,
    )
    expect(out).toEqual([{ month: '2026-07', amountMinor: 19_000, currency: 'NOK' }])
  })

  /**
   * Each invoice at ITS OWN date, never one rate for the batch. SEK is 0.09 on
   * 31 July and 0.05 on 16 August, so a single-rate implementation gets a
   * different answer here and this catches it.
   */
  it("uses the rate on each invoice's own day", () => {
    const out = monthlyInvoiceTotals([inv('2026-08-16', 10_000, 'SEK')], 'NOK', rates)
    // 100.00 SEK at 0.05 is $5, and $5 at 0.10 a krone is 50.00 NOK.
    expect(out).toEqual([{ month: '2026-08', amountMinor: 5_000, currency: 'NOK' }])
  })

  it('keeps each month apart, oldest first', () => {
    const out = monthlyInvoiceTotals(
      [inv('2026-08-16', 5_000, 'NOK'), inv('2026-07-31', 3_000, 'NOK')],
      'NOK',
      rates,
    )
    expect(out.map((m) => m.month)).toEqual(['2026-07', '2026-08'])
  })

  /**
   * The archive dates invoices at UTC midnight, so the month is read straight
   * off the date and no timezone is involved. None should be introduced: an
   * invoice dated the 1st must never fall into the previous month because a
   * zone put it at 23:00 the night before.
   */
  it('puts an invoice dated the first in that month, not the one before', () => {
    const out = monthlyInvoiceTotals([inv('2026-08-01', 1_000, 'NOK')], 'NOK', rates)
    expect(out[0].month).toBe('2026-08')
  })

  it('rounds to whole minor units, because a fraction of an øre is not money', () => {
    const out = monthlyInvoiceTotals([inv('2026-07-31', 3_333, 'SEK')], 'NOK', rates)
    expect(out[0].amountMinor).toBe(3_000) // 3333 * 0.9 = 2999.7
    expect(Number.isInteger(out[0].amountMinor)).toBe(true)
  })

  /**
   * A currency we hold no rate for is LEFT OUT and named, never counted at
   * face value. crossConvert returns the amount unchanged when it cannot find
   * a factor, which is right for a figure on a screen and wrong for one being
   * stored: 500.00 DKK counted as 500.00 NOK is a wrong total that looks
   * entirely reasonable. fx.ts says exactly this in crossFactor's own comment.
   */
  it('leaves out a currency it has no rate for, rather than counting it at par', () => {
    const out = monthlyInvoiceTotals(
      [inv('2026-07-31', 10_000, 'NOK'), inv('2026-07-31', 50_000, 'DKK')],
      'NOK',
      rates,
    )
    expect(out).toEqual([
      { month: '2026-07', amountMinor: 10_000, currency: 'NOK', unconverted: ['DKK'] },
    ])
  })

  it('says nothing about unconverted currencies when they all converted', () => {
    const out = monthlyInvoiceTotals([inv('2026-07-31', 10_000, 'NOK')], 'NOK', rates)
    expect(out[0].unconverted).toBeUndefined()
  })

  /**
   * A month where NOTHING converted has no total, and must not be reported as
   * zero. Zero is a real answer meaning "they billed us nothing", and this is
   * the opposite: we cannot say.
   */
  it('reports no amount at all for a month where nothing could be converted', () => {
    const out = monthlyInvoiceTotals([inv('2026-07-31', 50_000, 'DKK')], 'NOK', rates)
    expect(out).toEqual([])
  })
})
