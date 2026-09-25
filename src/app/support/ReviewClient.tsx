'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { AnalyticsView } from './AnalyticsView'
import { useToast } from '@/components/toast/useToast'

/**
 * Every conversation the assistant touched, and what a person thought of it.
 *
 * The question this page exists to answer is not "what did it say" but "can it
 * be trusted with more". So the counts at the top are the whole history rather
 * than the page, and a correction is stored as what the answer SHOULD have
 * been - the raw material for teaching it, rather than a complaint filed
 * somewhere nobody reads.
 */

type Conversation = {
  id: string
  externalTicketId: string
  /** 'gorgias' | 'sandbox': practice is filed beside the real thing, never mixed into it. */
  source: string
  customerEmail: string | null
  question: string
  answer: string | null
  category: string | null
  language: string | null
  confidence: number | null
  decision: string
  escalationReason: string | null
  summary: string | null
  orderNumber: string | null
  rating: string | null
  correction: string | null
  createdAt: string
}

/** The whole chat behind a row, as the customer saw it. */
type ChatLine = { who: 'customer' | 'assistant' | 'person' | 'widget'; text: string; at: string }

/**
 * Said plainly, because the point of showing the chat at all is to tell our
 * own line from a colleague's.
 */
const SPEAKER: Record<ChatLine['who'], string> = {
  customer: 'Customer',
  assistant: 'Assistant',
  person: 'A person',
  widget: 'Chat widget',
}

const FILTERS = ['all', 'sent', 'drafted', 'escalated', 'skipped', 'failed', 'sandbox'] as const

const LABEL: Record<string, string> = {
  sent: 'Answered by itself',
  drafted: 'Suggested to an agent',
  escalated: 'Handed to a person',
  // A turn the assistant finished and the helpdesk would not take. The answer
  // is on the row, so an agent can still use it, and the reason says what
  // refused it. Without a filter of its own this is the one outcome nobody
  // would ever look at.
  failed: 'Could not be delivered',
  // A chat that reached the assistant and that it deliberately left alone,
  // because a person was already answering it. Without a line of its own, a
  // chat the assistant stood out of looks exactly like a chat that never
  // arrived, which is a question nobody can answer from this page.
  skipped: 'A person was already answering',
  superseded: 'A later message answered',
  pending: 'Still working',
  sending: 'Still working',
  sandbox: 'Sandbox practice',
}

/**
 * What an empty filter means, said for each one.
 *
 * Every filter used to share "Nothing here yet", which reads as "this is
 * broken" on a filter that is simply empty - and it cost a round of "where? I
 * cannot see it" for a filter that was working perfectly and had nothing in it
 * yet. Each one now says what would put a line there.
 */
const EMPTY: Record<(typeof FILTERS)[number], string> = {
  all: 'Nothing here yet. Live conversations appear once Gorgias sends messages to the assistant; practice runs are under Sandbox practice.',
  sent: 'The assistant has not answered a chat by itself yet.',
  drafted: 'No suggestions waiting. These appear when the assistant is set to suggest an answer rather than send it.',
  escalated: 'Nothing handed over yet. This fills when the assistant decides a chat needs one of your team.',
  skipped: 'Nothing here yet. This fills when a customer writes while one of your team is already answering that chat, and the assistant stays out of it.',
  failed: 'Nothing has failed to send. This fills only if Gorgias refuses an answer the assistant had already written.',
  sandbox: 'No practice runs yet. Press "Test the assistant" to try it without writing to a customer.',
}

/** The two things this page is: the numbers, and what the assistant said. */
const VIEWS = [
  { key: 'analytics' as const, label: 'Analytics' },
  { key: 'ai' as const, label: 'AI conversations' },
]

export function ReviewClient({ email }: { email: string }) {
  const toast = useToast()
  const [view, setView] = useState<'analytics' | 'ai'>('analytics')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [rows, setRows] = useState<Conversation[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [correction, setCorrection] = useState('')
  const [chatId, setChatId] = useState<string | null>(null)
  const [chat, setChat] = useState<{ messages: ChatLine[]; reason?: string } | null>(null)

  /**
   * State set inside the promise callback, never after an await in the effect
   * body: React counts the latter as a synchronous set during render.
   */
  const load = useCallback(
    () =>
      fetch(
        // Practice is its own filter rather than a decision, because it is not
        // one: a sandbox run has a decision of its own.
        filter === 'sandbox'
          ? '/api/support/conversations?decision=all&source=sandbox'
          : `/api/support/conversations?decision=${filter}`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!body) return
          setRows(body.conversations)
          setCounts(body.counts)
        }),
    [filter],
  )

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The chat behind one row, read live. Closing and reopening reads it again
   * on purpose: a person may have answered since, and that is the very thing
   * somebody opening this is looking for.
   */
  async function showChat(id: string) {
    if (chatId === id) {
      setChatId(null)
      setChat(null)
      return
    }
    setChatId(id)
    setChat(null)
    const res = await fetch(`/api/support/conversations/${id}/chat`)
    const body = res.ok ? await res.json() : null
    setChat(body ?? { messages: [], reason: 'The chat could not be read.' })
  }

  async function judge(id: string, rating: 'good' | 'bad', text?: string) {
    const res = await fetch(`/api/support/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ rating, ...(text !== undefined ? { correction: text } : {}) }),
    })
    if (!res.ok) {
      toast.error('Could not record that')
      return
    }
    toast.success(rating === 'good' ? 'Marked good' : 'Marked bad')
    setCorrection('')
    await load()
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const sent = counts.sent ?? 0
  const escalated = counts.escalated ?? 0

  return (
    <AppShell email={email}>
      <PageHeader
        title="Support"
        subtitle="How customer service is performing, and every conversation the assistant handled."
      />

      <PageBody>
        <div className="max-w-[1100px] space-y-4">
          <div role="tablist" aria-label="View" className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-panel p-1">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                role="tab"
                aria-selected={view === v.key}
                onClick={() => setView(v.key)}
                className={`rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] transition-colors duration-150 ${
                  view === v.key ? 'bg-surface font-semibold text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          <div className="flex justify-end">
            <Link
              href="/support/sandbox"
              className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-faint"
            >
              Test the assistant
            </Link>
          </div>

          {view === 'analytics' && <AnalyticsView />}

          {view === 'ai' && (
          <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Conversations', value: total },
              { label: 'Answered by itself', value: sent },
              { label: 'Handed to a person', value: escalated },
              {
                label: 'Answered by itself',
                value: total ? `${Math.round((sent / total) * 100)}%` : '-',
                sub: 'share of all',
              },
            ].map((tile, i) => (
              <div key={i} className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
                <div className="text-[19px] font-semibold tabular-nums text-ink">{tile.value}</div>
                <div className="text-[11px] text-muted">
                  {tile.label}
                  {tile.sub ? ` (${tile.sub})` : ''}
                </div>
              </div>
            ))}
          </div>

          <div role="tablist" aria-label="Decision" className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-panel p-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`flex-1 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] transition-colors duration-150 ${
                  filter === f ? 'bg-surface font-semibold text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {f === 'all' ? 'All' : LABEL[f]}
              </button>
            ))}
          </div>

          {rows === null ? (
            <div className="skeleton h-[200px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
          ) : rows.length === 0 ? (
            <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-6 text-[13px] text-muted">
              {EMPTY[filter]}
            </div>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={r.id} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px] text-muted">
                    <span>
                      <span className="rounded-full border border-line px-1.5">{LABEL[r.decision] ?? r.decision}</span>
                      {r.category && <span className="ml-1.5">{r.category}</span>}
                      {r.language && <span className="ml-1.5">{r.language}</span>}
                      {r.confidence !== null && (
                        <span className="ml-1.5 tabular-nums">{Math.round(r.confidence * 100)}% sure</span>
                      )}
                      {r.orderNumber && <span className="ml-1.5 tabular-nums">{r.orderNumber}</span>}
                    </span>
                    <span className="tabular-nums">{r.createdAt.slice(0, 10)}</span>
                  </div>

                  <p className="mt-2 text-[13px] font-medium text-ink">{r.question}</p>
                  {r.answer ? (
                    <p className="mt-1 whitespace-pre-wrap text-[13px] text-muted">{r.answer}</p>
                  ) : (
                    <p className="mt-1 text-[13px] text-faint">It wrote no reply.</p>
                  )}
                  {r.escalationReason && (
                    <p className="mt-1 text-[12px] text-warn">Why a person: {r.escalationReason}</p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                    <button
                      onClick={() => void judge(r.id, 'good')}
                      className={`rounded-full border px-2.5 py-1 ${
                        r.rating === 'good' ? 'border-gain text-gain' : 'border-line text-muted hover:border-faint'
                      }`}
                    >
                      Good
                    </button>
                    <button
                      onClick={() => setOpenId(openId === r.id ? null : r.id)}
                      className={`rounded-full border px-2.5 py-1 ${
                        r.rating === 'bad' ? 'border-loss text-loss' : 'border-line text-muted hover:border-faint'
                      }`}
                    >
                      Needs work
                    </button>
                    {r.source !== 'sandbox' && (
                      <button
                        onClick={() => void showChat(r.id)}
                        className="rounded-full border border-line px-2.5 py-1 text-muted hover:border-faint"
                      >
                        {chatId === r.id ? 'Hide the whole chat' : 'Show the whole chat'}
                      </button>
                    )}
                    {r.correction && <span className="text-faint">Correction saved</span>}
                  </div>

                  {chatId === r.id && (
                    <div className="mt-2 rounded-[var(--radius-card)] border border-line bg-panel p-3">
                      {chat === null ? (
                        <div className="skeleton h-[60px] w-full" style={{ borderRadius: 'var(--radius-control)' }} />
                      ) : chat.messages.length === 0 ? (
                        <p className="text-[12px] text-muted">{chat.reason ?? 'Nothing was said in this chat.'}</p>
                      ) : (
                        <div className="space-y-2">
                          {chat.messages.map((line, i) => (
                            <div key={i}>
                              <div className="text-[11px] text-muted">
                                <span className={line.who === 'person' ? 'font-semibold text-ink' : ''}>
                                  {SPEAKER[line.who]}
                                </span>
                                <span className="ml-1.5 tabular-nums">
                                  {line.at.slice(0, 10)} {line.at.slice(11, 16)}
                                </span>
                              </div>
                              <p className="whitespace-pre-wrap text-[13px] text-ink">{line.text}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {openId === r.id && (
                    <div className="mt-2">
                      <textarea
                        aria-label="What it should have said"
                        value={correction}
                        onChange={(e) => setCorrection(e.target.value)}
                        rows={3}
                        placeholder="What it should have said instead"
                        className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                      />
                      <div className="mt-1 flex justify-end">
                        <button
                          onClick={() => void judge(r.id, 'bad', correction)}
                          className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[12px] font-semibold text-white"
                        >
                          Save correction
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          </>
          )}
        </div>
      </PageBody>
    </AppShell>
  )
}
