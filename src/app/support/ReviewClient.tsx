'use client'

import { useCallback, useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
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

const FILTERS = ['all', 'sent', 'drafted', 'escalated'] as const

const LABEL: Record<string, string> = {
  sent: 'Answered by itself',
  drafted: 'Suggested to an agent',
  escalated: 'Handed to a person',
}

export function ReviewClient({ email }: { email: string }) {
  const toast = useToast()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [rows, setRows] = useState<Conversation[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [correction, setCorrection] = useState('')

  /**
   * State set inside the promise callback, never after an await in the effect
   * body: React counts the latter as a synchronous set during render.
   */
  const load = useCallback(
    () =>
      fetch(`/api/support/conversations?decision=${filter}`)
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
        title="Assistant review"
        subtitle="Every conversation it touched, and whether it got it right."
      />
      <PageBody>
        <div className="max-w-[900px] space-y-4">
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
              Nothing here yet. Conversations appear once Gorgias starts sending messages to the assistant.
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
                    {r.correction && <span className="text-faint">Correction saved</span>}
                  </div>

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
        </div>
      </PageBody>
    </AppShell>
  )
}
