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

/**
 * @returns the id Gorgias gave the thing just created, when it says one.
 * Nothing depends on the rest of the answer, and a body we cannot read is not
 * a failed write, so an unreadable answer is a null id rather than a throw.
 */
async function post(creds: GorgiasCredentials, path: string, body: unknown): Promise<string | null> {
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
  const created = (await res.json().catch(() => null)) as { id?: number | string } | null
  return created?.id === undefined || created.id === null ? null : String(created.id)
}

/**
 * Who a chat reply is for.
 *
 * MEASURED on the live account 2026-09-25, and the last thing standing between
 * a correct answer and a customer reading it. A chat message Gorgias merely
 * FILES looks exactly like one it delivers: both answer 201. The difference is
 * the row afterwards. Ours came back
 *
 *     sent_datetime: null, integration_id: null, receiver: null
 *
 * and never reached the widget, while a reply a person sends carries the
 * widget's id, the customer as receiver, and the visitor's own chat address in
 * `source.to`. Sent with those three the same call came back with
 * `sent_datetime` set, and the line appeared in the chat (ticket 241516211).
 *
 * All three are read from the CUSTOMER's own message, which is the only place
 * that address exists. Null when there is none to read - a reply that is filed
 * is worth more than no reply at all, and the review row records what happened
 * either way.
 */
type ChatDestination = { widget: number; customer: number; visitor: string }

async function chatDestination(
  creds: GorgiasCredentials,
  conversationId: string,
): Promise<ChatDestination | null> {
  try {
    const messages = await fetchTicketMessages(creds, conversationId)
    const theirs = [...messages].reverse().find((m) => m.from_agent !== true && m.channel === 'chat')
    const widget = theirs?.integration_id ?? null
    const customer = theirs?.sender?.id ?? null
    const visitor = theirs?.source?.from?.address ?? null
    if (widget == null || customer == null || !visitor) return null
    return { widget, customer, visitor }
  } catch {
    return null
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
 * The routes only Gorgias itself writes on. Measured on 42 live chats,
 * 2026-09-21: all 99 agent messages written by a person arrived via
 * `helpdesk`; all 29 written by "Gorgias Bot" arrived via `gorgias_chat` (the
 * widget's "we are back in 9 minutes") or `rule` (a rule's auto-reply). An
 * agent does not type through the customer's widget, so an agent message that
 * came that way has no person behind it.
 */
const AUTOMATIC_VIAS = new Set(['gorgias_chat', 'rule'])

export function isAutomaticMessage(m: { from_agent: boolean | null; via: string | null }): boolean {
  return m.from_agent === true && AUTOMATIC_VIAS.has(m.via ?? '')
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
      // A chat reply has to be addressed to the visitor who wrote, or Gorgias
      // files it on the ticket and never delivers it. See `chatDestination`.
      const to = channel === 'chat' ? await chatDestination(creds, conversationId) : null
      return post(creds, `tickets/${conversationId}/messages`, {
        channel,
        from_agent: true,
        ...(to ? { integration_id: to.widget, receiver: { id: to.customer } } : {}),
        // Required. Measured against the live API on 2026-09-24: without it
        // Gorgias answers 400 `{"sender": ["Missing data for required
        // field."]}` and the customer gets nothing. The address is the
        // account the API key belongs to, which Gorgias resolves to its user.
        sender: { email: creds.email },
        // Omitting sent_datetime is what asks Gorgias to deliver it rather
        // than merely record it.
        public: true,
        body_text: text,
        source: to
          ? { type: channel, to: [{ name: '', address: to.visitor }], from: { name: '', address: '' } }
          : { type: channel },
      })
    },

    async addInternalNote(conversationId, text) {
      await post(creds, `tickets/${conversationId}/messages`, {
        channel: 'internal-note',
        from_agent: true,
        public: false,
        // A note is refused without a sender exactly as a reply is, so every
        // handover note failed too until this was measured.
        sender: { email: creds.email },
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
          automatic: isAutomaticMessage(m),
        }))
    },

    async tag(conversationId, tag) {
      await tagTicket(creds, conversationId, tag)
    },
  }
}
