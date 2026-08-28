import { describe, expect, it } from 'vitest'
import { mapAgent, mapTicket, type GorgiasTicket } from './map'

/**
 * Shapes taken from the live account on 2026-08-28, not from the docs: the
 * documented stats endpoint turned out not to match its own documentation, so
 * every field here was read off a real response.
 */
const ticket = (over: Partial<GorgiasTicket> = {}): GorgiasTicket => ({
  id: 236490307,
  status: 'closed',
  priority: 'normal',
  channel: 'email',
  via: 'email',
  language: 'no',
  spam: false,
  from_agent: false,
  messages_count: 4,
  subject: 'Hvor er pakken min?',
  customer: { id: 55, email: 'Kari@Example.com', name: 'Kari Olsen' },
  assignee_user: { id: 9, email: 'agent@ledendeteknologi.no', name: 'Ola Agent' },
  tags: [{ name: 'shipping' }, { name: 'vip' }],
  created_datetime: '2026-08-20T10:00:00+00:00',
  opened_datetime: '2026-08-20T10:00:05+00:00',
  closed_datetime: '2026-08-21T12:00:00+00:00',
  last_received_message_datetime: '2026-08-20T11:00:00+00:00',
  last_message_datetime: '2026-08-21T11:59:00+00:00',
  updated_datetime: '2026-08-21T12:00:00+00:00',
  ...over,
})

describe('mapTicket', () => {
  it('keeps what the reports are built from', () => {
    expect(mapTicket(ticket())).toMatchObject({
      source: 'gorgias',
      externalId: '236490307',
      status: 'closed',
      priority: 'normal',
      channel: 'email',
      subject: 'Hvor er pakken min?',
      language: 'no',
      spam: false,
      messagesCount: 4,
      customerName: 'Kari Olsen',
      assigneeEmail: 'agent@ledendeteknologi.no',
      assigneeName: 'Ola Agent',
      tags: ['shipping', 'vip'],
    })
  })

  /**
   * The customer's address is the join to our own orders, and mail is not case
   * sensitive. Stored lowercase so the match cannot fail on capitals alone.
   */
  it('lowercases the customer address, because that is the join to our orders', () => {
    expect(mapTicket(ticket()).customerEmail).toBe('kari@example.com')
  })

  it('reads every timestamp as a date', () => {
    const t = mapTicket(ticket())
    expect(t.createdAt.toISOString()).toBe('2026-08-20T10:00:00.000Z')
    expect(t.closedAt?.toISOString()).toBe('2026-08-21T12:00:00.000Z')
    expect(t.updatedAt.toISOString()).toBe('2026-08-21T12:00:00.000Z')
  })

  /**
   * An open ticket has no closing date, a chat has no subject, and a walk-in
   * has no customer. Null is the honest reading of each; a zero or an empty
   * string would be counted as a real value by everything downstream.
   */
  it('leaves what is genuinely absent as null rather than inventing it', () => {
    const t = mapTicket(
      ticket({
        status: 'open',
        closed_datetime: null,
        subject: null,
        customer: null,
        assignee_user: null,
        tags: [],
        language: null,
      }),
    )
    expect(t).toMatchObject({
      closedAt: null,
      subject: null,
      customerEmail: null,
      customerName: null,
      assigneeEmail: null,
      assigneeName: null,
      language: null,
      tags: [],
    })
  })

  it('marks spam, so it can be kept out of every count', () => {
    expect(mapTicket(ticket({ spam: true })).spam).toBe(true)
  })
})

describe('mapAgent', () => {
  it('keeps the people who answer tickets', () => {
    expect(
      mapAgent({
        id: 9,
        email: 'Agent@Ledendeteknologi.NO',
        name: 'Ola Agent',
        active: true,
        role: { name: 'agent' },
      }),
    ).toEqual({
      source: 'gorgias',
      externalId: '9',
      email: 'agent@ledendeteknologi.no',
      name: 'Ola Agent',
      role: 'agent',
      active: true,
    })
  })

  /**
   * Gorgias's own bot answers tickets and appears in this list. Kept, with its
   * role, so "tickets per agent" can tell a person from a machine rather than
   * quietly crediting a human with the bot's work.
   */
  it('keeps the bot, and says it is one', () => {
    const bot = mapAgent({ id: 1, email: 'bot@658d', name: 'AI Agent Bot', active: true, role: { name: 'bot' } })
    expect(bot.role).toBe('bot')
  })
})
