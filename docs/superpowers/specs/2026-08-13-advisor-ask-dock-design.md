# Advisor Ask: docked composer, daily conversation - design

**Date:** 2026-08-13
**Status:** approved, ready for an implementation plan
**Builds on:** `2026-08-10-ai-advisor-design.md`

## The ask

From the user:

> seems like the ask card is on the bottom can you update this page weather its on
> the top and im asking you if the client ask question here does the chat never
> delet or is it like idk a simple version give me approuch

Two things: the Ask box is buried, and nobody knows what happens to a conversation
after it is had.

## What already exists

| Piece | Where |
| --- | --- |
| Ask card: chips, bubbles, input row | `src/app/advisor/Chat.tsx` |
| Chat endpoint, 8 tool rounds, one 300s ceiling | `src/app/api/advisor/chat/route.ts` |
| Page composition, `<Chat />` last | `src/app/advisor/AdvisorClient.tsx:537-539` |
| Page shell, sidebar + content grid | `src/components/shell/AppShell.tsx:283-288` |
| `PageBody`, `children` only, no className | `src/components/shell/AppShell.tsx:386-388` |
| 6 chat tests | `src/app/advisor/Chat.test.tsx` |

Facts that shaped the design, all verified against the current code:

- The conversation lives in **`sessionStorage`** (`Chat.tsx:37,58`). It survives a
  page refresh and is destroyed when the tab closes. Nothing reaches the server.
- There is **no Clear control** and **no cap** on history.
- The transcript is resent **in full** on every question (`Chat.tsx:78`), so the
  tenth question in a sitting costs materially more than the first.
- The shop `Report` renders **only when there are no written items**
  (`AdvisorClient.tsx:533`). The two are mutually exclusive, so today's very long
  page is an artifact of the missing API key, not the normal state. Once briefings
  write, the page is a handful of ranked cards followed by Ask.

## Decisions

### The composer docks; the briefing stays first

A briefing is read before it is interrogated, so the ranked items keep the top of
the page. But a control nobody can see is a control nobody uses. Only the **input
row** pins to the bottom of the viewport; the conversation stays in the document.

Rejected: **moving the card to the top.** One line, but every morning would open on
an empty input rather than the ranked analysis the page exists to deliver. It would
read as a search engine, not a report.

Rejected: **a floating overlay panel.** It would cover the briefing and bring
z-index, scroll-locking and focus-trapping to a page that is a document, not an app
shell.

### A conversation belongs to a day

Storage moves to `localStorage`, stamped with the briefing's day. It survives
closing the tab; each morning's new briefing opens a fresh conversation. This
matches the product - a daily briefing deserves a daily chat - and bounds growth by
construction.

Rejected: **a server table.** A schema, a history screen and a retention policy for
one person on one laptop. The reasoning at `Chat.tsx:8-11` still holds.

## Design

### 1. The docked composer

`Chat` renders two things instead of one section:

- **The conversation card**, in normal flow, rendered only when
  `bubbles.length > 0 || busy`. Before the first question there is no card at all,
  extending the existing rule at `Chat.tsx:119-121`. This avoids an empty "Ask"
  heading sitting under the briefing every morning.
- **The composer**, `position: sticky; bottom: 0`, last in the flow, carrying the
  example chips while `bubbles.length === 0 && !busy`.

**Sticky, not fixed.** Three reasons, each verified:

1. No ancestor of `main` sets `overflow` - the only occurrence is inside the
   sidebar's own nav (`AppShell.tsx:294`) - so sticky is not silently disabled.
2. A sticky element inherits the content column's width, so it cannot overlap the
   232px sidebar (`AppShell.tsx:283`). A fixed bar spans the viewport and would
   have to have that width reconstructed by hand.
3. It occupies its space in the flow, so no spacer is needed and `PageBody` - which
   accepts only `children` (`AppShell.tsx:386`) - does not have to change.

Detail that makes it work: the composer keeps `border border-line bg-surface` so
briefing content cannot ghost through it while scrolling underneath, and gains
`env(safe-area-inset-bottom)` padding so iOS Safari's home indicator does not sit on
the Send button.

On send, the newest exchange scrolls into view, guarded by `prefers-reduced-motion`
to match the `motion-reduce:` convention already used in the file.

A **Clear** control sits beside the "Ask" heading in the conversation card, visible
only when there are bubbles. It empties bubbles, transcript and the stored entry.

### 2. The day-scoped conversation

The day comes from the briefing, not the browser:

```tsx
<Chat day={briefing?.day ?? null} />
```

This matters. `writeBriefing` derives its day with `todayInZone(timezone)`
(`src/lib/advisor/write.ts:30`), so a browser-computed date would disagree with the
briefing near midnight and wipe a conversation the page still considers current.

Stored under the existing key `advisor-chat`, now in `localStorage`:

```json
{ "day": "2026-08-13", "bubbles": [...], "transcript": [...] }
```

The old `sessionStorage` entry is a different store, so there is no collision and no
migration; any stale copy dies with the tab as it always did.

**Reset rule:** on mount, start empty only when a stored day and a current day both
exist *and differ*. A null `day` never wipes anything - a briefing that failed to
load must not destroy the conversation.

**Write rule:** every save stamps the entry with the current `day` prop, null
included. An entry written before the briefing loaded is therefore stamped null,
restores on the next mount rather than being discarded, and picks up a real day the
first time one is known.

### 3. Trimming the transcript, which is not a slice

Surviving a tab close means the transcript accumulates across a day, and every
question resends it. It must be capped, but it cannot be truncated naively. From
`chat/route.ts:78-106` the transcript interleaves four shapes:

```
{ role: 'user',      content: "why did revenue fall?" }   ← string
{ role: 'assistant', content: [ …, tool_use ] }           ← blocks
{ role: 'user',      content: [ tool_result, … ] }        ← blocks
{ role: 'assistant', content: [ text ] }
```

`slice(-n)` will eventually cut between a `tool_use` and its `tool_result`, and the
next request fails with a 400 - unpredictably, only in long conversations, only for
the one user who has them. The trim must cut at **exchange boundaries**, and the
predicate is the trap: tool results are user-role too, so role alone is not enough.

```ts
const startsExchange = (t: Turn) => t.role === 'user' && typeof t.content === 'string'
```

**Algorithm**, applied in the route immediately after `const turns = [...messages]`
and before the tool loop:

1. Collect the indices where `startsExchange` holds.
2. If there are more than **6**, drop everything before the 6th-from-last.
3. While `JSON.stringify(turns).length` exceeds **60,000** and more than one
   boundary remains, drop everything before the next boundary.
4. Never drop below the most recent exchange, however large it is.

The route already returns `messages: turns` (`chat/route.ts:86`) and the client
already stores what it is given (`Chat.tsx:88`), so trimming server-side bounds the
client's storage too - one implementation, one place. The visible bubbles keep the
whole day; they are text-only and cheap, and the code already separates them from
the transcript for exactly this reason (`Chat.tsx:32-34`).

Both numbers are first estimates. 60,000 characters is roughly 15k tokens, about
$0.075 of input per question at the ceiling. Tool results are JSON blobs and
dominate the size, so these should be re-tuned against a measured real conversation
rather than treated as settled.

## Edge cases

| Case | Behaviour |
| --- | --- |
| No briefing at all (`day` is null) | Asking still works; nothing is ever wiped |
| Stored day differs from today | Start empty, clear the entry, show the chips again |
| Corrupt stored JSON | Ignore and start empty, as `Chat.tsx:51` already does |
| Page shorter than the viewport | Sticky settles at the end of content; no floating bar |
| A single exchange over 60,000 chars | Kept whole; the API's own limits apply |
| Clear pressed mid-request | Disabled while `busy`, so the reply cannot land in a cleared thread |

## Testing

`Chat.test.tsx` grows from 6:

- chips render in the composer, and disappear after the first question
- a stored conversation from a different day starts empty
- a stored conversation from the same day is restored
- a null `day` restores rather than wipes
- Clear empties bubbles, transcript and storage
- Clear is unavailable while a request is in flight

Route-side, the trim gets its own tests, built to straddle the boundary because
that is the failure that would otherwise reach production:

- an over-long transcript is cut at an exchange boundary, never between a
  `tool_use` and its `tool_result`
- the character ceiling drops whole exchanges, not messages
- a transcript under both limits is returned unchanged

## Out of scope

No server table, no history screen, no retention policy, no streaming replies, no
change to the ranking or the Report. The briefing's content is untouched.
