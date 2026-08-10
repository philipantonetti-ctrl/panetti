import { deltaPct } from '../metrics/trend'
import type { Fact, FactKind, FactUnit } from './types'

/**
 * When a move is worth reporting.
 *
 * TWO gates, and both are needed. The percentage alone promotes noise: a small
 * market tripling on three orders would outrank a large one falling 12%. The
 * absolute size alone hides a real collapse in a small market, because it never
 * clears a threshold set for the big ones. Together they mean "it moved
 * meaningfully, AND the money involved matters".
 */
export const MIN_DELTA = 0.1
export const MIN_SHARE = 0.01
export const SATURATION_SHARE = 0.05

/**
 * 0..1, or null for "this is not a fact".
 *
 * `share` is what the move is worth as a fraction of the PREVIOUS window's
 * total revenue — the same frame for every shop, so a NOK store and a EUR one
 * are ranked against each other honestly.
 */
export function severityOf(delta: number | null, share: number): number | null {
  if (delta === null) return null
  if (Math.abs(delta) < MIN_DELTA) return null
  if (share < MIN_SHARE) return null
  return Math.min(share / SATURATION_SHARE, 1)
}

export type MovingFactArgs = {
  id: string
  kind: FactKind
  shopId: string | null
  shopName: string | null
  subject?: string | null
  current: number
  previous: number
  unit: FactUnit
  currency?: string
  /** What this move is worth, in the same currency as `baseline`. */
  impact: number
  /** The previous window's total revenue. Zero means there is nothing to
   *  compare against, so nothing here can be called material. */
  baseline: number
}

/** Build a fact, or null when it fails either gate. */
export function movingFact(args: MovingFactArgs): Fact | null {
  const delta = deltaPct(args.current, args.previous)
  const share = args.baseline > 0 ? Math.abs(args.impact) / args.baseline : 0
  const severity = severityOf(delta, share)
  if (severity === null) return null

  return {
    id: args.id,
    kind: args.kind,
    shopId: args.shopId,
    shopName: args.shopName,
    subject: args.subject ?? null,
    current: args.current,
    previous: args.previous,
    deltaPct: delta,
    unit: args.unit,
    severity,
    ...(args.currency ? { currency: args.currency } : {}),
  }
}
