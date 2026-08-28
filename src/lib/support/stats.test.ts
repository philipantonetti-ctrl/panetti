import { describe, expect, it } from 'vitest'
import { supportStats, type StatTicket } from './stats'

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
      medianResolutionHours: null, medianFirstResponseHours: null, csat: null,
    })
    expect(s.perDay).toEqual([])
  })
})
