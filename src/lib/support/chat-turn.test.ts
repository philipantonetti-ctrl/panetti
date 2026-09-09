import { describe, expect, it } from 'vitest'
import {
  handoverLine, humanTookOver, normalise, REPLY_CAP, splitForJudge, superseded, turnsOf,
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
  const own = ['Hej! Jeg er Panettis assistent.']
  it('ignores the assistant’s own replies, whitespace and all', () => {
    expect(humanTookOver([m(1, false, 'Hej'), m(2, true, '  Hej!  Jeg er Panettis assistent. ')], own)).toBe(false)
  })
  it('is true the moment an agent message is not one of ours', () => {
    expect(humanTookOver([m(1, false, 'Hej'), m(2, true, 'Hej, Selena her. Hvad kan jeg hjælpe med?')], own)).toBe(true)
  })
  it('is false with no agent message at all', () => {
    expect(humanTookOver([m(1, false, 'Hej')], own)).toBe(false)
  })
})

describe('turnsOf', () => {
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
    expect(turnsOf(long, 4)).toHaveLength(4)
    expect(turnsOf(long, 4)[3].text).toBe('t30')
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

describe('constants', () => {
  it('caps a chat at eight replies', () => expect(REPLY_CAP).toBe(8))
  it('normalises whitespace and case', () => expect(normalise('  Hej   du ')).toBe('hej du'))
})
