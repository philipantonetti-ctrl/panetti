'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Asking follow-up questions.
 *
 * The conversation lives in the browser: localStorage so closing the tab does
 * not lose it, stamped with the briefing's day so each morning starts fresh.
 * No server table, because a stored history is a schema, a list screen and a
 * retention question this feature does not need yet.
 */

const STORAGE_KEY = 'advisor-chat'

/**
 * Three questions that each demonstrate a different reach: back across two
 * periods, down to one shop, and across every product. Chosen to teach what
 * this box can do rather than to be asked verbatim.
 */
const EXAMPLES = [
  'Why did revenue change last week?',
  'Which shop made the most profit?',
  'Which products are selling worst?',
]

type Bubble = { role: 'user' | 'assistant'; text: string }

export function Chat({ day = null }: { day?: string | null }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // The model's own transcript, tool calls and all. Kept apart from the
  // bubbles, which are only what a person should read.
  const transcript = useRef<unknown[]>([])
  const endRef = useRef<HTMLDivElement>(null)

  // Keyed on `day`, not [], because the briefing is fetched after this mounts:
  // on the first pass `day` is null, and a mount-only check would never see the
  // real one arrive. Storage is rewritten on every change below, so re-running
  // this restores identical content rather than clobbering anything.
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) return
    try {
      const parsed = JSON.parse(saved) as {
        day?: string | null
        bubbles?: Bubble[]
        transcript?: unknown[]
      }

      // Only when both days are known and differ. An unstamped entry, or a
      // briefing that has not loaded, is never grounds for throwing work away.
      if (parsed.day && day && parsed.day !== day) {
        window.localStorage.removeItem(STORAGE_KEY)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setBubbles([])
        transcript.current = []
        return
      }

      // A cast is compile-time only -- a truthy but wrong-shaped value would
      // otherwise reach setBubbles and throw inside bubbles.map() during
      // render, outside this try/catch, taking the whole Advisor page down
      // with it rather than just failing to restore the chat.
      setBubbles(Array.isArray(parsed.bubbles) ? parsed.bubbles : [])
      transcript.current = Array.isArray(parsed.transcript) ? parsed.transcript : []
    } catch {
      // A corrupt entry is not worth a broken page.
    }
  }, [day])

  // matchMedia is absent in jsdom, so guard rather than assume a browser.
  useEffect(() => {
    if (bubbles.length === 0) return
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    endRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' })
  }, [bubbles])

  function remember(next: Bubble[]) {
    setBubbles(next)
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ day, bubbles: next, transcript: transcript.current }),
    )
  }

  function clear() {
    if (busy) return
    transcript.current = []
    setBubbles([])
    window.localStorage.removeItem(STORAGE_KEY)
  }

  async function send(preset?: string) {
    const question = (preset ?? draft).trim()
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
    <>
      {/* The conversation, in normal flow. Rendered only when it has something
          in it: an "Ask" heading over an empty box every morning is furniture,
          not information. */}
      {(bubbles.length > 0 || busy) && (
        <section className="mt-4 rounded-[12px] border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-semibold text-ink">Ask</h2>
            {bubbles.length > 0 && (
              <button
                onClick={clear}
                disabled={busy}
                className="text-[12px] text-muted transition-colors duration-150 hover:text-ink disabled:opacity-50 motion-reduce:transition-none"
              >
                Clear
              </button>
            )}
          </div>

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
            <div ref={endRef} />
          </div>
        </section>
      )}

      {/* The composer, pinned. Sticky rather than fixed so it inherits the
          content column and cannot cover the sidebar, and so it takes up its
          own space instead of needing a spacer under the last card. This must
          stay a direct child of <main>: sticky is confined to its parent's
          box, and a wrapper div would leave it nowhere to travel. */}
      <div className="sticky bottom-0 mt-4 rounded-[12px] border border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        {/* An empty box with a placeholder shows the control but not the
            capability: nothing in it says this can compare two weeks, name a
            product or reach a single shop. Three real questions do, and they
            stand down once the conversation has its own content. */}
        {bubbles.length === 0 && !busy && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {EXAMPLES.map((q) => (
              <button
                key={q}
                onClick={() => send(q)}
                className="rounded-full border border-line px-3 py-1 text-[12px] text-muted transition-colors duration-150 hover:border-accent hover:text-accent motion-reduce:transition-none"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-2 p-3">
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
            onClick={() => send()}
            disabled={busy}
            className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </>
  )
}
