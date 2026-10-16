import { describe, expect, it } from 'vitest'
import { vismaLabel } from './label'

const base = {
  settledAt: new Date('2026-10-06T08:00:00Z'), ingested: true, reference: 'R1', mapped: true, posting: null,
}

describe('vismaLabel', () => {
  it('explains why a payout is not posted', () => {
    expect(vismaLabel({ ...base, settledAt: null })).toBe('Waiting: not paid out yet')
    expect(vismaLabel({ ...base, settledAt: new Date('2026-09-20T08:00:00Z') })).toBe('Before 1 Oct')
    expect(vismaLabel({ ...base, ingested: false })).toBe('Waiting: report pending')
    expect(vismaLabel({ ...base, reference: null })).toBe('Waiting: no Dintero reference')
    expect(vismaLabel({ ...base, mapped: false })).toBe('Waiting: no Visma setup for this shop')
    expect(vismaLabel(base)).toBe('Ready')
  })
  it('states the posting outcome', () => {
    const p = (status: string, matched: number, unmatched: number, error: string | null = null) => ({
      ...base, posting: { status, matched, unmatched, error },
    })
    expect(vismaLabel(p('posted', 23, 0))).toBe('Posted to test: 23 of 23 orders settled')
    expect(vismaLabel(p('posted', 21, 2))).toBe('Posted to test: 21 of 23 orders settled, 2 left for Abacus')
    expect(vismaLabel(p('dry_run', 21, 2))).toBe('Dry run: 21 of 23 orders would settle')
    expect(vismaLabel(p('posting', 0, 0))).toBe('Posting to test')
    expect(vismaLabel(p('error', 0, 0, 'Cash account 1509 not found'))).toBe('Error: Cash account 1509 not found')
  })
})
