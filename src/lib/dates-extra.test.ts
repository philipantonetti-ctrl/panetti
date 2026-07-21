import { describe, it, expect } from 'vitest'
import { resolvePreset } from './dates'
import { rangeFromQuery } from './api/range'
import { addMonths, monthGrid, nextRange } from './date-range'

// A fixed Tuesday: 21 July 2026.
const NOW = new Date('2026-07-21T10:00:00Z')

const day = (d: Date) => d.toISOString().slice(0, 10)

describe('new presets', () => {
  it('last_week is the whole Monday-to-Sunday week before this one', () => {
    const r = resolvePreset('last_week', NOW)
    expect(day(r.from)).toBe('2026-07-13')
    expect(day(r.to)).toBe('2026-07-19')
  })

  it('last_month is the whole previous calendar month', () => {
    const r = resolvePreset('last_month', NOW)
    expect(day(r.from)).toBe('2026-06-01')
    expect(day(r.to)).toBe('2026-06-30')
  })

  it('last_year is the whole previous calendar year', () => {
    const r = resolvePreset('last_year', NOW)
    expect(day(r.from)).toBe('2025-01-01')
    expect(day(r.to)).toBe('2025-12-31')
  })

  it('last_12_months is a rolling 365 days including today', () => {
    const r = resolvePreset('last_12_months', NOW)
    expect(day(r.from)).toBe('2025-07-22')
    expect(day(r.to)).toBe('2026-07-21')
  })

  it('the API accepts the new presets', () => {
    const r = rangeFromQuery(new URLSearchParams('preset=last_month'), NOW)
    expect(day(r.from)).toBe('2026-06-01')
  })
})

describe('nextRange', () => {
  it('first pick starts, second pick ends', () => {
    const a = nextRange({}, '2026-07-12')
    expect(a).toEqual({ from: '2026-07-12' })
    expect(nextRange(a, '2026-07-16')).toEqual({ from: '2026-07-12', to: '2026-07-16' })
  })

  it('picking a day before the start restarts the range there', () => {
    expect(nextRange({ from: '2026-07-12' }, '2026-07-05')).toEqual({ from: '2026-07-05' })
  })

  it('picking after a complete range starts a fresh one', () => {
    expect(nextRange({ from: '2026-07-12', to: '2026-07-16' }, '2026-07-20')).toEqual({
      from: '2026-07-20',
    })
  })
})

describe('monthGrid', () => {
  it('lays July 2026 out Sunday-first', () => {
    const weeks = monthGrid(2026, 6)
    expect(weeks[0]).toEqual([null, null, null, '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'])
    expect(weeks.at(-1)).toEqual(['2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', null])
  })

  it('addMonths wraps across years both ways', () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 })
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 })
  })
})
