import { describe, it, expect } from 'vitest'
import { expenseInRange } from './expenses'
import type { EngineExpense } from './types'

function make(over: Partial<EngineExpense> = {}): EngineExpense {
  return {
    id: 'e1',
    shopId: 's1',
    amount: 1400000, // 14 000 kr in øre
    currency: 'NOK',
    recurrence: 'MONTHLY',
    startDate: new Date('2026-01-01'),
    endDate: null,
    active: true,
    ...over,
  }
}

describe('expenseInRange', () => {
  it('spreads a monthly expense across the days of the month', () => {
    // July has 31 days -> 1400000/31 = 45161.29 øre/day. 7 days -> round(316129.03) = 316129.
    expect(expenseInRange(make(), new Date('2026-07-01'), new Date('2026-07-07'))).toBe(316129)
  })

  it('charges exactly the full amount when the whole month is selected — no øre lost', () => {
    expect(expenseInRange(make(), new Date('2026-07-01'), new Date('2026-07-31'))).toBe(1400000)
  })

  it('uses each month own length — February is not July', () => {
    expect(expenseInRange(make(), new Date('2026-02-01'), new Date('2026-02-28'))).toBe(1400000)
  })

  it('charges a daily expense once per day', () => {
    const e = make({ recurrence: 'DAILY', amount: 10000 })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-05'))).toBe(50000)
  })

  it('spreads a weekly expense over 7 days', () => {
    const e = make({ recurrence: 'WEEKLY', amount: 70000 })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-07'))).toBe(70000)
  })

  it('spreads a yearly expense over the days of that year', () => {
    // 2026 has 365 days. 36500000/365 = 100000 per day. 10 days -> 1000000.
    const e = make({ recurrence: 'YEARLY', amount: 36500000 })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-10'))).toBe(1000000)
  })

  it('charges a one-time expense only on its start date', () => {
    const e = make({ recurrence: 'ONE_TIME', amount: 500000, startDate: new Date('2026-07-05') })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-31'))).toBe(500000)
    expect(expenseInRange(e, new Date('2026-07-06'), new Date('2026-07-31'))).toBe(0)
    expect(expenseInRange(e, new Date('2026-07-05'), new Date('2026-07-05'))).toBe(500000)
  })

  it('charges nothing before the expense started', () => {
    const e = make({ startDate: new Date('2026-07-15') })
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-14'))).toBe(0)
  })

  it('charges only the days from its start when the range straddles the start date', () => {
    // Starts 15 Jul; range 1-31 Jul -> 17 chargeable days (15th..31st).
    const e = make({ startDate: new Date('2026-07-15') })
    const perDay = 1400000 / 31
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-31'))).toBe(Math.round(perDay * 17))
  })

  it('stops charging after the end date', () => {
    const e = make({ endDate: new Date('2026-07-10') })
    const perDay = 1400000 / 31
    expect(expenseInRange(e, new Date('2026-07-01'), new Date('2026-07-31'))).toBe(Math.round(perDay * 10))
  })

  it('charges nothing for an inactive expense', () => {
    expect(expenseInRange(make({ active: false }), new Date('2026-07-01'), new Date('2026-07-31'))).toBe(0)
  })
})
