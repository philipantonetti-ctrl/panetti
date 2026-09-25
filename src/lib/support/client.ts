import type { GorgiasTicket, GorgiasUser } from './map'

/**
 * Talking to Gorgias.
 *
 * Measured against the live account on 2026-08-28: Basic auth with the account
 * email and an API key, cursor pagination, and a rate limit of 40 requests per
 * 20 seconds reported back in `x-gorgias-account-api-call-limit`.
 *
 * The list endpoint takes NO date filter - only a cursor and an ordering - so
 * "everything since yesterday" is expressed as "newest first, stop when we
 * reach what we already have". That is why the sync carries a watermark
 * rather than a query.
 */

export type GorgiasCredentials = { domain: string; email: string; apiKey: string }

/** Unset means not connected, which is a state and not an error. */
export function gorgiasCredentials(): GorgiasCredentials | null {
  const domain = process.env.GORGIAS_DOMAIN?.trim()
  const email = process.env.GORGIAS_EMAIL?.trim()
  const apiKey = process.env.GORGIAS_API_KEY?.trim()
  if (!domain || !email || !apiKey) return null
  return { domain, email, apiKey }
}

/**
 * One request in twenty is the documented ceiling of 40 per 20 seconds. Half
 * of it is taken deliberately: this runs beside the WooCommerce, Visma and
 * Bring stages in one cron, and a burst that earns a 429 would cost the whole
 * import rather than one page.
 */
export const PAGE_PAUSE_MS = 1_000

const REQUEST_TIMEOUT_MS = 20_000

export class GorgiasError extends Error {}

/** Never longer than the run has left. Floors at 1ms so the caller's deadline decides. */
function budgetMs(deadline?: number): number {
  if (deadline === undefined) return REQUEST_TIMEOUT_MS
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
}

async function get<T>(
  creds: GorgiasCredentials,
  path: string,
  params: Record<string, string>,
  deadline?: number,
): Promise<{ data: T[]; nextCursor: string | null }> {
  const url = new URL(`https://${creds.domain}.gorgias.com/api/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64')
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(budgetMs(deadline)),
  })

  if (res.status === 429) {
    // Named, so a caller can stop the whole import cleanly rather than
    // hammering a door that has just been shut.
    throw new GorgiasError(`Gorgias rate limit reached; retry after ${res.headers.get('retry-after') ?? '?'}s`)
  }
  if (!res.ok) {
    throw new GorgiasError(`Gorgias responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }

  const body = (await res.json()) as { data?: T[]; meta?: { next_cursor?: string | null } }
  return { data: body.data ?? [], nextCursor: body.meta?.next_cursor ?? null }
}

/** One page of tickets. `order` decides which end of history it reads from. */
export function fetchTickets(
  creds: GorgiasCredentials,
  opts: { order: 'created_datetime:asc' | 'updated_datetime:desc'; cursor?: string | null; limit?: number },
  deadline?: number,
) {
  return get<GorgiasTicket>(
    creds,
    'tickets',
    {
      limit: String(opts.limit ?? 100),
      order_by: opts.order,
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    },
    deadline,
  )
}

export function fetchUsers(creds: GorgiasCredentials, cursor?: string | null, deadline?: number) {
  return get<GorgiasUser>(creds, 'users', { limit: '100', ...(cursor ? { cursor } : {}) }, deadline)
}

export type GorgiasSurvey = { ticket_id: number; score: number | null; scored_datetime: string | null }

export function fetchSurveys(creds: GorgiasCredentials, cursor?: string | null, deadline?: number) {
  return get<GorgiasSurvey>(creds, 'satisfaction-surveys', { limit: '100', ...(cursor ? { cursor } : {}) }, deadline)
}

/** The thin cut of a message the Agents page needs: who, when, which ticket. */
export type GorgiasMessage = {
  id: number
  ticket_id: number | null
  from_agent: boolean | null
  public: boolean | null
  sender: { id?: number | null; name?: string | null } | null
  created_datetime: string | null
}

/**
 * Account-wide, newest first - like the ticket list, this endpoint has no
 * date filter, so "the last year" is expressed as "walk until you reach it".
 */
export function fetchMessages(creds: GorgiasCredentials, cursor?: string | null, deadline?: number) {
  return get<GorgiasMessage>(
    creds,
    'messages',
    { limit: '100', order_by: 'created_datetime:desc', ...(cursor ? { cursor } : {}) },
    deadline,
  )
}

/** One message of one ticket, as the chat turn reads it. */
export type GorgiasTicketMessage = {
  id: number
  from_agent: boolean | null
  public: boolean | null
  channel: string | null
  via: string | null
  body_text: string | null
  created_datetime: string | null
  sender: { id?: number | null; name?: string | null; email?: string | null } | null
  /** The integration it travelled through. In a chat, every message carries the widget's id. */
  integration_id?: number | null
  /**
   * Where it came from and went to. On a chat message from the customer,
   * `from.address` is that visitor's own chat address - the only place it
   * exists, and what a reply has to be addressed to.
   */
  source?: {
    from?: { address?: string | null } | null
    to?: { address?: string | null }[] | null
  } | null
}

/** One chat widget of the account, as the settings page offers it. */
export type GorgiasChatWidget = { id: string; name: string; language: string | null }

type GorgiasIntegration = {
  id: number
  type: string | null
  name: string | null
  deactivated_datetime: string | null
  meta: { language?: string | null } | null
}

/**
 * The account's live chat widgets. One Gorgias account serves every shop, so
 * "Panetti" exists five times over and only the language tells them apart.
 */
export async function fetchChatWidgets(creds: GorgiasCredentials, deadline?: number): Promise<GorgiasChatWidget[]> {
  const out: GorgiasChatWidget[] = []
  let cursor: string | null = null
  for (let page = 0; page < 5; page++) {
    const params: Record<string, string> = { limit: '100', ...(cursor ? { cursor } : {}) }
    const { data, nextCursor }: { data: GorgiasIntegration[]; nextCursor: string | null } =
      await get<GorgiasIntegration>(creds, 'integrations', params, deadline)
    for (const i of data) {
      if (i.type !== 'gorgias_chat' || i.deactivated_datetime) continue
      out.push({ id: String(i.id), name: i.name ?? 'Chat', language: i.meta?.language ?? null })
    }
    if (!nextCursor) break
    cursor = nextCursor
  }
  return out
}

/** Pages a chat can run to. Three hundred messages is a very long chat. */
const TICKET_MESSAGE_PAGES = 3

/**
 * Every message of one ticket, oldest first.
 *
 * `GET /api/messages?ticket_id=…`, NOT `GET /api/tickets/{id}/messages`:
 * Gorgias's reference marks the ticket-scoped one deprecated and says to use
 * this instead. The two answer the same `{ data, meta.next_cursor }` envelope,
 * so the only difference is which of them Gorgias intends to keep.
 *
 * This is also where the webhook learns what an HTTP integration cannot tell
 * it - the message's id, its text, and whether an agent wrote it - because
 * Gorgias documents no `message` template scope. Those three are documented
 * fields of the TicketMessage object, so they are read from here instead of
 * guessed into a template someone pastes by hand.
 *
 * Oldest first because the chat turn replays it as a conversation.
 */
export async function fetchTicketMessages(
  creds: GorgiasCredentials,
  ticketId: string,
  deadline?: number,
): Promise<GorgiasTicketMessage[]> {
  const out: GorgiasTicketMessage[] = []
  let cursor: string | null = null
  for (let page = 0; page < TICKET_MESSAGE_PAGES; page++) {
    const params: Record<string, string> = {
      ticket_id: ticketId,
      limit: '100',
      order_by: 'created_datetime:asc',
    }
    if (cursor) params.cursor = cursor
    const { data, nextCursor }: { data: GorgiasTicketMessage[]; nextCursor: string | null } =
      await get<GorgiasTicketMessage>(creds, 'messages', params, deadline)
    out.push(...data)
    if (!nextCursor) break
    cursor = nextCursor
  }
  return out
}

async function request<T>(
  creds: GorgiasCredentials,
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64')
  const res = await fetch(`https://${creds.domain}.gorgias.com/api/${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new GorgiasError(`Gorgias responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

/**
 * Mark a ticket for the people. Read first: `PUT /api/tickets/{id}` replaces
 * the tag set, and a handover must not strip the tags the agents put there.
 */
export async function tagTicket(creds: GorgiasCredentials, ticketId: string, tag: string): Promise<void> {
  const id = encodeURIComponent(ticketId)
  const current = await request<{ tags?: { name: string }[] | null }>(creds, 'GET', `tickets/${id}`)
  const names = (current.tags ?? []).map((t) => t.name)
  if (!names.includes(tag)) names.push(tag)
  await request(creds, 'PUT', `tickets/${id}`, { tags: names.map((name) => ({ name })) })
}
