'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { parseReply, type Span } from '@/lib/advisor/format'

/**
 * The assistant, reachable from every page.
 *
 * It began as the chat at the bottom of the Advisor page. The client asked for
 * it wherever he happens to be standing - looking at the forecast and asking
 * "how did you calculate that?" - so it became a button in the corner instead
 * of a section on one screen, and it sends the page along with the question so
 * that "that" has a referent.
 *
 * The conversation lives in the browser: localStorage, so walking to another
 * page (a full navigation, which unmounts this) does not lose it. No server
 * table, because a stored history is a schema, a list screen and a retention
 * question this does not need. It is cleared by the Clear button, never by us.
 */

const STORAGE_KEY = 'assistant-chat'

/**
 * Three questions that each reach a different way: back across two periods,
 * down to one shop, and into the working behind a recommendation. They teach
 * what the box can do, which an empty field with a placeholder cannot.
 */
const EXAMPLES = [
  'Why did revenue change last week?',
  'Which shop made the most profit?',
  'What should I order, and how was that worked out?',
]

type Bubble = { role: 'user' | 'assistant'; text: string }

/**
 * An answer as paragraphs and lists rather than as the markdown the model
 * writes. Rendered as elements, never as HTML, so the reply cannot inject
 * markup into the page it is answering about.
 */
function Answer({ text }: { text: string }) {
  const spans = (parts: Span[], key: string) =>
    parts.map((s, i) =>
      s.bold ? (
        <strong key={`${key}-${i}`} className="font-semibold text-ink">
          {s.text}
        </strong>
      ) : (
        <span key={`${key}-${i}`}>{s.text}</span>
      ),
    )

  return (
    <div className="flex flex-col gap-2 text-[13px] text-muted">
      {parseReply(text).map((block, b) =>
        block.kind === 'bullets' ? (
          <ul key={b} className="flex list-disc flex-col gap-1 pl-4 marker:text-faint">
            {block.items.map((item, i) => (
              <li key={i}>{spans(item, `${b}-${i}`)}</li>
            ))}
          </ul>
        ) : (
          <p key={b} className="whitespace-pre-wrap">
            {spans(block.spans, String(b))}
          </p>
        ),
      )}
    </div>
  )
}

export function Assistant() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // The model's own transcript, tool calls and all. Kept apart from the
  // bubbles, which are only what a person should read.
  const transcript = useRef<unknown[]>([])
  const endRef = useRef<HTMLDivElement>(null)

  /**
   * Restored when the panel is opened, not on mount.
   *
   * Reading storage in an effect would set state during render for every page
   * in the product, to fill a panel nobody has opened yet. Doing it on the
   * click costs nothing until it is wanted, and there is nothing on screen
   * before that which could disagree with the server's HTML.
   */
  function restore() {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) return
    try {
      const parsed = JSON.parse(saved) as { bubbles?: Bubble[]; transcript?: unknown[] }
      // A cast is compile-time only - a truthy but wrong-shaped value would
      // otherwise reach bubbles.map() during render, outside this try/catch,
      // and take down every page in the product rather than just the chat.
      setBubbles(Array.isArray(parsed.bubbles) ? parsed.bubbles : [])
      transcript.current = Array.isArray(parsed.transcript) ? parsed.transcript : []
    } catch {
      // A corrupt entry is not worth a broken page.
    }
  }

  // matchMedia is absent in jsdom, so guard rather than assume a browser.
  useEffect(() => {
    if (!open || bubbles.length === 0) return
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    endRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' })
  }, [bubbles, open])

  function remember(next: Bubble[]) {
    setBubbles(next)
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ bubbles: next, transcript: transcript.current }),
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
          page: pathname,
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

  if (!open) {
    return (
      <button
        onClick={() => {
          restore()
          setOpen(true)
        }}
        aria-label="Ask the assistant"
        className="fixed bottom-5 right-5 z-[var(--z-sticky)] flex h-12 w-12 items-center justify-center rounded-full bg-ink text-white shadow-lg transition-transform duration-150 hover:scale-105 motion-reduce:transition-none"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.3-.6L3 21l1.8-5A8.2 8.2 0 0 1 4 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8 8.4Z" />
        </svg>
      </button>
    )
  }

  return (
    <section
      aria-label="Assistant"
      className="fixed bottom-5 right-5 z-[var(--z-sticky)] flex max-h-[min(600px,calc(100vh-2.5rem))] w-[min(380px,calc(100vw-2.5rem))] flex-col rounded-[var(--radius-card)] border border-line bg-surface shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ink">Assistant</h2>
        <div className="flex items-center gap-3">
          {bubbles.length > 0 && (
            <button
              onClick={clear}
              disabled={busy}
              className="text-[12px] text-muted transition-colors duration-150 hover:text-ink disabled:opacity-50 motion-reduce:transition-none"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            aria-label="Close the assistant"
            className="text-[16px] leading-none text-muted transition-colors duration-150 hover:text-ink motion-reduce:transition-none"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {bubbles.length === 0 && !busy ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted">
              Ask about any shop, product, week or figure on the page you are on.
            </p>
            {EXAMPLES.map((q) => (
              <button
                key={q}
                onClick={() => send(q)}
                className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-left text-[12px] text-muted transition-colors duration-150 hover:border-accent hover:text-accent motion-reduce:transition-none"
              >
                {q}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {bubbles.map((bubble, i) =>
              bubble.role === 'user' ? (
                <p key={i} className="text-[13px] font-medium text-ink">
                  {bubble.text}
                </p>
              ) : (
                <Answer key={i} text={bubble.text} />
              ),
            )}
            {busy && <p className="text-[13px] text-faint">Looking it up…</p>}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t border-line p-3">
        <input
          aria-label="Your question"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          placeholder="Ask about anything here"
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
    </section>
  )
}
