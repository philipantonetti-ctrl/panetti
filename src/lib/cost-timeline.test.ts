import { describe, it, expect } from 'vitest'
import { resolveEffectiveFrom, applyCostChange, type CostRow } from './cost-timeline'
import { costOn } from './metrics/costs'

const day = (d: Date) => d.toISOString().slice(0, 10)
const TODAY = new Date('2026-07-14')

/**
 * "When should this cost apply from?" — the three choices in the Update COGS modal.
 */
describe('resolveEffectiveFrom', () => {
  it('applies to future orders only — from today', () => {
    expect(day(resolveEffectiveFrom({ apply: 'FUTURE' }, TODAY))).toBe('2026-07-14')
  })

  it('applies to the last 60 days — from 60 days ago', () => {
    expect(day(resolveEffectiveFrom({ apply: 'LAST_60_DAYS' }, TODAY))).toBe('2026-05-15')
  })

  it('applies from a chosen date', () => {
    expect(day(resolveEffectiveFrom({ apply: 'DATE_RANGE', from: '2026-03-01' }, TODAY))).toBe('2026-03-01')
  })

  it('falls back to today when a date was asked for but not given', () => {
    expect(day(resolveEffectiveFrom({ apply: 'DATE_RANGE' }, TODAY))).toBe('2026-07-14')
  })
})

/**
 * COGS and handling each get their OWN apply-from date (step 1/2 and 2/2 of the modal).
 * The stored timeline must end up telling the truth for BOTH, at every date.
 */
describe('applyCostChange', () => {
  const existing: CostRow[] = [
    { costPerItem: 10000, handlingCost: 100, effectiveFrom: new Date('2026-01-01') },
  ]

  it('adds one point when both costs apply from the same date', () => {
    const rows = applyCostChange(existing, {
      costPerItem: 12000,
      costFrom: new Date('2026-06-01'),
      handlingCost: 200,
      handlingFrom: new Date('2026-06-01'),
    })

    expect(rows).toHaveLength(2)
    expect(day(rows[1].effectiveFrom)).toBe('2026-06-01')
    expect(rows[1]).toMatchObject({ costPerItem: 12000, handlingCost: 200 })
  })

  it('keeps each cost on its own date when the two dates differ', () => {
    // New COGS from June, but the new handling cost from March.
    const rows = applyCostChange(existing, {
      costPerItem: 12000,
      costFrom: new Date('2026-06-01'),
      handlingCost: 200,
      handlingFrom: new Date('2026-03-01'),
    })

    // February: still the old cost and old handling.
    expect(costOn(rows, new Date('2026-02-15'))).toEqual({ costPerItem: 10000, handlingCost: 100 })
    // April: old COGS, but the NEW handling (it started in March).
    expect(costOn(rows, new Date('2026-04-15'))).toEqual({ costPerItem: 10000, handlingCost: 200 })
    // July: both new.
    expect(costOn(rows, new Date('2026-07-15'))).toEqual({ costPerItem: 12000, handlingCost: 200 })
  })

  it('never rewrites what an older order already cost', () => {
    const rows = applyCostChange(existing, {
      costPerItem: 99999,
      costFrom: new Date('2026-06-01'),
      handlingCost: 999,
      handlingFrom: new Date('2026-06-01'),
    })
    // An order from March keeps the cost that was true in March.
    expect(costOn(rows, new Date('2026-03-10'))).toEqual({ costPerItem: 10000, handlingCost: 100 })
  })

  it('starts a timeline from nothing', () => {
    const rows = applyCostChange([], {
      costPerItem: 5000,
      costFrom: new Date('2026-03-01'),
      handlingCost: 50,
      handlingFrom: new Date('2026-03-01'),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ costPerItem: 5000, handlingCost: 50 })
  })

  it('leaves a cost at zero for dates before it was ever known — never guesses', () => {
    const rows = applyCostChange([], {
      costPerItem: 5000,
      costFrom: new Date('2026-06-01'),
      handlingCost: 50,
      handlingFrom: new Date('2026-03-01'),
    })
    // Handling known from March, COGS only from June.
    expect(costOn(rows, new Date('2026-04-01'))).toEqual({ costPerItem: 0, handlingCost: 50 })
    expect(costOn(rows, new Date('2026-06-15'))).toEqual({ costPerItem: 5000, handlingCost: 50 })
  })

  it('updates in place rather than stacking duplicates on the same day', () => {
    const once = applyCostChange(existing, {
      costPerItem: 12000, costFrom: new Date('2026-06-01'),
      handlingCost: 200, handlingFrom: new Date('2026-06-01'),
    })
    const twice = applyCostChange(once, {
      costPerItem: 13000, costFrom: new Date('2026-06-01'),
      handlingCost: 300, handlingFrom: new Date('2026-06-01'),
    })

    expect(twice).toHaveLength(2) // still Jan + June, not three rows
    expect(costOn(twice, new Date('2026-07-01'))).toEqual({ costPerItem: 13000, handlingCost: 300 })
  })

  it('returns the timeline in date order', () => {
    const rows = applyCostChange(existing, {
      costPerItem: 12000, costFrom: new Date('2026-06-01'),
      handlingCost: 200, handlingFrom: new Date('2026-03-01'),
    })
    const dates = rows.map((r) => r.effectiveFrom.getTime())
    expect([...dates].sort((a, b) => a - b)).toEqual(dates)
  })
})
