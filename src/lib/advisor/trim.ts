/**
 * Bounding the conversation sent back to the model.
 *
 * The transcript is not a flat list of messages: an assistant turn may carry
 * tool_use blocks, and the user turn after it carries the matching
 * tool_result blocks. Cutting between those two is a 400 from the API, so a
 * slice by message count is not safe at any length.
 *
 * Only a user turn whose content is a STRING starts a new exchange. Tool
 * results are user-role as well, which is exactly the trap: testing the role
 * alone finds boundaries that are not boundaries.
 */

export type Turn = { role: 'user' | 'assistant'; content: unknown }

/** Six question-and-answer rounds is enough for real follow-up. */
export const MAX_EXCHANGES = 6

/**
 * Roughly 15k tokens, about $0.075 of input per question at the ceiling.
 * Tool results are JSON and dominate the size, so this is the limit that
 * usually bites first — the exchange count is the backstop, not the reverse.
 */
export const MAX_CHARS = 60_000

function startsExchange(turn: Turn): boolean {
  return turn.role === 'user' && typeof turn.content === 'string'
}

export function trimTranscript(
  turns: Turn[],
  maxExchanges: number = MAX_EXCHANGES,
  maxChars: number = MAX_CHARS,
): Turn[] {
  const starts: number[] = []
  turns.forEach((turn, i) => {
    if (startsExchange(turn)) starts.push(i)
  })
  // Nothing that looks like a question: leave it alone rather than guess.
  if (starts.length === 0) return turns

  let first = Math.max(0, starts.length - maxExchanges)
  // Whole exchanges, never messages — and never the last one, however big,
  // because a conversation with no current question is worth nothing.
  while (
    first < starts.length - 1 &&
    JSON.stringify(turns.slice(starts[first])).length > maxChars
  ) {
    first++
  }

  return turns.slice(starts[first])
}
