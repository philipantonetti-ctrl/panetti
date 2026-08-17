import { describe, expect, it } from 'vitest'
import { forecast, type ForecastInput } from './forecast'

const TODAY = new Date('2026-08-13T00:00:00Z')
const inDays = (n: number) => new Date(TODAY.getTime() + n * 86400000)
const day = (d: Date) => d.toISOString().slice(0, 10)

const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  stock: 100, level: 10, index: () => 1, arrivals: [],
  productionDays: 30, deliveryDays: 40, moq: null, unitsPerContainer: null, coverDays: null,
  ...over,
})

describe('forecast', () => {
  it('runs out when the stock is gone at the current rate', () => {
    // 100 units, 10 a day, so day 10 is the first day it reaches zero.
    expect(day(forecast(input(), TODAY).runsOutOn!)).toBe(day(inDays(9)))
  })

  it('orders back from the run-out date by production plus delivery', () => {
    const f = forecast(input({ stock: 1000 }), TODAY) // 100 days of cover
    expect(day(f.orderBy!)).toBe(day(new Date(f.runsOutOn!.getTime() - 70 * 86400000)))
    // Still ahead of us, so this must be null rather than a negative number the
    // page would have to interpret. Without this line the guard is deletable.
    expect(f.daysLate).toBeNull()
  })

  it('says how late an order already is rather than showing a past date', () => {
    // 100 units at 10 a day runs out in 10 days, but lead time is 70 days.
    const f = forecast(input(), TODAY)
    expect(f.daysLate).toBe(61)
  })

  it('a container landing before the run-out pushes the date out', () => {
    // 100 units at 10 a day, plus 500 landing on day 5: stock is 50 when the
    // container arrives, so 550 then drains at 10 a day and hits zero on day 59.
    const with_ = forecast(input({ arrivals: [{ eta: inDays(5), quantity: 500 }] }), TODAY)
    expect(day(with_.runsOutOn!)).toBe(day(inDays(59)))
  })

  it('a container landing after the run-out does not', () => {
    const without = forecast(input(), TODAY)
    const with_ = forecast(input({ arrivals: [{ eta: inDays(300), quantity: 500 }] }), TODAY)
    expect(day(with_.runsOutOn!)).toBe(day(without.runsOutOn!))
  })

  it('an order with no ETA never moves the date, and is reported instead', () => {
    // Counting stock whose arrival nobody knows would push out a real date on a
    // guess. The number is shown so someone goes and sets the ETA.
    const f = forecast(input({ arrivals: [{ eta: null, quantity: 500 }] }), TODAY)
    expect(day(f.runsOutOn!)).toBe(day(inDays(9)))
    expect(f.onOrderWithoutEta).toBe(500)
  })

  it('covers lead time plus the cover period', () => {
    // 10 a day over 30 + 40 + 90 days.
    expect(forecast(input({ stock: 1000 }), TODAY).quantity).toBe(1600)
  })

  it('honours a custom cover period instead of the 90-day default', () => {
    // 10 a day over 30 production + 40 delivery + 30 cover = 1000 units,
    // against 1600 at the default cover. So this pins the override itself.
    const f = forecast(input({ stock: 1000, coverDays: 30 }), TODAY)
    expect(f.quantity).toBe(1000)
  })

  it('never orders below the supplier minimum', () => {
    // Runs out on day 299, inside the 365-day horizon, so a quantity is
    // genuinely computed: 1/day over 30 + 40 + 90 days = 160 units. The
    // supplier's 500 minimum is what must raise it.
    const f = forecast(input({ stock: 300, level: 1, moq: 500 }), TODAY)
    expect(f.quantity).toBe(500)
  })

  it('rounds up to whole containers', () => {
    const f = forecast(input({ stock: 1000, unitsPerContainer: 1000 }), TODAY)
    expect(f.quantity).toBe(2000) // 1600 needed -> two containers
  })

  it('a container rounding can never drop below the minimum', () => {
    // 160 needed, raised to the 500 minimum, then rounded up to two 400-unit
    // containers = 800. Applying the container first would give 400, then the
    // minimum would lift it to 500 — not a whole number of containers.
    const f = forecast(input({ stock: 300, level: 1, moq: 500, unitsPerContainer: 400 }), TODAY)
    expect(f.quantity).toBe(800)
    expect(f.quantity).toBeGreaterThanOrEqual(500)
    expect(f.quantity! % 400).toBe(0)
  })

  /**
   * "Order 500" without "you need 160" is a number nobody can sanity-check. The
   * reorder tips quote both, and say which rule made up the difference, because
   * "the supplier will not take less" and "that is a whole container" are
   * different reasons to buy stock you do not yet need.
   */
  it('reports what demand alone called for, next to the number to order', () => {
    const f = forecast(input({ stock: 300, level: 1, moq: 500 }), TODAY)
    expect(f.needed).toBe(160)
    expect(f.quantity).toBe(500)
    expect(f.raisedBy).toBe('minimum')
  })

  it('names the container, not the minimum, when the container is what rounded it up', () => {
    const f = forecast(input({ stock: 1000, unitsPerContainer: 1000 }), TODAY)
    expect(f.needed).toBe(1600)
    expect(f.raisedBy).toBe('container')
  })

  it('names nothing when plain demand set the number', () => {
    const f = forecast(input({ stock: 1000 }), TODAY)
    expect(f.needed).toBe(1600)
    expect(f.quantity).toBe(1600)
    expect(f.raisedBy).toBeNull()
  })

  it('names the minimum when both rules applied, because the minimum is what binds', () => {
    // 160 needed. Containers alone would give 400; it is the 500 minimum that
    // forces the second container.
    const f = forecast(input({ stock: 300, level: 1, moq: 500, unitsPerContainer: 400 }), TODAY)
    expect(f.quantity).toBe(800)
    expect(f.raisedBy).toBe('minimum')
  })

  it('says nothing about dates when stock is unknown, and does not assume zero', () => {
    const f = forecast(input({ stock: null }), TODAY)
    expect(f.runsOutOn).toBeNull()
    expect(f.quantity).toBeNull()
    expect(f.note).toBe('no stock data')
  })

  it('reads "not selling" when nothing has sold, rather than running out today', () => {
    const f = forecast(input({ level: 0 }), TODAY)
    expect(f.runsOutOn).toBeNull()
    expect(f.note).toBe('not selling')
    expect(f.needed).toBeNull()
  })

  it('asks for lead times rather than inventing an order-by date', () => {
    const f = forecast(input({ productionDays: null }), TODAY)
    expect(f.runsOutOn).not.toBeNull()
    expect(f.orderBy).toBeNull()
    expect(f.quantity).toBeNull()
    expect(f.note).toBe('set lead times')
  })

  it('reports no risk when a year of selling does not empty the shelf', () => {
    const f = forecast(input({ stock: 100_000 }), TODAY)
    expect(f.runsOutOn).toBeNull()
    expect(f.note).toBe('no risk within a year')
  })
})
