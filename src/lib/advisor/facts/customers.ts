import { median } from '../../delivery/stats'
import type { LeaderboardRow } from '../../metrics/ambassadors'
import { movingFact } from '../severity'
import type { Fact } from '../types'

/** People rather than money: a B2B customer gone quiet, an ambassador moving. */

const DAY_MS = 24 * 60 * 60 * 1000

/** Fewer orders than this and there is no rhythm to be silent against. */
export const MIN_B2B_ORDERS = 3
/** Silence starts at twice a customer's own median gap. */
export const QUIET_MULTIPLE = 2
/** Four times their rhythm is as bad as this fact gets. */
export const QUIET_SATURATION = 4

export type B2bHistory = {
  customerId: string
  name: string
  shopId: string
  shopName: string
  /** Every order date this customer has, ascending. */
  orderDates: Date[]
}

export type B2bQuietArgs = {
  customers: B2bHistory[]
  now: Date
}

/**
 * Who has gone quiet - measured against their OWN rhythm, never a fixed number
 * of days. A customer who orders weekly and one who orders monthly fall silent
 * at very different points, and a shared threshold would nag about the first
 * while missing the second entirely.
 */
export function b2bQuietFacts(args: B2bQuietArgs): Fact[] {
  const facts: Fact[] = []

  for (const customer of args.customers) {
    if (customer.orderDates.length < MIN_B2B_ORDERS) continue

    const dates = [...customer.orderDates].sort((a, b) => a.getTime() - b.getTime())
    const gaps: number[] = []
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i].getTime() - dates[i - 1].getTime()) / DAY_MS)
    }

    const typical = median(gaps)
    // Every order on one day gives a median gap of zero. There is no rhythm
    // there to be late against, and dividing by it would invent one.
    if (typical === null || typical <= 0) continue

    const last = dates[dates.length - 1]
    const silent = (args.now.getTime() - last.getTime()) / DAY_MS
    if (silent < typical * QUIET_MULTIPLE) continue

    facts.push({
      id: `b2b-quiet:${customer.customerId}`,
      kind: 'B2B_QUIET',
      shopId: customer.shopId,
      shopName: customer.shopName,
      subject: customer.name,
      current: Math.round(silent),
      previous: Math.round(typical),
      // A ratio of days against days is not a period-over-period change, and
      // printing one as a percentage would be a different claim than the truth.
      deltaPct: null,
      unit: 'days',
      severity: Math.min(silent / (typical * QUIET_SATURATION), 1),
    })
  }

  return facts
}

export type AmbassadorFactsArgs = {
  now: LeaderboardRow[]
  before: LeaderboardRow[]
  /** The previous window's total revenue, display currency. */
  baseline: number
  /** The engine's display currency - sales figures are already converted into it. */
  currency: string
}

/** Who is selling more or less than they were. Money gates apply, unchanged. */
export function ambassadorFacts(args: AmbassadorFactsArgs): Fact[] {
  const prior = new Map(args.before.map((r) => [r.ambassadorId, r.sales]))
  const facts: Fact[] = []

  for (const person of args.now) {
    const previous = prior.get(person.ambassadorId)
    if (previous === undefined) continue

    const fact = movingFact({
      id: `ambassador:${person.ambassadorId}`,
      kind: 'AMBASSADOR_MOVE',
      // An ambassador can carry codes on several stores, so this belongs to no
      // single shop. Null says that, rather than picking one arbitrarily.
      shopId: null,
      shopName: null,
      subject: person.name,
      current: person.sales,
      previous,
      unit: 'money',
      currency: args.currency,
      impact: person.sales - previous,
      baseline: args.baseline,
    })
    if (fact) facts.push(fact)
  }

  return facts
}
