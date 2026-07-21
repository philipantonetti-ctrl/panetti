import { describe, it, expect } from 'vitest'
import { todayInZone, zoneDayEndUtc, zoneDayStartUtc, zonedDayStr } from './tz'

describe('timezone days', () => {
  it('an order just after midnight in Oslo belongs to the Oslo day, not the UTC day', () => {
    const d = new Date('2026-07-21T22:30:00Z') // 00:30 on the 22nd in Oslo (CEST)
    expect(zonedDayStr(d, 'Europe/Oslo')).toBe('2026-07-22')
    expect(zonedDayStr(d, 'UTC')).toBe('2026-07-21')
    expect(zonedDayStr(d, 'Europe/Helsinki')).toBe('2026-07-22') // 01:30
  })

  it('day boundaries in summer are 22:00 UTC the evening before', () => {
    expect(zoneDayStartUtc('2026-07-21', 'Europe/Oslo').toISOString()).toBe('2026-07-20T22:00:00.000Z')
    expect(zoneDayEndUtc('2026-07-21', 'Europe/Oslo').toISOString()).toBe('2026-07-21T21:59:59.999Z')
  })

  it('handles the DST switch days', () => {
    // 29 Mar 2026: clocks jump 02:00 -> 03:00. The day still starts at 00:00 CET.
    expect(zoneDayStartUtc('2026-03-29', 'Europe/Oslo').toISOString()).toBe('2026-03-28T23:00:00.000Z')
    // 25 Oct 2026: clocks fall back. The day starts at 00:00 CEST.
    expect(zoneDayStartUtc('2026-10-25', 'Europe/Oslo').toISOString()).toBe('2026-10-24T22:00:00.000Z')
    // And the day AFTER the fall-back starts on winter time again.
    expect(zoneDayStartUtc('2026-10-26', 'Europe/Oslo').toISOString()).toBe('2026-10-25T23:00:00.000Z')
  })

  it('todayInZone rolls to the next calendar day before UTC does', () => {
    const now = new Date('2026-07-21T23:30:00Z') // already 01:30 on the 22nd in Oslo
    expect(todayInZone('Europe/Oslo', now).toISOString()).toBe('2026-07-22T00:00:00.000Z')
    expect(todayInZone('UTC', now).toISOString()).toBe('2026-07-21T00:00:00.000Z')
  })
})
