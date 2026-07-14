import { utcDay } from './dates'
import { costOn } from './metrics/costs'

/**
 * A product's cost is a TIMELINE: each row says "from this day on, the product
 * cost this much." Saving a new cost never overwrites history — it adds a point.
 *
 * COGS and the handling cost are chosen in two steps (the "Update COGS (1/2)" then
 * "(2/2)" modal), so each can start from its OWN date. This file works out what the
 * timeline must look like afterwards so that BOTH are true at every date.
 */

export type CostRow = {
  costPerItem: number
  handlingCost: number
  effectiveFrom: Date
}

/** The three choices offered when saving a cost. */
export type ApplyFrom =
  | { apply: 'FUTURE' } // future orders only
  | { apply: 'LAST_60_DAYS' } // also the last 60 days of orders
  | { apply: 'DATE_RANGE'; from?: string } // from a date you choose (and onward)

const DAY_MS = 24 * 60 * 60 * 1000

/** Turn the chosen option into the day the cost starts applying. */
export function resolveEffectiveFrom(choice: ApplyFrom, today: Date = new Date()): Date {
  const start = utcDay(today)

  switch (choice.apply) {
    case 'FUTURE':
      return start
    case 'LAST_60_DAYS':
      return new Date(start.getTime() - 60 * DAY_MS)
    case 'DATE_RANGE': {
      if (!choice.from) return start // no date given — don't guess, use today
      const picked = new Date(choice.from)
      return Number.isNaN(picked.getTime()) ? start : utcDay(picked)
    }
  }
}

export type CostChange = {
  costPerItem: number
  costFrom: Date
  handlingCost: number
  handlingFrom: Date
}

/**
 * Rebuild the timeline so that, from `costFrom` onward the new COGS applies, and from
 * `handlingFrom` onward the new handling cost applies — while every earlier date keeps
 * exactly the cost it already had.
 *
 * We do that by taking every date where anything changes (the old breakpoints plus the
 * two new ones) and writing a full snapshot of both costs at each. Two identical dates
 * collapse into one row, so saving twice on the same day updates rather than duplicates.
 */
export function applyCostChange(existing: CostRow[], change: CostChange): CostRow[] {
  const costFrom = utcDay(change.costFrom)
  const handlingFrom = utcDay(change.handlingFrom)

  const breakpoints = [...existing.map((r) => utcDay(r.effectiveFrom)), costFrom, handlingFrom]

  // One row per distinct day, in order.
  const days = [...new Set(breakpoints.map((d) => d.getTime()))].sort((a, b) => a - b)

  return days.map((time) => {
    const on = new Date(time)
    const before = costOn(existing, on) // what was true here before this change

    return {
      effectiveFrom: on,
      costPerItem: time >= costFrom.getTime() ? change.costPerItem : before.costPerItem,
      handlingCost: time >= handlingFrom.getTime() ? change.handlingCost : before.handlingCost,
    }
  })
}
