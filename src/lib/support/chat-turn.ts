import type { TranscriptMessage } from './channel'
import type { Turn } from './agent'

/**
 * The decisions a chat turn makes, with nothing to mock.
 *
 * A live chat differs from an email in three ways this file owns: messages
 * arrive in bursts ("hi" / "where is my order" / "14689"), a person can step
 * in at any moment, and the same conversation is replayed to the model as
 * turns. Everything here is pure so each rule is provable on its own.
 */

/** Replies per chat before the assistant hands over regardless. */
export const REPLY_CAP = 8

/** How long to let a burst finish before reading the whole of it. */
export const BURST_WAIT_MS = 6_000

/** How far back an agent message is still recognisable as the assistant's own. */
export const OWN_TEXT_WINDOW_MS = 15 * 60_000

/**
 * How long a chat has to be left alone before the next customer message is a
 * NEW conversation rather than the same one.
 *
 * A chat widget keeps one conversation for a visitor for ever. Gorgias ticket
 * 241324637 held the customer's question on 24 September, four replies from a
 * person, and then, on 25 September, a new question - and every rule that asks
 * "is a person on this chat" answered yes to the new question because of the
 * old one. The assistant was silent, and nothing anywhere said why.
 *
 * Six hours, and the number is measured rather than chosen: over the 380
 * newest live chat messages on this account, a person's reply came a median of
 * five minutes after the message before it, nine in ten inside thirty-four
 * minutes, and only five of a hundred and sixty-one ever passed four hours. A
 * silence this long cannot cut across anybody still answering.
 */
export const NEW_CONVERSATION_GAP_MS = 6 * 60 * 60_000

/** The one customer-visible line a handover sends, per language. */
export const HANDOVER_LINES: Record<string, string> = {
  da: 'Jeg henter en kollega, som hjælper dig videre. Et øjeblik.',
  nb: 'Jeg henter en kollega som hjelper deg videre. Et øyeblikk.',
  sv: 'Jag hämtar en kollega som hjälper dig vidare. Ett ögonblick.',
  fi: 'Haen kollegan auttamaan sinua. Hetki vain.',
  de: 'Ich hole eine Kollegin oder einen Kollegen, die Ihnen weiterhelfen. Einen Moment.',
  en: 'I am getting a colleague to help you. One moment.',
}

export function handoverLine(language: string | null): string {
  return HANDOVER_LINES[language ?? ''] ?? HANDOVER_LINES.en
}

/** Case and whitespace are not differences. */
export function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Did the customer write again after the message that woke this run?
 *
 * If so, the run that the later message started answers the whole burst and
 * this one stops. When the transcript does not yet hold our message (Gorgias
 * can lag its own webhook), ids are compared as numbers: they only go up.
 */
export function supersededBy(transcript: TranscriptMessage[], messageId: string): string | null {
  const ours = transcript.findIndex((m) => m.id === messageId)
  if (ours >= 0) return transcript.slice(ours + 1).find((m) => !m.fromAgent)?.id ?? null
  const mine = Number(messageId)
  if (!Number.isFinite(mine)) return null
  return transcript.find((m) => !m.fromAgent && Number(m.id) > mine)?.id ?? null
}

export function superseded(transcript: TranscriptMessage[], messageId: string): boolean {
  return supersededBy(transcript, messageId) !== null
}

/**
 * The agent messages on a chat that the assistant itself put there.
 *
 * `ids` is what the channel called each message we sent, and it is the real
 * answer: an id is exact, it never expires, and nobody else can write one.
 * `texts` is the fallback for a channel that numbers nothing, and it is
 * dangerous alone - a suggested reply is a text a PERSON may paste - so only
 * text the assistant actually SENT may go in it.
 */
export type OwnMessages = { ids: Set<string>; texts: Set<string> }

export const NO_OWN: OwnMessages = { ids: new Set(), texts: new Set() }

/** True when this agent message is one the assistant put there. */
export function isOurs(m: TranscriptMessage, own: OwnMessages): boolean {
  return own.ids.has(m.id) || own.texts.has(normalise(m.text))
}

/**
 * True when a customer-visible agent message is not one the assistant wrote.
 *
 * Three kinds of agent message are not a person. Ours, known by the id the
 * channel gave it. What the channel wrote by itself: on 2026-09-21 the
 * widget's "back in 9 minutes" line sat in 28 of 42 live chats, one
 * millisecond after the customer's first message, and would have silenced
 * every one of them. And, only where ids are unavailable, text we just sent.
 *
 * Everything else is a person, and a person ends the assistant's turn for good.
 */
export function humanTookOver(transcript: TranscriptMessage[], own: OwnMessages): boolean {
  return transcript.some((m) => m.fromAgent && !m.automatic && !isOurs(m, own))
}

/**
 * True when nobody but the customer has spoken in this stretch of chat: no
 * person, and not the assistant either. The channel's own automatic lines do
 * not count, because nobody wrote them.
 *
 * This is what makes a returning customer a NEW conversation rather than the
 * old one: a silence, and then the customer alone.
 */
export function onlyTheCustomer(transcript: TranscriptMessage[], own: OwnMessages): boolean {
  return !transcript.some((m) => m.fromAgent && (!m.automatic || isOurs(m, own)))
}

/**
 * The transcript as turns: customer messages are user turns, agent messages
 * are assistant turns, consecutive same-role messages joined, empty ones and
 * the channel's automatic lines dropped, and only the last `limit` turns kept.
 *
 * An automatic line that is OURS stays. Some channels stamp a message the
 * assistant created through the API with the same `via` as their own
 * auto-replies; dropping it would hide the assistant's previous answers from
 * itself, and it would re-answer the question it just answered.
 */
export function turnsOf(transcript: TranscriptMessage[], own: OwnMessages = NO_OWN, limit = 20): Turn[] {
  const turns: Turn[] = []
  for (const m of transcript) {
    const text = m.text.trim()
    if (!text || (m.automatic && !isOurs(m, own))) continue
    const role: Turn['role'] = m.fromAgent ? 'assistant' : 'user'
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.text = `${last.text}\n${text}`
    else turns.push({ role, text })
  }
  return turns.slice(-limit)
}

/**
 * What the judge is asked and what it is shown first. The final customer turn
 * is the question; when the transcript does not end with one, the text the
 * channel delivered is used instead, so a lagging transcript never means a
 * silent customer.
 */
export function splitForJudge(turns: Turn[], fallback: string): { history: Turn[]; message: string } {
  const last = turns[turns.length - 1]
  if (last && last.role === 'user') return { history: turns.slice(0, -1), message: last.text }
  return { history: turns, message: fallback }
}

/** How many of the customer's earlier turns retrieval reads. A chat is short; a "den" reaches about this far back. */
export const ASKED_TURNS = 3

/**
 * What retrieval looks for: the customer's earlier turns and then the new
 * message. "Hvor mange grader blir den?" names no product, but the message
 * before it did, and the model is shown that message anyway; the knowledge
 * base has to be searched for it too, or the follow-up is a hand-over.
 */
export function askedSoFar(history: Turn[], message: string): string {
  const earlier = history.filter((t) => t.role === 'user').slice(-ASKED_TURNS).map((t) => t.text)
  return [...earlier, message].join('\n')
}

/**
 * Where the conversation the customer is in NOW begins: the `at` of the first
 * message after the newest long silence, or the first message of the ticket
 * when it ran without one. Null for a transcript with nothing in it, which is
 * also what a transcript we could not read looks like - so a caller can never
 * mistake "I read nothing" for "this is a fresh conversation".
 *
 * A time the channel gives us that will not parse is not a boundary. Guessing
 * one would split a live conversation in half and let the assistant talk over
 * whoever is in it.
 */
export function conversationStart(
  transcript: TranscriptMessage[],
  gapMs = NEW_CONVERSATION_GAP_MS,
): string | null {
  if (transcript.length === 0) return null
  for (let i = transcript.length - 1; i > 0; i--) {
    const at = Date.parse(transcript[i].at)
    const before = Date.parse(transcript[i - 1].at)
    if (Number.isFinite(at) && Number.isFinite(before) && at - before >= gapMs) return transcript[i].at
  }
  return transcript[0].at
}

/**
 * The part of the transcript from `at` onwards. A message whose time will not
 * parse is kept: it might be a person, and everything this is used for is
 * safer with one message too many than one too few.
 */
export function since(transcript: TranscriptMessage[], at: string | null): TranscriptMessage[] {
  if (at === null) return transcript
  const from = Date.parse(at)
  if (!Number.isFinite(from)) return transcript
  return transcript.filter((m) => {
    const t = Date.parse(m.at)
    return !Number.isFinite(t) || t >= from
  })
}
