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
export function superseded(transcript: TranscriptMessage[], messageId: string): boolean {
  const ours = transcript.findIndex((m) => m.id === messageId)
  if (ours >= 0) return transcript.slice(ours + 1).some((m) => !m.fromAgent)
  const mine = Number(messageId)
  if (!Number.isFinite(mine)) return false
  return transcript.some((m) => !m.fromAgent && Number(m.id) > mine)
}

/** True when a customer-visible agent message is not one the assistant wrote. */
export function humanTookOver(transcript: TranscriptMessage[], ownTexts: string[]): boolean {
  const own = new Set(ownTexts.map(normalise))
  return transcript.some((m) => m.fromAgent && !own.has(normalise(m.text)))
}

/**
 * The transcript as turns: customer messages are user turns, agent messages
 * are assistant turns, consecutive same-role messages joined, empty ones
 * dropped, and only the last `limit` turns kept.
 */
export function turnsOf(transcript: TranscriptMessage[], limit = 20): Turn[] {
  const turns: Turn[] = []
  for (const m of transcript) {
    const text = m.text.trim()
    if (!text) continue
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
