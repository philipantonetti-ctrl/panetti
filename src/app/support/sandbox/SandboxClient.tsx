'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

/**
 * The practice room.
 *
 * An admin talks to the assistant as a customer would, sees what it would
 * have DONE (sent, suggested, handed over) and why, sees what it looked at,
 * and corrects it. A correction becomes an example the very next turn can
 * find. Nothing here reaches Gorgias or a customer.
 */

type Shop = { id: string; name: string }
type Turn = { role: 'user' | 'assistant'; text: string }
type Result = {
  conversationId: string
  reply: string | null
  action: 'send' | 'draft' | 'escalate'
  reason: string | null
  category: string
  language: string
  confidence: number
  knowledge: { kind: string; title: string }[]
  saw: {
    customer: string | null
    orders: { number: string; shop: string; status: string; delivery: string | null; parcels: string[] }[]
  }
}
/** One line on screen: what was said, and for the assistant, what it worked out. */
type Line = Turn & { result?: Result; rated?: 'good' | 'bad' }

const ACTION: Record<Result['action'], string> = {
  send: 'Would send this',
  draft: 'Would only suggest this to an agent',
  escalate: 'Would hand over to a person',
}

const newKey = () => Math.random().toString(36).slice(2, 12)

export function SandboxClient({ email }: { email: string }) {
  const toast = useToast()
  const [shops, setShops] = useState<Shop[]>([])
  const [shopId, setShopId] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [sessionKey, setSessionKey] = useState(newKey)
  const [lines, setLines] = useState<Line[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [correcting, setCorrecting] = useState<{ id: string; text: string } | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/support/knowledge')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body) return
        setShops(body.shops)
        /**
         * panetti.dk first, because it is the first shop the assistant
         * answers. Named twice on purpose: several brands have a Danish shop,
         * and matching only "Denmark" opens on whichever of them sorts first.
         */
        const shops = body.shops as Shop[]
        const danish = (s: Shop) => /denmark|\.dk/i.test(s.name)
        const first = shops.find((s) => danish(s) && /panetti/i.test(s.name)) ?? shops.find(danish)
        setShopId((first ?? shops[0])?.id ?? '')
      })
  }, [])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  const last = [...lines].reverse().find((l) => l.result)?.result ?? null

  async function send() {
    const text = draft.trim()
    if (!text || !shopId || busy) return
    const messages: Turn[] = [...lines.map(({ role, text }) => ({ role, text })), { role: 'user', text }]
    setLines((l) => [...l, { role: 'user', text }])
    setDraft('')
    setBusy(true)
    try {
      const res = await fetch('/api/support/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId, customerEmail: customerEmail.trim() || null, sessionKey, messages }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(body?.error ?? 'The sandbox could not run that turn')
        return
      }
      const result = body as Result
      setLines((l) => [...l, { role: 'assistant', text: result.reply ?? '(no reply)', result }])
    } finally {
      setBusy(false)
    }
  }

  async function rate(result: Result, rating: 'good' | 'bad', correction?: string) {
    const res = await fetch(`/api/support/conversations/${result.conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ rating, ...(correction !== undefined ? { correction } : {}) }),
    })
    if (!res.ok) {
      toast.error('Could not record that')
      return
    }
    setLines((l) => l.map((x) => (x.result?.conversationId === result.conversationId ? { ...x, rated: rating } : x)))
    setCorrecting(null)
    toast.success(rating === 'good' ? 'Marked good' : 'Saved. The next turn can use it.')
  }

  function reset() {
    setLines([])
    setSessionKey(newKey())
    setCorrecting(null)
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Try the assistant"
        subtitle="Practice with the assistant before a customer ever sees it. Write as a customer would, then mark an answer wrong to teach it. Nothing on this page reaches a real customer or Gorgias."
      />
      <PageBody>
        <div className="grid max-w-[1100px] gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className="space-y-3">
            <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-3 text-[12px] text-muted">
              <label className="block">
                Shop
                <select
                  aria-label="Shop"
                  value={shopId}
                  onChange={(e) => {
                    setShopId(e.target.value)
                    reset()
                  }}
                  className="mt-0.5 block rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                >
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block grow">
                Customer email (optional, a real one shows its orders)
                <input
                  aria-label="Customer email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  placeholder="kunde@example.com"
                  className="mt-0.5 block w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                />
              </label>
              <button onClick={reset} className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-faint">
                Start over
              </button>
              <Link href="/support" className="text-[13px] text-accent">
                Back to Support
              </Link>
            </div>

            <div className="min-h-[320px] space-y-2 rounded-[var(--radius-card)] border border-line bg-surface p-3">
              {lines.length === 0 && (
                <p className="text-[13px] text-muted">
                  Write what a customer might write, in their own language. For example: Hvor er min pakke? You
                  will see its answer, whether it would really have sent it, and what it was looking at.
                </p>
              )}
              {lines.map((l, i) => (
                <div key={i} className={l.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div
                    className={`max-w-[85%] rounded-[var(--radius-card)] px-3 py-2 text-[13px] ${
                      l.role === 'user' ? 'bg-ink text-white' : 'border border-line bg-panel text-ink'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{l.text}</p>
                    {l.result && (
                      <div className="mt-2 space-y-1 border-t border-line pt-2 text-[11px] text-muted">
                        <div>
                          <span className={l.result.action === 'send' ? 'text-gain' : l.result.action === 'escalate' ? 'text-warn' : ''}>
                            {ACTION[l.result.action]}
                          </span>
                          {l.result.reason && <span> because {l.result.reason}</span>}
                        </div>
                        <div className="tabular-nums">
                          {Math.round(l.result.confidence * 100)}% sure · {l.result.category} · {l.result.language}
                        </div>
                        {l.result.knowledge.length > 0 && (
                          <div>Used: {l.result.knowledge.map((k) => `${k.kind}: ${k.title}`).join('; ')}</div>
                        )}
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => void rate(l.result!, 'good')}
                            className={`rounded-full border px-2 py-0.5 ${l.rated === 'good' ? 'border-gain text-gain' : 'border-line hover:border-faint'}`}
                          >
                            Good
                          </button>
                          <button
                            onClick={() => setCorrecting({ id: l.result!.conversationId, text: '' })}
                            className={`rounded-full border px-2 py-0.5 ${l.rated === 'bad' ? 'border-loss text-loss' : 'border-line hover:border-faint'}`}
                          >
                            Wrong
                          </button>
                        </div>
                        {correcting?.id === l.result.conversationId && (
                          <div className="pt-1">
                            <textarea
                              aria-label="What it should have said"
                              value={correcting.text}
                              onChange={(e) => setCorrecting({ id: correcting.id, text: e.target.value })}
                              rows={3}
                              placeholder="What it should have said instead"
                              className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                            />
                            <div className="mt-1 flex justify-end">
                              <button
                                onClick={() => void rate(l.result!, 'bad', correcting.text)}
                                disabled={!correcting.text.trim()}
                                className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
                              >
                                Save correction
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {busy && <p className="text-[12px] text-faint">Thinking…</p>}
              <div ref={bottom} />
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
              className="flex gap-2"
            >
              <input
                aria-label="Message as the customer"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write as the customer"
                disabled={busy || !shopId}
                className="grow rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={busy || !draft.trim() || !shopId}
                className="rounded-[var(--radius-control)] bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </section>

          <aside className="rounded-[var(--radius-card)] border border-line bg-surface p-3 text-[12px]">
            <h2 className="mb-2 text-[13px] font-semibold text-ink">What it saw</h2>
            {!last ? (
              <p className="text-muted">
                After the first answer, this shows the customer and the orders the assistant was looking at, so
                you can see what it knew before it wrote.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="text-muted">Customer: {last.saw.customer ?? 'unknown, no orders for this email'}</div>
                {last.saw.orders.length === 0 ? (
                  <div className="text-muted">Orders: none</div>
                ) : (
                  last.saw.orders.map((o) => (
                    <div key={o.number} className="border-t border-line pt-1.5">
                      <div className="font-medium tabular-nums text-ink">
                        {o.number} · {o.shop} · {o.status}
                      </div>
                      <div className="text-muted">{o.delivery ?? 'delivery not tracked'}</div>
                      {o.parcels.length > 0 && <div className="tabular-nums text-faint">{o.parcels.join(', ')}</div>}
                    </div>
                  ))
                )}
              </div>
            )}
          </aside>
        </div>
      </PageBody>
    </AppShell>
  )
}
