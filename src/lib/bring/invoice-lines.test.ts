import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSpecifiedInvoice, linesReconcile } from './invoice-lines'
import type { BringInvoice } from './invoice-map'

const xml = readFileSync(join(__dirname, 'fixtures/specified-invoice.xml'), 'utf8')

/** Sum of the six fixture lines' AMOUNT, in minor units. */
const FIXTURE_TOTAL_MINOR = 250000

const header = (over: Partial<BringInvoice> = {}): BringInvoice => ({
  customerNumber: '20020467369',
  invoiceNumber: '4710001522',
  invoiceDate: new Date('2026-07-31T00:00:00Z'),
  amountMinor: FIXTURE_TOTAL_MINOR,
  taxMinor: 0,
  totalMinor: FIXTURE_TOTAL_MINOR,
  currency: 'NOK',
  specificationAvailable: true,
  ...over,
})

describe('parseSpecifiedInvoice', () => {
  it('reads every line, keeping duplicates apart', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(parsed.lines).toHaveLength(6)
  })

  it('keeps two identical lines as two, because the report has no line id', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    const counts = new Map<string, number>()
    for (const l of parsed.lines) {
      const key = [l.waybillNumber, l.itemNumber, l.description, l.amountMinor].join('|')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    // Waybill 73325383643994654 is billed twice identically in the fixture, as
    // it is three times over in the real invoice. Collapsing those would
    // under-report that parcel.
    expect([...counts.values()]).toContain(2)
  })

  it('takes AMOUNT as the money, never GrossPrice', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    // GrossPrice is 0.00 on every line of the real report.
    expect(parsed.lines.every((l) => l.amountMinor >= 0)).toBe(true)
    expect(parsed.lines.reduce((n, l) => n + l.amountMinor, 0)).toBe(FIXTURE_TOTAL_MINOR)
  })

  it('reads the currency from the line, not from a guess', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(parsed.lines[0].currency).toBe('NOK')
  })

  it('reads TRX_DATE as dd.mm.yyyy', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(parsed.lines[0].chargedAt.toISOString().slice(0, 10)).toBe('2026-07-31')
  })

  it('returns null for a body that is not a report', () => {
    expect(parseSpecifiedInvoice('')).toBeNull()
    expect(parseSpecifiedInvoice('<html>gateway error</html>')).toBeNull()
  })

  it('reports zero lines skipped when every line has what it needs', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(parsed.skipped).toBe(0)
  })

  // I4: a dropped line and a truncated download both make the kept lines
  // fall short of the invoice header, and collectNextReport's reconciliation
  // error can't tell them apart without this count.
  it('counts a line dropped for missing a required field, apart from the lines it keeps', () => {
    const broken = xml.replace(
      '<WAYBILL_NUMBER>73325383643994654</WAYBILL_NUMBER>',
      '<WAYBILL_NUMBER></WAYBILL_NUMBER>',
    )
    const parsed = parseSpecifiedInvoice(broken)!
    expect(parsed.lines).toHaveLength(5)
    expect(parsed.skipped).toBe(1)
  })
})

describe('linesReconcile', () => {
  it('accepts a report whose lines sum to the invoice header', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(linesReconcile(parsed, header())).toBe(true)
  })

  it('rejects a short read, which is what a truncated download looks like', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    const short = { ...parsed, lines: parsed.lines.slice(0, 3) }
    expect(linesReconcile(short, header())).toBe(false)
  })

  it('rejects lines in a currency the invoice was not raised in', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(linesReconcile(parsed, header({ currency: 'SEK' }))).toBe(false)
  })
})
