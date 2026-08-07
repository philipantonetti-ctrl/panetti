import { describe, expect, it } from 'vitest'
import { deliveryStats, median } from './stats'
import type { OrderDelivery } from './view'

const v = (over: Partial<OrderDelivery> = {}): OrderDelivery => ({
  state: 'AVAILABLE', totalDays: 3, warehouseDays: 1, transitDays: 2,
  availableAt: new Date(), collectedAt: null, deadline: new Date(),
  promiseDays: 3, late: false, daysOver: null, trackingNumbers: ['T1'],
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

  it('splits the median wait into warehouse and transit', () => {
    const s = deliveryStats(
      [v({ warehouseDays: 1, transitDays: 2 }), v({ warehouseDays: 3, transitDays: 2 })],
      ['NO', 'NO'],
    )
    expect(s.medianWarehouseDays).toBe(2)
    expect(s.medianTransitDays).toBe(2)
  })

  it('rates on time against the promise each order actually had', () => {
    const s = deliveryStats(
      [v({ totalDays: 2, promiseDays: 3 }), v({ totalDays: 5, promiseDays: 3 })],
      ['NO', 'NO'],
    )
    expect(s.judged).toBe(2)
    expect(s.onTimeRate).toBe(0.5)
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
        v({ state: 'IN_TRANSIT', totalDays: null, late: true }),
        v({ state: 'NO_TRACKING', totalDays: null, late: true }),
        v({ state: 'NO_TRACKING', totalDays: null, late: false }),
      ],
      ['NO', 'NO', 'NO'],
    )
    expect(s.lateNow).toBe(2)
    expect(s.noTracking).toBe(2)
  })

  it('builds a distribution that shows the tail a median hides', () => {
    const s = deliveryStats(
      [v({ totalDays: 2 }), v({ totalDays: 2 }), v({ totalDays: 9 })],
      ['NO', 'NO', 'NO'],
    )
    expect(s.distribution).toEqual([{ days: 2, count: 2 }, { days: 9, count: 1 }])
  })

  it('breaks down by destination country, busiest first', () => {
    const s = deliveryStats(
      [v({ totalDays: 2 }), v({ totalDays: 4 }), v({ totalDays: 7 })],
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
