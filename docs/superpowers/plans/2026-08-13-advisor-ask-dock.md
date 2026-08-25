# Advisor Ask Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the Ask composer to the bottom of the Advisor page, make a conversation last exactly one day, and cap the transcript without ever splitting a tool call from its result.

**Architecture:** Three independent changes. A new pure function trims the model transcript at exchange boundaries and is called by the chat route, so the client's stored history is bounded by what the server hands back. `Chat` moves from `sessionStorage` to `localStorage` stamped with the briefing's day. `Chat`'s single card splits into a conversation card that renders only when it has content, plus a `position: sticky` composer.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind v4, vitest + @testing-library/react (jsdom), `@anthropic-ai/sdk`.

**Design doc:** `docs/superpowers/specs/2026-08-13-advisor-ask-dock-design.md`

## Global Constraints

- Never edit files with PowerShell `Get-Content`/`Set-Content`; it corrupts UTF-8. Use the Edit/Write tools.
- Tests run against local Postgres at `127.0.0.1:5432/ecom_analytics`. Never point them at the live Neon database.
- A full `npm test` on this machine fails 2-3 tests in `src/lib/woo/sync.test.ts` with `Test timed out in 5000ms`. That is parallel-load contention, not your change. Re-run with `npm test -- --testTimeout=20000` to confirm green.
- The repo's lint baseline is **8 errors, 4 warnings**, all pre-existing and in unrelated files. Do not "fix" them; just do not add to them.
- Existing behaviour that must not regress: the first request from a fresh mount sends exactly `{"messages":[{"role":"user","content":"<question>"}]}` (asserted at `Chat.test.tsx:31-35`).
- Money, ranking and the Report are out of scope. Do not touch `src/lib/advisor/brief.ts`, `collect.ts`, or the `Card`/`Report` components.

---

### Task 1: Trim the transcript at exchange boundaries

**Files:**
- Create: `src/lib/advisor/trim.ts`
- Create: `src/lib/advisor/trim.test.ts`
- Modify: `src/app/api/advisor/chat/route.ts:29` (delete the local `Turn` type), `:55` (call the trim)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export type Turn = { role: 'user' | 'assistant'; content: unknown }`, `export function trimTranscript(turns: Turn[], maxExchanges?: number, maxChars?: number): Turn[]`, `export const MAX_EXCHANGES: number`, `export const MAX_CHARS: number`.

**Why this is delicate:** the transcript is not a flat list of messages. `route.ts:78-106` pushes assistant turns whose `content` is an array of blocks (sometimes containing `tool_use`) and user turns whose `content` is an array of `tool_result` blocks. A `slice(-n)` will eventually land between a `tool_use` and its `tool_result`, and the Anthropic API rejects that with a 400. Tool results are `role: 'user'` too, so role alone cannot identify a boundary - the content must also be a string.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/advisor/trim.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_CHARS, trimTranscript, type Turn } from './trim'

/** One complete exchange: question, tool call, tool result, answer. */
function exchange(n: number, padding = ''): Turn[] {
  return [
    { role: 'user', content: `question ${n}` },
    { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'revenue', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: `{"cents":1}${padding}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] },
  ]
}

function idsOf(turns: Turn[], type: 'tool_use' | 'tool_result'): string[] {
  const ids: string[] = []
  for (const turn of turns) {
    if (!Array.isArray(turn.content)) continue
    for (const block of turn.content as { type: string; id?: string; tool_use_id?: string }[]) {
      if (block.type === type) ids.push((type === 'tool_use' ? block.id : block.tool_use_id) as string)
    }
  }
  return ids
}

function build(count: number, padding = ''): Turn[] {
  return Array.from({ length: count }, (_, i) => exchange(i, padding)).flat()
}

describe('trimTranscript', () => {
  it('leaves a short conversation exactly as it was', () => {
    const turns = build(3)
    expect(trimTranscript(turns)).toEqual(turns)
  })

  it('keeps only the last six exchanges', () => {
    const trimmed = trimTranscript(build(9))
    const questions = trimmed.filter((t) => t.role === 'user' && typeof t.content === 'string')
    expect(questions).toHaveLength(6)
    expect(questions[0].content).toBe('question 3')
    expect(questions[5].content).toBe('question 8')
  })

  // The one that matters. A naive slice(-n) passes every other test here and
  // then 400s in production, only for the person who has long conversations.
  it('never separates a tool_use from its tool_result', () => {
    const trimmed = trimTranscript(build(20))
    expect(idsOf(trimmed, 'tool_use')).toEqual(idsOf(trimmed, 'tool_result'))
    expect(idsOf(trimmed, 'tool_use')).not.toHaveLength(0)
  })

  it('always begins at the start of an exchange', () => {
    const trimmed = trimTranscript(build(9))
    expect(trimmed[0].role).toBe('user')
    expect(typeof trimmed[0].content).toBe('string')
  })

  it('drops whole exchanges until it is under the character ceiling', () => {
    // Three exchanges, each far over the ceiling on its own tool result.
    const trimmed = trimTranscript(build(3, 'x'.repeat(MAX_CHARS)))
    const questions = trimmed.filter((t) => t.role === 'user' && typeof t.content === 'string')
    expect(questions).toHaveLength(1)
    expect(questions[0].content).toBe('question 2')
  })

  it('keeps the newest exchange even when it alone exceeds the ceiling', () => {
    const trimmed = trimTranscript(exchange(0, 'x'.repeat(MAX_CHARS * 2)))
    expect(trimmed).toHaveLength(4)
    expect(idsOf(trimmed, 'tool_use')).toEqual(idsOf(trimmed, 'tool_result'))
  })

  it('discards anything before the first question', () => {
    const orphan: Turn[] = [{ role: 'assistant', content: [{ type: 'text', text: 'stray' }] }]
    const trimmed = trimTranscript([...orphan, ...exchange(1)])
    expect(trimmed[0].content).toBe('question 1')
  })

  it('returns a transcript with no questions unchanged', () => {
    const orphan: Turn[] = [{ role: 'assistant', content: [{ type: 'text', text: 'stray' }] }]
    expect(trimTranscript(orphan)).toEqual(orphan)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/advisor/trim.test.ts`
Expected: FAIL, `Failed to resolve import "./trim"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/advisor/trim.ts`:

```ts
/**
 * Bounding the conversation sent back to the model.
 *
 * The transcript is not a flat list of messages: an assistant turn may carry
 * tool_use blocks, and the user turn after it carries the matching
 * tool_result blocks. Cutting between those two is a 400 from the API, so a
 * slice by message count is not safe at any length.
 *
 * Only a user turn whose content is a STRING starts a new exchange. Tool
 * results are user-role as well, which is exactly the trap: testing the role
 * alone finds boundaries that are not boundaries.
 */

export type Turn = { role: 'user' | 'assistant'; content: unknown }

/** Six question-and-answer rounds is enough for real follow-up. */
export const MAX_EXCHANGES = 6

/**
 * Roughly 15k tokens, about $0.075 of input per question at the ceiling.
 * Tool results are JSON and dominate the size, so this is the limit that
 * usually bites first - the exchange count is the backstop, not the reverse.
 */
export const MAX_CHARS = 60_000

function startsExchange(turn: Turn): boolean {
  return turn.role === 'user' && typeof turn.content === 'string'
}

export function trimTranscript(
  turns: Turn[],
  maxExchanges: number = MAX_EXCHANGES,
  maxChars: number = MAX_CHARS,
): Turn[] {
  const starts: number[] = []
  turns.forEach((turn, i) => {
    if (startsExchange(turn)) starts.push(i)
  })
  // Nothing that looks like a question: leave it alone rather than guess.
  if (starts.length === 0) return turns

  let first = Math.max(0, starts.length - maxExchanges)
  // Whole exchanges, never messages - and never the last one, however big,
  // because a conversation with no current question is worth nothing.
  while (
    first < starts.length - 1 &&
    JSON.stringify(turns.slice(starts[first])).length > maxChars
  ) {
    first++
  }

  return turns.slice(starts[first])
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/advisor/trim.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Call it from the route**

In `src/app/api/advisor/chat/route.ts`, delete the local type on line 29:

```ts
type Turn = { role: 'user' | 'assistant'; content: unknown }
```

and import the shared one instead, adding to the existing imports at the top:

```ts
import { trimTranscript, type Turn } from '@/lib/advisor/trim'
```

Then change line 55 from:

```ts
    const turns = [...messages] as Anthropic.MessageParam[]
```

to:

```ts
    // Bounded here rather than in the browser: the route already returns the
    // array the client stores, so trimming once on the way in caps the cost of
    // this request AND the size of what the browser keeps.
    const turns = trimTranscript(messages) as Anthropic.MessageParam[]
```

- [ ] **Step 6: Verify the whole suite and types**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npm test -- --testTimeout=20000`
Expected: 0 failed. Test count rises by 8.

- [ ] **Step 7: Commit**

```bash
git add src/lib/advisor/trim.ts src/lib/advisor/trim.test.ts src/app/api/advisor/chat/route.ts
git commit -m "feat(advisor): cap the chat transcript without splitting a tool call"
```

---

### Task 2: A conversation belongs to a day

**Files:**
- Modify: `src/app/advisor/Chat.tsx:13` (comment), `:28` (signature), `:36-62` (storage)
- Modify: `src/app/advisor/AdvisorClient.tsx:537-539` (pass `day`)
- Modify: `src/app/advisor/Chat.test.tsx:7-10` (clear localStorage), add tests

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `Chat` accepts `{ day?: string | null }`, defaulting to `null`. Task 3 renders the same component and must keep that signature.

**Why the day comes from the server:** `writeBriefing` derives its day with `todayInZone(timezone)` (`src/lib/advisor/write.ts:30`). A browser-computed date would disagree with the briefing either side of midnight and wipe a conversation the page still considers current. `Briefing.day` already exists (`AdvisorClient.tsx:11`).

- [ ] **Step 1: Write the failing tests**

In `src/app/advisor/Chat.test.tsx`, replace the `afterEach` block at lines 7-10 with:

```tsx
afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
  // localStorage now outlives a test the way it outlives a tab, so a leak
  // here would let one test's conversation appear in the next one.
  window.localStorage.clear()
})
```

Then add this block inside `describe('Chat', ...)`, after the existing tests:

```tsx
  function seed(day: string | null, text: string) {
    window.localStorage.setItem(
      'advisor-chat',
      JSON.stringify({ day, bubbles: [{ role: 'user', text }], transcript: [] }),
    )
  }

  it('restores a conversation stored under the same day', () => {
    seed('2026-08-13', 'question from this morning')
    render(<Chat day="2026-08-13" />)
    expect(screen.getByText('question from this morning')).toBeInTheDocument()
  })

  it('starts empty when the stored conversation belongs to another day', () => {
    seed('2026-08-12', 'question from yesterday')
    render(<Chat day="2026-08-13" />)
    expect(screen.queryByText('question from yesterday')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('advisor-chat')).toBeNull()
  })

  // A briefing that failed to load must not destroy the conversation.
  it('keeps the conversation when no day is known yet', () => {
    seed('2026-08-12', 'question from yesterday')
    render(<Chat />)
    expect(screen.getByText('question from yesterday')).toBeInTheDocument()
  })

  it('keeps an unstamped conversation once a day arrives', () => {
    seed(null, 'asked before the briefing loaded')
    render(<Chat day="2026-08-13" />)
    expect(screen.getByText('asked before the briefing loaded')).toBeInTheDocument()
  })

  it('stamps what it saves with the current day', async () => {
    stubFetch({ reply: 'Answered.', messages: [] })
    render(<Chat day="2026-08-13" />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText('Answered.')).toBeInTheDocument())
    const stored = JSON.parse(window.localStorage.getItem('advisor-chat') as string)
    expect(stored.day).toBe('2026-08-13')
    expect(stored.bubbles).toHaveLength(2)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/advisor/Chat.test.tsx`
Expected: FAIL. The new tests fail because `Chat` takes no props and still writes to `sessionStorage`; TypeScript also rejects `<Chat day="…" />`.

- [ ] **Step 3: Rewrite the storage in `Chat.tsx`**

Replace the doc comment at lines 5-13 with:

```tsx
/**
 * Asking follow-up questions.
 *
 * The conversation lives in the browser: localStorage so closing the tab does
 * not lose it, stamped with the briefing's day so each morning starts fresh.
 * No server table, because a stored history is a schema, a list screen and a
 * retention question this feature does not need yet.
 */

const STORAGE_KEY = 'advisor-chat'
```

Replace the component signature at line 28 and the hydrate effect at lines 36-62 with:

```tsx
export function Chat({ day = null }: { day?: string | null }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // The model's own transcript, tool calls and all. Kept apart from the
  // bubbles, which are only what a person should read.
  const transcript = useRef<unknown[]>([])

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBubbles(Array.isArray(parsed.bubbles) ? parsed.bubbles : [])
      transcript.current = Array.isArray(parsed.transcript) ? parsed.transcript : []
    } catch {
      // A corrupt entry is not worth a broken page.
    }
  }, [day])

  function remember(next: Bubble[]) {
    setBubbles(next)
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ day, bubbles: next, transcript: transcript.current }),
    )
  }
```

Leave `send` and the JSX exactly as they are; Task 3 changes those.

- [ ] **Step 4: Pass the day in from the page**

In `src/app/advisor/AdvisorClient.tsx`, change lines 537-539 from:

```tsx
        <div className="mt-4">
          <Chat />
        </div>
```

to:

```tsx
        <Chat day={briefing?.day ?? null} />
```

The wrapper goes now rather than in Task 3 because Task 3's sticky composer cannot work inside it - see that task for why. `Chat` carries its own top margin from here on.

- [ ] **Step 5: Restore the spacing Chat just lost**

In `src/app/advisor/Chat.tsx`, add the top margin to the section element at line 98:

```tsx
    <section className="mt-4 rounded-[12px] border border-line bg-surface">
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/app/advisor/Chat.test.tsx`
Expected: PASS, 11 tests. The pre-existing "survives a refresh" test must still pass - it exercises the same restore path through localStorage now.

- [ ] **Step 7: Verify types and the whole suite**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npm test -- --testTimeout=20000`
Expected: 0 failed.

- [ ] **Step 8: Commit**

```bash
git add src/app/advisor/Chat.tsx src/app/advisor/Chat.test.tsx src/app/advisor/AdvisorClient.tsx
git commit -m "feat(advisor): a conversation survives the tab and ends with the day"
```

---

### Task 3: Dock the composer

**Files:**
- Modify: `src/app/advisor/Chat.tsx:97-158` (the whole return)
- Modify: `src/app/advisor/Chat.test.tsx` (scrollIntoView stub, new tests)

**Interfaces:**
- Consumes: `Chat({ day })` from Task 2, and the fact that `AdvisorClient` no longer wraps it in a div.
- Produces: no new exports.

**The one thing that will silently not work if you get it wrong:** `position: sticky` is constrained to its **parent's** content box. If the composer's parent is a short wrapper that only contains `Chat`, the element has nowhere to travel and will look completely static. It must be a direct child of `<main>` - which is what `PageBody` renders (`AppShell.tsx:386-388`) and why Task 2 deleted the wrapper div. Sticky is right here rather than `fixed` because no ancestor of `main` sets `overflow` (the only one is inside the sidebar's own nav, `AppShell.tsx:294`), because it inherits the content column width and so cannot overlap the 232px sidebar (`AppShell.tsx:283`), and because it occupies flow space, so nothing needs a spacer.

- [ ] **Step 1: Write the failing tests**

In `src/app/advisor/Chat.test.tsx`, add this stub directly below the existing imports, because jsdom does not implement `scrollIntoView` and the component will call it:

```tsx
// jsdom has no layout, so this method does not exist there.
Element.prototype.scrollIntoView = vi.fn()
```

Then add these tests inside `describe('Chat', ...)`:

```tsx
  it('shows no conversation card until something has been asked', () => {
    render(<Chat />)
    expect(screen.queryByRole('heading', { name: 'Ask' })).not.toBeInTheDocument()
    // The composer is always there, though.
    expect(screen.getByPlaceholderText(/Ask/i)).toBeInTheDocument()
  })

  it('offers no way to clear an empty conversation', () => {
    render(<Chat />)
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument()
  })

  it('clears the conversation and the stored copy', async () => {
    stubFetch({ reply: 'Answered.', messages: [{ role: 'user', content: 'A question' }] })
    render(<Chat day="2026-08-13" />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(screen.getByText('Answered.')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /clear/i }))

    expect(screen.queryByText('A question')).not.toBeInTheDocument()
    expect(screen.queryByText('Answered.')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('advisor-chat')).toBeNull()
    // And the examples come back, because the box is empty again.
    expect(screen.getAllByRole('button', { name: /why/i })[0]).toBeInTheDocument()
  })

  it('cannot be cleared while an answer is in flight', async () => {
    // A fetch that never settles leaves the component busy.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})))
    render(<Chat day="2026-08-13" />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText(/Looking it up/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /clear/i })).toBeDisabled()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/advisor/Chat.test.tsx`
Expected: FAIL. There is no Clear button, and the "Ask" heading renders even when empty.

- [ ] **Step 3: Add the clear handler and the scroll target**

In `src/app/advisor/Chat.tsx`, add `useRef` usage for the scroll anchor beside the existing `transcript` ref:

```tsx
  const endRef = useRef<HTMLDivElement>(null)
```

Add this function directly after `remember`:

```tsx
  function clear() {
    if (busy) return
    transcript.current = []
    setBubbles([])
    window.localStorage.removeItem(STORAGE_KEY)
  }
```

And add this effect after the hydrate effect, so a new answer brings itself into view:

```tsx
  // matchMedia is absent in jsdom, so guard rather than assume a browser.
  useEffect(() => {
    if (bubbles.length === 0) return
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    endRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' })
  }, [bubbles])
```

- [ ] **Step 4: Replace the whole return block**

Replace `src/app/advisor/Chat.tsx` lines 97-158 (everything from `return (` to the closing `)` of the component) with:

```tsx
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/advisor/Chat.test.tsx`
Expected: PASS, 15 tests.

- [ ] **Step 6: Verify types, lint and the whole suite**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npm run lint`
Expected: still 8 errors, 4 warnings. If the count rose, the new code caused it - fix that, not the baseline.

Run: `npm test -- --testTimeout=20000`
Expected: 0 failed.

- [ ] **Step 7: See it in a real browser**

Start the dev server in the background. **Never pipe it to `head`** - that wedges the process and holds the port:

```bash
npm run dev
```

Open `http://localhost:3000/advisor` and confirm, at a narrow window height so the page scrolls:

1. The composer stays visible at the bottom while the briefing scrolls behind it.
2. No conversation card and no "Ask" heading before the first question.
3. The three example chips sit in the composer, and disappear after one question.
4. Asking scrolls the answer into view above the composer.
5. Clear empties the thread and brings the chips back.
6. The composer never overlaps the left sidebar at desktop width.

Stop the server explicitly when done.

- [ ] **Step 8: Commit**

```bash
git add src/app/advisor/Chat.tsx src/app/advisor/Chat.test.tsx
git commit -m "feat(advisor): pin the Ask composer so it cannot be scrolled past"
```

---

## Done when

- `npm test -- --testTimeout=20000` reports 0 failed, with **17 more tests** than before: 8 in `trim.test.ts`, and `Chat.test.tsx` going from 6 to 15.
- `npx tsc --noEmit` is silent.
- `npm run lint` is still 8 errors, 4 warnings.
- The composer is reachable from anywhere on the Advisor page, a conversation survives a closed tab, and a conversation from yesterday does not.
