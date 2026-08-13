import { describe, expect, it } from 'vitest'
import { dailyBurn, hasSeasonalHistory, seasonalIndex, type Sale } from './burn'

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
    expect(seasonalIndex(sales, TODAY, TODAY)).toBeLessThanOrEqual(4)
  })

  it('clamps at the bottom too', () => {
    // Two years of sales, all of them far from this date last year.
    const sales: Sale[] = []
    for (let i = 0; i < 60; i++) sales.push({ day: daysBefore(i), units: 50 })
    for (let i = 180; i < 240; i++) sales.push({ day: daysBefore(i), units: 50 })
    expect(seasonalIndex(sales, TODAY, TODAY)).toBeGreaterThanOrEqual(0.25)
  })
})
