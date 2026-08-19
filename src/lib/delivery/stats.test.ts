import { describe, expect, it } from 'vitest'
import { deliveryStats, median } from './stats'
import type { OrderDelivery } from './view'

const v = (over: Partial<OrderDelivery> = {}): OrderDelivery => ({
  state: 'AVAILABLE', totalDays: 3, warehouseDays: 1, transitDays: 2,
  availableAt: new Date(), collectedAt: null, deadline: new Date(),
  promiseDays: 3, late: false, daysOver: null,
  parcels: [{ number: 'T1', carrier: 'Bring', url: 'https://tracking.bring.com/tracking/T1' }],
  ...over,
})

describe('median', () => {
  it('is the middle value of an odd list', () => expect(median([5, 1, 3])).toBe(3))
  it('averages the two middle values of an even list', () => expect(median([1, 2, 3, 4])).toBe(2.5))
  it('is null for nothing, rather than zero', () => expect(median([])).toBeNull())
  it('is not dragged by an outlier the way a mean would be', () => {
    // A mean here is 25.75. Two parcels stuck in customs must not become the
    // headline figure.
    expect(median([2, 3, 3, 95])).toBe(3)
  })
})

describe('deliveryStats', () => {
  it('counts and medians only what was actually delivered', () => {
    const s = deliveryStats(
      [v({ totalDays: 2 }), v({ totalDays: 4 }), v({ state: 'IN_TRANSIT', totalDays: null })],
      ['NO', 'NO', 'NO'],
    )
    expect(s.delivered).toBe(2)
    expect(s.medianDays).toBe(3)
  })

  it('counts what is still on the way, so a page with no deliveries can still say what is happening', () => {
    // The case this exists for: a workspace switched on last week. Every
    // finished-delivery figure below is legitimately null, and without these
    // two counts the page cannot tell "nothing is set up" from "four parcels
    // are moving perfectly normally".
    const s = deliveryStats(
      [
        v({ state: 'BOOKED', totalDays: null }),
        v({ state: 'BOOKED', totalDays: null }),
        v({ state: 'IN_TRANSIT', totalDays: null }),
        v({ state: 'NO_TRACKING', totalDays: null }),
      ],
      ['NO', 'NO', 'NO', 'NO'],
    )
    expect(s.booked).toBe(2)
    expect(s.inTransit).toBe(1)
    expect(s.noTracking).toBe(1)
    expect(s.delivered).toBe(0)
    expect(s.medianDays).toBeNull()
  })

  it('does not count a delivered order as still moving', () => {
    const s = deliveryStats([v({ state: 'AVAILABLE', totalDays: 3 })], ['NO'])
    expect(s.booked).toBe(0)
    expect(s.inTransit).toBe(0)
    expect(s.delivered).toBe(1)
  })

  it('splits the median wait into warehouse and transit', () => {
    const s = deliveryStats(
      [v({ warehouseDays: 1, transitDays: 2 }), v({ warehouseDays: 3, transitDays: 2 })],
      ['NO', 'NO'],
    )
    expect(s.medianWarehouseDays).toBe(2)
    expect(s.medianTransitDays).toBe(2)
  })

  it('rates on time against the promise each order actually had', () => {
    // `late` is stated on each fixture rather than left to default, because it
    // is what the rate now reads. deliveryFor is the only thing entitled to
    // decide lateness — it knows the business-day deadline — so a fixture that
    // means "this one missed its promise" has to say so.
    const s = deliveryStats(
      [
        v({ totalDays: 2, promiseDays: 3, late: false }),
        v({ totalDays: 5, promiseDays: 3, late: true }),
      ],
      ['NO', 'NO'],
    )
    expect(s.judged).toBe(2)
    expect(s.onTimeRate).toBe(0.5)
  })

  it('trusts the business-day verdict over a raw calendar-day comparison', () => {
    // Placed Thursday, three BUSINESS days promised, delivered Monday. That is
    // 4 calendar days against a promise of 3, so a naive totalDays <=
    // promiseDays test calls it late — but the deadline was Tuesday and
    // deliveryFor correctly says it was not. The rate must agree with the late
    // list on the same page, or the tile accuses an order the list exonerates.
    const s = deliveryStats(
      [v({ totalDays: 4, promiseDays: 3, late: false, availableAt: new Date() })],
      ['NO'],
    )
    expect(s.onTimeRate).toBe(1)
    expect(s.lateNow).toBe(0)
  })

  it('leaves an unpromised order out of the rate and says how many', () => {
    const s = deliveryStats(
      [v({ totalDays: 2, promiseDays: 3 }), v({ totalDays: 9, promiseDays: null })],
      ['NO', 'DE'],
    )
    expect(s.judged).toBe(1)
    expect(s.onTimeRate).toBe(1)
    expect(s.unjudged).toBe(1)
  })

  it('counts what is late right now and what has no tracking at all', () => {
    const s = deliveryStats(
      [
        v({ state: 'IN_TRANSIT', totalDays: null, availableAt: null, late: true }),
        v({ state: 'NO_TRACKING', totalDays: null, availableAt: null, late: true }),
        v({ state: 'NO_TRACKING', totalDays: null, availableAt: null, late: false }),
      ],
      ['NO', 'NO', 'NO'],
    )
    expect(s.lateNow).toBe(2)
    expect(s.noTracking).toBe(2)
  })

  /**
   * Reported live 2026-08-19: the tile read 155 while the Late list under it
   * showed 8. The other 147 were orders past their promise with no parcel at
   * all, which api/delivery/route.ts deliberately moved into their own section
   * — a missing warehouse file is not evidence of a missed promise. lateNow
   * was never taught about that split, so the tile went on counting both.
   *
   * The tile's own tooltip calls itself "the list to chase". An order nobody
   * has a tracking number for cannot be chased with anyone.
   */
  it('leaves an order with no parcel out of the chase queue', () => {
    const s = deliveryStats(
      [
        v({ state: 'IN_TRANSIT', totalDays: null, availableAt: null, late: true }),
        v({ state: 'NO_TRACKING', totalDays: null, availableAt: null, late: true, parcels: [] }),
        v({ state: 'NO_TRACKING', totalDays: null, availableAt: null, late: true, parcels: [] }),
      ],
      ['NO', 'NO', 'NO'],
    )

    expect(s.lateNow).toBe(1)
    // Still counted, and still visible in their own section — removed from the
    // chase queue, not from the page.
    expect(s.noTracking).toBe(2)
  })

  it('does not queue an order that already arrived, however late it was', () => {
    // It missed its promise, so it must hurt the on-time rate. But nobody is
    // waiting for it any more, so it does not belong in a tile people read as
    // a list of things to chase.
    const s = deliveryStats(
      [v({ totalDays: 5, promiseDays: 3, availableAt: new Date(), late: true })],
      ['NO'],
    )
    expect(s.lateNow).toBe(0)
    expect(s.onTimeRate).toBe(0)
  })

  it('keeps a returned parcel in the live queue, since the customer got nothing', () => {
    const s = deliveryStats(
      [v({ state: 'RETURNED', totalDays: null, availableAt: null, late: true })],
      ['NO'],
    )
    expect(s.lateNow).toBe(1)
  })

  it('builds a distribution that shows the tail a median hides', () => {
    const s = deliveryStats(
      [v({ totalDays: 2 }), v({ totalDays: 2 }), v({ totalDays: 9 })],
      ['NO', 'NO', 'NO'],
    )
    expect(s.distribution).toEqual([{ days: 2, count: 2 }, { days: 9, count: 1 }])
  })

  it('breaks down by destination country, busiest first', () => {
    // `late` stated explicitly for the same reason as the rate test above.
    const s = deliveryStats(
      [
        v({ totalDays: 2, late: false }),
        v({ totalDays: 4, late: true }),
        v({ totalDays: 7, late: true }),
      ],
      ['NO', 'NO', 'SE'],
    )
    expect(s.byCountry[0]).toEqual({ country: 'NO', delivered: 2, medianDays: 3, onTimeRate: 0.5 })
    expect(s.byCountry[1].country).toBe('SE')
  })

  it('labels an order with no country rather than dropping it', () => {
    const s = deliveryStats([v({ totalDays: 2 })], [null])
    expect(s.byCountry[0].country).toBe('Unknown')
  })

  it('reports nothing rather than zero when there is nothing to report', () => {
    const s = deliveryStats([], [])
    expect(s.medianDays).toBeNull()
    expect(s.onTimeRate).toBeNull()
    expect(s.delivered).toBe(0)
  })
})
