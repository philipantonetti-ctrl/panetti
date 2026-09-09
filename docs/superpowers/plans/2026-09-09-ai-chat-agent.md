# AI Chat Agent on Gorgias Live Chat: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing Claude support assistant answer Gorgias live chats for one shop at a time (panetti.dk first), with a sandbox where an admin tests and corrects it, and a handover that gives the chat to a person and keeps the assistant silent afterwards.

**Architecture:** The August pipeline (`judge` -> `decide` -> `Channel`) is extended, not replaced. A chat turn is a new orchestrator (`chat.ts`) built from pure decision functions (`chat-turn.ts`) and the existing `Channel` seam, which grows two optional methods (`transcript`, `tag`) that only the Gorgias adapter implements. The sandbox runs the same judge with a capturing channel and records with `source = 'sandbox'`. Corrections become `example` knowledge items that the existing keyword retrieval finds.

**Tech Stack:** Next.js 15 app router, Prisma 6 on Postgres (local portable Postgres for tests, Neon in production), `@anthropic-ai/sdk` (model `claude-opus-5`), Vitest (`npx vitest run <file>`), Zod, Tailwind classes already used by the settings pages.

**Spec:** `docs/superpowers/specs/2026-09-09-ai-chat-agent-design.md`

## Global Constraints

- Model stays `claude-opus-5` (`ADVISOR_MODEL`). Chat turns use adaptive thinking (the Opus 5 default), `output_config: { effort: 'low' }`, `max_tokens: 1024`, client timeout 25 s.
- Nothing is sent to a customer unless: `Shop.aiChatFrom` is set and the chat started at or after it, rules mode is `auto`, the category is allowed, confidence clears the floor, no escalate keyword, the session is `ai`, and fewer than 8 replies so far. Draft mode never speaks to the customer, not even the handover line.
- A person writing on a chat silences the assistant on that ticket for good (`status = 'human'`). No hand-back.
- Every DB test uses tagged rows and cleans up (`[ai-chat-test]` style markers). No test touches Neon. No test spends Anthropic credits: `judge` is mocked in every integration test.
- Never run `git stash`, `git checkout -- .`, `git reset --hard` or any command that reverts work. Commit after every task with the trailer below.
- Commit trailer, every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE
  ```
- Branch: `feat/ai-chat-agent` (already created from `origin/main`, holds the spec commit). Memory note: the checkout can be moved by a background sync; run `git branch --show-current` after every commit and switch back if it moved.
- Copy for Philip's screens: plain sentences, no em dashes, no menu-path jargon.
- Prisma schema changes must be additive (nullable columns, new tables) so `prisma db push` on deploy accepts them.

## File structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | `Shop.aiChatFrom`, `AiChatSession`, three new columns on `AiConversation` |
| `src/lib/support/examples.ts` (+ `.integration.test.ts`) | A correction becomes an `example` knowledge item |
| `src/lib/support/agent.ts` (+ `agent.test.ts`) | `judge` learns history and chat mode; pure `judgeMessages` and `chatInstructions` |
| `src/lib/support/rules.ts` | `DEFAULT_ESCALATE_WORDS` |
| `src/lib/support/sandbox.ts` (+ `.integration.test.ts`) | One sandbox turn, capturing channel, records as `sandbox` |
| `src/app/api/support/sandbox/route.ts` (+ `.integration.test.ts`) | POST for the sandbox page |
| `src/app/support/sandbox/page.tsx`, `SandboxClient.tsx` | The sandbox screen |
| `src/app/api/support/conversations/route.ts`, `[id]/route.ts` | Source filter; correction promotes to example |
| `src/app/api/support/analytics/route.ts` | Sandbox rows excluded from counts |
| `src/app/support/ReviewClient.tsx` | Sandbox filter and link |
| `src/app/api/support/chat-settings/route.ts` (+ `.integration.test.ts`) | Per-shop `aiChatFrom`, webhook URL and body template |
| `src/app/settings/ai-support/SupportAiClient.tsx` | Per-shop live chat table; keyword pre-fill |
| `src/lib/support/client.ts` (+ `client.test.ts`) | `fetchTicketMessages`, `tagTicket` |
| `src/lib/support/channel.ts` | `TranscriptMessage`, optional `transcript`/`tag`, `messageId` |
| `src/lib/support/gorgias-channel.ts` (+ `gorgias-channel.test.ts`) | `replyChannelFor`, transcript and tag through Gorgias |
| `src/lib/support/chat-turn.ts` (+ `chat-turn.test.ts`) | Pure chat decisions: supersede, latch, turns, cap, handover line |
| `src/lib/support/chat.ts` (+ `chat.integration.test.ts`) | The chat turn orchestrator |
| `src/app/api/gorgias/webhook/route.ts` (+ existing `.integration.test.ts`) | `?shop=` and the chat branch |
| `README.md` | Gorgias chat setup for Philip |

## Shared interfaces (every task refers to these exact names)

```ts
// src/lib/support/agent.ts
export type Turn = { role: 'user' | 'assistant'; text: string }
export type ChatMode = { firstReply: boolean; customerKnown: boolean }
export function chatInstructions(mode: ChatMode): string
export function judgeMessages(input: {
  message: string; subject: string | null; context: CustomerContext; knowledge: KnowledgeRow[]; history?: Turn[]
}): Anthropic.MessageParam[]
export async function judge(input: {
  message: string; subject: string | null; context: CustomerContext; knowledge: KnowledgeRow[]
  extraInstructions: string; history?: Turn[]; chat?: ChatMode
}): Promise<SupportJudgement>

// src/lib/support/channel.ts
export type TranscriptMessage = { id: string; fromAgent: boolean; text: string; at: string }
export type IncomingMessage = { conversationId: string; customerEmail: string | null; customerName: string | null
  text: string; subject: string | null; via: string | null; messageId?: string | null }
export type Channel = {
  name: string
  sendMessage(conversationId: string, text: string): Promise<void>
  addInternalNote(conversationId: string, text: string): Promise<void>
  transcript?(conversationId: string): Promise<TranscriptMessage[]>
  tag?(conversationId: string, tag: string): Promise<void>
}

// src/lib/support/chat-turn.ts
export const REPLY_CAP = 8
export const BURST_WAIT_MS = 6_000
export const OWN_TEXT_WINDOW_MS = 15 * 60_000
export const HANDOVER_LINES: Record<string, string>
export function handoverLine(language: string | null): string
export function normalise(text: string): string
export function superseded(transcript: TranscriptMessage[], messageId: string): boolean
export function humanTookOver(transcript: TranscriptMessage[], ownTexts: string[]): boolean
export function turnsOf(transcript: TranscriptMessage[], limit?: number): Turn[]
export function splitForJudge(turns: Turn[], fallback: string): { history: Turn[]; message: string }

// src/lib/support/chat.ts
export type ChatIncoming = { shopId: string; conversationId: string; messageId: string; customerEmail: string | null
  customerName: string | null; text: string; via: string | null; fromAgent: boolean; conversationStartedAt: Date | null }
export type ChatDeps = { channel: Channel; wait?: (ms: number) => Promise<void>
  rules?: RulesConfig & { extraInstructions: string }; now?: () => Date }
export type ChatResult = { decision: 'sent' | 'drafted' | 'escalated' | 'skipped' | 'superseded'; reason: string | null }
export async function handleChatMessage(incoming: ChatIncoming, deps: ChatDeps): Promise<ChatResult>

// src/lib/support/sandbox.ts
export type SandboxTurnInput = { shopId: string; customerEmail: string | null; messages: Turn[]; sessionKey: string }
export type SandboxTurnResult = { conversationId: string; reply: string | null; action: 'send' | 'draft' | 'escalate'
  reason: string | null; category: string; language: string; confidence: number
  knowledge: { kind: string; title: string }[]
  saw: { customer: string | null; orders: { number: string; shop: string; status: string; delivery: string | null; parcels: string[] }[] } }
export async function runSandboxTurn(input: SandboxTurnInput, deps?: { rules?: RulesConfig & { extraInstructions: string } }): Promise<SandboxTurnResult>

// src/lib/support/examples.ts
export async function promoteCorrection(conversationId: string, correction: string): Promise<{ knowledgeItemId: string } | null>

// src/lib/support/rules.ts
export const DEFAULT_ESCALATE_WORDS = ['menneske', 'person', 'medarbejder', 'kundeservice', 'human', 'agent']

// src/lib/support/client.ts
export type GorgiasTicketMessage = { id: number; from_agent: boolean | null; public: boolean | null; channel: string | null
  via: string | null; body_text: string | null; created_datetime: string | null
  sender: { id?: number | null; name?: string | null; email?: string | null } | null }
export async function fetchTicketMessages(creds: GorgiasCredentials, ticketId: string, deadline?: number): Promise<GorgiasTicketMessage[]>
export async function tagTicket(creds: GorgiasCredentials, ticketId: string, tag: string): Promise<void>

// src/lib/support/gorgias-channel.ts
export function replyChannelFor(via: string | null): string
```

---

## Phase 1: sandbox, learning loop, per-shop switch

### Task 1: Schema

**Files:**
- Modify: `prisma/schema.prisma` (Shop block around line 50 and line 89; AiConversation block around line 1464)

**Interfaces:**
- Produces: `Shop.aiChatFrom`, model `AiChatSession`, `AiConversation.shopId/sessionId/externalMessageId`.

- [ ] **Step 1: Add the shop switch and relation**

In `model Shop`, directly after the `wooNotesFrom` field:

```prisma
  /// Null = the assistant never answers this shop's live chats, which is what
  /// every shop reads until someone switches one on. Set = a chat whose
  /// Gorgias ticket was created at or after this instant may be answered by
  /// the assistant, under the shared rules in AiSupportRules.
  ///
  /// A date rather than a boolean, compared against the chat's own start
  /// time, for the same reason as wooNotesFrom above: switching a shop on can
  /// never reach a chat already in progress.
  aiChatFrom           DateTime?
```

Next to the `knowledgeItems KnowledgeItem[]` relation line, add:

```prisma
  aiChatSessions        AiChatSession[]
```

- [ ] **Step 2: Add the session table and the conversation columns**

Directly after `model AiConversation { ... }` add:

```prisma
/// One live chat the assistant has been asked about, and whether it may still
/// speak there.
///
/// The status is a one-way latch. `ai` means it may reply. `handed_over`
/// means it handed the chat to a person and will never write on it again.
/// `human` means a person wrote on the chat, which silences the assistant for
/// good on that ticket. There is no hand-back in this version, deliberately:
/// two writers on one chat window is the failure everyone would notice.
model AiChatSession {
  id String @id @default(cuid())

  shopId String
  shop   Shop   @relation(fields: [shopId], references: [id], onDelete: Cascade)

  /// The channel's name and its own id for the conversation.
  source           String @default("gorgias")
  externalTicketId String

  /// ai | handed_over | human
  status String @default("ai")

  customerEmail String?
  /// Last language the assistant detected, nb | sv | da | fi | de | en.
  language      String?

  /// The newest customer message we have been told about.
  lastCustomerMessageId String?
  /// Replies the assistant has sent on this chat. Eight is the runaway cap.
  replies               Int     @default(0)

  handedOverAt   DateTime?
  handoverReason String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  conversations AiConversation[]

  @@unique([source, externalTicketId])
  @@index([shopId, status])
}
```

Inside `model AiConversation`, after `orderNumber String?` add:

```prisma
  /// Which shop's chat or email it came from. Null for rows written before
  /// shops were known here.
  shopId String?

  /// The live chat this turn belongs to. Null for email and sandbox rows.
  sessionId String?
  session   AiChatSession? @relation(fields: [sessionId], references: [id], onDelete: SetNull)

  /// The channel's own id for the customer message this row answers. This is
  /// the double-answer guard for chat: a row is CLAIMED with this id before
  /// the assistant is asked, so a second delivery of the same message fails
  /// the unique constraint and answers nothing. Null where the channel does
  /// not number messages (email, sandbox).
  externalMessageId String?
```

And add, beside the existing `@@unique([source, externalTicketId, createdAt])`:

```prisma
  @@unique([source, externalMessageId])
  @@index([sessionId])
```

Postgres treats NULLs as distinct in a unique index, so the many null `externalMessageId` rows do not collide.

- [ ] **Step 3: Validate, push to the local database, regenerate the client**

Run:
```bash
npx prisma validate && npx prisma db push && npx prisma generate
```
Expected: "The schema is valid", "Your database is now in sync", client generated. If `db push` warns about data loss, STOP: the change was not additive.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(support): per-shop chat switch, chat sessions and message-claim columns

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 2: A correction becomes an example

**Files:**
- Create: `src/lib/support/examples.ts`
- Create: `src/lib/support/examples.integration.test.ts`
- Modify: `src/app/api/support/conversations/[id]/route.ts`

**Interfaces:**
- Consumes: `knowledgeFor` from `./knowledge`, `db`.
- Produces: `promoteCorrection(conversationId, correction): Promise<{ knowledgeItemId: string } | null>`.

- [ ] **Step 1: Write the failing test**

`src/lib/support/examples.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { promoteCorrection } from './examples'
import { knowledgeFor } from './knowledge'

/**
 * The correction loop, closed: what a person typed as "it should have said"
 * is found by the retrieval the assistant actually uses, scoped to the shop
 * and language it was said in.
 */
const TAG = '[ai-example-test]'

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { body: { contains: TAG } } })
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: 'EX-' } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(cleanup)

describe('promoteCorrection', () => {
  it('turns a correction into an example the next similar question can find', async () => {
    const shop = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'DKK' } })
    const conv = await db.aiConversation.create({
      data: {
        source: 'sandbox', externalTicketId: 'EX-1', shopId: shop.id, language: 'da',
        question: 'Kan jeg bytte pizzaovnen til en anden model?', decision: 'drafted',
      },
    })

    const promoted = await promoteCorrection(conv.id, `Ja, inden 14 dage, hvis den er uåbnet. ${TAG}`)

    expect(promoted).not.toBeNull()
    const item = await db.knowledgeItem.findUniqueOrThrow({ where: { id: promoted!.knowledgeItemId } })
    expect(item).toMatchObject({
      kind: 'example', shopId: shop.id, language: 'da', active: true,
      title: 'Kan jeg bytte pizzaovnen til en anden model?',
    })

    const found = await knowledgeFor('Hej, kan jeg bytte pizzaovnen?', { shopId: shop.id, language: 'da' })
    expect(found.some((r) => r.kind === 'example' && r.body.includes(TAG))).toBe(true)

    const updated = await db.aiConversation.findUniqueOrThrow({ where: { id: conv.id } })
    expect(updated.rating).toBe('bad')
    expect(updated.correction).toContain('14 dage')
  })

  it('is not offered to another shop or language', async () => {
    const shop = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'DKK' } })
    const other = await db.shop.create({ data: { name: `Mazzetti ${TAG}`, currency: 'NOK' } })
    const conv = await db.aiConversation.create({
      data: { source: 'sandbox', externalTicketId: 'EX-2', shopId: shop.id, language: 'da', question: 'Bytte pizzaovnen?', decision: 'drafted' },
    })
    await promoteCorrection(conv.id, `Ja. ${TAG}`)

    const elsewhere = await knowledgeFor('bytte pizzaovnen', { shopId: other.id, language: 'nb' })
    expect(elsewhere.some((r) => r.body.includes(TAG))).toBe(false)
  })

  it('does nothing for a blank correction or an unknown conversation', async () => {
    expect(await promoteCorrection('no-such-id', 'text')).toBeNull()
    const conv = await db.aiConversation.create({
      data: { source: 'sandbox', externalTicketId: 'EX-3', question: 'q', decision: 'drafted' },
    })
    expect(await promoteCorrection(conv.id, '   ')).toBeNull()
    expect(await db.knowledgeItem.count({ where: { body: { contains: TAG } } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/lib/support/examples.integration.test.ts`
Expected: FAIL, cannot find module `./examples`.

- [ ] **Step 3: Implement**

`src/lib/support/examples.ts`:

```ts
import { db } from '@/lib/db'

/**
 * A correction becomes an example the assistant can find next time.
 *
 * Until now a correction was stored and read by nobody: the review page kept
 * "what it should have said" beside the answer and nothing downstream ever
 * looked. This writes it where retrieval looks - a KnowledgeItem of kind
 * `example`, title = the customer's question, body = the corrected answer,
 * scoped to the shop and language of the conversation it came from. The
 * existing keyword overlap in knowledgeFor() surfaces it for a similar
 * question, and the prompt tells the model to follow a matching example.
 *
 * The conversation row keeps the correction too, as the record of what was
 * typed and when.
 */

/** KnowledgeItem.title is what the retrieval matches on; the question is cut to fit. */
const TITLE_LIMIT = 200

export async function promoteCorrection(
  conversationId: string,
  correction: string,
): Promise<{ knowledgeItemId: string } | null> {
  const text = correction.trim()
  if (!text) return null

  const row = await db.aiConversation.findUnique({
    where: { id: conversationId },
    select: { question: true, shopId: true, language: true },
  })
  if (!row) return null

  const item = await db.knowledgeItem.create({
    data: {
      kind: 'example',
      title: row.question.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT) || 'Customer question',
      body: text,
      shopId: row.shopId,
      language: row.language,
    },
  })
  await db.aiConversation.update({
    where: { id: conversationId },
    data: { rating: 'bad', correction: text },
  })
  return { knowledgeItemId: item.id }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/support/examples.integration.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Wire the review page's correction through it**

In `src/app/api/support/conversations/[id]/route.ts`, add the import and replace the body of `PATCH` after `const { id } = await params`:

```ts
import { promoteCorrection } from '@/lib/support/examples'
```

```ts
    const { id } = await params
    const correction = parsed.data.correction?.trim() || null

    // A non-empty correction is the teaching moment: it becomes an example
    // the assistant retrieves, not only a note beside the answer.
    if (correction) {
      const promoted = await promoteCorrection(id, correction)
      if (!promoted) {
        return NextResponse.json({ error: 'No such conversation' }, { status: 404, headers: NO_STORE })
      }
      return NextResponse.json({ ok: true, knowledgeItemId: promoted.knowledgeItemId }, { headers: NO_STORE })
    }

    const updated = await db.aiConversation.updateMany({
      where: { id },
      data: {
        ...(parsed.data.rating !== undefined ? { rating: parsed.data.rating } : {}),
        ...(parsed.data.correction !== undefined ? { correction: null } : {}),
      },
    })
    if (updated.count === 0) {
      return NextResponse.json({ error: 'No such conversation' }, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
```

- [ ] **Step 6: Type-check and run the support suite**

Run: `npx tsc --noEmit && npx vitest run src/lib/support src/app/api/support`
Expected: all passed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/support/examples.ts src/lib/support/examples.integration.test.ts "src/app/api/support/conversations/[id]/route.ts"
git commit -m "feat(support): a correction becomes an example the assistant retrieves

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 3: The judge learns history and chat mode

**Files:**
- Modify: `src/lib/support/agent.ts`
- Modify: `src/lib/support/rules.ts` (add `DEFAULT_ESCALATE_WORDS`)
- Create: `src/lib/support/agent.test.ts`

**Interfaces:**
- Produces: `Turn`, `ChatMode`, `chatInstructions`, `judgeMessages`, `judge` with `history?` and `chat?`; `DEFAULT_ESCALATE_WORDS`.

- [ ] **Step 1: Write the failing tests (pure, no network)**

`src/lib/support/agent.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { chatInstructions, judgeMessages, type Turn } from './agent'
import type { CustomerContext } from '@/lib/inbox/context'

/** The prompt pieces a chat turn adds, proven without a model in the room. */

const nobody: CustomerContext = { customer: null, orders: [], previousTickets: [] }

describe('chatInstructions', () => {
  it('asks for short chat answers and to hand over on request, every time', () => {
    const text = chatInstructions({ firstReply: false, customerKnown: true })
    expect(text).toMatch(/live chat/i)
    expect(text).toMatch(/few short sentences/i)
    expect(text).toMatch(/asks for a person/i)
  })

  it('says who it is only on the first reply', () => {
    expect(chatInstructions({ firstReply: true, customerKnown: true })).toMatch(/Panetti's assistant/)
    expect(chatInstructions({ firstReply: false, customerKnown: true })).not.toMatch(/Panetti's assistant/)
  })

  it('asks for the order number and email when it holds no orders', () => {
    expect(chatInstructions({ firstReply: false, customerKnown: false })).toMatch(/order number and the email/i)
    expect(chatInstructions({ firstReply: false, customerKnown: true })).not.toMatch(/order number and the email/i)
  })
})

describe('judgeMessages', () => {
  it('sends one user message when there is no history, as before', () => {
    const msgs = judgeMessages({ message: 'Hvor er pakken?', subject: 'Pakke', context: nobody, knowledge: [] })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(String(msgs[0].content)).toContain('CUSTOMER CONTEXT')
    expect(String(msgs[0].content)).toContain('(subject: Pakke)')
    expect(String(msgs[0].content)).toContain('Hvor er pakken?')
  })

  it('replays the conversation as alternating turns, facts first, the new message last', () => {
    const history: Turn[] = [
      { role: 'user', text: 'Hej' },
      { role: 'assistant', text: 'Hej! Jeg er Panettis assistent.' },
    ]
    const msgs = judgeMessages({ message: 'Hvor er min ordre 14689?', subject: null, context: nobody, knowledge: [], history })
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user'])
    expect(String(msgs[0].content)).toContain('KNOWLEDGE BASE')
    expect(String(msgs[0].content)).toContain('CONVERSATION SO FAR')
    expect(msgs[1].content).toBe('Hej')
    expect(msgs[2].content).toBe('Hej! Jeg er Panettis assistent.')
    expect(String(msgs[3].content)).toContain('Hvor er min ordre 14689?')
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run src/lib/support/agent.test.ts`
Expected: FAIL, `chatInstructions` / `judgeMessages` are not exported.

- [ ] **Step 3: Implement in `agent.ts`**

Add after `SupportJudgement`:

```ts
/** One turn of a conversation, as the model replays it. */
export type Turn = { role: 'user' | 'assistant'; text: string }

/** What is different about a live chat turn. */
export type ChatMode = {
  /** The assistant has not spoken in this chat yet, so it introduces itself. */
  firstReply: boolean
  /** We hold orders for this customer. False means it must not state order facts. */
  customerKnown: boolean
}

/**
 * The extra rules for a chat window. Appended to the system prompt as its
 * own block so the cached first block stays byte-identical for email and chat.
 */
export function chatInstructions(mode: ChatMode): string {
  const lines = [
    'THIS IS A LIVE CHAT, not an email. Answer in a few short sentences, the way a person types',
    'in a chat window. No greeting line on every turn, no sign-off.',
    'If the customer asks for a person, a human, an agent or a colleague, set wantsHuman to true',
    'and put one short sentence in reply saying you are getting a colleague.',
    'If you cannot answer from the facts and knowledge in front of you, say so in one sentence and',
    'set wantsHuman to true rather than guessing.',
  ]
  if (mode.firstReply) {
    lines.push(
      'This is your first reply in this chat: say in one short clause that you are Panetti\'s assistant',
      'and that the customer can ask for a person at any time.',
    )
  }
  if (!mode.customerKnown) {
    lines.push(
      'You have no orders in front of you for this customer. For anything about an order or a parcel,',
      'ask for the order number and the email used at checkout, and state no order facts until then.',
    )
  }
  return lines.join('\n')
}

/**
 * The messages array, built once here so the shape is testable without a
 * model. No history: one user message, as before. With history: the facts
 * and knowledge first, then the conversation replayed as turns, then what
 * the customer just wrote.
 */
export function judgeMessages(input: {
  message: string
  subject: string | null
  context: CustomerContext
  knowledge: KnowledgeRow[]
  history?: Turn[]
}): Anthropic.MessageParam[] {
  const facts = [contextBlock(input.context), '', knowledgeBlock(input.knowledge)].join('\n')
  if (!input.history?.length) {
    return [
      {
        role: 'user',
        content: [
          facts,
          '',
          `THE CUSTOMER WROTE${input.subject ? ` (subject: ${input.subject})` : ''}:`,
          input.message,
        ].join('\n'),
      },
    ]
  }
  return [
    {
      role: 'user',
      content: `${facts}\n\nTHE CONVERSATION SO FAR follows, oldest first. Your own earlier replies are the assistant turns.`,
    },
    ...input.history.map((t) => ({ role: t.role, content: t.text })),
    { role: 'user', content: `THE CUSTOMER NOW WROTE:\n${input.message}` },
  ]
}
```

Change the `judge` signature and body:

```ts
export async function judge(input: {
  message: string
  subject: string | null
  context: CustomerContext
  knowledge: KnowledgeRow[]
  extraInstructions: string
  history?: Turn[]
  chat?: ChatMode
}): Promise<SupportJudgement> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new NoApiKey('No ANTHROPIC_API_KEY is configured, so the assistant cannot read tickets.')

  // A chat window is waited on; an email is not. The chat budget is short on
  // purpose - a reply that takes a minute to arrive is a reply nobody reads.
  const client = new Anthropic({ apiKey, timeout: input.chat ? 25_000 : 60_000, maxRetries: 1 })
  const system = [
    { type: 'text' as const, text: SYSTEM, cache_control: { type: 'ephemeral' as const } },
    ...(input.chat ? [{ type: 'text' as const, text: chatInstructions(input.chat) }] : []),
    ...(input.extraInstructions.trim()
      ? [{ type: 'text' as const, text: `HOUSE INSTRUCTIONS:\n${input.extraInstructions.trim()}` }]
      : []),
  ]

  const res = await client.messages.create({
    model: ADVISOR_MODEL,
    max_tokens: input.chat ? 1024 : 2000,
    ...(input.chat ? { output_config: { effort: 'low' as const } } : {}),
    system,
    tools: [
      {
        name: 'answer',
        description: 'Your reading of this conversation and what to say about it.',
        input_schema: SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'answer' },
    messages: judgeMessages(input),
  })
```

Keep everything after `const res = ...` (the refusal check and the mapping) exactly as it is. Also add one line to the `SYSTEM` prompt, after rule 4:

```
5. When the KNOWLEDGE BASE holds an [example] whose question matches this one, follow its
   answer: it is what a person said the reply should have been.
```

In `src/lib/support/rules.ts`, after `DEFAULT_RULES`:

```ts
/**
 * Words that mean "I want a person", pre-filled once into the shared escalate
 * list when it is empty. Danish first because panetti.dk is the first shop
 * whose chat the assistant answers. Philip edits the list on the settings page.
 */
export const DEFAULT_ESCALATE_WORDS = ['menneske', 'person', 'medarbejder', 'kundeservice', 'human', 'agent']
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `npx vitest run src/lib/support/agent.test.ts src/lib/support/handle.integration.test.ts && npx tsc --noEmit`
Expected: all passed, no type errors. If `output_config` is rejected by the SDK types, check `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` for `output_config` (it is there at SDK 0.7x+); do not remove it silently.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support/agent.ts src/lib/support/agent.test.ts src/lib/support/rules.ts
git commit -m "feat(support): the judge replays a conversation and knows it is in a chat window

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 4: A sandbox turn

**Files:**
- Create: `src/lib/support/sandbox.ts`
- Create: `src/lib/support/sandbox.integration.test.ts`

**Interfaces:**
- Consumes: `judge`, `Turn`, `ChatMode` (Task 3), `decide`, `DEFAULT_RULES`, `RulesConfig`, `knowledgeFor`, `getCustomerContext`.
- Produces: `runSandboxTurn(input, deps?)`, `SandboxTurnInput`, `SandboxTurnResult`.

- [ ] **Step 1: Write the failing test**

`src/lib/support/sandbox.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

/**
 * The practice room. The judge is mocked (no credits spent), nothing has a
 * channel to reach, and every run is filed under source = sandbox so the
 * review counts never mistake practice for customers.
 */
const judge = vi.fn()
vi.mock('./agent', async () => {
  const actual = await vi.importActual<typeof import('./agent')>('./agent')
  return { ...actual, judge: (...args: unknown[]) => judge(...args) }
})

const { runSandboxTurn } = await import('./sandbox')

const TAG = '[ai-sandbox-test]'
const EMAIL = 'mette.sandbox@example.invalid'

const judgement = (over = {}) => ({
  category: 'shipping', language: 'da', confidence: 0.95, wantsHuman: false,
  escalationReason: null, summary: 'Asks where the parcel is.', reply: 'Din pakke er på vej.', ...over,
})

async function cleanup() {
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: 'sandbox:test-' } } })
  await db.knowledgeItem.deleteMany({ where: { title: { startsWith: TAG } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

let shopId = ''
beforeEach(async () => {
  await cleanup()
  judge.mockReset()
  judge.mockResolvedValue(judgement())
  shopId = (await db.shop.create({ data: { name: `Panetti Denmark ${TAG}`, currency: 'DKK' } })).id
  await db.order.create({
    data: {
      shopId, externalId: 'sb-1', number: '14689', placedAt: new Date('2026-09-06'), status: 'completed',
      currency: 'DKK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: 'Mette', customerEmail: EMAIL,
    },
  })
})

const rules = { mode: 'draft', autoCategories: ['shipping'], escalateKeywords: [], minConfidence: 0.8, extraInstructions: '' }

describe('runSandboxTurn', () => {
  it('judges as if live even while the rules say draft, and records the run as sandbox', async () => {
    const r = await runSandboxTurn(
      { shopId, customerEmail: EMAIL, sessionKey: 'test-1', messages: [{ role: 'user', text: 'Hvor er min pakke?' }] },
      { rules },
    )

    expect(r.action).toBe('send')
    expect(r.reply).toBe('Din pakke er på vej.')
    expect(r.saw.orders.map((o) => o.number)).toEqual(['14689'])
    const row = await db.aiConversation.findUniqueOrThrow({ where: { id: r.conversationId } })
    expect(row).toMatchObject({ source: 'sandbox', externalTicketId: 'sandbox:test-1', shopId, decision: 'sent', question: 'Hvor er min pakke?' })
  })

  it('passes the earlier turns as history and says it is not the first reply', async () => {
    await runSandboxTurn(
      {
        shopId, customerEmail: null, sessionKey: 'test-2',
        messages: [
          { role: 'user', text: 'Hej' },
          { role: 'assistant', text: 'Hej, jeg er Panettis assistent.' },
          { role: 'user', text: 'Kan I sende til Bornholm?' },
        ],
      },
      { rules },
    )

    const call = judge.mock.calls[0][0]
    expect(call.history).toEqual([
      { role: 'user', text: 'Hej' },
      { role: 'assistant', text: 'Hej, jeg er Panettis assistent.' },
    ])
    expect(call.message).toBe('Kan I sende til Bornholm?')
    expect(call.chat).toEqual({ firstReply: false, customerKnown: false })
  })

  it('reports why it would not send, and offers the shop-scoped knowledge it used', async () => {
    await db.knowledgeItem.create({
      data: { kind: 'policy', title: `${TAG} Levering til Bornholm`, body: 'Vi sender til Bornholm med Bring.', shopId, language: 'da' },
    })
    judge.mockResolvedValue(judgement({ category: 'product', confidence: 0.5 }))

    const r = await runSandboxTurn(
      { shopId, customerEmail: null, sessionKey: 'test-3', messages: [{ role: 'user', text: 'Levering til Bornholm?' }] },
      { rules },
    )

    expect(r.action).toBe('draft')
    expect(r.reason).toMatch(/"product" is not a question the assistant may answer by itself/)
    expect(r.knowledge.map((k) => k.title)).toContain(`${TAG} Levering til Bornholm`)
    expect(judge.mock.calls[0][0].knowledge.some((k: { title: string }) => k.title.includes('Bornholm'))).toBe(true)
  })

  it('hands over when the customer asks for a person, whatever the judge said', async () => {
    const r = await runSandboxTurn(
      { shopId, customerEmail: null, sessionKey: 'test-4', messages: [{ role: 'user', text: 'Jeg vil tale med et menneske' }] },
      { rules: { ...rules, escalateKeywords: ['menneske'] } },
    )
    expect(r.action).toBe('escalate')
    expect(r.reason).toMatch(/menneske/)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/lib/support/sandbox.integration.test.ts`
Expected: FAIL, cannot find module `./sandbox`.

- [ ] **Step 3: Implement**

`src/lib/support/sandbox.ts`:

```ts
import { db } from '@/lib/db'
import { judge, NoApiKey, type ChatMode, type SupportJudgement, type Turn } from './agent'
import { getCustomerContext } from './channel'
import { knowledgeFor } from './knowledge'
import { decide, DEFAULT_RULES, type RulesConfig } from './rules'

/**
 * One turn in the practice room.
 *
 * The same judge, the same knowledge scoping and the same gates as a live
 * chat, with two deliberate differences: nothing has a channel to reach, and
 * the rules' mode is treated as `auto`, so a shop still in draft mode is
 * tested as if it were live. Every run is recorded with source = sandbox so
 * the review page can show it and the counts can leave it out.
 */

export type SandboxTurnInput = {
  shopId: string
  customerEmail: string | null
  /** The whole transcript so far; the last entry is the new customer message. */
  messages: Turn[]
  /** The page's key for this practice conversation, so its turns group together. */
  sessionKey: string
}

export type SandboxTurnResult = {
  /** The AiConversation row, for Good / Wrong on the page. */
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

export class SandboxError extends Error {}

async function loadRules(): Promise<RulesConfig & { extraInstructions: string }> {
  const row = await db.aiSupportRules.findUnique({ where: { id: 'singleton' } })
  if (!row) return { ...DEFAULT_RULES, extraInstructions: '' }
  return {
    mode: row.mode,
    autoCategories: row.autoCategories,
    escalateKeywords: row.escalateKeywords,
    minConfidence: row.minConfidence,
    extraInstructions: row.extraInstructions,
  }
}

export async function runSandboxTurn(
  input: SandboxTurnInput,
  deps: { rules?: RulesConfig & { extraInstructions: string } } = {},
): Promise<SandboxTurnResult> {
  const last = input.messages[input.messages.length - 1]
  if (!last || last.role !== 'user' || !last.text.trim()) {
    throw new SandboxError('The last message must be something the customer wrote.')
  }
  const shop = await db.shop.findUnique({ where: { id: input.shopId }, select: { id: true } })
  if (!shop) throw new SandboxError('No such shop.')

  const rules = deps.rules ?? (await loadRules())
  const history = input.messages.slice(0, -1)
  const message = last.text.trim()

  const context = input.customerEmail
    ? await getCustomerContext(input.customerEmail)
    : { customer: null, orders: [], previousTickets: [] }

  const knowledge = await knowledgeFor(message, {
    shopId: input.shopId,
    country: context.customer?.country ?? null,
    skus: context.orders.flatMap((o) => o.products.map((p) => p.name)).slice(0, 20),
  })

  const chat: ChatMode = {
    firstReply: !history.some((t) => t.role === 'assistant'),
    customerKnown: context.orders.length > 0,
  }

  let judgement: SupportJudgement
  try {
    judgement = await judge({ message, subject: null, context, knowledge, extraInstructions: rules.extraInstructions, history, chat })
  } catch (e) {
    // The practice room says what went wrong instead of pretending to hand over.
    throw new SandboxError(e instanceof NoApiKey ? e.message : 'The assistant could not be reached.')
  }

  // As if live: the mode is the one thing the sandbox overrides.
  const verdict = decide(
    { category: judgement.category, confidence: judgement.confidence, wantsHuman: judgement.wantsHuman },
    message,
    { ...rules, mode: 'auto' },
  )
  const decision = verdict.action === 'send' ? 'sent' : verdict.action === 'draft' ? 'drafted' : 'escalated'
  const reason = verdict.action === 'escalate' ? (judgement.escalationReason ?? verdict.reason) : verdict.reason

  const row = await db.aiConversation.create({
    data: {
      source: 'sandbox',
      externalTicketId: `sandbox:${input.sessionKey}`,
      shopId: input.shopId,
      customerEmail: input.customerEmail,
      question: message.slice(0, 5000),
      answer: judgement.reply,
      category: judgement.category,
      language: judgement.language,
      confidence: judgement.confidence,
      decision,
      escalationReason: reason,
      summary: judgement.summary,
      orderNumber: context.orders[0]?.number ?? null,
    },
  })

  return {
    conversationId: row.id,
    reply: judgement.reply,
    action: verdict.action,
    reason,
    category: judgement.category,
    language: judgement.language,
    confidence: judgement.confidence,
    knowledge: knowledge.map((k) => ({ kind: k.kind, title: k.title })),
    saw: {
      customer: context.customer ? `${context.customer.name || 'name unknown'} (${context.customer.email})` : null,
      orders: context.orders.map((o) => ({
        number: o.number,
        shop: o.shop,
        status: o.status,
        delivery: o.deliveryPhrase,
        parcels: o.parcels.map((p) => p.number),
      })),
    },
  }
}
```

Check `Parcel` from `src/lib/delivery/view` has a `number` field (it does: `parcel.number` is used in `contextBlock`). If its name differs, use the same field `contextBlock` uses.

- [ ] **Step 4: Run the test and type-check**

Run: `npx vitest run src/lib/support/sandbox.integration.test.ts && npx tsc --noEmit`
Expected: 4 passed, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support/sandbox.ts src/lib/support/sandbox.integration.test.ts
git commit -m "feat(support): a sandbox turn judges as if live and records itself as practice

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 5: The sandbox route

**Files:**
- Create: `src/app/api/support/sandbox/route.ts`
- Create: `src/app/api/support/sandbox/route.integration.test.ts`

**Interfaces:**
- Consumes: `runSandboxTurn`, `SandboxError` (Task 4).
- Produces: `POST /api/support/sandbox` taking `{ shopId, customerEmail?, sessionKey, messages }`, answering `SandboxTurnResult` or `{ error }`.

- [ ] **Step 1: Write the failing test**

`src/app/api/support/sandbox/route.integration.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

const runSandboxTurn = vi.fn()
vi.mock('@/lib/support/sandbox', async () => {
  const actual = await vi.importActual<typeof import('@/lib/support/sandbox')>('@/lib/support/sandbox')
  return { ...actual, runSandboxTurn: (...args: unknown[]) => runSandboxTurn(...args) }
})

const { POST } = await import('./route')

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/support/sandbox', { method: 'POST', body: JSON.stringify(body) }))

describe('POST /api/support/sandbox', () => {
  it('runs one turn and hands the page everything the sandbox worked out', async () => {
    runSandboxTurn.mockResolvedValueOnce({
      conversationId: 'c1', reply: 'Din pakke er på vej.', action: 'send', reason: null,
      category: 'shipping', language: 'da', confidence: 0.95, knowledge: [], saw: { customer: null, orders: [] },
    })
    const res = await post({ shopId: 's1', customerEmail: '', sessionKey: 'k1', messages: [{ role: 'user', text: 'Hvor er min pakke?' }] })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ action: 'send', reply: 'Din pakke er på vej.' })
    expect(runSandboxTurn.mock.calls[0][0]).toMatchObject({ shopId: 's1', customerEmail: null, sessionKey: 'k1' })
  })

  it('refuses a transcript that does not end with the customer', async () => {
    const res = await post({ shopId: 's1', sessionKey: 'k1', messages: [{ role: 'assistant', text: 'Hej' }] })
    expect(res.status).toBe(400)
    expect(runSandboxTurn).not.toHaveBeenCalled()
  })

  it('says what went wrong in the sandbox, in words for the page', async () => {
    const { SandboxError } = await import('@/lib/support/sandbox')
    runSandboxTurn.mockRejectedValueOnce(new SandboxError('No ANTHROPIC_API_KEY is configured, so the assistant cannot read tickets.'))
    const res = await post({ shopId: 's1', sessionKey: 'k1', messages: [{ role: 'user', text: 'Hej' }] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/ANTHROPIC_API_KEY/)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/app/api/support/sandbox/route.integration.test.ts`
Expected: FAIL, cannot find module `./route`.

- [ ] **Step 3: Implement**

`src/app/api/support/sandbox/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { runSandboxTurn, SandboxError } from '@/lib/support/sandbox'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'
/** A judge call plus the customer lookup; well inside this, but not instant. */
export const maxDuration = 60

/**
 * The practice room's one door. Admin only: this is the assistant speaking
 * in the company's voice, even if nobody outside hears it.
 */
const Body = z.object({
  shopId: z.string().trim().min(1),
  customerEmail: z.string().trim().email().nullable().optional().or(z.literal('')),
  sessionKey: z.string().trim().min(1).max(60),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(5000) }))
    .min(1)
    .max(40)
    .refine((m) => m[m.length - 1].role === 'user' && m[m.length - 1].text.trim().length > 0, {
      message: 'The last message must be something the customer wrote.',
    }),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'The last message must be something the customer wrote.' }, { status: 400, headers: NO_STORE })
    }
    const result = await runSandboxTurn({
      shopId: parsed.data.shopId,
      customerEmail: parsed.data.customerEmail ? parsed.data.customerEmail.toLowerCase() : null,
      sessionKey: parsed.data.sessionKey,
      messages: parsed.data.messages,
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof SandboxError) return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'The sandbox could not run that turn' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: Run the test and type-check**

Run: `npx vitest run src/app/api/support/sandbox/route.integration.test.ts && npx tsc --noEmit`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/support/sandbox
git commit -m "feat(support): the sandbox route

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 6: Review page: sandbox filter, counts without practice, link

**Files:**
- Modify: `src/app/api/support/conversations/route.ts`
- Modify: `src/app/api/support/analytics/route.ts:138`
- Modify: `src/app/support/ReviewClient.tsx`
- Create: `src/app/api/support/conversations/route.integration.test.ts`

**Interfaces:**
- Produces: `GET /api/support/conversations?decision=<all|sent|drafted|escalated>&source=<live|sandbox>`; rows gain `source` and `shopId`.

- [ ] **Step 1: Write the failing route test**

`src/app/api/support/conversations/route.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

const { GET } = await import('./route')

const PREFIX = 'convroute-'
async function cleanup() {
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: PREFIX } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  await db.aiConversation.createMany({
    data: [
      { source: 'gorgias', externalTicketId: `${PREFIX}1`, question: 'live', decision: 'sent' },
      { source: 'sandbox', externalTicketId: `${PREFIX}sandbox:1`, question: 'practice', decision: 'sent' },
    ],
  })
})

const get = (qs: string) => GET(new Request(`http://localhost/api/support/conversations?${qs}`))

describe('GET /api/support/conversations', () => {
  it('leaves practice runs out of the list and the counts unless asked', async () => {
    const body = await (await get('decision=all')).json()
    const ours = body.conversations.filter((c: { externalTicketId: string }) => c.externalTicketId.startsWith(PREFIX))
    expect(ours.map((c: { question: string }) => c.question)).toEqual(['live'])
    // Counts are over everything, so only prove the practice row is not among them.
    const practice = await db.aiConversation.count({ where: { source: 'sandbox' } })
    const live = await db.aiConversation.count({ where: { source: { not: 'sandbox' } } })
    expect(Object.values(body.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(live)
    expect(practice).toBeGreaterThan(0)
  })

  it('shows practice runs on request', async () => {
    const body = await (await get('decision=all&source=sandbox')).json()
    const ours = body.conversations.filter((c: { externalTicketId: string }) => c.externalTicketId.startsWith(PREFIX))
    expect(ours.map((c: { question: string; source: string }) => [c.question, c.source])).toEqual([['practice', 'sandbox']])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/app/api/support/conversations/route.integration.test.ts`
Expected: FAIL on the first assertion (practice row present) or missing `source`.

- [ ] **Step 3: Implement the route change**

In `src/app/api/support/conversations/route.ts`, replace the body of the `try` block up to the response:

```ts
    assertAdmin(await currentUser())
    const url = new URL(req.url)
    const decision = url.searchParams.get('decision')
    // Practice runs from the sandbox are shown only when asked for, and never
    // counted: "how often does it send" is a question about customers.
    const source = url.searchParams.get('source') === 'sandbox' ? 'sandbox' : { not: 'sandbox' }

    const [rows, counts] = await Promise.all([
      db.aiConversation.findMany({
        where: { source, ...(decision && decision !== 'all' ? { decision } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      db.aiConversation.groupBy({ by: ['decision'], _count: true, where: { source: { not: 'sandbox' } } }),
    ])
```

and add to each mapped row: `source: r.source, shopId: r.shopId,`.

In `src/app/api/support/analytics/route.ts` line 138, change the groupBy to:

```ts
      db.aiConversation.groupBy({ by: ['decision'], _count: true, where: { source: { not: 'sandbox' } } }),
```

- [ ] **Step 4: Run the route tests**

Run: `npx vitest run src/app/api/support/conversations src/app/api/support/analytics`
Expected: all passed.

- [ ] **Step 5: The page: a Sandbox filter and a link to the sandbox**

In `src/app/support/ReviewClient.tsx`:

- Add `import Link from 'next/link'`.
- Change `const FILTERS = ['all', 'sent', 'drafted', 'escalated'] as const` to `const FILTERS = ['all', 'sent', 'drafted', 'escalated', 'sandbox'] as const` and add `sandbox: 'Sandbox practice'` to `LABEL`.
- Add `source: string` to the `Conversation` type.
- Change the fetch in `load` to:

```ts
      fetch(
        filter === 'sandbox'
          ? '/api/support/conversations?decision=all&source=sandbox'
          : `/api/support/conversations?decision=${filter}`,
      )
```

- Directly under the `VIEWS` tablist `div` (inside the `max-w-[1100px]` wrapper, before `{view === 'analytics' && ...}`), add:

```tsx
          <div className="flex justify-end">
            <Link
              href="/support/sandbox"
              className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-faint"
            >
              Try the assistant in the sandbox
            </Link>
          </div>
```

- In the empty-state text, change to: `Nothing here yet. Live conversations appear once Gorgias sends messages to the assistant; practice runs are under Sandbox practice.`

- [ ] **Step 6: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src/app/support/ReviewClient.tsx src/app/api/support/conversations/route.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/support/conversations src/app/api/support/analytics/route.ts src/app/support/ReviewClient.tsx
git commit -m "feat(support): practice runs are shown on request and never counted

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 7: The sandbox screen

**Files:**
- Create: `src/app/support/sandbox/page.tsx`
- Create: `src/app/support/sandbox/SandboxClient.tsx`

**Interfaces:**
- Consumes: `POST /api/support/sandbox` (Task 5), `PATCH /api/support/conversations/[id]` (Task 2), `GET /api/support/knowledge` for the shop list.

- [ ] **Step 1: The page shell**

`src/app/support/sandbox/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { SandboxClient } from './SandboxClient'

export const dynamic = 'force-dynamic'

export default async function SandboxPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  // The assistant speaking in the company's voice, even in practice. Admins only.
  if (user.role !== 'ADMIN') redirect('/portal')

  return <SandboxClient email={user.email} />
}
```

- [ ] **Step 2: The client**

`src/app/support/sandbox/SandboxClient.tsx`:

```tsx
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
        // panetti.dk first, because it is the first shop the assistant answers.
        const dk = (body.shops as Shop[]).find((s) => /denmark|\.dk/i.test(s.name))
        setShopId((dk ?? body.shops[0])?.id ?? '')
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
        title="Assistant sandbox"
        subtitle="Talk to it as a customer would. Nothing here reaches a customer or Gorgias."
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
                <p className="text-[13px] text-muted">Write what a customer might write, in their language. For example: Hvor er min pakke?</p>
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
              <p className="text-muted">After the first answer, the customer facts and orders it had in front of it appear here.</p>
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
```

- [ ] **Step 3: Type-check, lint, and look at it**

Run: `npx tsc --noEmit && npx eslint src/app/support/sandbox`
Expected: clean.

Then start the dev server in the background (never piped to `head`), sign in as the seeded admin, open `http://localhost:3000/support/sandbox`, pick a shop, send "Hvor er min pakke?". With no `ANTHROPIC_API_KEY` locally the toast must read "No ANTHROPIC_API_KEY is configured…"; with a key it must show a reply with the action line under it. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add src/app/support/sandbox
git commit -m "feat(support): the sandbox screen

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 8: Per-shop chat settings, the webhook panel, keyword pre-fill

**Files:**
- Create: `src/app/api/support/chat-settings/route.ts`
- Create: `src/app/api/support/chat-settings/route.integration.test.ts`
- Modify: `src/app/settings/ai-support/SupportAiClient.tsx`

**Interfaces:**
- Produces: `GET /api/support/chat-settings` -> `{ shops: { id, name, aiChatFrom: 'YYYY-MM-DD' | null, webhookUrl: string | null }[], secretConfigured: boolean, bodyTemplate: string }`; `PUT /api/support/chat-settings` with `{ shopId, date: 'YYYY-MM-DD' | null }`.

- [ ] **Step 1: Confirm the Gorgias template variable names**

WebFetch `https://docs.gorgias.com/http-integrations-81822` and `https://developers.gorgias.com/docs/receive-and-respond-to-tickets-from-a-third-party-app` and note the variable syntax for the ticket id, message id, message body text, `from_agent`, ticket channel, ticket via, ticket created time, customer email and name. If a name below differs from the docs, change the constant in Step 4 to the documented one. Do not guess.

- [ ] **Step 2: Write the failing route test**

`src/app/api/support/chat-settings/route.integration.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

const { GET, PUT } = await import('./route')

const TAG = '[chat-settings-test]'
async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
let shopId = ''
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti Denmark ${TAG}`, currency: 'DKK' } })).id
  vi.stubEnv('GORGIAS_WEBHOOK_SECRET', 's3cret')
  vi.stubEnv('APP_URL', 'https://panetti.vercel.app')
})
afterEach(() => vi.unstubAllEnvs())

describe('chat settings', () => {
  it('lists each shop with its switch and the exact webhook URL to paste', async () => {
    const body = await (await GET()).json()
    const row = body.shops.find((s: { id: string }) => s.id === shopId)
    expect(row).toMatchObject({ aiChatFrom: null, webhookUrl: `https://panetti.vercel.app/api/gorgias/webhook?token=s3cret&shop=${shopId}` })
    expect(body.secretConfigured).toBe(true)
    expect(body.bodyTemplate).toContain('"ticketId"')
    expect(body.bodyTemplate).toContain('"messageId"')
    expect(body.bodyTemplate).toContain('"fromAgent"')
  })

  it('says when the secret is missing instead of printing a broken URL', async () => {
    vi.stubEnv('GORGIAS_WEBHOOK_SECRET', '')
    const body = await (await GET()).json()
    expect(body.secretConfigured).toBe(false)
    expect(body.shops.find((s: { id: string }) => s.id === shopId).webhookUrl).toBeNull()
  })

  it('sets and clears the switch as a date at midnight UTC', async () => {
    const put = (date: string | null) =>
      PUT(new Request('http://localhost/api/support/chat-settings', { method: 'PUT', body: JSON.stringify({ shopId, date }) }))

    expect((await put('2026-09-10')).status).toBe(200)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).aiChatFrom?.toISOString()).toBe('2026-09-10T00:00:00.000Z')

    expect((await put(null)).status).toBe(200)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).aiChatFrom).toBeNull()
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run src/app/api/support/chat-settings/route.integration.test.ts`
Expected: FAIL, cannot find module `./route`.

- [ ] **Step 4: Implement the route**

`src/app/api/support/chat-settings/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * The per-shop switch for live chat, and the two things Philip pastes into
 * Gorgias for each shop: the webhook URL and the request body. Shown verbatim
 * so nothing is typed by hand. The variable names below are Gorgias's
 * HTTP-integration template names, confirmed against their documentation
 * when this was written; the webhook reads exactly these keys.
 */
export const BODY_TEMPLATE = `{
  "ticketId": "{{ticket.id}}",
  "messageId": "{{message.id}}",
  "channel": "{{ticket.channel}}",
  "via": "{{ticket.via}}",
  "ticketCreatedAt": "{{ticket.created_datetime}}",
  "customerEmail": "{{ticket.customer.email}}",
  "customerName": "{{ticket.customer.name}}",
  "subject": "{{ticket.subject}}",
  "message": "{{message.body_text}}",
  "fromAgent": {{message.from_agent}}
}`

const appUrl = () => (process.env.APP_URL ?? 'https://panetti.vercel.app').replace(/\/$/, '')

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const secret = process.env.GORGIAS_WEBHOOK_SECRET?.trim() ?? ''
    const shops = await db.shop.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, aiChatFrom: true },
    })
    return NextResponse.json(
      {
        secretConfigured: secret.length > 0,
        bodyTemplate: BODY_TEMPLATE,
        shops: shops.map((s) => ({
          id: s.id,
          name: s.name,
          aiChatFrom: s.aiChatFrom ? s.aiChatFrom.toISOString().slice(0, 10) : null,
          webhookUrl: secret
            ? `${appUrl()}/api/gorgias/webhook?token=${encodeURIComponent(secret)}&shop=${encodeURIComponent(s.id)}`
            : null,
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not load the chat settings' }, { status: 500, headers: NO_STORE })
  }
}

const Body = z.object({
  shopId: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
})

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'A shop and a date, or no date' }, { status: 400, headers: NO_STORE })
    // updateMany: a shop id that no longer exists is a no-op, not a failure.
    await db.shop.updateMany({
      where: { id: parsed.data.shopId },
      data: { aiChatFrom: parsed.data.date ? new Date(`${parsed.data.date}T00:00:00Z`) : null },
    })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not save' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 5: Run the route test**

Run: `npx vitest run src/app/api/support/chat-settings/route.integration.test.ts`
Expected: 3 passed.

- [ ] **Step 6: The settings page section and the keyword pre-fill**

In `src/app/settings/ai-support/SupportAiClient.tsx`:

Add imports and types near the top:

```ts
import { DEFAULT_ESCALATE_WORDS } from '@/lib/support/rules'

type ChatShop = { id: string; name: string; aiChatFrom: string | null; webhookUrl: string | null }
```

Add state inside the component:

```ts
  const [chatShops, setChatShops] = useState<ChatShop[]>([])
  const [secretConfigured, setSecretConfigured] = useState(true)
  const [bodyTemplate, setBodyTemplate] = useState('')
  const [setupFor, setSetupFor] = useState<string | null>(null)
  const [savingShop, setSavingShop] = useState<string | null>(null)
  const [prefilled, setPrefilled] = useState(false)
```

Extend `load` to fetch the chat settings as a third request and, when the rules arrive with an empty keyword list, pre-fill it:

```ts
      Promise.all([
        fetch('/api/support/knowledge').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/support/rules').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/support/chat-settings').then((r) => (r.ok ? r.json() : null)),
      ]).then(([k, r, c]) => {
        ...existing k and r handling...
        if (r) {
          const empty = r.rules.escalateKeywords.length === 0
          setRules({
            mode: r.rules.mode,
            autoCategories: r.rules.autoCategories,
            // The words for "I want a person", suggested once; saving keeps them.
            escalateKeywords: empty ? [...DEFAULT_ESCALATE_WORDS] : r.rules.escalateKeywords,
            minConfidence: r.rules.minConfidence,
            extraInstructions: r.rules.extraInstructions ?? '',
          })
          setPrefilled(empty)
          setCategories(r.categories)
        }
        if (c) {
          setChatShops(c.shops)
          setSecretConfigured(c.secretConfigured)
          setBodyTemplate(c.bodyTemplate)
        }
      }),
```

Add a helper in the component:

```ts
  async function setChatDate(shop: ChatShop, date: string) {
    setSavingShop(shop.id)
    try {
      const res = await fetch('/api/support/chat-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.id, date: date || null }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save')
        return
      }
      toast.success(date ? `${shop.name}: the assistant answers chats started from ${date}` : `${shop.name}: the assistant no longer answers chats`)
      setChatShops((s) => s.map((x) => (x.id === shop.id ? { ...x, aiChatFrom: date || null } : x)))
    } finally {
      setSavingShop(null)
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied')
    } catch {
      toast.error('Could not copy. Select it and copy by hand.')
    }
  }
```

Under the escalate-keywords `<input>` (inside its `<label>`), add the hint:

```tsx
                  {prefilled && (
                    <span className="mt-0.5 block text-[11px] text-faint">
                      Suggested words for "I want a person". Press Save to keep them.
                    </span>
                  )}
```

Insert a new `<section>` between the rules section and the knowledge section:

```tsx
          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <h2 className="mb-1 text-[15px] font-semibold text-ink">Live chat, per shop</h2>
            <p className="mb-3 text-[12px] text-muted">
              Set a date and the assistant answers that shop&apos;s Gorgias chats started from that day, under the
              rules above. Leave it empty and it answers none. Each shop also needs one HTTP integration in Gorgias:
              press Show setup for the exact values.
            </p>
            {!secretConfigured && (
              <p className="mb-3 rounded-[var(--radius-control)] border border-warn px-3 py-2 text-[12px] text-warn">
                GORGIAS_WEBHOOK_SECRET is not set on the server, so there is no URL to paste yet.
              </p>
            )}
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-muted">
                  <th className="py-2 pr-4">Shop</th>
                  <th className="py-2 pr-4">Assistant answers chats from</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {chatShops.map((s) => (
                  <tr key={s.id} className="border-b border-line align-top last:border-b-0">
                    <td className="py-2.5 pr-4 font-medium text-ink">{s.name}</td>
                    <td className="py-2.5 pr-4">
                      <input
                        type="date"
                        aria-label={`Assistant answers chats for ${s.name} from`}
                        defaultValue={s.aiChatFrom ?? ''}
                        onChange={(e) => void setChatDate(s, e.target.value)}
                        disabled={savingShop === s.id}
                        className="rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1.5 text-xs text-ink disabled:opacity-60"
                      />
                      {s.aiChatFrom && (
                        <button
                          onClick={() => void setChatDate(s, '')}
                          disabled={savingShop === s.id}
                          className="ml-2 text-xs font-medium text-loss hover:underline disabled:opacity-60"
                        >
                          Clear
                        </button>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      <button onClick={() => setSetupFor(setupFor === s.id ? null : s.id)} className="text-xs text-accent">
                        {setupFor === s.id ? 'Hide setup' : 'Show setup'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {setupFor && (() => {
              const s = chatShops.find((x) => x.id === setupFor)
              if (!s) return null
              return (
                <div className="mt-3 space-y-2 rounded-[var(--radius-control)] border border-line bg-panel p-3 text-[12px] text-muted">
                  <p className="text-ink">In Gorgias: Settings, Integrations, HTTP integration, Add. Fill in exactly this for {s.name}.</p>
                  <ol className="list-decimal space-y-1 pl-4">
                    <li>Name: Panetti assistant, {s.name}</li>
                    <li>Trigger: Ticket message created</li>
                    <li>Method: POST</li>
                    <li>
                      URL:{' '}
                      {s.webhookUrl ? (
                        <>
                          <code className="break-all text-ink">{s.webhookUrl}</code>{' '}
                          <button onClick={() => void copy(s.webhookUrl!)} className="text-accent">Copy</button>
                        </>
                      ) : (
                        'not available until the secret is set'
                      )}
                    </li>
                    <li>Headers: Content-Type: application/json</li>
                    <li>
                      Body:{' '}
                      <button onClick={() => void copy(bodyTemplate)} className="text-accent">Copy</button>
                      <pre className="mt-1 overflow-x-auto rounded-[var(--radius-control)] border border-line bg-surface p-2 text-[11px] text-ink">{bodyTemplate}</pre>
                    </li>
                    <li>
                      Then add a Gorgias rule so it only fires for this shop&apos;s chat: when a ticket message is created,
                      if channel is chat and integration is the {s.name} chat, trigger this HTTP integration.
                    </li>
                  </ol>
                </div>
              )
            })()}
          </section>
```

- [ ] **Step 7: Type-check, lint, and look at it**

Run: `npx tsc --noEmit && npx eslint src/app/settings/ai-support`
Expected: clean. In the dev server, open `/settings/ai-support`: the new section lists every shop, a date saves with a toast, Show setup reveals the URL and body, and the keyword box shows the six suggested words with the hint when the stored list is empty.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/support/chat-settings src/app/settings/ai-support/SupportAiClient.tsx
git commit -m "feat(support): per-shop live chat switch with the Gorgias values to paste

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

Phase 1 is deployable on its own: nothing reaches Gorgias, and Philip can start training the assistant from the sandbox.

---

## Phase 2: live chat on panetti.dk

### Task 9: Gorgias client: a ticket's messages, and a tag

**Files:**
- Modify: `src/lib/support/client.ts`
- Create: `src/lib/support/client.test.ts`

**Interfaces:**
- Produces: `GorgiasTicketMessage`, `fetchTicketMessages(creds, ticketId, deadline?)`, `tagTicket(creds, ticketId, tag)`.

- [ ] **Step 1: Write the failing tests (fetch stubbed, no network)**

`src/lib/support/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTicketMessages, tagTicket } from './client'

const creds = { domain: 'acme', email: 'admin@example.invalid', apiKey: 'key' }

type Call = { url: string; init: RequestInit }
function stub(responses: ((call: Call) => unknown)[]) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init }
    calls.push(call)
    const body = responses[calls.length - 1]?.(call) ?? {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}
afterEach(() => vi.unstubAllGlobals())

describe('fetchTicketMessages', () => {
  it('walks the ticket oldest first and follows the cursor', async () => {
    const calls = stub([
      () => ({ data: [{ id: 1 }], meta: { next_cursor: 'c2' } }),
      () => ({ data: [{ id: 2 }], meta: { next_cursor: null } }),
    ])
    const out = await fetchTicketMessages(creds, '236490307')
    expect(out.map((m) => m.id)).toEqual([1, 2])
    expect(calls[0].url).toContain('https://acme.gorgias.com/api/tickets/236490307/messages?')
    expect(calls[0].url).toContain('order_by=created_datetime%3Aasc')
    expect(calls[1].url).toContain('cursor=c2')
  })
})

describe('tagTicket', () => {
  it('keeps the tags the agents set and adds ours', async () => {
    const calls = stub([
      () => ({ id: 5, tags: [{ name: 'vip' }] }),
      () => ({ id: 5 }),
    ])
    await tagTicket(creds, '5', 'ai-handover')
    expect(calls[0].init.method ?? 'GET').toBe('GET')
    expect(calls[1].init.method).toBe('PUT')
    expect(calls[1].url).toBe('https://acme.gorgias.com/api/tickets/5')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ tags: [{ name: 'vip' }, { name: 'ai-handover' }] })
  })

  it('does not add a tag twice', async () => {
    const calls = stub([() => ({ id: 5, tags: [{ name: 'ai-handover' }] }), () => ({ id: 5 })])
    await tagTicket(creds, '5', 'ai-handover')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ tags: [{ name: 'ai-handover' }] })
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run src/lib/support/client.test.ts`
Expected: FAIL, `fetchTicketMessages` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/support/client.ts`:

```ts
/** One message of one ticket, as the chat turn reads it. */
export type GorgiasTicketMessage = {
  id: number
  from_agent: boolean | null
  public: boolean | null
  channel: string | null
  via: string | null
  body_text: string | null
  created_datetime: string | null
  sender: { id?: number | null; name?: string | null; email?: string | null } | null
}

/** Pages a chat can run to. Three hundred messages is a very long chat. */
const TICKET_MESSAGE_PAGES = 3

/**
 * Every message of one ticket, oldest first.
 *
 * Measured from their API reference: `GET /api/tickets/{id}/messages` pages
 * like the account-wide list, with a cursor. Oldest first because the chat
 * turn replays it as a conversation.
 */
export async function fetchTicketMessages(
  creds: GorgiasCredentials,
  ticketId: string,
  deadline?: number,
): Promise<GorgiasTicketMessage[]> {
  const out: GorgiasTicketMessage[] = []
  let cursor: string | null = null
  for (let page = 0; page < TICKET_MESSAGE_PAGES; page++) {
    const { data, nextCursor }: { data: GorgiasTicketMessage[]; nextCursor: string | null } = await get<GorgiasTicketMessage>(
      creds,
      `tickets/${encodeURIComponent(ticketId)}/messages`,
      { limit: '100', order_by: 'created_datetime:asc', ...(cursor ? { cursor } : {}) },
      deadline,
    )
    out.push(...data)
    if (!nextCursor) break
    cursor = nextCursor
  }
  return out
}

async function request<T>(
  creds: GorgiasCredentials,
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64')
  const res = await fetch(`https://${creds.domain}.gorgias.com/api/${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new GorgiasError(`Gorgias responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

/**
 * Mark a ticket for the people. Read first: `PUT /api/tickets/{id}` replaces
 * the tag set, and a handover must not strip the tags the agents put there.
 */
export async function tagTicket(creds: GorgiasCredentials, ticketId: string, tag: string): Promise<void> {
  const id = encodeURIComponent(ticketId)
  const current = await request<{ tags?: { name: string }[] | null }>(creds, 'GET', `tickets/${id}`)
  const names = (current.tags ?? []).map((t) => t.name)
  if (!names.includes(tag)) names.push(tag)
  await request(creds, 'PUT', `tickets/${id}`, { tags: names.map((name) => ({ name })) })
}
```

- [ ] **Step 4: Run the tests and type-check**

Run: `npx vitest run src/lib/support/client.test.ts && npx tsc --noEmit`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support/client.ts src/lib/support/client.test.ts
git commit -m "feat(support): read one ticket's messages and tag a ticket in Gorgias

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 10: The channel seam grows a transcript and a tag; the reply channel for chat

**Files:**
- Modify: `src/lib/support/channel.ts`
- Modify: `src/lib/support/gorgias-channel.ts`
- Create: `src/lib/support/gorgias-channel.test.ts`

**Interfaces:**
- Consumes: `fetchTicketMessages`, `tagTicket` (Task 9).
- Produces: `TranscriptMessage`, `Channel.transcript?`, `Channel.tag?`, `IncomingMessage.messageId?`, `replyChannelFor(via)`.

- [ ] **Step 1: Write the failing tests**

`src/lib/support/gorgias-channel.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubEnv('GORGIAS_DOMAIN', 'acme')
vi.stubEnv('GORGIAS_EMAIL', 'admin@example.invalid')
vi.stubEnv('GORGIAS_API_KEY', 'key')
const { gorgiasChannel, replyChannelFor } = await import('./gorgias-channel')

afterEach(() => vi.unstubAllGlobals())

describe('replyChannelFor', () => {
  it.each([
    ['gorgias_chat', 'chat'],
    ['offline_capture', 'chat'],
    ['chat', 'chat'],
    ['email', 'email'],
    ['helpdesk', 'email'],
    ['api', 'email'],
    [null, 'email'],
    ['instagram-direct-message', 'instagram-direct-message'],
  ])('%s is answered on %s', (via, channel) => {
    expect(replyChannelFor(via)).toBe(channel)
  })
})

describe('the Gorgias channel for a chat', () => {
  it('sends a chat reply on the chat channel, not on the widget name Gorgias reports', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null })
      return new Response('{}', { status: 200 })
    }))
    await gorgiasChannel('gorgias_chat')!.sendMessage('7', 'Hej!')
    expect(calls[0].body).toMatchObject({ channel: 'chat', source: { type: 'chat' }, public: true, from_agent: true, body_text: 'Hej!' })
  })

  it('reads the transcript as public messages only, oldest first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        data: [
          { id: 1, from_agent: false, public: true, body_text: 'Hej', created_datetime: '2026-09-09T10:00:00Z' },
          { id: 2, from_agent: true, public: false, body_text: 'internal note', created_datetime: '2026-09-09T10:00:05Z' },
          { id: 3, from_agent: true, public: true, body_text: 'Hej! Jeg er assistenten.', created_datetime: '2026-09-09T10:00:10Z' },
        ],
        meta: { next_cursor: null },
      }), { status: 200 }),
    ))
    const t = await gorgiasChannel('gorgias_chat')!.transcript!('7')
    expect(t).toEqual([
      { id: '1', fromAgent: false, text: 'Hej', at: '2026-09-09T10:00:00Z' },
      { id: '3', fromAgent: true, text: 'Hej! Jeg er assistenten.', at: '2026-09-09T10:00:10Z' },
    ])
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run src/lib/support/gorgias-channel.test.ts`
Expected: FAIL, `replyChannelFor` is not exported; `transcript` is not a function.

- [ ] **Step 3: Extend the seam**

In `src/lib/support/channel.ts`, replace the `IncomingMessage` and `Channel` types:

```ts
/** One inbound message, as any channel would describe it. */
export type IncomingMessage = {
  /** The channel's own id for the conversation, so replies can find it. */
  conversationId: string
  customerEmail: string | null
  customerName: string | null
  /** What the customer actually wrote, plain text. */
  text: string
  subject: string | null
  /** email, chat, instagram-direct-message, whatever the channel calls it. */
  via: string | null
  /** The channel's own id for this one message. Null where messages are not numbered. */
  messageId?: string | null
}

/** One line of a conversation as the channel holds it, customer-visible only. */
export type TranscriptMessage = {
  id: string
  fromAgent: boolean
  text: string
  /** ISO timestamp as the channel reports it. */
  at: string
}

export type Channel = {
  /** The channel's name, for the record. */
  name: string
  /** Answer the customer, through the channel they wrote in on. */
  sendMessage(conversationId: string, text: string): Promise<void>
  /**
   * Leave a note only the agents can see. This is how the AI hands a
   * conversation to a human: summary, reason, and a suggested reply.
   */
  addInternalNote(conversationId: string, text: string): Promise<void>
  /**
   * The conversation so far, oldest first, customer-visible messages only.
   * Optional: an email channel answers one message at a time and needs none.
   */
  transcript?(conversationId: string): Promise<TranscriptMessage[]>
  /** Mark the conversation for the people. Optional: not every channel has tags. */
  tag?(conversationId: string, tag: string): Promise<void>
}
```

- [ ] **Step 4: The Gorgias adapter**

In `src/lib/support/gorgias-channel.ts`, change the import line to:

```ts
import { fetchTicketMessages, gorgiasCredentials, GorgiasError, tagTicket, type GorgiasCredentials } from './client'
```

Add before `gorgiasChannel`:

```ts
/**
 * Which Gorgias channel a reply goes out on.
 *
 * `via` is how the customer arrived; the reply channel is not always the same
 * word. A chat ticket reports via as `gorgias_chat` (the widget) or
 * `offline_capture` (the widget outside opening hours), and a message posted
 * on either of those names is refused: the channel is `chat`. Everything the
 * helpdesk itself made (`helpdesk`, `api`) is answered by email.
 */
export function replyChannelFor(via: string | null): string {
  if (!via || via === 'api' || via === 'helpdesk') return 'email'
  if (via === 'gorgias_chat' || via === 'offline_capture' || via === 'chat') return 'chat'
  return via
}
```

In `gorgiasChannel`, replace `const channel = via && via !== 'api' ? via : 'email'` with `const channel = replyChannelFor(via)` and add two methods to the returned object after `addInternalNote`:

```ts
    async transcript(conversationId) {
      const messages = await fetchTicketMessages(creds, conversationId)
      return messages
        .filter((m) => m.public !== false)
        .map((m) => ({
          id: String(m.id),
          fromAgent: m.from_agent === true,
          text: m.body_text ?? '',
          at: m.created_datetime ?? '',
        }))
    },

    async tag(conversationId, tag) {
      await tagTicket(creds, conversationId, tag)
    },
```

- [ ] **Step 5: Run the tests and the whole support folder**

Run: `npx vitest run src/lib/support src/app/api/gorgias && npx tsc --noEmit`
Expected: all passed. The existing webhook test's `via: 'email'` case is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/lib/support/channel.ts src/lib/support/gorgias-channel.ts src/lib/support/gorgias-channel.test.ts
git commit -m "feat(support): the channel seam can read a transcript and tag; chat replies go out on chat

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 11: Pure chat decisions

**Files:**
- Create: `src/lib/support/chat-turn.ts`
- Create: `src/lib/support/chat-turn.test.ts`

**Interfaces:**
- Consumes: `TranscriptMessage` (Task 10), `Turn` (Task 3).
- Produces: everything listed under `chat-turn.ts` in the shared interfaces.

- [ ] **Step 1: Write the failing tests**

`src/lib/support/chat-turn.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  handoverLine, humanTookOver, normalise, REPLY_CAP, splitForJudge, superseded, turnsOf,
} from './chat-turn'
import type { TranscriptMessage } from './channel'

const m = (id: number, fromAgent: boolean, text: string): TranscriptMessage => ({
  id: String(id), fromAgent, text, at: `2026-09-09T10:00:${String(id).padStart(2, '0')}Z`,
})

describe('superseded', () => {
  it('is true when the customer wrote again after the message that woke us', () => {
    expect(superseded([m(1, false, 'hi'), m(2, false, 'where is my order'), m(3, false, '14689')], '2')).toBe(true)
  })
  it('is false when ours is the newest customer message, whatever the agents wrote after', () => {
    expect(superseded([m(1, false, 'hi'), m(2, false, 'where is my order'), m(3, true, 'One moment')], '2')).toBe(false)
  })
  it('falls back to numeric ids when the transcript does not yet hold our message', () => {
    expect(superseded([m(1, false, 'hi'), m(5, false, 'and?')], '4')).toBe(true)
    expect(superseded([m(1, false, 'hi'), m(3, false, 'and?')], '4')).toBe(false)
  })
})

describe('humanTookOver', () => {
  const own = ['Hej! Jeg er Panettis assistent.']
  it('ignores the assistant’s own replies, whitespace and all', () => {
    expect(humanTookOver([m(1, false, 'Hej'), m(2, true, '  Hej!  Jeg er Panettis assistent. ')], own)).toBe(false)
  })
  it('is true the moment an agent message is not one of ours', () => {
    expect(humanTookOver([m(1, false, 'Hej'), m(2, true, 'Hej, Selena her. Hvad kan jeg hjælpe med?')], own)).toBe(true)
  })
  it('is false with no agent message at all', () => {
    expect(humanTookOver([m(1, false, 'Hej')], own)).toBe(false)
  })
})

describe('turnsOf', () => {
  it('joins consecutive customer messages into one turn and keeps the order', () => {
    expect(turnsOf([m(1, false, 'hi'), m(2, false, 'where is my order'), m(3, true, 'One moment'), m(4, false, '14689')])).toEqual([
      { role: 'user', text: 'hi\nwhere is my order' },
      { role: 'assistant', text: 'One moment' },
      { role: 'user', text: '14689' },
    ])
  })
  it('keeps only the last N turns', () => {
    const long: TranscriptMessage[] = []
    for (let i = 1; i <= 30; i++) long.push(m(i, i % 2 === 0, `t${i}`))
    expect(turnsOf(long, 4)).toHaveLength(4)
    expect(turnsOf(long, 4)[3].text).toBe('t30')
  })
  it('drops empty messages', () => {
    expect(turnsOf([m(1, false, ''), m(2, false, 'hi')])).toEqual([{ role: 'user', text: 'hi' }])
  })
})

describe('splitForJudge', () => {
  it('takes the final customer turn as the message and the rest as history', () => {
    const r = splitForJudge([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }, { role: 'user', text: 'where?' }], 'fallback')
    expect(r).toEqual({ history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }], message: 'where?' })
  })
  it('uses the delivered text when the transcript does not end with the customer', () => {
    expect(splitForJudge([{ role: 'assistant', text: 'hello' }], 'where?')).toEqual({ history: [{ role: 'assistant', text: 'hello' }], message: 'where?' })
    expect(splitForJudge([], 'where?')).toEqual({ history: [], message: 'where?' })
  })
})

describe('handoverLine', () => {
  it('speaks the customer’s language and falls back to English', () => {
    expect(handoverLine('da')).toMatch(/kollega/)
    expect(handoverLine('nb')).toMatch(/kollega/)
    expect(handoverLine('de')).toMatch(/Kolleg/)
    expect(handoverLine('xx')).toMatch(/colleague/)
    expect(handoverLine(null)).toMatch(/colleague/)
  })
})

describe('constants', () => {
  it('caps a chat at eight replies', () => expect(REPLY_CAP).toBe(8))
  it('normalises whitespace and case', () => expect(normalise('  Hej   du ')).toBe('hej du'))
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run src/lib/support/chat-turn.test.ts`
Expected: FAIL, cannot find module `./chat-turn`.

- [ ] **Step 3: Implement**

`src/lib/support/chat-turn.ts`:

```ts
import type { TranscriptMessage } from './channel'
import type { Turn } from './agent'

/**
 * The decisions a chat turn makes, with nothing to mock.
 *
 * A live chat differs from an email in three ways this file owns: messages
 * arrive in bursts ("hi" / "where is my order" / "14689"), a person can step
 * in at any moment, and the same conversation is replayed to the model as
 * turns. Everything here is pure so each rule is provable on its own.
 */

/** Replies per chat before the assistant hands over regardless. */
export const REPLY_CAP = 8

/** How long to let a burst finish before reading the whole of it. */
export const BURST_WAIT_MS = 6_000

/** How far back an agent message is still recognisable as the assistant's own. */
export const OWN_TEXT_WINDOW_MS = 15 * 60_000

/** The one customer-visible line a handover sends, per language. */
export const HANDOVER_LINES: Record<string, string> = {
  da: 'Jeg henter en kollega, som hjælper dig videre. Et øjeblik.',
  nb: 'Jeg henter en kollega som hjelper deg videre. Et øyeblikk.',
  sv: 'Jag hämtar en kollega som hjälper dig vidare. Ett ögonblick.',
  fi: 'Haen kollegan auttamaan sinua. Hetki vain.',
  de: 'Ich hole eine Kollegin oder einen Kollegen, die Ihnen weiterhelfen. Einen Moment.',
  en: 'I am getting a colleague to help you. One moment.',
}

export function handoverLine(language: string | null): string {
  return HANDOVER_LINES[language ?? ''] ?? HANDOVER_LINES.en
}

/** Case and whitespace are not differences. */
export function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Did the customer write again after the message that woke this run?
 *
 * If so, the run that the later message started answers the whole burst and
 * this one stops. When the transcript does not yet hold our message (Gorgias
 * can lag its own webhook), ids are compared as numbers: they only go up.
 */
export function superseded(transcript: TranscriptMessage[], messageId: string): boolean {
  const ours = transcript.findIndex((m) => m.id === messageId)
  if (ours >= 0) return transcript.slice(ours + 1).some((m) => !m.fromAgent)
  const mine = Number(messageId)
  if (!Number.isFinite(mine)) return false
  return transcript.some((m) => !m.fromAgent && Number(m.id) > mine)
}

/** True when a customer-visible agent message is not one the assistant wrote. */
export function humanTookOver(transcript: TranscriptMessage[], ownTexts: string[]): boolean {
  const own = new Set(ownTexts.map(normalise))
  return transcript.some((m) => m.fromAgent && !own.has(normalise(m.text)))
}

/**
 * The transcript as turns: customer messages are user turns, agent messages
 * are assistant turns, consecutive same-role messages joined, empty ones
 * dropped, and only the last `limit` turns kept.
 */
export function turnsOf(transcript: TranscriptMessage[], limit = 20): Turn[] {
  const turns: Turn[] = []
  for (const m of transcript) {
    const text = m.text.trim()
    if (!text) continue
    const role: Turn['role'] = m.fromAgent ? 'assistant' : 'user'
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.text = `${last.text}\n${text}`
    else turns.push({ role, text })
  }
  return turns.slice(-limit)
}

/**
 * What the judge is asked and what it is shown first. The final customer turn
 * is the question; when the transcript does not end with one, the text the
 * channel delivered is used instead, so a lagging transcript never means a
 * silent customer.
 */
export function splitForJudge(turns: Turn[], fallback: string): { history: Turn[]; message: string } {
  const last = turns[turns.length - 1]
  if (last && last.role === 'user') return { history: turns.slice(0, -1), message: last.text }
  return { history: turns, message: fallback }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/support/chat-turn.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support/chat-turn.ts src/lib/support/chat-turn.test.ts
git commit -m "feat(support): the pure decisions of a chat turn

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 12: The chat turn orchestrator

**Files:**
- Create: `src/lib/support/chat.ts`
- Create: `src/lib/support/chat.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 10, 11; `escalateToHuman`, `getCustomerContext`, `knowledgeFor`, `decide`, `DEFAULT_RULES`.
- Produces: `handleChatMessage(incoming, deps)`, `ChatIncoming`, `ChatDeps`, `ChatResult`.

- [ ] **Step 1: Write the failing tests**

`src/lib/support/chat.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'
import type { Channel, TranscriptMessage } from './channel'

/**
 * A live chat, end to end, with the outsiders replaced: the judge is mocked
 * and the channel is a fake that holds a transcript. What is real is the
 * session latch, the burst rule, the claim on each message id, the gates and
 * what gets recorded.
 */
const judge = vi.fn()
vi.mock('./agent', async () => {
  const actual = await vi.importActual<typeof import('./agent')>('./agent')
  return { ...actual, judge: (...args: unknown[]) => judge(...args) }
})

const { handleChatMessage } = await import('./chat')

const TAG = '[ai-chat-test]'
const EMAIL = 'nikolaj.chat@example.invalid'

const sent: { to: string; text: string }[] = []
const notes: { to: string; text: string }[] = []
const tags: { to: string; tag: string }[] = []
let transcript: TranscriptMessage[] = []
const channel: Channel = {
  name: 'test',
  async sendMessage(id, text) { sent.push({ to: id, text }) },
  async addInternalNote(id, text) { notes.push({ to: id, text }) },
  async transcript() { return transcript },
  async tag(id, tag) { tags.push({ to: id, tag }) },
}
const m = (id: number, fromAgent: boolean, text: string): TranscriptMessage => ({
  id: String(id), fromAgent, text, at: `2026-09-09T10:00:${String(id).padStart(2, '0')}Z`,
})

const judgement = (over = {}) => ({
  category: 'shipping', language: 'da', confidence: 0.95, wantsHuman: false,
  escalationReason: null, summary: 'Asks where the parcel is.', reply: 'Din pakke er på vej.', ...over,
})

const auto = { mode: 'auto', autoCategories: ['shipping'], escalateKeywords: ['menneske'], minConfidence: 0.8, extraInstructions: '' }
const deps = (over: Partial<Parameters<typeof handleChatMessage>[1]> = {}) => ({ channel, wait: async () => {}, rules: auto, ...over })

let shopId = ''
const incoming = (over: Partial<Parameters<typeof handleChatMessage>[0]> = {}) => ({
  shopId, conversationId: 'C-1', messageId: '2', customerEmail: EMAIL, customerName: 'Nikolaj',
  text: 'Hvor er min pakke?', via: 'gorgias_chat', fromAgent: false,
  conversationStartedAt: new Date('2026-09-09T10:00:00Z'), ...over,
})

async function cleanup() {
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: 'C-' } } })
  await db.aiChatSession.deleteMany({ where: { externalTicketId: { startsWith: 'C-' } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  sent.length = 0; notes.length = 0; tags.length = 0
  transcript = [m(1, false, 'Hej'), m(2, false, 'Hvor er min pakke?')]
  judge.mockReset()
  judge.mockResolvedValue(judgement())
  shopId = (await db.shop.create({ data: { name: `Panetti Denmark ${TAG}`, currency: 'DKK', aiChatFrom: new Date('2026-09-08T00:00:00Z') } })).id
  await db.order.create({
    data: {
      shopId, externalId: 'chat-1', number: '14689', placedAt: new Date('2026-09-06'), status: 'completed',
      currency: 'DKK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: 'Nikolaj', customerEmail: EMAIL,
    },
  })
})

describe('handleChatMessage', () => {
  it('answers in the chat, replays the burst as one question, and records the turn against the message id', async () => {
    const r = await handleChatMessage(incoming(), deps())

    expect(r.decision).toBe('sent')
    expect(sent).toEqual([{ to: 'C-1', text: 'Din pakke er på vej.' }])
    expect(judge.mock.calls[0][0].message).toBe('Hej\nHvor er min pakke?')
    expect(judge.mock.calls[0][0].chat).toEqual({ firstReply: true, customerKnown: true })
    const row = await db.aiConversation.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })
    expect(row).toMatchObject({ source: 'test', externalMessageId: '2', shopId, decision: 'sent', question: 'Hej\nHvor er min pakke?' })
    const session = await db.aiChatSession.findUniqueOrThrow({ where: { source_externalTicketId: { source: 'test', externalTicketId: 'C-1' } } })
    expect(session).toMatchObject({ status: 'ai', replies: 1, language: 'da' })
  })

  it('answers the same message only once, however often it is delivered', async () => {
    await handleChatMessage(incoming(), deps())
    const again = await handleChatMessage(incoming(), deps())
    expect(again.decision).toBe('skipped')
    expect(sent).toHaveLength(1)
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('lets the later delivery answer a burst', async () => {
    transcript = [m(1, false, 'Hej'), m(2, false, 'Hvor er min pakke?'), m(3, false, '14689')]
    const r = await handleChatMessage(incoming({ messageId: '2' }), deps())
    expect(r.decision).toBe('superseded')
    expect(sent).toHaveLength(0)
    expect(judge).not.toHaveBeenCalled()
  })

  it('stays silent for good once a person has written on the chat', async () => {
    transcript = [m(1, false, 'Hej'), m(2, true, 'Hej, Selena her!'), m(3, false, 'Hvor er min pakke?')]
    const r = await handleChatMessage(incoming({ messageId: '3' }), deps())
    expect(r.decision).toBe('skipped')
    expect(judge).not.toHaveBeenCalled()
    const session = await db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })
    expect(session.status).toBe('human')

    transcript = [...transcript, m(4, false, 'Hallo?')]
    expect((await handleChatMessage(incoming({ messageId: '4' }), deps())).decision).toBe('skipped')
    expect(sent).toHaveLength(0)
  })

  it('flips the latch on an agent message that is not its own, and ignores its own', async () => {
    await handleChatMessage(incoming(), deps())
    const own = await handleChatMessage(incoming({ messageId: '3', fromAgent: true, text: 'Din pakke er på vej.' }), deps())
    expect(own.decision).toBe('skipped')
    expect((await db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })).status).toBe('ai')

    const human = await handleChatMessage(incoming({ messageId: '4', fromAgent: true, text: 'Selena here, taking over.' }), deps())
    expect(human.decision).toBe('skipped')
    expect((await db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })).status).toBe('human')
  })

  it('hands over with one line to the customer, a note, a tag, and never speaks again on that chat', async () => {
    transcript = [m(1, false, 'Jeg vil tale med et menneske')]
    const r = await handleChatMessage(incoming({ messageId: '1', text: 'Jeg vil tale med et menneske' }), deps())

    expect(r.decision).toBe('escalated')
    expect(sent).toEqual([{ to: 'C-1', text: 'Jeg henter en kollega, som hjælper dig videre. Et øjeblik.' }])
    expect(notes[0].text).toMatch(/menneske/)
    expect(tags).toEqual([{ to: 'C-1', tag: 'ai-handover' }])
    const session = await db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })
    expect(session.status).toBe('handed_over')
    expect(session.handoverReason).toMatch(/menneske/)

    transcript = [...transcript, m(2, false, 'Hallo?')]
    expect((await handleChatMessage(incoming({ messageId: '2', text: 'Hallo?' }), deps())).decision).toBe('skipped')
    expect(sent).toHaveLength(1)
  })

  it('in draft mode leaves a note and says nothing to the customer, even on a handover', async () => {
    const draft = { ...auto, mode: 'draft' }
    expect((await handleChatMessage(incoming(), deps({ rules: draft }))).decision).toBe('drafted')
    expect(sent).toHaveLength(0)
    expect(notes).toHaveLength(1)

    transcript = [m(1, false, 'Hej'), m(2, false, 'Hvor er min pakke?'), m(3, false, 'menneske tak')]
    const r = await handleChatMessage(incoming({ messageId: '3', text: 'menneske tak' }), deps({ rules: draft }))
    expect(r.decision).toBe('escalated')
    expect(sent).toHaveLength(0)
    expect(tags).toEqual([{ to: 'C-1', tag: 'ai-handover' }])
  })

  it('does nothing for a shop that is not switched on, or a chat older than the switch', async () => {
    await db.shop.update({ where: { id: shopId }, data: { aiChatFrom: null } })
    expect((await handleChatMessage(incoming(), deps())).decision).toBe('skipped')

    await db.shop.update({ where: { id: shopId }, data: { aiChatFrom: new Date('2026-09-10T00:00:00Z') } })
    expect((await handleChatMessage(incoming(), deps())).decision).toBe('skipped')
    expect(judge).not.toHaveBeenCalled()
    expect(await db.aiChatSession.count({ where: { externalTicketId: 'C-1' } })).toBe(0)
  })

  it('hands over after the eighth reply', async () => {
    await db.aiChatSession.create({ data: { shopId, source: 'test', externalTicketId: 'C-1', replies: 8 } })
    const r = await handleChatMessage(incoming(), deps())
    expect(r.decision).toBe('escalated')
    expect(r.reason).toMatch(/eight/i)
    expect(judge).not.toHaveBeenCalled()
  })

  it('hands over when the assistant cannot be reached, with the reason on the note', async () => {
    judge.mockRejectedValue(new Error('network down'))
    const r = await handleChatMessage(incoming(), deps())
    expect(r.decision).toBe('escalated')
    expect(notes[0].text).toMatch(/could not be reached/i)
    // No judgement means no detected language yet, so the line is the English one.
    expect(sent).toEqual([{ to: 'C-1', text: 'I am getting a colleague to help you. One moment.' }])
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run src/lib/support/chat.integration.test.ts`
Expected: FAIL, cannot find module `./chat`.

- [ ] **Step 3: Implement**

`src/lib/support/chat.ts`:

```ts
import { db } from '@/lib/db'
import { judge, NoApiKey, type SupportJudgement } from './agent'
import { escalateToHuman, getCustomerContext, type Channel } from './channel'
import {
  BURST_WAIT_MS, handoverLine, HANDOVER_LINES, humanTookOver, normalise, OWN_TEXT_WINDOW_MS, REPLY_CAP,
  splitForJudge, superseded, turnsOf,
} from './chat-turn'
import { knowledgeFor } from './knowledge'
import { decide, DEFAULT_RULES, type RulesConfig } from './rules'

/**
 * One customer message in a live chat, from arrival to answer.
 *
 * The email path (handle.ts) answers one message at a time. A chat is a
 * conversation: messages come in bursts, a person can step in, and the
 * assistant must never talk over them. So this file owns four things the
 * email path has no need of - the session latch, the burst wait, the claim on
 * each message id, and the transcript replayed as history - and then hands
 * the judgement to the same rules.
 *
 * The channel is still an interface. Nothing here knows it is Gorgias.
 */

export type ChatIncoming = {
  shopId: string
  conversationId: string
  messageId: string
  customerEmail: string | null
  customerName: string | null
  text: string
  via: string | null
  fromAgent: boolean
  /** When the chat started, as the channel reports it. Null when it did not say. */
  conversationStartedAt: Date | null
}

export type ChatDeps = {
  channel: Channel
  /** Injected by tests so the burst wait does not make a suite take six seconds. */
  wait?: (ms: number) => Promise<void>
  /** Injected by tests so no test touches the shared rules row. */
  rules?: RulesConfig & { extraInstructions: string }
  now?: () => Date
}

export type ChatResult = {
  decision: 'sent' | 'drafted' | 'escalated' | 'skipped' | 'superseded'
  reason: string | null
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function loadRules(): Promise<RulesConfig & { extraInstructions: string }> {
  const row = await db.aiSupportRules.findUnique({ where: { id: 'singleton' } })
  if (!row) return { ...DEFAULT_RULES, extraInstructions: '' }
  return {
    mode: row.mode,
    autoCategories: row.autoCategories,
    escalateKeywords: row.escalateKeywords,
    minConfidence: row.minConfidence,
    extraInstructions: row.extraInstructions,
  }
}

/**
 * The texts the assistant itself put in this chat recently: its replies, and
 * every handover line. An agent message equal to one of these is ours; any
 * other agent message is a person.
 */
async function ownTexts(sessionId: string, now: Date): Promise<string[]> {
  const rows = await db.aiConversation.findMany({
    where: { sessionId, answer: { not: null }, createdAt: { gte: new Date(now.getTime() - OWN_TEXT_WINDOW_MS) } },
    select: { answer: true },
  })
  return [...rows.map((r) => r.answer as string), ...Object.values(HANDOVER_LINES)]
}

export async function handleChatMessage(incoming: ChatIncoming, deps: ChatDeps): Promise<ChatResult> {
  const now = deps.now ?? (() => new Date())
  const wait = deps.wait ?? sleep
  const { channel } = deps
  const skip = (reason: string): ChatResult => ({ decision: 'skipped', reason })

  // The switch, checked before anything is written: a shop that is off leaves
  // no trace, and a chat older than the switch is not ours.
  const shop = await db.shop.findUnique({ where: { id: incoming.shopId }, select: { aiChatFrom: true } })
  if (!shop || !shop.aiChatFrom) return skip('This shop is not switched on for chat.')
  if (!incoming.conversationStartedAt) return skip('The channel did not say when the chat started.')
  if (incoming.conversationStartedAt < shop.aiChatFrom) return skip('The chat started before the switch.')

  const session = await db.aiChatSession.upsert({
    where: { source_externalTicketId: { source: channel.name, externalTicketId: incoming.conversationId } },
    create: {
      shopId: incoming.shopId,
      source: channel.name,
      externalTicketId: incoming.conversationId,
      customerEmail: incoming.customerEmail,
    },
    update: { ...(incoming.customerEmail ? { customerEmail: incoming.customerEmail } : {}) },
  })

  // An agent message: ours comes back through the same trigger and is
  // ignored; anyone else's is a person, and the assistant goes quiet for good.
  if (incoming.fromAgent) {
    const own = new Set((await ownTexts(session.id, now())).map(normalise))
    if (own.has(normalise(incoming.text))) return skip('The assistant’s own message.')
    await db.aiChatSession.update({ where: { id: session.id }, data: { status: 'human' } })
    return skip('A person is on this chat.')
  }

  if (session.status !== 'ai') return skip(session.status === 'human' ? 'A person is on this chat.' : 'Already handed over.')
  const text = incoming.text.trim()
  if (!text) return skip('The message had no text.')

  // Claim the message before waiting. The unique constraint on
  // (source, externalMessageId) makes a second delivery of the same message
  // fail here and answer nothing, whatever the timing.
  let claim: { id: string }
  try {
    claim = await db.aiConversation.create({
      data: {
        source: channel.name,
        externalTicketId: incoming.conversationId,
        externalMessageId: incoming.messageId,
        sessionId: session.id,
        shopId: incoming.shopId,
        customerEmail: incoming.customerEmail,
        question: text.slice(0, 5000),
        decision: 'pending',
      },
      select: { id: true },
    })
  } catch {
    return skip('This message was already handled.')
  }
  await db.aiChatSession.update({ where: { id: session.id }, data: { lastCustomerMessageId: incoming.messageId } })

  const outcome = async (decision: ChatResult['decision'], fields: Record<string, unknown>, reason: string | null): Promise<ChatResult> => {
    await db.aiConversation.update({ where: { id: claim.id }, data: { decision, escalationReason: reason, ...fields } }).catch(() => {})
    return { decision, reason }
  }

  // Let the burst finish, then read all of it.
  await wait(BURST_WAIT_MS)
  let transcript: Awaited<ReturnType<NonNullable<Channel['transcript']>>> = []
  try {
    transcript = channel.transcript ? await channel.transcript(incoming.conversationId) : []
  } catch {
    // A transcript we could not read is not a reason to leave the customer
    // waiting: the delivered text alone is answered below.
  }
  if (superseded(transcript, incoming.messageId)) return outcome('superseded', {}, 'The customer wrote again; the later message answers.')
  if (humanTookOver(transcript, await ownTexts(session.id, now()))) {
    await db.aiChatSession.update({ where: { id: session.id }, data: { status: 'human' } })
    return outcome('skipped', {}, 'A person is on this chat.')
  }

  const rules = deps.rules ?? (await loadRules())
  if (rules.mode === 'off') return outcome('skipped', {}, 'The assistant is switched off.')

  // The whole burst is the question, and it is what the review row shows.
  const turns = turnsOf(transcript)
  const { history, message } = splitForJudge(turns, text)
  const asked = { question: message.slice(0, 5000) }

  const handover = async (reason: string, judgement: SupportJudgement | null): Promise<ChatResult> => {
    // Before the first judgement no language is known, so the line is English.
    const language = judgement?.language ?? session.language
    // Draft mode never speaks to the customer, not even to say a person is coming.
    if (rules.mode === 'auto') await channel.sendMessage(incoming.conversationId, handoverLine(language))
    await escalateToHuman(channel, incoming.conversationId, reason, judgement?.summary ?? 'The assistant handed this chat over.', judgement?.reply ?? null)
    if (channel.tag) await channel.tag(incoming.conversationId, 'ai-handover').catch(() => {})
    await db.aiChatSession.update({
      where: { id: session.id },
      data: { status: 'handed_over', handedOverAt: now(), handoverReason: reason, ...(language ? { language } : {}) },
    })
    return outcome('escalated', { ...asked, ...(judgement ? recordable(judgement) : {}) }, reason)
  }

  if (session.replies >= REPLY_CAP) {
    return handover(`The assistant has already replied eight times in this chat, so a person takes over.`, null)
  }

  const context = incoming.customerEmail
    ? await getCustomerContext(incoming.customerEmail)
    : { customer: null, orders: [], previousTickets: [] }
  const knowledge = await knowledgeFor(message, {
    shopId: incoming.shopId,
    country: context.customer?.country ?? null,
    language: session.language,
    skus: context.orders.flatMap((o) => o.products.map((p) => p.name)).slice(0, 20),
  })

  let judgement: SupportJudgement
  try {
    judgement = await judge({
      message, subject: null, context, knowledge, extraInstructions: rules.extraInstructions, history,
      chat: { firstReply: session.replies === 0, customerKnown: context.orders.length > 0 },
    })
  } catch (e) {
    return handover(e instanceof NoApiKey ? e.message : 'The assistant could not be reached.', null)
  }

  const verdict = decide(
    { category: judgement.category, confidence: judgement.confidence, wantsHuman: judgement.wantsHuman },
    message,
    rules,
  )

  if (verdict.action === 'send' && judgement.reply) {
    await channel.sendMessage(incoming.conversationId, judgement.reply)
    await db.aiChatSession.update({
      where: { id: session.id },
      data: { replies: { increment: 1 }, language: judgement.language },
    })
    return outcome('sent', { ...asked, ...recordable(judgement), orderNumber: context.orders[0]?.number ?? null }, null)
  }

  if (verdict.action === 'escalate') {
    return handover(judgement.escalationReason ?? verdict.reason ?? 'A person should handle this.', judgement)
  }

  // Draft: a suggestion for whoever answers, and the session stays open so
  // the next message is drafted too.
  const reason = verdict.reason ?? 'Waiting for a person to send it.'
  await escalateToHuman(channel, incoming.conversationId, reason, judgement.summary, judgement.reply)
  await db.aiChatSession.update({ where: { id: session.id }, data: { language: judgement.language } })
  return outcome('drafted', { ...asked, ...recordable(judgement), orderNumber: context.orders[0]?.number ?? null }, reason)
}

/** The judgement's columns on the review row. */
function recordable(j: SupportJudgement) {
  return {
    answer: j.reply,
    category: j.category,
    language: j.language,
    confidence: j.confidence,
    summary: j.summary,
  }
}
```

Note for the "answered only once" test: the second delivery finds the session in status `ai`, then its `create` with the same `(source, externalMessageId)` fails the unique constraint and returns `skipped`. For the "own message" test, the first turn's row must carry `answer` (it does, via `recordable`) and `sessionId` (set in the claim).

- [ ] **Step 4: Run the tests and type-check**

Run: `npx vitest run src/lib/support/chat.integration.test.ts && npx tsc --noEmit`
Expected: 10 passed. If Prisma's generated name for the compound unique differs from `source_externalTicketId`, read it from `node_modules/.prisma/client/index.d.ts` (search `AiChatSessionWhereUniqueInput`) and use that name in both the code and the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support/chat.ts src/lib/support/chat.integration.test.ts
git commit -m "feat(support): a live chat turn - burst, latch, claim, reply or handover

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 13: The webhook learns which shop, and routes chat

**Files:**
- Modify: `src/app/api/gorgias/webhook/route.ts`
- Modify: `src/app/api/gorgias/webhook/route.integration.test.ts`

**Interfaces:**
- Consumes: `handleChatMessage` (Task 12), `gorgiasChannel` (Task 10).
- Produces: `POST /api/gorgias/webhook?token=…&shop=<Shop.id>` handling chat bodies with `messageId`, `channel`, `via`, `ticketCreatedAt`, `fromAgent`.

- [ ] **Step 1: Add the failing tests**

Append to the `vi.mock` section of `src/app/api/gorgias/webhook/route.integration.test.ts`:

```ts
const handleChatMessage = vi.fn(async () => ({ decision: 'sent', reason: null }))
vi.mock('@/lib/support/chat', () => ({
  handleChatMessage: (incoming: never, deps: never) => handleChatMessage(incoming, deps),
}))
```

and `handleChatMessage.mockClear()` in `beforeEach`. Add a describe block:

```ts
const chat = {
  ticketId: 551789749,
  messageId: 90210,
  channel: 'chat',
  via: 'gorgias_chat',
  ticketCreatedAt: '2026-09-09T10:00:00+02:00',
  customerEmail: 'Nikolaj@Example.com',
  customerName: 'Nikolaj',
  subject: 'Conversation with Nikolaj',
  message: 'Hvor er min pakke?',
  fromAgent: false,
}

describe('a chat message with a shop', () => {
  const postChat = (body: unknown, qs = 'token=s3cret&shop=shop_dk') =>
    POST(new Request(`http://localhost/api/gorgias/webhook?${qs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))

  it('goes to the chat turn with the shop, the message id and the start time', async () => {
    const res = await postChat(chat)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, decision: 'sent' })
    expect(handleMessage).not.toHaveBeenCalled()
    expect(handleChatMessage.mock.calls[0][0]).toMatchObject({
      shopId: 'shop_dk', conversationId: '551789749', messageId: '90210', customerEmail: 'nikolaj@example.com',
      text: 'Hvor er min pakke?', via: 'gorgias_chat', fromAgent: false,
      conversationStartedAt: new Date('2026-09-09T08:00:00Z'),
    })
  })

  it('passes an agent message through, so the chat turn can tell its own from a person', async () => {
    await postChat({ ...chat, fromAgent: true })
    expect(handleChatMessage.mock.calls[0][0]).toMatchObject({ fromAgent: true })
  })

  it('asks which message when a chat body has no message id', async () => {
    expect((await postChat({ ...chat, messageId: undefined })).status).toBe(400)
    expect(handleChatMessage).not.toHaveBeenCalled()
  })

  it('treats a chat without a shop as it always did, an email-style ticket', async () => {
    await postChat(chat, 'token=s3cret')
    expect(handleChatMessage).not.toHaveBeenCalled()
    expect(handleMessage).toHaveBeenCalledTimes(1)
  })

  it('answers 200 when the chat turn fails, because Gorgias never retries', async () => {
    handleChatMessage.mockRejectedValueOnce(new Error('database down'))
    const res = await postChat(chat)
    expect(res.status).toBe(200)
    expect((await res.json()).decision).toBe('failed')
  })
})
```

- [ ] **Step 2: Run to make sure the new block fails**

Run: `npx vitest run src/app/api/gorgias/webhook/route.integration.test.ts`
Expected: the new cases FAIL (`handleChatMessage` never called).

- [ ] **Step 3: Implement**

In `src/app/api/gorgias/webhook/route.ts`:

Add the import:

```ts
import { handleChatMessage } from '@/lib/support/chat'
```

Extend `Body`:

```ts
type Body = {
  ticketId?: string | number
  /** The message's own id. Required for chat, where one ticket has many. */
  messageId?: string | number
  /** chat | email | ... as Gorgias names the ticket's channel. */
  channel?: string
  /** ISO time the ticket was created; compared with the shop's chat switch. */
  ticketCreatedAt?: string
  customerEmail?: string
  customerName?: string
  subject?: string
  message?: string
  via?: string
  /** True when the message was written by an agent, so we do not answer ourselves. */
  fromAgent?: boolean
}
```

After the `ticketId` check and BEFORE the existing `fromAgent` short-circuit, add:

```ts
  // A chat, on a shop that was named in the URL: the chat turn owns it,
  // agent messages included, because telling its own replies from a person's
  // is the chat turn's job. Without a shop the body is handled the old way.
  const shopId = new URL(req.url).searchParams.get('shop')?.trim() || null
  const isChat = body.channel === 'chat' || body.via === 'gorgias_chat' || body.via === 'offline_capture'
  if (shopId && isChat) {
    const messageId = body.messageId === undefined ? '' : String(body.messageId).trim()
    if (!messageId) {
      return NextResponse.json({ error: 'Which message?' }, { status: 400, headers: NO_STORE })
    }
    const channel = gorgiasChannel(body.via ?? 'chat')
    if (!channel) {
      return NextResponse.json(
        { ok: true, decision: 'skipped', reason: 'Gorgias credentials are not configured' },
        { headers: NO_STORE },
      )
    }
    const startedAt = body.ticketCreatedAt ? new Date(body.ticketCreatedAt) : null
    try {
      const result = await handleChatMessage(
        {
          shopId,
          conversationId: ticketId,
          messageId,
          customerEmail: body.customerEmail?.trim().toLowerCase() || null,
          customerName: body.customerName?.trim() || null,
          text: body.message ?? '',
          via: body.via ?? null,
          fromAgent: body.fromAgent === true,
          conversationStartedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
        },
        { channel },
      )
      return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE })
    } catch (e) {
      // 200 deliberately, for the same reason as below: Gorgias does not retry.
      console.error(e)
      return NextResponse.json({ ok: false, decision: 'failed', error: 'Could not handle the message' }, { headers: NO_STORE })
    }
  }
```

- [ ] **Step 4: Run the webhook tests and the type-check**

Run: `npx vitest run src/app/api/gorgias/webhook && npx tsc --noEmit`
Expected: all passed, including the untouched email cases.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/gorgias/webhook
git commit -m "feat(support): the Gorgias webhook routes a shop's chat to the chat turn

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
```

---

### Task 14: README, full verification, pull request

**Files:**
- Modify: `README.md` (after the "## Gorgias" section)

- [ ] **Step 1: Write the setup section**

Insert after the Gorgias sidebar steps in `README.md`:

```markdown
### The assistant on live chat

The support assistant (`src/lib/support/`) can answer a shop's Gorgias live
chats. Off for every shop until an admin sets a date on
Settings -> Support assistant -> Live chat, per shop. It answers chats
started from that date, under the same rules as email: draft mode leaves
suggestions as internal notes, auto mode answers the ticked categories by
itself and hands anything else to a person with a note and the tag
`ai-handover`. A person writing on a chat silences the assistant on that
chat for good.

Switching a shop on, once:

1. Set `GORGIAS_WEBHOOK_SECRET` in Vercel (any long random string) and
   redeploy.
2. Open Settings -> Support assistant, press Show setup beside the shop, and
   create the HTTP integration in Gorgias with exactly the URL and body shown
   (trigger: Ticket message created, method POST).
3. Add a Gorgias rule so that integration fires only for that shop's chat.
4. Practise first at Support -> Try the assistant in the sandbox: a wrong
   answer plus a correction becomes an example it uses from the next turn.
5. Set the shop's date. Start in draft mode and read the notes on real chats;
   switch the mode to auto when the drafts are right.

The webhook is `/api/gorgias/webhook?token=<secret>&shop=<shop id>`. Gorgias
does not retry a failed delivery, so the route answers 200 to everything it
has taken responsibility for and records the problem on the conversation.
```

- [ ] **Step 2: The whole suite, the type-check, lint and the build**

Run, one after the other:

```bash
npx vitest run
npx tsc --noEmit
npx eslint src --max-warnings=0 || npx eslint src
npm run build
```

Expected: every test passes (a red `sync.test.ts` on a full run is contention; re-run it alone with `--testTimeout=20000`), no type errors, no new lint errors, build clean. `npm run build` pushes the schema to the local database first; that is expected.

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs: switching a shop's live chat on for the assistant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE"
git branch --show-current
git push -u origin feat/ai-chat-agent
```

- [ ] **Step 4: Open the pull request**

```bash
gh pr create --base main --head feat/ai-chat-agent --title "feat(support): the assistant answers live chat, one shop at a time" --body-file - <<'EOF'
Philip asked to switch on AI for the Gorgias live chat, try it in the software first with corrections, then roll it out per shop with handover to a person. Gorgias's own AI Agent is Shopify-only, so the assistant is ours, inside the Gorgias chat window. Design: docs/superpowers/specs/2026-09-09-ai-chat-agent-design.md.

## What ships

- A sandbox at /support/sandbox: talk to the assistant as a customer, see what it would do and why, mark it wrong with a correction that becomes an example it retrieves from the next turn on. Corrections on the review page do the same.
- Per-shop switch `Shop.aiChatFrom` on the Support assistant settings page, with the exact Gorgias webhook URL and body to paste.
- A chat turn (`src/lib/support/chat.ts`): six-second burst wait, one answer per message id, a transcript replayed as history, a human latch, handover with one line, a note and the `ai-handover` tag, an eight-reply cap. Draft mode never speaks to the customer.
- Chat replies go out on Gorgias's `chat` channel (the adapter previously used the widget's `via` name).

## Not proven here

One real chat on panetti.dk: Philip switches the shop on in draft mode, we read the note, then auto. Recorded in a follow-up comment.

## Tests

`npx vitest run` green, `tsc --noEmit` clean, `next build` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_0142Cm8hri6fDN2XTwXdotjE
EOF
```

- [ ] **Step 5: Watch the deploy**

After merge, check the production deployment with `gh api repos/philipantonetti-ctrl/panetti/deployments?per_page=3` and, once it is live, open `/settings/ai-support` on https://panetti.vercel.app to see the Live chat section. Then send Philip the five steps from the README section in plain words.

---

## Self-review

**Spec coverage.** Data model (Task 1). Correction loop, both places (Task 2; the sandbox uses the same PATCH route in Task 7). Chat-mode prompt, self-identification, order-number request, examples followed (Task 3). Sandbox behaviour incl. mode treated as auto, source `sandbox`, knowledge and facts shown (Tasks 4, 5, 7). Review page filter and counts (Task 6). Per-shop switch, webhook URL, body template, keyword pre-fill (Task 8). Gorgias reads and tag (Task 9). `via` -> `chat` mapping, transcript of public messages (Task 10). Burst, supersede, latch, cap, handover line per language (Task 11). Orchestration incl. claim-by-insert, draft mode silence, error handover, shop switch and start-time checks (Task 12). Webhook routing with `?shop=` (Task 13). Setup docs and live proof (Task 14). Gaps: none found. The Gorgias template variable names are confirmed in Task 8 Step 1 rather than assumed.

**Placeholders.** None: every code step carries its code; the one external lookup (Task 8 Step 1) names the URLs.

**Type consistency.** `Turn` is defined once in `agent.ts` and imported by `chat-turn.ts`, `sandbox.ts` and the sandbox page (redeclared there as a local type with the same shape, which is normal for a client component). `TranscriptMessage` lives in `channel.ts` and is consumed by `chat-turn.ts`, `chat.ts` and the tests. `ChatDeps.rules` and `runSandboxTurn`'s `deps.rules` share the shape `RulesConfig & { extraInstructions: string }`. The compound unique `source_externalTicketId` is the Prisma default name for `@@unique([source, externalTicketId])`; Task 12 Step 4 says where to check if the generated name differs.
