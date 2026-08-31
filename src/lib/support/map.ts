/**
 * Gorgias's wire shapes, turned into ours.
 *
 * Every field here was read off a real response from the live account on
 * 2026-08-28 rather than from the documentation, which was wrong about the
 * reporting endpoint and silent about several of these.
 *
 * The result is deliberately channel-agnostic: nothing downstream of this file
 * knows the word Gorgias. If the helpdesk is ever replaced, a second mapper is
 * written and the history, the reports and the AI all keep working.
 */

export type GorgiasTicket = {
  id: number
  status: string
  priority: string | null
  channel: string | null
  via: string | null
  language: string | null
  spam: boolean | null
  from_agent: boolean | null
  messages_count: number | null
  subject: string | null
  customer: { id?: number; email?: string | null; name?: string | null } | null
  assignee_user: { id?: number; email?: string | null; name?: string | null } | null
  tags: { name: string }[] | null
  created_datetime: string
  opened_datetime: string | null
  closed_datetime: string | null
  last_received_message_datetime: string | null
  last_message_datetime: string | null
  updated_datetime: string
}

export type GorgiasUser = {
  id: number
  email: string | null
  name: string | null
  active: boolean | null
  role: { name?: string | null } | null
  /** Gorgias keeps the profile photo here; the field is their flexible bag. */
  meta?: { profile_picture_url?: string | null } | null
}

export type MappedTicket = {
  source: string
  externalId: string
  status: string
  priority: string | null
  channel: string | null
  via: string | null
  subject: string | null
  language: string | null
  spam: boolean
  fromAgent: boolean
  messagesCount: number
  customerEmail: string | null
  customerName: string | null
  assigneeEmail: string | null
  assigneeName: string | null
  tags: string[]
  createdAt: Date
  openedAt: Date | null
  closedAt: Date | null
  lastCustomerMessageAt: Date | null
  lastMessageAt: Date | null
  updatedAt: Date
}

export const SOURCE = 'gorgias'

/** An empty string is not an address, and null is not a date. */
const text = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim()
  return s || null
}
const lower = (v: string | null | undefined): string | null => text(v)?.toLowerCase() ?? null
const date = (v: string | null | undefined): Date | null => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export function mapTicket(t: GorgiasTicket, source: string = SOURCE): MappedTicket {
  return {
    source,
    externalId: String(t.id),
    status: t.status,
    priority: text(t.priority),
    channel: text(t.channel),
    via: text(t.via),
    subject: text(t.subject),
    language: text(t.language),
    spam: t.spam === true,
    fromAgent: t.from_agent === true,
    messagesCount: t.messages_count ?? 0,
    // Lowercased because this is the join to Order.customerEmail, and mail is
    // not case sensitive while Postgres is.
    customerEmail: lower(t.customer?.email),
    customerName: text(t.customer?.name),
    assigneeEmail: lower(t.assignee_user?.email),
    assigneeName: text(t.assignee_user?.name),
    tags: (t.tags ?? []).map((tag) => tag.name).filter(Boolean),
    // created_datetime is the only timestamp Gorgias always sends; a ticket
    // without one cannot be placed in time at all, so the caller drops it.
    createdAt: date(t.created_datetime)!,
    openedAt: date(t.opened_datetime),
    closedAt: date(t.closed_datetime),
    lastCustomerMessageAt: date(t.last_received_message_datetime),
    lastMessageAt: date(t.last_message_datetime),
    updatedAt: date(t.updated_datetime) ?? date(t.created_datetime)!,
  }
}

export function mapAgent(u: GorgiasUser, source: string = SOURCE) {
  return {
    source,
    externalId: String(u.id),
    email: lower(u.email),
    name: text(u.name),
    // Gorgias's own answering bot appears in this list. Kept with its role so
    // "tickets per agent" can tell a person from a machine.
    role: text(u.role?.name),
    // The photo the helpdesk shows for them, so the Agents page can wear the
    // same faces. Their absence is a real state: initials render instead.
    avatarUrl: text(u.meta?.profile_picture_url),
    active: u.active !== false,
  }
}
