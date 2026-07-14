import { describe, it, expect } from 'vitest'
import { toMinor, toMajor, mulRate, pct, sum, formatMoney } from './money'

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
})
