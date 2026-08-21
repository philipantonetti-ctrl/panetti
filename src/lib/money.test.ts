import { describe, it, expect } from 'vitest'
import { toMinor, toMajor, mulRate, pct, sum, formatMoney, formatMoneyWhole } from './money'

describe('money', () => {
  it('converts major units to integer minor units', () => {
    expect(toMinor(10.5)).toBe(1050)
    expect(toMinor('44999.00')).toBe(4499900)
    expect(toMinor(0)).toBe(0)
  })

  it('rounds half away from zero, so 0.005 never silently disappears', () => {
    expect(toMinor(0.005)).toBe(1)
    expect(toMinor(-0.005)).toBe(-1)
  })

  it('converts minor units back to major', () => {
    expect(toMajor(1050)).toBe(10.5)
  })

  it('multiplies by a rate and returns whole minor units', () => {
    expect(mulRate(10000, 0.0937)).toBe(937)
  })

  it('takes a percentage of an amount', () => {
    expect(pct(10000, 0.1)).toBe(1000)
  })

  it('sums a list of amounts', () => {
    expect(sum([100, 250, 3])).toBe(353)
    expect(sum([])).toBe(0)
  })

  it('formats money for display in its currency', () => {
    expect(formatMoney(4499900, 'NOK')).toContain('44')
    expect(formatMoney(125050, 'USD')).toContain('1,250')
  })

  /**
   * The dashboard headline figures, without øre.
   *
   * A million kroner and 25 øre is not a more precise answer than a million
   * kroner. It is three more characters on the figures the page is built
   * around, and at 32px they were wide enough to run out of the Net Profit
   * card and over the one beside it.
   *
   * Rounds, never truncates. Truncating would make every figure on the strip
   * quietly smaller than the truth, and this is the number the owner opens the
   * page to read.
   */
  it('formats money with no minor units at all', () => {
    expect(formatMoneyWhole(100637025, 'NOK')).toContain('1,006,370')
    expect(formatMoneyWhole(100637025, 'NOK')).not.toContain('.25')
    expect(formatMoneyWhole(100637075, 'NOK')).toContain('1,006,371')
  })

  // Still money, so it still carries its currency. A bare 1,006,370 on a page
  // that consolidates four currencies into one would be the wrong kind of tidy.
  it('keeps the currency when it drops the minor units', () => {
    expect(formatMoneyWhole(100637025, 'NOK')).toContain('NOK')
    expect(formatMoneyWhole(125050, 'USD')).toContain('$')
  })
})
