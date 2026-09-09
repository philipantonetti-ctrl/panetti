import { fetchTicketMessages, gorgiasCredentials, GorgiasError, tagTicket, type GorgiasCredentials } from './client'
import type { Channel } from './channel'

/**
 * Gorgias as one channel among others.
 *
 * The only file in the support code that knows how to talk back to a helpdesk.
 * Everything above it works against the `Channel` interface, so replacing
 * Gorgias is writing a sibling of this file.
 *
 * Measured from their API reference: a message is created on the ticket with
 * `channel` and `from_agent`, and leaving `sent_datetime` out is what makes
 * Gorgias actually deliver it through the customer's own channel. `public:
 * false` makes it an internal note instead, seen only by agents.
 */

const REQUEST_TIMEOUT_MS = 20_000

async function post(creds: GorgiasCredentials, path: string, body: unknown): Promise<void> {
  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64')
  const res = await fetch(`https://${creds.domain}.gorgias.com/api/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new GorgiasError(`Gorgias responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
}

/**
 * Which Gorgias channel a reply goes out on.
 *
 * `via` is how the customer arrived; the reply channel is not always the same
 * word. A chat ticket reports via as `gorgias_chat` (the widget) or
 * `offline_capture` (the widget outside opening hours), and a message posted
 * on either of those names is refused: the channel is `chat`. Everything the
 * helpdesk itself made (`helpdesk`, `api`) is answered by email.
 */
export function replyChannelFor(via: string | null): string {
  if (!via || via === 'api' || via === 'helpdesk') return 'email'
  if (via === 'gorgias_chat' || via === 'offline_capture' || via === 'chat') return 'chat'
  return via
}

/**
 * @param via what the customer wrote in on. The reply goes back the same way,
 * so an Instagram message is not answered by email.
 */
export function gorgiasChannel(via: string | null = 'email'): Channel | null {
  const creds = gorgiasCredentials()
  if (!creds) return null

  // An internal note is always a note, whatever channel the customer used.
  const channel = replyChannelFor(via)

  return {
    name: 'gorgias',

    async sendMessage(conversationId, text) {
      await post(creds, `tickets/${conversationId}/messages`, {
        channel,
        from_agent: true,
        // Omitting sent_datetime is what asks Gorgias to deliver it rather
        // than merely record it.
        public: true,
        body_text: text,
        source: { type: channel },
      })
    },

    async addInternalNote(conversationId, text) {
      await post(creds, `tickets/${conversationId}/messages`, {
        channel: 'internal-note',
        from_agent: true,
        public: false,
        body_text: text,
      })
    },

    async transcript(conversationId) {
      const messages = await fetchTicketMessages(creds, conversationId)
      // `public: false` is an internal note between agents. Replaying one to
      // the model would let a note about a customer reach that customer.
      return messages
        .filter((m) => m.public !== false)
        .map((m) => ({
          id: String(m.id),
          fromAgent: m.from_agent === true,
          text: m.body_text ?? '',
          at: m.created_datetime ?? '',
        }))
    },

    async tag(conversationId, tag) {
      await tagTicket(creds, conversationId, tag)
    },
  }
}
