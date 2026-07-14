import { describe, it, expect } from 'vitest'
import { utcDay, daysInRange, eachDay, resolvePreset, daysInMonthOf } from './dates'

describe('dates', () => {
  it('normalises a date to UTC midnight, so a time-of-day never shifts a day', () => {
    expect(utcDay(new Date('2026-07-14T23:59:59Z')).toISOString()).toBe('2026-07-14T00:00:00.000Z')
  })

  it('counts days in a range inclusively — a single day is 1 day, not 0', () => {
    expect(daysInRange(new Date('2026-07-01'), new Date('2026-07-01'))).toBe(1)
    expect(daysInRange(new Date('2026-07-01'), new Date('2026-07-31'))).toBe(31)
  })

  it('iterates every day in a range', () => {
    const days = eachDay(new Date('2026-07-01'), new Date('2026-07-03'))
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it('knows how many days are in the month a date falls in', () => {
    expect(daysInMonthOf(new Date('2026-07-14'))).toBe(31)
    expect(daysInMonthOf(new Date('2026-02-10'))).toBe(28)
    expect(daysInMonthOf(new Date('2024-02-10'))).toBe(29) // leap year
  })

  it('resolves presets relative to a given "today"', () => {
    const today = new Date('2026-07-14T10:00:00Z')

    const t = resolvePreset('today', today)
    expect(t.from.toISOString().slice(0, 10)).toBe('2026-07-14')
    expect(t.to.toISOString().slice(0, 10)).toBe('2026-07-14')

    const y = resolvePreset('yesterday', today)
    expect(y.from.toISOString().slice(0, 10)).toBe('2026-07-13')

    const m = resolvePreset('this_month', today)
    expect(m.from.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(m.to.toISOString().slice(0, 10)).toBe('2026-07-14')

    const l7 = resolvePreset('last_7_days', today)
    expect(l7.from.toISOString().slice(0, 10)).toBe('2026-07-08') // 7 days INCLUDING today
    expect(l7.to.toISOString().slice(0, 10)).toBe('2026-07-14')

    const yr = resolvePreset('this_year', today)
    expect(yr.from.toISOString().slice(0, 10)).toBe('2026-01-01')
  })
})
