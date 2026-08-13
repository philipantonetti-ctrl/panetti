import { describe, expect, it } from 'vitest'
import { MAX_CHARS, trimTranscript, type Turn } from './trim'

/** One complete exchange: question, tool call, tool result, answer. */
function exchange(n: number, padding = ''): Turn[] {
  return [
    { role: 'user', content: `question ${n}` },
    { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'revenue', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: `{"cents":1}${padding}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] },
  ]
}

function idsOf(turns: Turn[], type: 'tool_use' | 'tool_result'): string[] {
  const ids: string[] = []
  for (const turn of turns) {
    if (!Array.isArray(turn.content)) continue
    for (const block of turn.content as { type: string; id?: string; tool_use_id?: string }[]) {
      if (block.type === type) ids.push((type === 'tool_use' ? block.id : block.tool_use_id) as string)
    }
  }
  return ids
}

function build(count: number, padding = ''): Turn[] {
  return Array.from({ length: count }, (_, i) => exchange(i, padding)).flat()
}

describe('trimTranscript', () => {
  it('leaves a short conversation exactly as it was', () => {
    const turns = build(3)
    expect(trimTranscript(turns)).toEqual(turns)
  })

  it('keeps only the last six exchanges', () => {
    const trimmed = trimTranscript(build(9))
    const questions = trimmed.filter((t) => t.role === 'user' && typeof t.content === 'string')
    expect(questions).toHaveLength(6)
    expect(questions[0].content).toBe('question 3')
    expect(questions[5].content).toBe('question 8')
  })

  // The one that matters. A naive slice(-n) passes every other test here and
  // then 400s in production, only for the person who has long conversations.
  it('never separates a tool_use from its tool_result', () => {
    const trimmed = trimTranscript(build(20))
    expect(idsOf(trimmed, 'tool_use')).toEqual(idsOf(trimmed, 'tool_result'))
    expect(idsOf(trimmed, 'tool_use')).not.toHaveLength(0)
  })

  it('always begins at the start of an exchange', () => {
    const trimmed = trimTranscript(build(9))
    expect(trimmed[0].role).toBe('user')
    expect(typeof trimmed[0].content).toBe('string')
  })

  it('drops whole exchanges until it is under the character ceiling', () => {
    // Three exchanges, each far over the ceiling on its own tool result.
    const trimmed = trimTranscript(build(3, 'x'.repeat(MAX_CHARS)))
    const questions = trimmed.filter((t) => t.role === 'user' && typeof t.content === 'string')
    expect(questions).toHaveLength(1)
    expect(questions[0].content).toBe('question 2')
  })

  it('keeps the newest exchange even when it alone exceeds the ceiling', () => {
    const trimmed = trimTranscript(exchange(0, 'x'.repeat(MAX_CHARS * 2)))
    expect(trimmed).toHaveLength(4)
    expect(idsOf(trimmed, 'tool_use')).toEqual(idsOf(trimmed, 'tool_result'))
  })

  it('discards anything before the first question', () => {
    const orphan: Turn[] = [{ role: 'assistant', content: [{ type: 'text', text: 'stray' }] }]
    const trimmed = trimTranscript([...orphan, ...exchange(1)])
    expect(trimmed[0].content).toBe('question 1')
  })

  it('returns a transcript with no questions unchanged', () => {
    const orphan: Turn[] = [{ role: 'assistant', content: [{ type: 'text', text: 'stray' }] }]
    expect(trimTranscript(orphan)).toEqual(orphan)
  })
})
