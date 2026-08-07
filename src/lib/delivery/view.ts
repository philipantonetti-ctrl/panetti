import { VOIDED_STATUSES } from '../metrics/types'
import { daysBetween, deadlineFor } from './days'
import { promiseOn, type PromisePoint } from './promise'

export type DeliveryState =
  | 'UNTRACKED' // this shop is not delivery-tracked at all
  | 'BEFORE_TRACKING' // placed before we started tracking this shop
  | 'VOIDED' // refunded or cancelled: never going to be delivered
  | 'NO_TRACKING' // expected a parcel, have none
  | 'BOOKED' // label made, still in the warehouse
  | 'IN_TRANSIT'
  | 'AVAILABLE' // with the customer, or waiting at their pickup point
  | 'RETURNED'
  | 'CANCELLED'

export type DeliveryShipment = {
  trackingNumber: string
  bookedAt: Date | null
  handedInAt: Date | null
  availableAt: Date | null
  collectedAt: Date | null
  outcome: string | null
  lastStatus: string | null
}

export type DeliveryOrder = {
  id: string
  number: string
  placedAt: Date
  status: string
  shippingCountry: string | null
  shopName: string
  shopTimezone: string | null
  shopTrackingFrom: Date | null
  shipments: DeliveryShipment[]
}

export type OrderDelivery = {
  state: DeliveryState
  totalDays: number | null
  warehouseDays: number | null
  transitDays: number | null
  availableAt: Date | null
  collectedAt: Date | null
  deadline: Date | null
  promiseDays: number | null
  late: boolean
  daysOver: number | null
  trackingNumbers: string[]
}

const VOIDED = new Set<string>(VOIDED_STATUSES)

const maxDate = (dates: (Date | null)[]): Date | null => {
  const real = dates.filter((d): d is Date => d !== null)
  return real.length ? new Date(Math.max(...real.map((d) => d.getTime()))) : null
}

const minDate = (dates: (Date | null)[]): Date | null => {
  const real = dates.filter((d): d is Date => d !== null)
  return real.length ? new Date(Math.min(...real.map((d) => d.getTime()))) : null
}

const EMPTY = {
  totalDays: null, warehouseDays: null, transitDays: null,
  availableAt: null, collectedAt: null, deadline: null, promiseDays: null,
  late: false, daysOver: null,
}

/**
 * What happened to one order's delivery.
 *
 * THE one place that decides whether an order is late. The Delivery page, the
 * Orders column and the Slack alert all read this, so they cannot drift apart
 * and tell three different stories about the same order.
 *
 * Pure. No database, no clock of its own — `now` is passed in so a test can
 * stand anywhere in time.
 */
export function deliveryFor(
  order: DeliveryOrder,
  promises: PromisePoint[],
  fallbackTz: string,
  now: Date,
): OrderDelivery {
  const trackingNumbers = order.shipments.map((s) => s.trackingNumber)
  const base = { ...EMPTY, trackingNumbers }

  // Three ways an order is simply not our business to judge. Each is separate
  // because each reads differently on screen, and "we are not tracking this"
  // must never look like "this has not shipped".
  if (!order.shopTrackingFrom) return { ...base, state: 'UNTRACKED' }
  if (order.placedAt < order.shopTrackingFrom) return { ...base, state: 'BEFORE_TRACKING' }
  // A refunded order is never going to be delivered. Without this, every refund
  // in the tracked window becomes a permanent late delivery.
  if (VOIDED.has(order.status.toLowerCase())) return { ...base, state: 'VOIDED' }

  const tz = order.shopTimezone ?? fallbackTz
  const promise = promiseOn(promises, order.shippingCountry, order.placedAt)
  // No promise in force means no judgement. Never a zero-day deadline, which
  // would make every order instantly late.
  const deadline = promise
    ? deadlineFor(order.placedAt, promise.days, promise.businessDays, tz)
    : null
  const promiseDays = promise?.days ?? null

  const returned = order.shipments.some((s) => s.outcome === 'RETURNED')
  const cancelled = order.shipments.some((s) => s.outcome === 'CANCELLED')

  // An order is available only when its LAST parcel is: a customer holding one
  // of two boxes has not received their order.
  //
  // The returned/cancelled guard is not belt-and-braces. `availableAt` and
  // `outcome` are separate denormalised columns, and a pickup-point parcel
  // genuinely sets availableAt (READY_FOR_PICKUP) BEFORE it is returned
  // uncollected. Without this guard such an order would report totalDays — so it
  // would count as delivered in the median — and `late` would be false, so it
  // would never alert. The customer never received it. Same rule milestonesFrom
  // applies in map.ts; the two must not drift.
  const allAvailable =
    !returned &&
    !cancelled &&
    order.shipments.length > 0 &&
    order.shipments.every((s) => s.availableAt !== null)
  const availableAt = allAvailable ? maxDate(order.shipments.map((s) => s.availableAt)) : null

  const allCollected =
    order.shipments.length > 0 && order.shipments.every((s) => s.collectedAt !== null)
  const collectedAt = allCollected ? maxDate(order.shipments.map((s) => s.collectedAt)) : null

  const handedInAt = minDate(order.shipments.map((s) => s.handedInAt))

  const state: DeliveryState = returned
    ? 'RETURNED'
    : cancelled
      ? 'CANCELLED'
      : availableAt
        ? 'AVAILABLE'
        : order.shipments.length === 0
          ? 'NO_TRACKING'
          : handedInAt
            ? 'IN_TRANSIT'
            : 'BOOKED'

  // Late = past the promise, judged at the moment the order actually became
  // available — or right now, if it never has. Gating on `!availableAt` alone
  // is not enough: a shipment that DID arrive can still have taken longer than
  // the promise allowed ("judges the total against the promise, not the
  // transit half"), and that must still read as late. One rule covers three
  // shapes: a parcel that arrived but took too long, one still crawling
  // through Bring past its deadline, and an order the warehouse never booked
  // at all — there being no shipment for a shipment-driven rule to see.
  const referenceAt = availableAt ?? now
  const late = deadline !== null && referenceAt > deadline
  const daysOver = late ? daysBetween(deadline!, referenceAt, tz) : null

  return {
    state,
    // The headline is the customer's whole wait, from placing the order to it
    // being available to them.
    totalDays: availableAt ? daysBetween(order.placedAt, availableAt, tz) : null,
    warehouseDays: handedInAt ? daysBetween(order.placedAt, handedInAt, tz) : null,
    transitDays: handedInAt && availableAt ? daysBetween(handedInAt, availableAt, tz) : null,
    availableAt,
    // Recorded and shown, never judged: a customer who takes a week to walk to
    // the pickup point has not been failed by anyone.
    collectedAt,
    deadline,
    promiseDays,
    late,
    daysOver,
    trackingNumbers,
  }
}
