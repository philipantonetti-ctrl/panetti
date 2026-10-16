/** The Visma status shown per payout on Finance > Payouts. Pure. */

import { POSTING_START } from './run'

export type VismaLabelInput = {
  settledAt: Date | null
  ingested: boolean
  reference: string | null
  mapped: boolean
  posting: { status: string; matched: number; unmatched: number; error: string | null } | null
}

export function vismaLabel(i: VismaLabelInput): string {
  const p = i.posting
  if (p) {
    const total = p.matched + p.unmatched
    if (p.status === 'posted') {
      return p.unmatched === 0
        ? `Posted to test: ${p.matched} of ${total} orders settled`
        : `Posted to test: ${p.matched} of ${total} orders settled, ${p.unmatched} left for Abacus`
    }
    if (p.status === 'dry_run') return `Dry run: ${p.matched} of ${total} orders would settle`
    if (p.status === 'posting') return 'Posting to test'
    return `Error: ${p.error ?? 'unknown'}`
  }
  if (!i.settledAt) return 'Waiting: not paid out yet'
  if (i.settledAt < POSTING_START) return 'Before 1 Oct'
  if (!i.ingested) return 'Waiting: report pending'
  if (!i.reference) return 'Waiting: no Dintero reference'
  if (!i.mapped) return 'Waiting: no Visma setup for this shop'
  return 'Ready'
}
