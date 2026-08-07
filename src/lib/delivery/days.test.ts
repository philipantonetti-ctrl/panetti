import { describe, expect, it } from 'vitest'
import { addBusinessDays, addCalendarDays, daysBetween, deadlineFor, isBusinessDay } from './days'

describe('isBusinessDay', () => {
  it('counts Monday to Friday and no more', () => {
    expect(isBusinessDay('2026-08-03')).toBe(true) // Monday
    expect(isBusinessDay('2026-08-07')).toBe(true) // Friday
    expect(isBusinessDay('2026-08-08')).toBe(false) // Saturday
    expect(isBusinessDay('2026-08-09')).toBe(false) // Sunday
  })
})

describe('addBusinessDays', () => {
  it('steps over the weekend, which is the whole reason this exists', () => {
    // Friday + 3 business days = Wednesday, not Monday. Calendar days would
    // mark every Friday order late by Monday morning.
    expect(addBusinessDays('2026-08-07', 3)).toBe('2026-08-12')
  })

  it('starts counting from the next day, not the same one', () => {
    expect(addBusinessDays('2026-08-03', 1)).toBe('2026-08-04')
  })

  it('lands on Monday when a Saturday order gets one day', () => {
    expect(addBusinessDays('2026-08-08', 1)).toBe('2026-08-10')
  })

  it('returns the day itself for zero', () => {
    expect(addBusinessDays('2026-08-05', 0)).toBe('2026-08-05')
  })
})

describe('addCalendarDays', () => {
  it('does not skip the weekend', () => {
    expect(addCalendarDays('2026-08-07', 3)).toBe('2026-08-10')
  })

  it('crosses a month boundary', () => {
    expect(addCalendarDays('2026-08-30', 3)).toBe('2026-09-02')
  })
})

describe('deadlineFor', () => {
  const OSLO = 'Europe/Oslo'

  it('is the last instant of the due day in the shop timezone', () => {
    // Monday 3 Aug 10:00 Oslo + 3 business days = end of Thursday 6 Aug Oslo,
    // which is 21:59:59.999Z because Oslo is UTC+2 in August.
    const d = deadlineFor(new Date('2026-08-03T08:00:00Z'), 3, true, OSLO)
    expect(d.toISOString()).toBe('2026-08-06T21:59:59.999Z')
  })

  it('uses the order day as seen in the shop timezone, not in UTC', () => {
    // 23:30Z on Sunday is already Monday in Oslo, so the clock starts Monday.
    const d = deadlineFor(new Date('2026-08-02T23:30:00Z'), 1, true, OSLO)
    expect(d.toISOString()).toBe('2026-08-04T21:59:59.999Z')
  })

  it('honours a calendar-day promise', () => {
    const d = deadlineFor(new Date('2026-08-07T08:00:00Z'), 3, false, OSLO)
    expect(d.toISOString()).toBe('2026-08-10T21:59:59.999Z')
  })

  it('holds across the autumn DST change rather than drifting an hour', () => {
    // 25 Oct 2026 is the switch; Oslo is UTC+1 after it.
    const d = deadlineFor(new Date('2026-10-23T08:00:00Z'), 3, true, OSLO)
    expect(d.toISOString()).toBe('2026-10-28T22:59:59.999Z')
  })
})

describe('daysBetween', () => {
  it('counts calendar days elapsed in the shop timezone', () => {
    expect(daysBetween(
      new Date('2026-08-03T08:00:00Z'), new Date('2026-08-06T14:00:00Z'), 'Europe/Oslo',
    )).toBe(3)
  })

  it('is zero on the same day, however many hours apart', () => {
    expect(daysBetween(
      new Date('2026-08-03T06:00:00Z'), new Date('2026-08-03T20:00:00Z'), 'Europe/Oslo',
    )).toBe(0)
  })

  it('counts the day boundary as seen locally, not in UTC', () => {
    // 22:30Z on 3 Aug is already 4 Aug in Oslo.
    expect(daysBetween(
      new Date('2026-08-03T06:00:00Z'), new Date('2026-08-03T22:30:00Z'), 'Europe/Oslo',
    )).toBe(1)
  })
})
