import { utcDay } from '../dates'
import type { CostPoint } from './types'

export type EffectiveCost = { costPerItem: number; handlingCost: number }

const ZERO: EffectiveCost = { costPerItem: 0, handlingCost: 0 }

/**
 * The cost that was true on `date`: the cost point with the latest
 * effectiveFrom that is on or before that day.
 *
 * If no cost was ever entered for that period the cost is ZERO — we never
 * guess. The UI flags zero-cost products so they get noticed, not hidden.
 */
export function costOn(history: CostPoint[], date: Date): EffectiveCost {
  const day = utcDay(date).getTime()

  let best: CostPoint | null = null
  for (const point of history) {
    const from = utcDay(point.effectiveFrom).getTime()
    if (from > day) continue
    if (!best || from > utcDay(best.effectiveFrom).getTime()) best = point
  }

  if (!best) return ZERO
  return { costPerItem: best.costPerItem, handlingCost: best.handlingCost }
}
