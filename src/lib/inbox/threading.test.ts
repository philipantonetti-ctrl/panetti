import { describe, expect, it } from 'vitest'
import {
  headerValue, messageIdsIn, threadRefs, ticketNumberIn, ticketToken,
  replySubject, mintMessageId, isAutomated, spamScoreOf,
} from './threading'

const H = (pairs: [string, string][]) => pairs.map(([Name, Value]) => ({ Name, Value }))

describe('headerValue', () => {
  it('is case-insensitive on the name, because mailers disagree on it', () => {
    expect(headerValue(H([['message-id', '<a@x>']]), 'Message-ID')).toBe('<a@x>')
    expect(headerValue(H([]), 'Message-ID')).toBeNull()
  })
})

describe('messageIdsIn', () => {
  it('extracts every bracketed id, brackets stripped, in order', () => {
    expect(messageIdsIn('<a@x> <b@y>\r\n <c@z>')).toEqual(['a@x', 'b@y', 'c@z'])
  })
  it('accepts a bare id without brackets, which some clients send', () => {
    expect(messageIdsIn('a@x')).toEqual(['a@x'])
  })
  it('is empty for nothing', () => {
    expect(messageIdsIn(null)).toEqual([])
    expect(messageIdsIn('')).toEqual([])
  })
})

describe('threadRefs', () => {
  it('reads Message-ID, In-Reply-To and References from the header list', () => {
    const refs = threadRefs(H([
      ['Message-ID', '<c@gmail.com>'],
      ['In-Reply-To', '<b@panetti.no>'],
      ['References', '<a@gmail.com> <b@panetti.no>'],
    ]))
    expect(refs).toEqual({ messageId: 'c@gmail.com', inReplyTo: 'b@panetti.no', references: ['a@gmail.com', 'b@panetti.no'] })
  })
  it('is all-empty when the headers carry none', () => {
    expect(threadRefs(H([]))).toEqual({ messageId: null, inReplyTo: null, references: [] })
  })
})

describe('ticket token in the subject', () => {
  it('finds our own token anywhere in the subject', () => {
    expect(ticketNumberIn('Re: Where is my order [PA-1042]')).toBe(1042)
    expect(ticketNumberIn('Fwd: [PA-7] hello')).toBe(7)
  })
  it("ignores subjects without one, and other people's brackets", () => {
    expect(ticketNumberIn('Order #1042')).toBeNull()
    expect(ticketNumberIn('[Ticket 1042]')).toBeNull()
  })
  it('renders the token the same way it parses it', () => {
    expect(ticketNumberIn(`x ${ticketToken(1042)}`)).toBe(1042)
  })
})

describe('replySubject', () => {
  it('prefixes Re: once and appends the token once', () => {
    expect(replySubject('Where is my order?', 12)).toBe('Re: Where is my order? [PA-12]')
    expect(replySubject('Re: Where is my order? [PA-12]', 12)).toBe('Re: Where is my order? [PA-12]')
    expect(replySubject('RE: hello', 3)).toBe('RE: hello [PA-3]')
  })
  it('gives an empty subject something to thread on', () => {
    expect(replySubject('', 5)).toBe('Re: Your message [PA-5]')
  })
})

describe('mintMessageId', () => {
  it('is bracketed, carries the ticket number and the mailbox domain, and never repeats', () => {
    const a = mintMessageId(1042, 'support@panetti.no')
    const b = mintMessageId(1042, 'support@panetti.no')
    expect(a).toMatch(/^<pa1042\.[a-z0-9]+\.[a-f0-9]{8}@panetti\.no>$/)
    expect(a).not.toBe(b)
  })
})

describe('isAutomated', () => {
  it('flags out-of-office and bulk mail by the headers Zendesk suspends on', () => {
    expect(isAutomated(H([['Auto-Submitted', 'auto-replied']]))).toBe(true)
    expect(isAutomated(H([['Precedence', 'bulk']]))).toBe(true)
    expect(isAutomated(H([['X-Autoreply', 'yes']]))).toBe(true)
  })
  it('lets a human message through, including Auto-Submitted: no', () => {
    expect(isAutomated(H([['Auto-Submitted', 'no']]))).toBe(false)
    expect(isAutomated(H([]))).toBe(false)
  })
})

describe('spamScoreOf', () => {
  it("reads Postmark's SpamAssassin score", () => {
    expect(spamScoreOf(H([['X-Spam-Score', '7.3']]))).toBe(7.3)
    expect(spamScoreOf(H([['X-Spam-Score', '-0.1']]))).toBe(-0.1)
  })
  it('is null when absent or unreadable - unknown, not clean', () => {
    expect(spamScoreOf(H([]))).toBeNull()
    expect(spamScoreOf(H([['X-Spam-Score', 'n/a']]))).toBeNull()
  })
})
