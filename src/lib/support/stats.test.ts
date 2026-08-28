import { describe, expect, it } from 'vitest'
import { backlogHealth, supportStats, type StatTicket } from './stats'

const at = (s: string) => new Date(`${s}T00:00:00.000Z`)

const ticket = (over: Partial<StatTicket> = {}): StatTicket => ({
  status: 'closed',
  channel: 'email',
  language: 'no',
  tags: [],
  assigneeName: 'Ola Agent',
  spam: false,
  createdAt: at('2026-08-20'),
  closedAt: at('2026-08-21'),
  firstResponseAt: null,
  satisfaction: null,
  shop: 'Panetti Norway',
  ...over,
})

describe('supportStats', () => {
  it('counts what is open and what is closed', () => {
    const s = supportStats([ticket(), ticket({ closedAt: null }), ticket({ closedAt: null })])
    expect(s).toMatchObject({ tickets: 3, closed: 1, open: 2 })
  })

  it('takes the median time to close, not the average, and says how many it is made of', () => {
    const s = supportStats([
      ticket({ createdAt: at('2026-08-01'), closedAt: at('2026-08-02') }), // 24h
      ticket({ createdAt: at('2026-08-01'), closedAt: at('2026-08-03') }), // 48h
      ticket({ createdAt: at('2026-08-01'), closedAt: at('2026-08-31') }), // 720h, the outlier
    ])
    expect(s.medianResolutionHours).toBe(48)
    expect(s.resolutionSample).toBe(3)
  })

  /**
   * A ticket nobody measured is not a ticket answered instantly. Counting a
   * null as zero would report a response time the team never achieved.
   */
  it('leaves unmeasured tickets out of the response time rather than scoring them zero', () => {
    const s = supportStats([
      ticket({ createdAt: at('2026-08-01'), firstResponseAt: new Date('2026-08-01T02:00:00Z') }),
      ticket({ firstResponseAt: null }),
      ticket({ firstResponseAt: null }),
    ])
    expect(s.medianFirstResponseHours).toBe(2)
    expect(s.firstResponseSample).toBe(1)
  })

  it('reports nothing at all for a response time nobody has measured yet', () => {
    const s = supportStats([ticket(), ticket()])
    expect(s.medianFirstResponseHours).toBeNull()
    expect(s.firstResponseSample).toBe(0)
  })

  /** An unanswered survey is silence, and silence is not a bad score. */
  it('averages only the surveys a customer actually answered', () => {
    const s = supportStats([
      ticket({ satisfaction: 5 }),
      ticket({ satisfaction: 3 }),
      ticket({ satisfaction: null }),
    ])
    expect(s.csat).toBe(4)
    expect(s.csatSample).toBe(2)
  })

  /**
   * Spam is counted so a person can see it, and then kept out of everything:
   * left in it inflates the volume and drags the times toward tickets nobody
   * ever answered.
   */
  it('counts spam separately and excludes it from every other figure', () => {
    const s = supportStats([ticket(), ticket({ spam: true }), ticket({ spam: true })])
    expect(s.spam).toBe(2)
    expect(s.tickets).toBe(1)
    expect(s.byChannel).toEqual([{ key: 'email', tickets: 1 }])
  })

  it('breaks the volume down by channel, agent, language and shop, biggest first', () => {
    const s = supportStats([
      ticket({ channel: 'email', assigneeName: 'Ola', shop: 'Panetti Norway' }),
      ticket({ channel: 'email', assigneeName: 'Kari', shop: 'Panetti Norway' }),
      ticket({ channel: 'chat', assigneeName: 'Ola', shop: 'Mazzetti.no' }),
    ])
    expect(s.byChannel).toEqual([
      { key: 'email', tickets: 2 },
      { key: 'chat', tickets: 1 },
    ])
    expect(s.byAgent[0]).toEqual({ key: 'Ola', tickets: 2 })
    expect(s.byShop[0]).toEqual({ key: 'Panetti Norway', tickets: 2 })
  })

  it('counts a ticket once per tag it carries', () => {
    const s = supportStats([ticket({ tags: ['shipping', 'vip'] }), ticket({ tags: ['shipping'] })])
    expect(s.byTag).toEqual([
      { key: 'shipping', tickets: 2 },
      { key: 'vip', tickets: 1 },
    ])
  })

  it('leaves an unassigned or unknown value out of its breakdown rather than inventing a bucket', () => {
    const s = supportStats([ticket({ assigneeName: null, channel: null, shop: null })])
    expect(s.byAgent).toEqual([])
    expect(s.byChannel).toEqual([])
    expect(s.byShop).toEqual([])
  })

  it('gives the daily volume oldest first, for the chart', () => {
    const s = supportStats([
      ticket({ createdAt: at('2026-08-21') }),
      ticket({ createdAt: at('2026-08-20') }),
      ticket({ createdAt: at('2026-08-20') }),
    ])
    expect(s.perDay).toEqual([
      { day: '2026-08-20', tickets: 2 },
      { day: '2026-08-21', tickets: 1 },
    ])
  })

  it('is all zeroes and nulls for no tickets, never a divide by nothing', () => {
    const s = supportStats([])
    expect(s).toMatchObject({
      tickets: 0, open: 0, closed: 0,
      medianResolutionHours: null, p90ResolutionHours: null,
      medianFirstResponseHours: null, csat: null, busiestHour: null,
    })
    expect(s.perDay).toEqual([])
  })

  /**
   * The median says the typical customer was served in a day. The p90 says one
   * in ten waited a fortnight. Only the second one explains a bad review.
   */
  it('reports the slow tail beside the median, not just the middle', () => {
    const rows = [
      ...Array.from({ length: 9 }, () => ticket({ createdAt: at('2026-08-01'), closedAt: at('2026-08-02') })), // 24h
      ticket({ createdAt: at('2026-08-01'), closedAt: at('2026-08-15') }), // 336h
    ]
    const s = supportStats(rows)
    expect(s.medianResolutionHours).toBe(24)
    expect(s.p90ResolutionHours).toBe(24)
    expect(supportStats([...rows, ...rows.slice(9)]).p90ResolutionHours).toBe(336)
  })

  it('returns a duration a ticket really took, never an interpolation between two', () => {
    const s = supportStats([
      ticket({ createdAt: at('2026-08-01'), closedAt: at('2026-08-02') }), // 24h
      ticket({ createdAt: at('2026-08-01'), closedAt: at('2026-08-06') }), // 120h
    ])
    expect(s.p90ResolutionHours).toBe(120)
  })

  it('keeps the week in calendar order so it reads as days, not as a ranking', () => {
    // 2026-08-24 is a Monday.
    const s = supportStats([ticket({ createdAt: at('2026-08-26') }), ticket({ createdAt: at('2026-08-24') })])
    expect(s.byWeekday.map((d) => d.key)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(s.byWeekday.find((d) => d.key === 'Mon')?.tickets).toBe(1)
    expect(s.byWeekday.find((d) => d.key === 'Wed')?.tickets).toBe(1)
    expect(s.byWeekday.find((d) => d.key === 'Sun')?.tickets).toBe(0)
  })

  /**
   * Staffing is decided on the office clock. Read in UTC this ticket arrives
   * late on Wednesday; in Oslo it arrives on Thursday morning, which is the
   * shift that has to be covered.
   */
  it('reads the arrival day and hour on the workspace clock, not on UTC', () => {
    const lateWednesdayUtc = [ticket({ createdAt: new Date('2026-08-26T23:30:00Z') })]
    const utc = supportStats(lateWednesdayUtc)
    const oslo = supportStats(lateWednesdayUtc, 'Europe/Oslo')

    expect(utc.busiestHour).toBe(23)
    expect(utc.byWeekday.find((d) => d.key === 'Wed')?.tickets).toBe(1)

    expect(oslo.busiestHour).toBe(1)
    expect(oslo.byWeekday.find((d) => d.key === 'Thu')?.tickets).toBe(1)
    expect(oslo.perDay).toEqual([{ day: '2026-08-27', tickets: 1 }])
  })

  it('gives every hour of the day a slot, so a quiet hour is a gap and not a missing bar', () => {
    const s = supportStats([ticket({ createdAt: new Date('2026-08-20T09:15:00Z') })])
    expect(s.byHour).toHaveLength(24)
    expect(s.byHour[9]).toEqual({ hour: 9, tickets: 1 })
    expect(s.byHour[10]).toEqual({ hour: 10, tickets: 0 })
  })
})

/**
 * The backlog is the "are we behind" question, and it is deliberately not
 * windowed: the ticket that has been open since spring is the one that matters
 * most and the one a 90 day window drops.
 */
describe('backlogHealth', () => {
  const now = new Date('2026-08-28T12:00:00Z')

  it('counts what is waiting, how long the worst has waited, and the typical wait', () => {
    const b = backlogHealth(
      [
        { createdAt: new Date('2026-08-28T06:00:00Z') }, // 6h
        { createdAt: new Date('2026-08-27T12:00:00Z') }, // 24h
        { createdAt: new Date('2026-07-29T12:00:00Z') }, // 30 days
      ],
      now,
    )
    expect(b).toEqual({ open: 3, olderThanWeek: 1, oldestAgeDays: 30, medianAgeHours: 24 })
  })

  it('says nothing rather than zero when there is no backlog at all', () => {
    expect(backlogHealth([], now)).toEqual({
      open: 0,
      olderThanWeek: 0,
      oldestAgeDays: null,
      medianAgeHours: null,
    })
  })

  it('does not let a ticket dated in the future report a negative wait', () => {
    const b = backlogHealth([{ createdAt: new Date('2026-09-01T00:00:00Z') }], now)
    expect(b.open).toBe(1)
    expect(b.oldestAgeDays).toBeNull()
  })
})
