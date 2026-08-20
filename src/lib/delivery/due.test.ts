import { describe, expect, it } from 'vitest'
import { trackingDueAt } from './due'

const CET = 'Europe/Oslo'

/** The due instant as an ISO string, for an order placed at `iso`. */
const due = (iso: string) => trackingDueAt(new Date(iso), CET).toISOString()

/**
 * The client's own table, given 2026-08-20.
 *
 *   Customer order cutoff:     12:00 CET
 *   Warehouse tracking import: once daily at 18:00 CET
 *
 *   Order placed    Expected dispatch   First file it should appear in
 *   Aug 19, 09:00   Aug 19              Aug 19, 18:00
 *   Aug 19, 11:59   Aug 19              Aug 19, 18:00
 *   Aug 19, 12:01   Aug 20              Aug 20, 18:00
 *   Aug 19, 16:00   Aug 20              Aug 20, 18:00
 *   Aug 20, 10:00   Aug 20              Aug 20, 18:00
 *   Aug 20, 14:00   Aug 21              Aug 21, 18:00
 *
 * August is CEST, UTC+2, so 12:00 CET is 10:00Z and 18:00 CET is 16:00Z.
 * Written as UTC instants on purpose: that is what the database holds, and a
 * rule about local clock times has to survive the conversion.
 */
describe('trackingDueAt, against the rule as the client wrote it', () => {
  it('Aug 19 09:00 is expected in the Aug 19 file', () => {
    expect(due('2026-08-19T07:00:00Z')).toBe('2026-08-19T16:00:00.000Z')
  })

  it('Aug 19 11:59 is still expected in the Aug 19 file', () => {
    expect(due('2026-08-19T09:59:00Z')).toBe('2026-08-19T16:00:00.000Z')
  })

  it('Aug 19 12:01 slips to the Aug 20 file', () => {
    expect(due('2026-08-19T10:01:00Z')).toBe('2026-08-20T16:00:00.000Z')
  })

  it('Aug 19 16:00 is expected in the Aug 20 file', () => {
    expect(due('2026-08-19T14:00:00Z')).toBe('2026-08-20T16:00:00.000Z')
  })

  it('Aug 20 10:00 is expected in the Aug 20 file', () => {
    expect(due('2026-08-20T08:00:00Z')).toBe('2026-08-20T16:00:00.000Z')
  })

  it('Aug 20 14:00 is expected in the Aug 21 file', () => {
    expect(due('2026-08-20T12:00:00Z')).toBe('2026-08-21T16:00:00.000Z')
  })

  // The promise is "same day if ordered BEFORE 12:00", so noon itself is not
  // before it. Stated because an off-by-one here silently moves a whole day of
  // orders into the wrong file.
  it('treats 12:00:00 exactly as after the cutoff', () => {
    expect(due('2026-08-19T10:00:00Z')).toBe('2026-08-20T16:00:00.000Z')
  })

  it('treats 11:59:59 as before it', () => {
    expect(due('2026-08-19T09:59:59Z')).toBe('2026-08-19T16:00:00.000Z')
  })
})

/**
 * The warehouse is CLOSED Saturday and Sunday, and tracking links only come on
 * weekdays. Confirmed by the client in his own words on 2026-08-20:
 *
 *   "We only get tracking link week days"
 *   "Warehouse is closed saturdays and sundays"
 *
 * So a weekend produces no file at all, and an order that would have dispatched
 * into one waits for Monday's. None of the client's six tabled rows touch a
 * weekend, which is why this had to be asked rather than read off them.
 */
describe('weekends, which the warehouse is closed for', () => {
  it('sends a Friday afternoon order to the Monday file', () => {
    // Fri 2026-08-21 14:00 CEST. Dispatch would be Saturday; nobody is there.
    expect(due('2026-08-21T12:00:00Z')).toBe('2026-08-24T16:00:00.000Z')
  })

  it('sends a Saturday morning order to the Monday file', () => {
    // Sat 2026-08-22 09:00 CEST, before the cutoff, but the doors are shut.
    expect(due('2026-08-22T07:00:00Z')).toBe('2026-08-24T16:00:00.000Z')
  })

  it('sends a Sunday evening order to the Monday file', () => {
    expect(due('2026-08-23T18:00:00Z')).toBe('2026-08-24T16:00:00.000Z')
  })

  it('leaves a Friday morning order in the Friday file', () => {
    expect(due('2026-08-21T07:00:00Z')).toBe('2026-08-21T16:00:00.000Z')
  })
})

/**
 * The rule is written in local clock time, so it has to hold on both sides of
 * a daylight-saving switch. Europe/Oslo leaves CEST on 2026-10-25.
 */
describe('across the daylight-saving switch', () => {
  it('is 18:00 local in summer, which is 16:00 UTC', () => {
    expect(due('2026-08-19T07:00:00Z')).toBe('2026-08-19T16:00:00.000Z')
  })

  it('is 18:00 local in winter, which is 17:00 UTC', () => {
    // Mon 2026-11-02 09:00 CET (UTC+1).
    expect(due('2026-11-02T08:00:00Z')).toBe('2026-11-02T17:00:00.000Z')
  })

  it('is still 18:00 local on the day the clocks go back', () => {
    // Sun 2026-10-25 is the switch, and a Sunday, so the file is Monday the
    // 26th at 18:00 CET, by then UTC+1.
    expect(due('2026-10-25T09:00:00Z')).toBe('2026-10-26T17:00:00.000Z')
  })
})
