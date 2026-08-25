'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { useLiveTick } from '@/lib/use-live-tick'
import { formatMoney } from '@/lib/money'
import { hasMissingMarker, renderMacro } from '@/lib/inbox/macros'
import type { CustomerContext, OrderSummary } from '@/lib/inbox/context'

export type MailboxOption = { id: string; address: string; name: string; language: string }
export type UserOption = { id: string; email: string }
export type MacroOption = { id: string; name: string; language: string; body: string }

type TicketRow = {
  id: string
  number: number
  subject: string
  status: string
  priority: string
  customerEmail: string
  customerName: string
  tags: string[]
  category: string | null
  mailbox: string
  mailboxName: string
  assignee: { id: string; email: string } | null
  lastMessageAt: string
}

type Message = {
  id: string
  direction: 'INBOUND' | 'OUTBOUND' | 'NOTE'
  author: string | null
  fromEmail: string
  toEmail: string
  text: string
  fullText: string
  sentAt: string
  spamScore: number | null
  attachments: { id: string; filename: string; contentType: string; sizeBytes: number }[]
}

type Detail = {
  ticket: TicketRow & {
    language: string
    languageDetected: boolean
    mailbox: { id: string; address: string; name: string; language: string; shopId: string | null }
    matchedOrder: { id: string; number: string } | null
  }
  messages: Message[]
  context: CustomerContext
}

const STATUSES = ['OPEN', 'PENDING', 'CLOSED'] as const
const STATUS_LABEL: Record<string, string> = { OPEN: 'Open', PENDING: 'Pending', CLOSED: 'Closed' }

const day = (iso: string) => iso.slice(0, 10)

/** Skeleton in the shape of the content - never a spinner in a table. */
function ListSkeleton() {
  return <div className="skeleton h-[200px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
}

export function InboxClient({
  me,
  mailboxes,
  users,
  macros,
}: {
  me: { id: string; email: string }
  mailboxes: MailboxOption[]
  users: UserOption[]
  macros: MacroOption[]
}) {
  const toast = useToast()
  const tick = useLiveTick()

  const [status, setStatus] = useState<(typeof STATUSES)[number]>('OPEN')
  const [mailboxId, setMailboxId] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [q, setQ] = useState('')
  const [tickets, setTickets] = useState<TicketRow[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [composerKind, setComposerKind] = useState<'reply' | 'note'>('reply')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const loadList = useCallback(
    (signal?: AbortSignal) => {
      const params = new URLSearchParams({ status })
      if (mailboxId) params.set('mailboxId', mailboxId)
      if (assigneeId) params.set('assigneeId', assigneeId)
      if (q.trim()) params.set('q', q.trim())
      return fetch(`/api/inbox/tickets?${params}`, { signal })
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load the inbox')
          return res.json() as Promise<{ tickets: TicketRow[] }>
        })
        .then((json) => {
          setTickets(json.tickets)
          setError('')
        })
        .catch((e: Error) => {
          if (e.name !== 'AbortError') setError(e.message)
        })
    },
    [status, mailboxId, assigneeId, q],
  )

  useEffect(() => {
    const ctrl = new AbortController()
    void loadList(ctrl.signal)
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [loadList, tick])

  const loadDetail = useCallback((id: string, signal?: AbortSignal) => {
    return fetch(`/api/inbox/tickets/${id}`, { signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load the ticket')
        return res.json() as Promise<Detail>
      })
      .then(setDetail)
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
  }, [])

  useEffect(() => {
    if (!selectedId) return
    const ctrl = new AbortController()
    void loadDetail(selectedId, ctrl.signal)
    return () => ctrl.abort()
  }, [selectedId, loadDetail])

  async function patchTicket(fields: Record<string, unknown>) {
    if (!selectedId) return
    const res = await fetch(`/api/inbox/tickets/${selectedId}`, { method: 'PATCH', body: JSON.stringify(fields) })
    if (!res.ok) {
      toast.error((await res.json()).error ?? 'Could not update the ticket')
      return
    }
    await Promise.all([loadDetail(selectedId), loadList()])
  }

  async function send() {
    if (!selectedId || !text.trim() || sending) return
    setSending(true)
    try {
      const res = await fetch(`/api/inbox/tickets/${selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ kind: composerKind, text }),
      })
      if (!res.ok) {
        toast.error((await res.json()).error ?? 'Could not save the message')
        return
      }
      toast.success(composerKind === 'reply' ? 'Reply sent' : 'Note added')
      setText('')
      await Promise.all([loadDetail(selectedId), loadList()])
    } finally {
      setSending(false)
    }
  }

  const matchedSummary: OrderSummary | null = useMemo(() => {
    if (!detail) return null
    const id = detail.ticket.matchedOrder?.id
    return (id && detail.context.orders.find((o) => o.id === id)) || null
  }, [detail])

  function insertMacro(macroId: string) {
    if (!detail) return
    const macro = macros.find((m) => m.id === macroId)
    if (!macro) return
    const firstName = detail.ticket.customerName.trim().split(/\s+/)[0] || null
    const r = renderMacro(macro.body, {
      customer_name: firstName,
      order_number: detail.ticket.matchedOrder?.number ?? null,
      tracking_number: matchedSummary?.parcels[0]?.number ?? null,
      product_name: matchedSummary?.products.map((p) => p.name).join(', ') || null,
      delivery_status: matchedSummary?.deliveryPhrase ?? null,
      agent_name: me.email.split('@')[0],
      brand_name: detail.ticket.mailbox.name,
    })
    // Appended, never replacing: half-typed words are the agent's, not ours.
    setText((t) => (t.trim() ? `${t}\n${r.text}` : r.text))
  }

  const missing = useMemo(() => {
    const names = [...text.matchAll(/⟪([a-z_]+)⟫/gi)].map((m) => m[1])
    return [...new Set(names)]
  }, [text])

  const macroChoices = useMemo(() => {
    if (!detail) return macros
    const lang = detail.ticket.language
    // The ticket's language first; everything else still reachable below it.
    return [...macros].sort((a, b) => Number(b.language === lang) - Number(a.language === lang) || a.name.localeCompare(b.name))
  }, [macros, detail])

  return (
    <AppShell email={me.email}>
      <PageHeader title="Inbox" subtitle="Every brand's support email, in one queue.">
        <select
          aria-label="Mailbox"
          value={mailboxId}
          onChange={(e) => setMailboxId(e.target.value)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-[13px] text-ink"
        >
          <option value="">All mailboxes</option>
          {mailboxes.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <select
          aria-label="Assignee"
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-[13px] text-ink"
        >
          <option value="">Anyone</option>
          <option value={me.id}>Me</option>
          <option value="none">Unassigned</option>
          {users.filter((u) => u.id !== me.id).map((u) => (
            <option key={u.id} value={u.id}>{u.email}</option>
          ))}
        </select>
        <input
          aria-label="Search tickets"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search subject, customer, PA-number"
          className="w-56 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
        />
      </PageHeader>

      <PageBody>
        {error && (
          <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">{error}</div>
        )}

        <div className="flex gap-4">
          {/* The queue */}
          <div className="w-[340px] shrink-0">
            <div role="tablist" aria-label="Ticket status" className="mb-3 flex gap-1 rounded-[var(--radius-control)] border border-line bg-panel p-1">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={status === s}
                  onClick={() => setStatus(s)}
                  className={`flex-1 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] transition-colors duration-150 ${
                    status === s ? 'bg-surface font-semibold text-ink' : 'text-muted hover:text-ink'
                  }`}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>

            {tickets === null ? (
              <ListSkeleton />
            ) : tickets.length === 0 ? (
              <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-6 text-[13px] text-muted">
                No {STATUS_LABEL[status].toLowerCase()} tickets{q ? ' match the search' : ''}.
              </div>
            ) : (
              <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
                {tickets.map((t) => (
                  <button
                    key={t.id}
                    data-testid="ticket-row"
                    aria-current={t.id === selectedId || undefined}
                    onClick={() => setSelectedId(t.id)}
                    className={`block w-full border-b border-line px-3.5 py-3 text-left last:border-b-0 transition-colors duration-150 ${
                      t.id === selectedId ? 'bg-accent-soft' : 'hover:bg-panel'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-semibold text-ink">{t.subject}</span>
                      <span className="shrink-0 text-[11px] text-faint tabular-nums">{day(t.lastMessageAt)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                      <span className="tabular-nums">PA-{t.number}</span>
                      <span className="truncate">{t.customerName || t.customerEmail}</span>
                      {t.priority === 'HIGH' && <span className="rounded-full bg-panel px-1.5 text-[11px] text-loss">high</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                      <span>{t.mailboxName}</span>
                      {t.category && <span>· {t.category}</span>}
                      {t.tags.map((tag) => (
                        <span key={tag} className="rounded-full border border-line px-1.5">{tag}</span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* The thread */}
          <div className="min-w-0 flex-1">
            {!detail ? (
              <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-10 text-center text-[13px] text-muted">
                Pick a ticket to read it.
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <h2 className="text-[15px] font-semibold text-ink">{detail.ticket.subject}</h2>
                  <div className="mt-0.5 text-[12px] text-muted">
                    PA-{detail.ticket.number} · {detail.ticket.mailbox.name} · {detail.ticket.category ?? 'uncategorised'} ·{' '}
                    {detail.ticket.language}
                    {detail.ticket.languageDetected ? '' : ' (mailbox default)'}
                  </div>
                </div>

                {detail.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-[var(--radius-card)] border px-4 py-3 ${
                      m.direction === 'NOTE'
                        ? 'border-line bg-panel'
                        : m.direction === 'OUTBOUND'
                          ? 'border-line bg-accent-soft'
                          : 'border-line bg-surface'
                    }`}
                  >
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px] text-muted">
                      <span>
                        {m.direction === 'NOTE' ? (
                          <span className="font-semibold text-warn">Internal note</span>
                        ) : m.direction === 'OUTBOUND' ? (
                          <>Sent from {m.fromEmail}{m.author ? ` by ${m.author}` : ''}</>
                        ) : (
                          <>{m.fromEmail}</>
                        )}
                        {m.spamScore !== null && m.spamScore >= 5 && (
                          <span className="ml-2 rounded-full border border-line px-1.5 text-[11px] text-loss">spam score {m.spamScore}</span>
                        )}
                      </span>
                      <span className="tabular-nums">{day(m.sentAt)}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-[13px] text-ink">{m.text}</div>
                    {m.direction === 'INBOUND' && m.fullText !== m.text && (
                      <details className="mt-1 text-[12px] text-muted">
                        <summary className="cursor-pointer">Show quoted text</summary>
                        <div className="mt-1 whitespace-pre-wrap">{m.fullText}</div>
                      </details>
                    )}
                    {m.attachments.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {m.attachments.map((a) => (
                          <span key={a.id} className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-muted">
                            {a.filename}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {/* The composer */}
                <div className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div role="tablist" aria-label="Message kind" className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-panel p-0.5">
                      {(['reply', 'note'] as const).map((k) => (
                        <button
                          key={k}
                          role="tab"
                          aria-selected={composerKind === k}
                          onClick={() => setComposerKind(k)}
                          className={`rounded-[var(--radius-control)] px-2.5 py-1 text-[12px] ${
                            composerKind === k ? 'bg-surface font-semibold text-ink' : 'text-muted hover:text-ink'
                          }`}
                        >
                          {k === 'reply' ? 'Reply' : 'Internal note'}
                        </button>
                      ))}
                    </div>
                    {composerKind === 'reply' && (
                      <select
                        aria-label="Insert macro"
                        value=""
                        onChange={(e) => { if (e.target.value) insertMacro(e.target.value) }}
                        className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
                      >
                        <option value="">Insert macro…</option>
                        {macroChoices.map((m) => (
                          <option key={m.id} value={m.id}>{m.name} ({m.language})</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <textarea
                    aria-label="Message"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={5}
                    placeholder={composerKind === 'reply' ? `Reply as ${detail.ticket.mailbox.address}…` : 'A note the customer never sees…'}
                    className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
                  />
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[12px] text-warn">{missing.length > 0 && `Fill in: ${missing.join(', ')}`}</span>
                    <button
                      onClick={() => void send()}
                      disabled={sending || !text.trim() || (composerKind === 'reply' && hasMissingMarker(text))}
                      className="rounded-[var(--radius-control)] bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
                    >
                      {composerKind === 'reply' ? 'Send reply' : 'Add note'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* The customer, beside the conversation */}
          {detail && (
            <div data-testid="ticket-sidebar" className="w-[320px] shrink-0 space-y-3">
              <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Customer</h3>
                {detail.context.customer ? (
                  <div className="space-y-0.5 text-[13px] text-ink">
                    <div className="font-semibold">{detail.context.customer.name || detail.ticket.customerEmail}</div>
                    <div className="text-muted">{detail.context.customer.email}</div>
                    <div className="text-muted">{detail.context.customer.phone ?? 'No phone on file'}</div>
                    <div className="text-muted">
                      {detail.context.customer.country ?? 'Country unknown'}
                      {detail.context.orders[0] ? ` · ${detail.context.orders[0].shop}` : ''}
                    </div>
                  </div>
                ) : (
                  <div className="text-[13px] text-muted">No customer found - no orders on this address.</div>
                )}
              </div>

              <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">This ticket</h3>
                <div className="space-y-2 text-[13px]">
                  <label className="block">
                    <span className="text-[12px] text-muted">Status</span>
                    <select
                      aria-label="Status"
                      value={detail.ticket.status}
                      onChange={(e) => void patchTicket({ status: e.target.value })}
                      className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-ink"
                    >
                      {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[12px] text-muted">Assign to</span>
                    <select
                      aria-label="Assign to"
                      value={detail.ticket.assignee?.id ?? ''}
                      onChange={(e) => void patchTicket({ assigneeUserId: e.target.value || null })}
                      className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-ink"
                    >
                      <option value="">Nobody</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[12px] text-muted">Priority</span>
                    <select
                      aria-label="Priority"
                      value={detail.ticket.priority}
                      onChange={(e) => void patchTicket({ priority: e.target.value })}
                      className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-ink"
                    >
                      <option value="LOW">Low</option>
                      <option value="NORMAL">Normal</option>
                      <option value="HIGH">High</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[12px] text-muted">Matched order</span>
                    <select
                      aria-label="Matched order"
                      value={detail.ticket.matchedOrder?.id ?? ''}
                      onChange={(e) => void patchTicket({ matchedOrderId: e.target.value || null })}
                      className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-ink"
                    >
                      <option value="">None</option>
                      {detail.context.orders.map((o) => (
                        <option key={o.id} value={o.id}>{o.number} · {o.shop}</option>
                      ))}
                    </select>
                  </label>
                  <TagEditor tags={detail.ticket.tags} onChange={(tags) => void patchTicket({ tags })} />
                </div>
              </div>

              <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Orders</h3>
                {detail.context.orders.length === 0 ? (
                  <div className="text-[13px] text-muted">None on this address.</div>
                ) : (
                  <div className="space-y-3">
                    {detail.context.orders.map((o) => (
                      <div key={o.id} className="border-b border-line pb-2.5 text-[13px] last:border-b-0 last:pb-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-semibold text-ink tabular-nums">{o.number}</span>
                          <span className="text-muted tabular-nums">{formatMoney(o.total, o.currency)}</span>
                        </div>
                        <div className="text-[12px] text-muted">
                          {o.shop} · {day(o.placedAt)}
                          {o.refunded && <span className="ml-1.5 rounded-full border border-line px-1.5 text-[11px] text-loss">Refunded in the shop</span>}
                        </div>
                        <div className="text-[12px] text-muted">
                          {o.products.map((p) => `${p.quantity} × ${p.name}`).join(', ')}
                        </div>
                        {o.deliveryPhrase && <div className="text-[12px] text-ink">{o.deliveryPhrase}</div>}
                        {o.parcels.map((p) => (
                          <a key={p.number} href={p.url} target="_blank" rel="noreferrer" className="block text-[12px] text-accent underline-offset-2 hover:underline">
                            {p.carrier} {p.number}
                          </a>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Previous conversations</h3>
                {detail.context.previousTickets.length === 0 ? (
                  <div className="text-[13px] text-muted">This is their first.</div>
                ) : (
                  <div className="space-y-1.5">
                    {detail.context.previousTickets.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setSelectedId(t.id)}
                        className="block w-full text-left text-[13px] text-ink hover:text-accent"
                      >
                        <span className="text-muted tabular-nums">PA-{t.number}</span> {t.subject}
                        <span className="ml-1 text-[11px] text-faint">{STATUS_LABEL[t.status] ?? t.status} · {day(t.lastMessageAt)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </PageBody>
    </AppShell>
  )
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('')
  return (
    <label className="block">
      <span className="text-[12px] text-muted">Tags</span>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-full border border-line bg-panel px-2 py-0.5 text-[12px] text-ink">
            {t}
            <button aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))} className="text-faint hover:text-loss">
              ×
            </button>
          </span>
        ))}
        <input
          aria-label="Add tag"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              onChange([...tags, draft.trim()])
              setDraft('')
            }
          }}
          placeholder="Add tag…"
          className="w-24 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 text-[12px] text-ink"
        />
      </div>
    </label>
  )
}
