import { deltaPct } from '../../metrics/trend'
import type { DeliveryStats } from '../../delivery/stats'
import type { Fact } from '../types'

/**
 * How delivery moved, per shop and per destination country.
 *
 * These deliberately DO NOT use the money gates in severity.ts. A day is not
 * money, so "worth 1% of revenue" has no meaning here. What a median needs
 * instead is enough parcels to be a median at all - hence a count gate - and a
 * change large enough to act on, in days.
 */

/** Fewer than this and the median is an anecdote, not a figure. */
export const MIN_DELIVERED = 10
/** A shift smaller than this is inside the noise of a normal week. */
export const MIN_DAYS_MOVE = 0.5
/** Days of slippage that count as the worst it gets. */
export const DAYS_SATURATION = 2
/** On-time rate: five points is the smallest drop worth a sentence. */
export const MIN_ON_TIME_DROP = 0.05
export const ON_TIME_SATURATION = 0.2
/** Below this the late queue is a normal morning, not a problem. */
export const MIN_LATE_NOW = 5
export const LATE_NOW_SATURATION = 20

export type DeliveryFactsArgs = {
  shopId: string
  shopName: string
  now: DeliveryStats
  before: DeliveryStats
}

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1)

export function deliveryFacts(args: DeliveryFactsArgs): Fact[] {
  const { shopId, shopName, now, before } = args
  const facts: Fact[] = []

  const daysMove = (
    id: string,
    subject: string | null,
    current: number | null,
    previous: number | null,
    deliveredNow: number,
    deliveredBefore: number,
  ) => {
    if (current === null || previous === null) return
    if (deliveredNow < MIN_DELIVERED || deliveredBefore < MIN_DELIVERED) return
    // Only slippage. A delivery that got FASTER is good news, and a briefing
    // that opens with good news teaches the reader to skim it.
    const slip = current - previous
    if (slip < MIN_DAYS_MOVE) return

    facts.push({
      id,
      kind: 'DELIVERY_DAYS_MOVE',
      shopId,
      shopName,
      subject,
      current,
      previous,
      deltaPct: deltaPct(current, previous),
      unit: 'days',
      severity: clamp01(slip / DAYS_SATURATION),
    })
  }

  daysMove(`delivery-days:${shopId}`, null, now.medianDays, before.medianDays, now.delivered, before.delivered)

  const beforeCountry = new Map(before.byCountry.map((c) => [c.country, c]))
  for (const country of now.byCountry) {
    const prior = beforeCountry.get(country.country)
    if (!prior) continue
    daysMove(
      `delivery-days:${shopId}:${country.country}`,
      country.country,
      country.medianDays,
      prior.medianDays,
      country.delivered,
      prior.delivered,
    )
  }

  if (
    now.onTimeRate !== null &&
    before.onTimeRate !== null &&
    now.judged >= MIN_DELIVERED &&
    before.judged >= MIN_DELIVERED
  ) {
    const drop = before.onTimeRate - now.onTimeRate
    if (drop >= MIN_ON_TIME_DROP) {
      facts.push({
        id: `on-time:${shopId}`,
        kind: 'ON_TIME_MOVE',
        shopId,
        shopName,
        subject: null,
        current: now.onTimeRate,
        previous: before.onTimeRate,
        deltaPct: deltaPct(now.onTimeRate, before.onTimeRate),
        unit: 'percent',
        severity: clamp01(drop / ON_TIME_SATURATION),
      })
    }
  }

  // Late RIGHT NOW is a to-do list, not a trend. It is reported when it is big
  // enough to be worth a morning, and only when it grew.
  if (now.lateNow >= MIN_LATE_NOW && now.lateNow > before.lateNow) {
    facts.push({
      id: `late-now:${shopId}`,
      kind: 'LATE_NOW',
      shopId,
      shopName,
      subject: null,
      current: now.lateNow,
      previous: before.lateNow,
      deltaPct: deltaPct(now.lateNow, before.lateNow),
      unit: 'count',
      severity: clamp01(now.lateNow / LATE_NOW_SATURATION),
    })
  }

  return facts
}
