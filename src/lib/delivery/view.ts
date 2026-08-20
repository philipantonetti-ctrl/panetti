import { VOIDED_STATUSES } from '../metrics/types'
import { daysBetween, deadlineFor } from './days'
import { trackingDueAt } from './due'
import { promiseOn, type PromisePoint } from './promise'
import { carrierName, trackingUrl } from './tracking-url'

export type DeliveryState =
  | 'UNTRACKED' // this shop is not delivery-tracked at all
  | 'BEFORE_TRACKING' // placed before we started tracking this shop
  | 'VOIDED' // refunded or cancelled: never going to be delivered
  | 'NO_TRACKING' // expected a parcel, have none
  | 'BOOKED' // label made, still in the warehouse
  | 'IN_TRANSIT'
  // These two were one state called AVAILABLE, which said "with the customer,
  // OR waiting at their pickup point". Both are true endings and the clock
  // stops at the same moment for each, but they are not the same news: DHL
  // reports only the second kind, so every DHL order read "Available" beside a
  // DHL page reading "Delivered". Both timestamps were already stored.
  | 'AVAILABLE' // arrived at the pickup point, not yet collected
  | 'DELIVERED' // in the customer's hands
  /**
   * No parcel yet, and none expected yet: the warehouse file that would first
   * have carried its number has not been produced. Split out of NO_TRACKING,
   * which counted an order from the second it was placed and so filed a day
   * and a half of perfectly normal orders under "no warehouse file has
   * mentioned these". See due.ts for the cutoff and the file hour.
   */
  | 'NOT_DUE'
  | 'RETURNED'
  | 'CANCELLED'

export type DeliveryShipment = {
  trackingNumber: string
  /** Who is carrying it. Decides where its tracking link points. */
  carrier: string
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
  /** Which shop sold it. Promises are per shop as well as per country. */
  shopId: string
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
  /**
   * The order's parcels, each with the link that actually reaches its own
   * carrier. Carries the built URL rather than the carrier name so that the
   * three screens showing these — the delivery page, the Slack alert and the
   * Orders column — cannot each get the mapping slightly different.
   */
  parcels: Parcel[]
}

/**
 * Both `carrier` and `url` are ready to render: the name is already written
 * the way a person reads it and the link already points at the right site. The
 * page shows both carriers in one list, so it needs the name to tell them
 * apart — but it should not have to know the carrier rules to get either.
 */
export type Parcel = { number: string; carrier: string; url: string }

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
  const parcels = order.shipments.map((s) => ({
    number: s.trackingNumber,
    carrier: carrierName(s.carrier),
    url: trackingUrl(s.trackingNumber, s.carrier),
  }))
  const base = { ...EMPTY, parcels }

  // Three ways an order is simply not our business to judge. Each is separate
  // because each reads differently on screen, and "we are not tracking this"
  // must never look like "this has not shipped".
  if (!order.shopTrackingFrom) return { ...base, state: 'UNTRACKED' }
  /**
   * The cutoff hides only what it cannot speak for.
   *
   * It answers "could we possibly know what happened to this order", and for
   * one holding a parcel the answer is yes — we are looking straight at it.
   * Hiding it anyway threw away real evidence for no gain.
   *
   * That gain matters because of what the cutoff is FOR. The warehouse does
   * not send files for past orders, so every order older than the feed reads
   * NO_TRACKING forever and no amount of importing will move it; walking the
   * cutoff forward is the only cure. But while the cutoff silenced older
   * orders regardless of evidence, that cure also erased the median, the
   * on-time rate and the distribution chart over the same period — measured on
   * a seeded run: delivered 1 -> 0, medianDays 2 -> null, onTimeRate 1 -> null.
   * Nobody would accept that trade, so the feature went unused and the
   * unanswerable orders stayed on the page.
   */
  if (order.placedAt < order.shopTrackingFrom && order.shipments.length === 0)
    return { ...base, state: 'BEFORE_TRACKING' }
  // A refunded order is never going to be delivered. Without this, every refund
  // in the tracked window becomes a permanent late delivery.
  if (VOIDED.has(order.status.toLowerCase())) return { ...base, state: 'VOIDED' }

  const tz = order.shopTimezone ?? fallbackTz
  const promise = promiseOn(promises, order.shopId, order.shippingCountry, order.placedAt)
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

  // collectedAt before availableAt: a collected parcel is also an available
  // one, so the more specific fact has to be asked about first or it can never
  // be reported. Everything below this line is unchanged — in particular the
  // clock still stops at availableAt, so a customer who takes a week to walk
  // to the pickup point still does not make the delivery late.
  const state: DeliveryState = returned
    ? 'RETURNED'
    : cancelled
      ? 'CANCELLED'
      : collectedAt
        ? 'DELIVERED'
        : availableAt
          ? 'AVAILABLE'
          : order.shipments.length === 0
            ? // Too new to be missing. An order placed after noon is not
              // expected in a file until tomorrow evening, and calling it "no
              // tracking" before then reports the warehouse working normally
              // as a fault.
              now < trackingDueAt(order.placedAt, tz)
              ? 'NOT_DUE'
              : 'NO_TRACKING'
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
    parcels,
  }
}
