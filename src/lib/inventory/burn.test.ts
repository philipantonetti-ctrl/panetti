import { describe, expect, it } from 'vitest'
import {
  dailyBurn,
  hasSeasonalHistory,
  seasonalIndex,
  seasonalLevel,
  yearOverYear,
  type Sale,
} from './burn'

const TODAY = new Date('2026-08-13T00:00:00Z')
const daysBefore = (n: number) => new Date(TODAY.getTime() - n * 86400000)

/** One sale of `units` on each of the last `n` days. */
const steady = (n: number, units: number): Sale[] =>
  Array.from({ length: n }, (_, i) => ({ day: daysBefore(i), units }))

describe('dailyBurn', () => {
  it('averages units sold per day over the window', () => {
    // 60 days at 2 a day = 120 units over 60 days = 2.
    expect(dailyBurn(steady(60, 2), TODAY)).toBeCloseTo(2)
  })

  it('ignores sales older than the window, so last spring does not set today', () => {
    const old: Sale[] = [{ day: daysBefore(200), units: 10_000 }]
    expect(dailyBurn(old, TODAY)).toBe(0)
  })

  it('is zero when nothing sold, which the page reads as "not selling"', () => {
    expect(dailyBurn([], TODAY)).toBe(0)
  })
})

describe('seasonalLevel', () => {
  it('is the plain daily rate when the period is an ordinary one', () => {
    expect(seasonalLevel(steady(60, 2), TODAY, () => 1)).toBeCloseTo(2)
  })

  /**
   * The reason this exists. Measuring a rate inside a peak and then multiplying
   * it by the NEXT peak counts the season twice, and the forecast orders for a
   * Christmas that happens twice over.
   */
  it('reads a busy period as a smaller underlying rate, not as the new normal', () => {
    // 2 a day sold in a period that runs at twice the yearly average means the
    // underlying business is doing 1 a day.
    expect(seasonalLevel(steady(60, 2), TODAY, () => 2)).toBeCloseTo(1)
  })

  it('reads a quiet period as a larger underlying rate, so a lull is not the new normal either', () => {
    expect(seasonalLevel(steady(60, 2), TODAY, () => 0.5)).toBeCloseTo(4)
  })

  /**
   * The round trip that keeps the two figures on the page honest: the level put
   * back into the season it was measured in has to reproduce the rate anyone can
   * see in the "Per day" column.
   */
  it('multiplied back by its own season, returns the rate actually observed', () => {
    const sales = steady(60, 3)
    expect(seasonalLevel(sales, TODAY, () => 2.5) * 2.5).toBeCloseTo(dailyBurn(sales, TODAY))
  })

  it('measures the same window dailyBurn does, so last spring cannot set today', () => {
    expect(seasonalLevel([{ day: daysBefore(200), units: 10_000 }], TODAY, () => 1)).toBe(0)
  })

  it('is zero when nothing sold, which the page reads as "not selling"', () => {
    expect(seasonalLevel([], TODAY, () => 1)).toBe(0)
  })
})

describe('yearOverYear', () => {
  /**
   * The same 60 calendar days, a year apart. Comparing like with like is what
   * makes this a growth figure rather than a seasonal one - and it is the exact
   * multiplier the forecast applies to last year's shape.
   */
  it('reports growth against the same period last year as a fraction', () => {
    const sales = [
      ...Array.from({ length: 60 }, (_, i) => ({ day: daysBefore(i), units: 23 })),
      ...Array.from({ length: 60 }, (_, i) => ({ day: daysBefore(365 + i), units: 20 })),
    ]
    expect(yearOverYear(sales, TODAY)).toBeCloseTo(0.15)
  })

  it('reports a decline as a negative fraction', () => {
    const sales = [
      ...Array.from({ length: 60 }, (_, i) => ({ day: daysBefore(i), units: 8 })),
      ...Array.from({ length: 60 }, (_, i) => ({ day: daysBefore(365 + i), units: 10 })),
    ]
    expect(yearOverYear(sales, TODAY)).toBeCloseTo(-0.2)
  })

  /**
   * A shop open thirteen months has only part of the window to compare against,
   * and dividing by a part-window reports growth that never happened.
   */
  it('is null when the history does not reach the whole of last year’s window', () => {
    expect(yearOverYear(steady(400, 5), TODAY)).toBeNull()
  })

  it('is null when the same period last year sold nothing, because that is not a percentage', () => {
    const sales = [
      ...Array.from({ length: 60 }, (_, i) => ({ day: daysBefore(i), units: 5 })),
      { day: daysBefore(500), units: 1 },
    ]
    expect(yearOverYear(sales, TODAY)).toBeNull()
  })
})

describe('hasSeasonalHistory', () => {
  it('is false under 400 days, so Germany at 11 months is honest about it', () => {
    expect(hasSeasonalHistory(steady(330, 1), TODAY)).toBe(false)
  })

  it('is true once a full year plus margin exists', () => {
    expect(hasSeasonalHistory([{ day: daysBefore(500), units: 1 }], TODAY)).toBe(true)
  })
})

describe('seasonalIndex', () => {
  it('is exactly 1 without enough history, never a guess', () => {
    expect(seasonalIndex(steady(100, 5), daysBefore(-30), TODAY)).toBe(1)
  })

  it('rises above 1 for a period that was busy last year', () => {
    // Flat 1/day for two years, except a burst around this time last year.
    const sales = steady(730, 1)
    for (let i = 360; i <= 374; i++) sales.push({ day: daysBefore(i), units: 20 })
    const index = seasonalIndex(sales, TODAY, TODAY)
    expect(index).toBeGreaterThan(1)
  })

  it('clamps, so one freak week cannot order a container', () => {
    const sales = steady(730, 1)
    sales.push({ day: daysBefore(365), units: 1_000_000 })
    expect(seasonalIndex(sales, TODAY, TODAY)).toBe(4)
  })

  it('clamps at the bottom, and actually reaches the clamp to prove it', () => {
    // Over 400 days of history so seasonality is genuinely computed, with the
    // target window (a year ago, +/- 14 days) deliberately EMPTY and every sale
    // sitting in the baseline outside it. Ratio is 0/280, so only the clamp can
    // produce the answer.
    const sales: Sale[] = []
    for (let i = 380; i <= 716; i++) sales.push({ day: daysBefore(i), units: 10 })
    expect(seasonalIndex(sales, TODAY, TODAY)).toBe(0.25)
  })

  it('reports a genuinely twice-as-busy period as exactly 2, not merely "more than 1"', () => {
    // 20 a day through the window a year ago, 10 a day across the rest of the
    // baseline. The honest answer is exactly 2. The previous formula counted the
    // window inside its own baseline and would report 1.857 here.
    const sales: Sale[] = []
    for (let i = 352; i <= 379; i++) sales.push({ day: daysBefore(i), units: 20 })
    for (let i = 380; i <= 716; i++) sales.push({ day: daysBefore(i), units: 10 })
    expect(seasonalIndex(sales, TODAY, TODAY)).toBe(2)
  })
})
