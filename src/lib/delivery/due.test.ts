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
 * The warehouse packs and files seven days a week, confirmed by the client on
 * 2026-08-20. So a weekend is not special: Saturday gets its own 18:00 file
 * like any other day, and a Friday afternoon order is expected in it.
 *
 * This was briefly built the other way, rolling weekends forward to Monday on
 * the assumption that no export comes off a Saturday. It does. None of the
 * client's six tabled rows touched a weekend, which is why the assumption was
 * not caught by them.
 */
describe('weekends, which the warehouse also works', () => {
  it('sends a Friday afternoon order to the Saturday file', () => {
    // Fri 2026-08-21 14:00 CEST, past the cutoff, so Saturday dispatches it.
    expect(due('2026-08-21T12:00:00Z')).toBe('2026-08-22T16:00:00.000Z')
  })

  it('keeps a Saturday morning order in the Saturday file', () => {
    // Sat 2026-08-22 09:00 CEST, before the cutoff, so it goes out that day.
    expect(due('2026-08-22T07:00:00Z')).toBe('2026-08-22T16:00:00.000Z')
  })

  it('sends a Sunday evening order to the Monday file', () => {
    // Sun 2026-08-23 20:00 CEST, past the cutoff, so Monday dispatches it.
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
    // Sun 2026-10-25 is the switch. 09:00Z is 10:00 in Oslo, which has already
    // moved to CET, so it is before the cutoff and dispatches the same day.
    expect(due('2026-10-25T09:00:00Z')).toBe('2026-10-25T17:00:00.000Z')
  })
})
