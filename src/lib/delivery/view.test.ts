import { describe, expect, it } from 'vitest'
import { deliveryFor, type DeliveryOrder } from './view'
import type { PromisePoint } from './promise'

const OSLO = 'Europe/Oslo'
const NOW = new Date('2026-08-20T12:00:00Z')

const promises: PromisePoint[] = [
  { country: '*', days: 6, businessDays: true, effectiveFrom: new Date('2026-01-01') },
  { country: 'NO', days: 3, businessDays: true, effectiveFrom: new Date('2026-01-01') },
]

const order = (over: Partial<DeliveryOrder> = {}): DeliveryOrder => ({
  id: 'o1', number: '1001',
  placedAt: new Date('2026-08-03T08:00:00Z'), // Monday
  status: 'completed',
  shippingCountry: 'NO',
  shopName: 'Panetti', shopTimezone: OSLO,
  shopTrackingFrom: new Date('2026-01-01'),
  shipments: [],
  ...over,
})

const parcel = (over = {}) => ({
  trackingNumber: 'T1', bookedAt: null, handedInAt: null,
  availableAt: null, collectedAt: null, outcome: null, lastStatus: null,
  ...over,
})

describe('deliveryFor', () => {
  it('splits the wait into warehouse days and transit days', () => {
    const v = deliveryFor(order({
      shipments: [parcel({
        handedInAt: new Date('2026-08-04T16:00:00Z'),
        availableAt: new Date('2026-08-06T09:00:00Z'),
        outcome: 'DELIVERED',
      })],
    }), promises, OSLO, NOW)

    expect(v.state).toBe('AVAILABLE')
    expect(v.warehouseDays).toBe(1)
    expect(v.transitDays).toBe(2)
    expect(v.totalDays).toBe(3)
    expect(v.late).toBe(false)
  })

  it('judges the total against the promise, not the transit half', () => {
    // Handed over late, arrived quickly. The customer still waited 6 days.
    const v = deliveryFor(order({
      shipments: [parcel({
        handedInAt: new Date('2026-08-08T16:00:00Z'),
        availableAt: new Date('2026-08-09T09:00:00Z'),
        outcome: 'DELIVERED',
      })],
    }), promises, OSLO, NOW)
    expect(v.totalDays).toBe(6)
    expect(v.late).toBe(true)
  })

  it('is available when the LAST parcel is, for a multi-parcel order', () => {
    const v = deliveryFor(order({
      shipments: [
        parcel({ trackingNumber: 'T1', availableAt: new Date('2026-08-05T09:00:00Z'), outcome: 'DELIVERED' }),
        parcel({ trackingNumber: 'T2', availableAt: new Date('2026-08-07T09:00:00Z'), outcome: 'DELIVERED' }),
      ],
    }), promises, OSLO, NOW)
    expect(v.availableAt).toEqual(new Date('2026-08-07T09:00:00Z'))
    expect(v.trackingNumbers).toEqual(['T1', 'T2'])
  })

  it('is not available while one parcel of an order is still moving', () => {
    const v = deliveryFor(order({
      shipments: [
        parcel({ trackingNumber: 'T1', availableAt: new Date('2026-08-05T09:00:00Z') }),
        parcel({ trackingNumber: 'T2', handedInAt: new Date('2026-08-04T09:00:00Z') }),
      ],
    }), promises, OSLO, NOW)
    expect(v.availableAt).toBeNull()
    expect(v.state).toBe('IN_TRANSIT')
  })

  it('does not judge the customer for collecting late', () => {
    const v = deliveryFor(order({
      shipments: [parcel({
        handedInAt: new Date('2026-08-04T16:00:00Z'),
        availableAt: new Date('2026-08-05T09:00:00Z'),
        collectedAt: new Date('2026-08-19T09:00:00Z'),
        outcome: 'DELIVERED',
      })],
    }), promises, OSLO, NOW)
    expect(v.totalDays).toBe(2)
    expect(v.collectedAt).toEqual(new Date('2026-08-19T09:00:00Z'))
    expect(v.late).toBe(false)
  })

  it('marks an order past its promise with no parcel at all as late', () => {
    const v = deliveryFor(order(), promises, OSLO, NOW)
    expect(v.state).toBe('NO_TRACKING')
    expect(v.late).toBe(true)
    expect(v.daysOver).toBeGreaterThan(0)
  })

  it('does not judge a shop that is not tracked', () => {
    const v = deliveryFor(order({ shopTrackingFrom: null }), promises, OSLO, NOW)
    expect(v.state).toBe('UNTRACKED')
    expect(v.late).toBe(false)
  })

  it('does not judge an order placed before tracking started', () => {
    const v = deliveryFor(
      order({ shopTrackingFrom: new Date('2026-08-10') }), promises, OSLO, NOW,
    )
    expect(v.state).toBe('BEFORE_TRACKING')
    expect(v.late).toBe(false)
  })

  it('never marks a refunded order late, because it is never going to arrive', () => {
    for (const status of ['refunded', 'cancelled', 'failed', 'trash']) {
      const v = deliveryFor(order({ status }), promises, OSLO, NOW)
      expect(v.state).toBe('VOIDED')
      expect(v.late).toBe(false)
    }
  })

  it('reports a return as its own outcome, never as delivered', () => {
    const v = deliveryFor(order({
      shipments: [parcel({ handedInAt: new Date('2026-08-04T16:00:00Z'), outcome: 'RETURNED' })],
    }), promises, OSLO, NOW)
    expect(v.state).toBe('RETURNED')
    expect(v.totalDays).toBeNull()
    // Still late: the customer never got their order, and that is the thing
    // worth knowing.
    expect(v.late).toBe(true)
  })

  it('ignores availableAt on a parcel that was returned uncollected', () => {
    // NOT hypothetical. availableAt and outcome are separate denormalised
    // columns: a pickup-point parcel sets availableAt on READY_FOR_PICKUP, then
    // is returned when nobody collects it. Trusting availableAt alone would
    // count this as delivered in the median AND make `late` false, so it would
    // never alert — for an order the customer never received.
    const v = deliveryFor(order({
      shipments: [parcel({
        handedInAt: new Date('2026-08-04T16:00:00Z'),
        availableAt: new Date('2026-08-06T09:00:00Z'),
        outcome: 'RETURNED',
      })],
    }), promises, OSLO, NOW)
    expect(v.state).toBe('RETURNED')
    expect(v.availableAt).toBeNull()
    expect(v.totalDays).toBeNull()
    expect(v.late).toBe(true)
  })

  it('makes no judgement at all when no promise is in force', () => {
    const v = deliveryFor(order({ shippingCountry: 'NO' }), [], OSLO, NOW)
    expect(v.deadline).toBeNull()
    expect(v.promiseDays).toBeNull()
    expect(v.late).toBe(false)
  })

  it('falls back to the star promise for a country with none of its own', () => {
    const v = deliveryFor(order({ shippingCountry: 'DE' }), promises, OSLO, NOW)
    expect(v.promiseDays).toBe(6)
  })

  it('prefers the shop timezone over the workspace one', () => {
    const a = deliveryFor(order({ shopTimezone: 'Europe/Oslo' }), promises, 'UTC', NOW)
    const b = deliveryFor(order({ shopTimezone: null }), promises, 'Europe/Oslo', NOW)
    expect(a.deadline).toEqual(b.deadline)
  })
})
