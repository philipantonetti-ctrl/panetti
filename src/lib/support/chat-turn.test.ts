import { describe, expect, it } from 'vitest'
import {
  askedSoFar, conversationStart, handoverLine, humanTookOver, NEW_CONVERSATION_GAP_MS, normalise, NO_OWN,
  REPLY_CAP, since, splitForJudge, superseded, turnsOf,
} from './chat-turn'
import type { TranscriptMessage } from './channel'

const m = (id: number, fromAgent: boolean, text: string): TranscriptMessage => ({
  id: String(id), fromAgent, text, at: `2026-09-09T10:00:${String(id).padStart(2, '0')}Z`,
})

describe('superseded', () => {
  it('is true when the customer wrote again after the message that woke us', () => {
    expect(superseded([m(1, false, 'hi'), m(2, false, 'where is my order'), m(3, false, '14689')], '2')).toBe(true)
  })
  it('is false when ours is the newest customer message, whatever the agents wrote after', () => {
    expect(superseded([m(1, false, 'hi'), m(2, false, 'where is my order'), m(3, true, 'One moment')], '2')).toBe(false)
  })
  it('falls back to numeric ids when the transcript does not yet hold our message', () => {
    expect(superseded([m(1, false, 'hi'), m(5, false, 'and?')], '4')).toBe(true)
    expect(superseded([m(1, false, 'hi'), m(3, false, 'and?')], '4')).toBe(false)
  })
})

describe('humanTookOver', () => {
  const own = { ids: new Set(['9001']), texts: new Set(['hej! jeg er panettis assistent.']) }

  it('knows its own reply by the id the channel gave it, whatever the text says', () => {
    // The text differs from anything we stored; only the id says it is ours.
    expect(humanTookOver([m(1, false, 'Hej'), m(9001, true, 'Ovnen gaar op til 450 grader.')], own)).toBe(false)
  })

  /**
   * The hand-over note hands an agent a suggested reply and invites them to
   * send it. Pasted verbatim, matching on text would read a person as us and
   * the assistant would keep writing in a chat a person is handling.
   */
  it('treats a person pasting our suggested reply as a person, because only SENT text is ours', () => {
    const drafted = { ...own, texts: new Set(['hej! jeg er panettis assistent.']) }
    expect(humanTookOver([m(1, false, 'Hej'), m(5, true, 'Pakken er afsendt i dag.')], drafted)).toBe(true)
  })

  it('ignores the assistant’s own replies by text too, whitespace and all', () => {
    expect(humanTookOver([m(1, false, 'Hej'), m(2, true, '  Hej!  Jeg er Panettis assistent. ')], own)).toBe(false)
  })
  it('is true the moment an agent message is not one of ours', () => {
    expect(humanTookOver([m(1, false, 'Hej'), m(2, true, 'Hej, Selena her. Hvad kan jeg hjælpe med?')], own)).toBe(true)
  })
  // Measured on 42 live chats, 2026-09-21: "Gorgias Bot" posts "Takk for at du tar kontakt! Vi er
  // tilbake om ca. 9 minutter." one millisecond after the customer's first message. Nobody is there.
  it("is false for the channel's own automatic line, which is nobody", () => {
    const bot = { ...m(2, true, 'Takk for at du tar kontakt! Vi er tilbake om ca. 9 minutter.'), automatic: true }
    expect(humanTookOver([m(1, false, 'Hei'), bot], own)).toBe(false)
    expect(humanTookOver([m(1, false, 'Hei'), bot, m(3, true, 'Hei, Selena her.')], own)).toBe(true)
  })
  it('is false with no agent message at all', () => {
    expect(humanTookOver([m(1, false, 'Hej')], own)).toBe(false)
  })
})

describe('turnsOf', () => {
  it("leaves the channel's automatic line out, so the model never thinks it promised nine minutes", () => {
    const bot = { ...m(2, true, 'Vi er tilbake om ca. 9 minutter.'), automatic: true }
    expect(turnsOf([m(1, false, 'Hei'), bot, m(3, false, 'Hvor varm blir ovnen?')])).toEqual([
      { role: 'user', text: 'Hei\nHvor varm blir ovnen?' },
    ])
  })
  /**
   * Some channels stamp a message we created through the API with the same
   * `via` as their own auto-replies. Dropped, the assistant loses its own
   * previous answers and re-answers the question it just answered.
   */
  it('keeps an automatic message that is OURS, so the assistant still sees what it said', () => {
    const own = { ids: new Set(['2']), texts: new Set<string>() }
    const ours = { ...m(2, true, 'Den gaar op til 450 grader.'), automatic: true }
    expect(turnsOf([m(1, false, 'Hvor varm?'), ours, m(3, false, 'Og hvor lang tid?')], own)).toEqual([
      { role: 'user', text: 'Hvor varm?' },
      { role: 'assistant', text: 'Den gaar op til 450 grader.' },
      { role: 'user', text: 'Og hvor lang tid?' },
    ])
  })

  it('joins consecutive customer messages into one turn and keeps the order', () => {
    expect(turnsOf([m(1, false, 'hi'), m(2, false, 'where is my order'), m(3, true, 'One moment'), m(4, false, '14689')])).toEqual([
      { role: 'user', text: 'hi\nwhere is my order' },
      { role: 'assistant', text: 'One moment' },
      { role: 'user', text: '14689' },
    ])
  })
  it('keeps only the last N turns', () => {
    const long: TranscriptMessage[] = []
    for (let i = 1; i <= 30; i++) long.push(m(i, i % 2 === 0, `t${i}`))
    expect(turnsOf(long, NO_OWN, 4)).toHaveLength(4)
    expect(turnsOf(long, NO_OWN, 4)[3].text).toBe('t30')
  })
  it('drops empty messages', () => {
    expect(turnsOf([m(1, false, ''), m(2, false, 'hi')])).toEqual([{ role: 'user', text: 'hi' }])
  })
})

describe('splitForJudge', () => {
  it('takes the final customer turn as the message and the rest as history', () => {
    const r = splitForJudge([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }, { role: 'user', text: 'where?' }], 'fallback')
    expect(r).toEqual({ history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }], message: 'where?' })
  })
  it('uses the delivered text when the transcript does not end with the customer', () => {
    expect(splitForJudge([{ role: 'assistant', text: 'hello' }], 'where?')).toEqual({ history: [{ role: 'assistant', text: 'hello' }], message: 'where?' })
    expect(splitForJudge([], 'where?')).toEqual({ history: [], message: 'where?' })
  })
})

describe('handoverLine', () => {
  it('speaks the customer’s language and falls back to English', () => {
    expect(handoverLine('da')).toMatch(/kollega/)
    expect(handoverLine('nb')).toMatch(/kollega/)
    expect(handoverLine('de')).toMatch(/Kolleg/)
    expect(handoverLine('xx')).toMatch(/colleague/)
    expect(handoverLine(null)).toMatch(/colleague/)
  })
})

/**
 * A Gorgias chat keeps ONE ticket for a visitor for ever. Measured on the live
 * account: ticket 241324637 carried the customer's question on 24 September,
 * four replies from a person, and then a new question on 25 September. Without
 * a boundary, every rule that asks "is a person on this chat" answers yes for
 * the rest of the shop's life.
 */
describe('conversationStart', () => {
  const at = (iso: string, id: number, fromAgent = false): TranscriptMessage =>
    ({ id: String(id), fromAgent, text: 'x', at: iso })

  it('is the first message when the chat ran without a long silence', () => {
    expect(conversationStart([at('2026-09-24T07:58:00Z', 1), at('2026-09-24T08:01:00Z', 2, true)]))
      .toBe('2026-09-24T07:58:00Z')
  })

  it('is the message after the silence, so yesterday is not this conversation', () => {
    expect(conversationStart([
      at('2026-09-24T07:58:00Z', 1), at('2026-09-24T08:10:00Z', 2, true), at('2026-09-25T09:21:00Z', 3),
    ])).toBe('2026-09-25T09:21:00Z')
  })

  it('takes the NEWEST silence, however many the ticket has', () => {
    expect(conversationStart([
      at('2026-09-20T09:00:00Z', 1), at('2026-09-24T07:58:00Z', 2), at('2026-09-25T09:21:00Z', 3),
    ])).toBe('2026-09-25T09:21:00Z')
  })

  it('is null for an empty transcript, so nothing can be released on a transcript we could not read', () => {
    expect(conversationStart([])).toBeNull()
  })

  it('will not break a chat over a time it cannot read', () => {
    expect(conversationStart([at('2026-09-24T07:58:00Z', 1), at('not a time', 2)])).toBe('2026-09-24T07:58:00Z')
  })

  it('is six hours, which is clear of how this helpdesk works', () => {
    // Measured over 380 live chat messages: 90% of a person's replies land
    // within 34 minutes of the message before, and 5 of 161 ever passed four
    // hours. Six hours cannot cut across anyone still answering.
    expect(NEW_CONVERSATION_GAP_MS).toBe(6 * 60 * 60_000)
  })
})

describe('since', () => {
  const at = (iso: string, id: number, fromAgent = false): TranscriptMessage =>
    ({ id: String(id), fromAgent, text: 'x', at: iso })

  it('keeps this conversation and drops the one before it', () => {
    const t = [at('2026-09-24T07:58:00Z', 1), at('2026-09-24T08:10:00Z', 2, true), at('2026-09-25T09:21:00Z', 3)]
    expect(since(t, '2026-09-25T09:21:00Z').map((m) => m.id)).toEqual(['3'])
    expect(humanTookOver(since(t, '2026-09-25T09:21:00Z'), NO_OWN)).toBe(false)
    expect(humanTookOver(t, NO_OWN)).toBe(true)
  })

  it('keeps everything when there is no start, and keeps a message whose time will not read', () => {
    const t = [at('2026-09-24T07:58:00Z', 1), at('rubbish', 2, true)]
    expect(since(t, null)).toHaveLength(2)
    expect(since(t, '2026-09-25T00:00:00Z').map((m) => m.id)).toEqual(['2'])
  })
})

describe('constants', () => {
  it('caps a chat at eight replies', () => expect(REPLY_CAP).toBe(8))
  it('normalises whitespace and case', () => expect(normalise('  Hej   du ')).toBe('hej du'))
})

describe('askedSoFar', () => {
  it("joins the customer's last three earlier turns and the new message, and never the assistant's", () => {
    const history = [
      { role: 'user' as const, text: 'one' }, { role: 'assistant' as const, text: 'Pizzetta Pro is great' },
      { role: 'user' as const, text: 'two' }, { role: 'user' as const, text: 'three' }, { role: 'user' as const, text: 'four' },
    ]
    expect(askedSoFar(history, 'five')).toBe('two\nthree\nfour\nfive')
    expect(askedSoFar([], 'five')).toBe('five')
  })
})
