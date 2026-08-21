import { describe, expect, it } from 'vitest'
import type { DeliveryStats } from '@/lib/delivery/stats'
import { deliveryFacts } from './delivery'

const stats = (over: Partial<DeliveryStats>): DeliveryStats => ({
  delivered: 40,
  medianDays: 3,
  medianWarehouseDays: 1,
  medianTransitDays: 2,
  splitDelivered: 2,
  medianSplitDays: 3,
  onTimeRate: 0.95,
  judged: 40,
  unjudged: 0,
  lateNow: 0,
  noTracking: 0,
  notDue: 0,
  collected: 40,
  readyForCollection: 0,
  booked: 0,
  inTransit: 0,
  deliveredUndated: 0,
  distribution: [],
  byCountry: [],
  ...over,
})

const where = { shopId: 'shop_dk', shopName: 'Panetti Denmark' }

describe('deliveryFacts', () => {
  it('reports the median rising by more than half a day', () => {
    const facts = deliveryFacts({ ...where, now: stats({ medianDays: 4.8 }), before: stats({ medianDays: 3 }) })
    const move = facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE' && f.subject === null)
    expect(move).toBeDefined()
    expect(move!.current).toBe(4.8)
    expect(move!.previous).toBe(3)
    expect(move!.unit).toBe('days')
  })

  it('ignores a shift too small to act on', () => {
    const facts = deliveryFacts({ ...where, now: stats({ medianDays: 3.2 }), before: stats({ medianDays: 3 }) })
    expect(facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE')).toBeUndefined()
  })

  it('ignores a median built on too few parcels to mean anything', () => {
    const facts = deliveryFacts({
      ...where,
      now: stats({ medianDays: 9, delivered: 3 }),
      before: stats({ medianDays: 3, delivered: 40 }),
    })
    expect(facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE')).toBeUndefined()
  })

  it('also ignores it when the FEW parcels are on the before side', () => {
    // Every other case here has before.delivered at the stats() default of
    // 40, so `|| deliveredBefore < MIN_DELIVERED` was never the reason a
    // fact got dropped. Same slip, same shape, low count on the other side.
    const facts = deliveryFacts({
      ...where,
      now: stats({ medianDays: 9, delivered: 40 }),
      before: stats({ delivered: 3 }),
    })
    expect(facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE')).toBeUndefined()
  })

  it('says nothing when a window has no delivered parcels at all', () => {
    const facts = deliveryFacts({
      ...where,
      now: stats({ medianDays: null, delivered: 0 }),
      before: stats({ medianDays: 3 }),
    })
    expect(facts).toEqual([])
  })

  it('reports a country whose median rose, naming it', () => {
    const facts = deliveryFacts({
      ...where,
      now: stats({ byCountry: [{ country: 'DK', delivered: 30, medianDays: 5, onTimeRate: 0.7 }] }),
      before: stats({ byCountry: [{ country: 'DK', delivered: 28, medianDays: 3, onTimeRate: 0.95 }] }),
    })
    const country = facts.find((f) => f.kind === 'DELIVERY_DAYS_MOVE' && f.subject === 'DK')
    expect(country).toBeDefined()
    expect(country!.id).toBe('delivery-days:shop_dk:DK')
  })

  it('reports the on-time rate falling by more than five points', () => {
    const facts = deliveryFacts({ ...where, now: stats({ onTimeRate: 0.8 }), before: stats({ onTimeRate: 0.95 }) })
    const move = facts.find((f) => f.kind === 'ON_TIME_MOVE')
    expect(move).toBeDefined()
    expect(move!.unit).toBe('percent')
  })

  it('does not report an on-time rate that IMPROVED', () => {
    const facts = deliveryFacts({ ...where, now: stats({ onTimeRate: 0.99 }), before: stats({ onTimeRate: 0.8 }) })
    expect(facts.find((f) => f.kind === 'ON_TIME_MOVE')).toBeUndefined()
  })

  it('reports a queue of orders late right now, once it is worth acting on', () => {
    const facts = deliveryFacts({ ...where, now: stats({ lateNow: 12 }), before: stats({ lateNow: 2 }) })
    const late = facts.find((f) => f.kind === 'LATE_NOW')
    expect(late).toBeDefined()
    expect(late!.current).toBe(12)
    expect(late!.unit).toBe('count')
  })

  it('stays quiet about a handful of late orders', () => {
    const facts = deliveryFacts({ ...where, now: stats({ lateNow: 3 }), before: stats({ lateNow: 1 }) })
    expect(facts.find((f) => f.kind === 'LATE_NOW')).toBeUndefined()
  })

  it('stays quiet about a late queue that shrank, even above the floor', () => {
    // now.lateNow clears MIN_LATE_NOW on its own; nothing here exercised the
    // "and it grew" half until this shrank from an even bigger queue.
    const facts = deliveryFacts({ ...where, now: stats({ lateNow: 8 }), before: stats({ lateNow: 15 }) })
    expect(facts.find((f) => f.kind === 'LATE_NOW')).toBeUndefined()
  })
})
