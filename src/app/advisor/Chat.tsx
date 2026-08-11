'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Asking follow-up questions.
 *
 * The conversation lives in the browser: sessionStorage so a refresh does not
 * lose it, and no server table, because a stored history is a schema, a list
 * screen and a retention question this feature does not need yet.
 */

const STORAGE_KEY = 'advisor-chat'

type Bubble = { role: 'user' | 'assistant'; text: string }

export function Chat() {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // The model's own transcript, tool calls and all. Kept apart from the
  // bubbles, which are only what a person should read.
  const transcript = useRef<unknown[]>([])

  useEffect(() => {
    const saved = window.sessionStorage.getItem(STORAGE_KEY)
    if (!saved) return
    try {
      const parsed = JSON.parse(saved) as { bubbles: Bubble[]; transcript: unknown[] }
      // sessionStorage is synchronous and the deps array is empty, so this
      // effect runs exactly once, on mount, to hydrate from it — not the
      // render-loop resync the cascading-render warning below guards against.
      // A cast is compile-time only -- a truthy but wrong-shaped value would
      // otherwise reach setBubbles and throw inside bubbles.map() during
      // render, outside this try/catch, taking the whole Advisor page down
      // with it rather than just failing to restore the chat.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBubbles(Array.isArray(parsed.bubbles) ? parsed.bubbles : [])
      transcript.current = Array.isArray(parsed.transcript) ? parsed.transcript : []
    } catch {
      // A corrupt entry is not worth a broken page.
    }
  }, [])

  function remember(next: Bubble[]) {
    setBubbles(next)
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ bubbles: next, transcript: transcript.current }),
    )
  }

  async function send() {
    const question = draft.trim()
    if (!question || busy) return

    const asked: Bubble[] = [...bubbles, { role: 'user', text: question }]
    remember(asked)
    setDraft('')
    setBusy(true)

    try {
      const res = await fetch('/api/advisor/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...transcript.current, { role: 'user', content: question }],
        }),
      })
      const body = await res.json()

      if (!res.ok || body.error) {
        remember([...asked, { role: 'assistant', text: body.error ?? 'Could not answer.' }])
        return
      }

      transcript.current = body.messages ?? transcript.current
      remember([...asked, { role: 'assistant', text: body.reply ?? '' }])
    } catch {
      remember([...asked, { role: 'assistant', text: 'Could not reach the server.' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[12px] border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-3 text-[13px] font-semibold text-ink">Ask</h2>

      {/* Rendered only when it has something in it: an empty transcript still
          painted its own padding, leaving a dead grey strip under the heading. */}
      {(bubbles.length > 0 || busy) && (
      <div className="flex flex-col gap-3 px-4 py-3">
        {bubbles.map((bubble, i) => (
          <p
            key={i}
            className={
              bubble.role === 'user'
                ? 'text-[13px] font-medium text-ink'
                : 'whitespace-pre-wrap text-[13px] text-muted'
            }
          >
            {bubble.text}
          </p>
        ))}
        {busy && <p className="text-[13px] text-faint">Looking it up…</p>}
      </div>
      )}

      <div className="flex gap-2 border-t border-line p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          placeholder="Ask about any shop, product or week"
          className="flex-1 rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[13px]"
        />
        <button
          onClick={send}
          disabled={busy}
          className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </section>
  )
}
