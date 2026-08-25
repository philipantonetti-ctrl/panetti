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

  /**
   * The premise this replaces - "a container landing after the run-out does
   * not move the date" - is the exact bug the client reported: MACBE661 stood
   * at zero stock with 41 chairs on order, and the page said "order 10 now,
   * 105 days late" because the walk stopped at the first empty day and never
   * saw the arrivals. An arrival after a stockout RESCUES it; the run-out that
   * should drive an order is the day stock finally stays gone.
   */
  it('an arrival after the first stockout rescues it, and the run-out becomes the day stock stays gone', () => {
    // 100 at 10 a day empties on day 9. The 500 landing on day 30 first
    // absorb the 210 units of demand missed during the gap - a stockout's
    // missed sales press the next container into service, erring on ordering
    // earlier rather than later - leaving 290 to drain: gone again day 59.
    const f = forecast(input({ arrivals: [{ eta: inDays(30), quantity: 500 }] }), TODAY)
    expect(day(f.runsOutOn!)).toBe(day(inDays(59)))
  })

  it('names the out-of-stock gap the arrival will heal', () => {
    const f = forecast(input({ arrivals: [{ eta: inDays(30), quantity: 500 }] }), TODAY)
    expect(day(f.gap!.from)).toBe(day(inDays(9)))
    expect(day(f.gap!.until)).toBe(day(inDays(30)))
  })

  it('reports no gap when stock never runs dry before the terminal run-out', () => {
    const f = forecast(input({ arrivals: [{ eta: inDays(5), quantity: 500 }] }), TODAY)
    expect(f.gap).toBeNull()
  })

  /**
   * MACBE661's real shape: empty shelf today, arrivals booked that cover
   * demand past the horizon. The old walk said "runs out today, order now,
   * 105 days late"; the truth is that no new order is needed within a year,
   * and the only real problem is the gap until the next container lands.
   */
  it('says covered when arrivals carry demand past the horizon, and still names the gap', () => {
    const f = forecast(input({ stock: 0, level: 0.1, arrivals: [{ eta: inDays(11), quantity: 40 }] }), TODAY)
    expect(f.runsOutOn).toBeNull()
    expect(f.orderBy).toBeNull()
    expect(f.daysLate).toBeNull()
    expect(f.note).toBe('no risk within a year')
    expect(day(f.gap!.from)).toBe(day(inDays(0)))
    expect(day(f.gap!.until)).toBe(day(inDays(11)))
  })

  /**
   * The suggestion must not re-order what is already on the water. 100 at 10
   * a day runs out day 9; 50 more land on day 30 - too few to reopen the
   * shelf, but real units inside the window the order has to cover.
   */
  it('nets incoming arrivals off the suggested quantity', () => {
    const f = forecast(input({ arrivals: [{ eta: inDays(30), quantity: 50 }] }), TODAY)
    expect(day(f.runsOutOn!)).toBe(day(inDays(9)))
    // 90 days of cover at 10 a day is 900, minus the 50 already coming.
    expect(f.needed).toBe(850)
  })

  /**
   * An arrival whose date has passed but which nobody has received is in
   * limbo: counting it as stock on a guessed day would fake coverage (one
   * open order here is two years past its date), and dropping it silently
   * loses real chairs. It is reported, and a person decides.
   */
  it('reports an overdue unreceived arrival instead of counting it', () => {
    const f = forecast(input({ arrivals: [{ eta: inDays(-2), quantity: 15 }] }), TODAY)
    expect(day(f.runsOutOn!)).toBe(day(inDays(9))) // unmoved
    expect(f.overdueArrivals).toEqual({ quantity: 15, since: inDays(-2) })
  })

  it('reports no overdue arrivals when there are none', () => {
    expect(forecast(input(), TODAY).overdueArrivals).toBeNull()
  })

  it('an order with no ETA never moves the date, and is reported instead', () => {
    // Counting stock whose arrival nobody knows would push out a real date on a
    // guess. The number is shown so someone goes and sets the ETA.
    const f = forecast(input({ arrivals: [{ eta: null, quantity: 500 }] }), TODAY)
    expect(day(f.runsOutOn!)).toBe(day(inDays(9)))
    expect(f.onOrderWithoutEta).toBe(500)
  })

  /**
   * The quantity is the COVER period and nothing more. Lead time already
   * decides WHEN to order (order-by = run-out minus lead); adding it to the
   * quantity as well is what turned "the stock should last 45 days" into
   * 6110 pizza ovens - 200 days of sales on a product with 140 days of lead.
   * The client's own orders overlap (twelve on that one SKU this year), so
   * nothing obliges one order to carry the next order's lead time too.
   */
  it('orders enough for the cover period alone; lead time sets the date, not the amount', () => {
    // 10 a day over the 90-day default cover = 900. Not 30 + 40 + 90 = 1600.
    expect(forecast(input({ stock: 1000 }), TODAY).quantity).toBe(900)
  })

  it('honours a custom cover period instead of the 90-day default', () => {
    // 10 a day over 30 days of cover = 300 units, against 900 at the default.
    const f = forecast(input({ stock: 1000, coverDays: 30 }), TODAY)
    expect(f.quantity).toBe(300)
  })

  /**
   * PANPIZPRO as the client saw it on 2026-08-22: 897 in stock at 29.87 a
   * day, 70 + 70 days of lead, 60 days of cover, containers of 611. The page
   * said "How many: 6110" - ten containers, 200 days of sales.
   */
  it('sizes the pizza oven order to its cover days: three containers, not ten', () => {
    const f = forecast(
      input({
        stock: 897, level: 29.87, productionDays: 70, deliveryDays: 70,
        coverDays: 60, moq: 611, unitsPerContainer: 611,
      }),
      TODAY,
    )
    expect(f.needed).toBe(1793) // 60 days x 29.87, rounded up
    expect(f.quantity).toBe(1833) // three containers of 611
    expect(f.raisedBy).toBe('container')
  })

  it('never orders below the supplier minimum', () => {
    // Runs out on day 299, inside the 365-day horizon, so a quantity is
    // genuinely computed: 1/day over the 90-day cover = 90 units. The
    // supplier's 500 minimum is what must raise it.
    const f = forecast(input({ stock: 300, level: 1, moq: 500 }), TODAY)
    expect(f.quantity).toBe(500)
  })

  it('rounds up to whole containers', () => {
    const f = forecast(input({ stock: 1000, unitsPerContainer: 400 }), TODAY)
    expect(f.quantity).toBe(1200) // 900 needed -> three containers
  })

  it('a container rounding can never drop below the minimum', () => {
    // 90 needed, raised to the 500 minimum, then rounded up to two 400-unit
    // containers = 800. Applying the container first would give 400, then the
    // minimum would lift it to 500 - not a whole number of containers.
    const f = forecast(input({ stock: 300, level: 1, moq: 500, unitsPerContainer: 400 }), TODAY)
    expect(f.quantity).toBe(800)
    expect(f.quantity).toBeGreaterThanOrEqual(500)
    expect(f.quantity! % 400).toBe(0)
  })

  /**
   * "Order 500" without "you need 90" is a number nobody can sanity-check. The
   * reorder tips quote both, and say which rule made up the difference, because
   * "the supplier will not take less" and "that is a whole container" are
   * different reasons to buy stock you do not yet need.
   */
  it('reports what demand alone called for, next to the number to order', () => {
    const f = forecast(input({ stock: 300, level: 1, moq: 500 }), TODAY)
    expect(f.needed).toBe(90)
    expect(f.quantity).toBe(500)
    expect(f.raisedBy).toBe('minimum')
  })

  it('names the container, not the minimum, when the container is what rounded it up', () => {
    const f = forecast(input({ stock: 1000, unitsPerContainer: 400 }), TODAY)
    expect(f.needed).toBe(900)
    expect(f.raisedBy).toBe('container')
  })

  it('names nothing when plain demand set the number', () => {
    const f = forecast(input({ stock: 1000 }), TODAY)
    expect(f.needed).toBe(900)
    expect(f.quantity).toBe(900)
    expect(f.raisedBy).toBeNull()
  })

  it('names the minimum when both rules applied, because the minimum is what binds', () => {
    // 90 needed. Containers alone would give 400; it is the 500 minimum that
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
