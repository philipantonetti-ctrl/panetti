import { describe, expect, it } from 'vitest'
import type { OrderDelivery } from '@/lib/delivery/view'
import { deliveryPhrase } from './delivery-phrase'

const view = (over: Partial<OrderDelivery>): OrderDelivery => ({
  state: 'IN_TRANSIT', totalDays: null, warehouseDays: null, transitDays: null,
  availableAt: null, collectedAt: null, deadline: null, promiseDays: null,
  late: false, daysOver: null, parcels: [], ...over,
})

describe('deliveryPhrase', () => {
  it('says what the Delivery page would say, in a sentence', () => {
    expect(deliveryPhrase(view({ state: 'DELIVERED', totalDays: 3 }))).toBe('delivered, 3 days after the order')
    expect(deliveryPhrase(view({ state: 'DELIVERED_UNDATED' }))).toBe('delivered')
    expect(deliveryPhrase(view({ state: 'AVAILABLE' }))).toBe('ready for pickup')
    expect(deliveryPhrase(view({ state: 'IN_TRANSIT' }))).toBe('in transit')
    expect(deliveryPhrase(view({ state: 'IN_TRANSIT', late: true, daysOver: 2 }))).toBe('in transit, 2 days past the promised date')
    expect(deliveryPhrase(view({ state: 'BOOKED' }))).toBe('packed at the warehouse, not yet handed to the carrier')
    expect(deliveryPhrase(view({ state: 'NO_TRACKING' }))).toBe('not shipped yet')
    expect(deliveryPhrase(view({ state: 'NOT_DUE' }))).toBe('not shipped yet')
    expect(deliveryPhrase(view({ state: 'RETURNED' }))).toBe('returned to sender')
    expect(deliveryPhrase(view({ state: 'CANCELLED' }))).toBe('shipment cancelled')
  })
  it('is null when there is nothing honest to say', () => {
    expect(deliveryPhrase(view({ state: 'UNTRACKED' }))).toBeNull()
    expect(deliveryPhrase(view({ state: 'BEFORE_TRACKING' }))).toBeNull()
    expect(deliveryPhrase(view({ state: 'VOIDED' }))).toBeNull()
  })
})
