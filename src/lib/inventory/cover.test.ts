import { describe, expect, it } from 'vitest'
import { daysLeft, readAgo } from './cover'

const TODAY = new Date('2026-08-14T00:00:00Z')

describe('daysLeft', () => {
  it('counts whole days to the run-out date', () => {
    expect(daysLeft(new Date('2026-09-18T00:00:00Z'), TODAY)).toBe(35)
  })

  it('is null when there is no run-out date, because the row has nothing to count to', () => {
    expect(daysLeft(null, TODAY)).toBeNull()
  })

  it('is zero on the day it runs out, not one', () => {
    expect(daysLeft(TODAY, TODAY)).toBe(0)
  })

  it('is zero for a date already past, never negative', () => {
    // A run-out date in the past means it is gone, and "-6 days left" reads as
    // a countdown that is still running.
    expect(daysLeft(new Date('2026-08-08T00:00:00Z'), TODAY)).toBe(0)
  })

  it('ignores the time of day, because the forecast works in whole UTC days', () => {
    expect(daysLeft(new Date('2026-08-15T23:59:00Z'), TODAY)).toBe(1)
  })
})

describe('readAgo', () => {
  it('says never when no shop has reported', () => {
    expect(readAgo(null, TODAY)).toBe('never')
  })

  it('says just now within the hour', () => {
    expect(readAgo(new Date('2026-08-13T23:30:00Z'), TODAY)).toBe('just now')
  })

  it('counts hours inside a day', () => {
    expect(readAgo(new Date('2026-08-13T22:00:00Z'), TODAY)).toBe('2h ago')
  })

  it('counts days beyond that', () => {
    expect(readAgo(new Date('2026-08-11T00:00:00Z'), TODAY)).toBe('3d ago')
  })

  it('does not read a clock skew as the future', () => {
    // A shop's timestamp can land slightly ahead of ours. "-1h ago" is worse
    // than saying it is current.
    expect(readAgo(new Date('2026-08-14T00:30:00Z'), TODAY)).toBe('just now')
  })
})
