# Support Inbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A unified support inbox inside panetti-analytics: every brand's support address forwards into Postmark, each email becomes or continues a ticket auto-matched to its customer, orders and parcels, and agents reply from the brand's own address without leaving the app.

**Architecture:** Postmark inbound webhook → `ingestInbound()` (thread by RFC Message-ID chain, match order, classify) → five new Prisma tables. Replies go out through the existing `sendEmail()` (extended with per-brand From and threading headers). The sidebar reuses the same `deliveryFor()` verdict the Delivery page prints. Pure logic (threading, identifiers, macros, category, language) lives in `src/lib/inbox/` and is unit-tested; DB logic is integration-tested against the one local Postgres with tagged rows.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 6 / PostgreSQL, zod 4, vitest 4 (projects: `app` parallel, `delivery` serial), Playwright. Design record: `docs/plans/2026-08-24-support-inbox-design.md`.

---

## Ground rules (read once)

- **Worktree:** everything happens in `C:\Users\alama\.config\superpowers\worktrees\ecom-analytics\support-inbox` on branch `feat/support-inbox`. All commands below run from that root. The main checkout is another session's - never touch it.
- **Shared Postgres.** The local DB is shared with another live session. Integration tests must create their own rows tagged `[inbox-test]` (shop names, mailbox addresses `*.inbox-test.invalid`) and clean them up in `beforeEach` + `afterAll`. Never `deleteMany()` a table wholesale in a test.
- **Tests that touch the DB** are named `*.integration.test.ts` and, unless they touch a shared singleton, stay in the parallel `app` vitest project (they will - nothing here touches `Setting`/`DeliveryConfig`).
- **Comment style:** this codebase's comments are decision records - say WHY a branch exists, never what the next line does. Match it. No "added by", no restating code.
- **Money** is integer minor units; render with `formatMoney(minor, currency)` from `@/lib/money`.
- **Null ≠ zero / null ≠ empty.** `null` means "don't know" everywhere (language undetected, no match, phone not stored). Never store a guess.
- **Commit after every task** with the repo's message style: `type(scope): what changed, in a sentence a person would say`. End with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Verification commands:** `npx vitest run <file>` for one file; `npm test` for the suite; `npx tsc --noEmit` for types; `npm run lint`; `npm run test:e2e -- --headed e2e/inbox.spec.ts` (e2e needs `--headed` on this machine and a running `npm run dev` or lets Playwright start one).
- **Known baseline:** on `origin/main`, `src/app/dashboard/DashboardClient.test.tsx` fails deterministically (affiliate merge added a sixth stat tile). Task 0 fixes it. `src/lib/woo/sync.test.ts` can time out when the other session hammers Postgres - rerun alone; it passes.

---

### Task 0: Baseline - make main's one red test green

**Files:**
- Modify: `src/app/dashboard/DashboardClient.test.tsx:145`

**Why:** `bdf3306` added the AFFILIATE COST tile (`src/components/dashboard/StatStrip.tsx:230`). Only zero-figure tiles carry the "vs the day before" tooltip; in this test all figures are zero, so all six tiles carry it. The sibling assertion at line 130 still expects 5 because there five tiles have non-zero figures and show the label as text instead. 6 is correct.

**Step 1: Run the failing test**

Run: `npx vitest run src/app/dashboard/DashboardClient.test.tsx`
Expected: 1 failed - `expected [...] to have a length of 5 but got 6`

**Step 2: Fix the expectation**

Change line 145 to:

```ts
    // Six, not five: the AFFILIATE COST tile joined the strip and, with every
    // figure at zero, it carries the same "no data" tooltip as the others.
    expect(await screen.findAllByTitle('vs the day before: 2026-08-20 → 2026-08-20')).toHaveLength(6)
```

**Step 3: Run it again**

Run: `npx vitest run src/app/dashboard/DashboardClient.test.tsx`
Expected: 6 passed

**Step 4: Commit**

```bash
git add src/app/dashboard/DashboardClient.test.tsx
git commit -m "test(dashboard): the day-before tooltip counts the affiliate tile too"
```

---

### Task 1: Schema - five tables and one column

**Files:**
- Modify: `prisma/schema.prisma` (Shop relations ~line 66, Order fields ~line 166 + index block ~line 182, User relations ~line 262, new models at end)

**Step 1: Add relations and the phone column**

In `model Shop`, add to the relation list:

```prisma
  mailboxes             Mailbox[]
```

In `model Order`, after `shippingCountry   String?` add:

```prisma
  /// From Woo's billing details. Same tri-state as customerName: null = not
  /// yet backfilled, '' = checked, the store has none. Stored digits-and-plus
  /// as Woo gives it; the inbox normalises at match time, not here.
  customerPhone     String?
```

and in the Order relation list add `tickets     Ticket[]`, and in the index block add:

```prisma
  @@index([customerEmail])
```

In `model User`, add:

```prisma
  assignedTickets Ticket[]
  ticketMessages  TicketMessage[]
```

**Step 2: Append the new models at the end of the file**

```prisma
/// One support address, forwarded into Postmark's inbound stream.
///
/// The routing anchor. Which brand and country an email belongs to is decided
/// by the address it was sent TO, never inferred from its text - support@
/// panetti.de is Panetti Germany, full stop. `shopId` is what scopes an order
/// number found in the mail: Woo numbers repeat across stores, so "#1042" only
/// means something inside this mailbox's own shop.
model Mailbox {
  id        String   @id @default(cuid())
  address   String   @unique // lowercase
  name      String
  shopId    String?
  /// Default reply language for this brand: nb | sv | da | fi | de | en.
  /// A ticket whose language could not be detected renders in this.
  language  String   @default("en")
  signature String   @default("")
  active    Boolean  @default(true)
  createdAt DateTime @default(now())

  shop    Shop?    @relation(fields: [shopId], references: [id], onDelete: SetNull)
  tickets Ticket[]
}

/// One conversation with one customer about one thing.
model Ticket {
  id             String    @id @default(cuid())
  /// Human-facing, rendered PA-1042, and carried in every outbound subject as
  /// [PA-1042] so a reply from a client that strips threading headers still
  /// finds its way home.
  number         Int       @unique @default(autoincrement())
  mailboxId      String
  status         String    @default("OPEN") // OPEN | PENDING | CLOSED
  priority       String    @default("NORMAL") // LOW | NORMAL | HIGH
  subject        String
  customerEmail  String // lowercase
  customerName   String    @default("")
  tags           String[]  @default([])
  /// shipping | return | warranty | refund | product | other. Null = not yet
  /// classified. Keyword rules write it today; an AI classifier can replace
  /// them without touching this column.
  category       String?
  /// Null = not detected. Rendered as the mailbox default, never stored as one:
  /// Norwegian and Danish fool every detector, and a stored guess would pick
  /// the wrong macro variant forever.
  language       String?
  assigneeUserId String?
  /// The order this conversation is ABOUT, from the matching cascade or a
  /// person's hand. Null is honest: the sidebar says "no order matched" and
  /// offers the customer's orders to pick from.
  matchedOrderId String?
  firstMessageAt DateTime
  lastMessageAt  DateTime
  closedAt       DateTime?
  createdAt      DateTime  @default(now())

  mailbox      Mailbox         @relation(fields: [mailboxId], references: [id], onDelete: Cascade)
  assignee     User?           @relation(fields: [assigneeUserId], references: [id], onDelete: SetNull)
  matchedOrder Order?          @relation(fields: [matchedOrderId], references: [id], onDelete: SetNull)
  messages     TicketMessage[]

  @@index([mailboxId, status, lastMessageAt])
  @@index([customerEmail])
  @@index([assigneeUserId])
}

/// One email in, one email out, or one internal note - the same row shape, so
/// the thread is one ordered list. A NOTE never leaves the building.
model TicketMessage {
  id            String   @id @default(cuid())
  ticketId      String
  direction     String // INBOUND | OUTBOUND | NOTE
  authorUserId  String? // null on INBOUND
  /// RFC 5322 Message-ID without the angle brackets. Theirs as received; ours
  /// minted BEFORE sending so the References chain never depends on reading
  /// anything back from Postmark. Unique, which is what makes a redelivered
  /// webhook a no-op - the ShipmentEvent seam, applied to email.
  rfcMessageId  String?  @unique
  inReplyTo     String?
  /// Space-separated ids, oldest first, exactly as the header carries them.
  references    String   @default("")
  fromEmail     String
  toEmail       String
  textBody      String
  /// Stored raw; sanitised at render time, never trusted.
  htmlBody      String?
  /// Postmark's quoted-history-free text - what the thread view shows.
  strippedReply String?
  spamScore     Float?
  postmarkId    String?
  sentAt        DateTime

  ticket      Ticket             @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  author      User?              @relation(fields: [authorUserId], references: [id], onDelete: SetNull)
  attachments TicketAttachment[]

  @@index([ticketId, sentAt])
}

/// Bytes in Postgres, deliberately: one database, and Postmark keeps inbound
/// content only 45 days, so this is the system of record. Capped at 10 MB per
/// file on the way in.
model TicketAttachment {
  id          String @id @default(cuid())
  messageId   String
  filename    String
  contentType String
  sizeBytes   Int
  content     Bytes

  message TicketMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@index([messageId])
}

/// A reply template. One row per language variant sharing a name - the
/// ticket's language (or its mailbox's default) picks the variant.
model Macro {
  id        String   @id @default(cuid())
  name      String
  language  String   @default("en")
  body      String
  createdAt DateTime @default(now())

  @@unique([name, language])
}
```

**Step 3: Push and regenerate**

Run: `npm run db:push`
Expected: `Your database is now in sync with your Prisma schema.` and `Generated Prisma Client`.

Run: `npx tsc --noEmit`
Expected: no output (clean).

**Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(inbox): mailboxes, tickets, messages, attachments and macros - and the phone Woo always sent"
```

---

### Task 2: `sendEmail` learns From, headers, and the returned id

**Files:**
- Modify: `src/lib/email/send.ts`
- Test: `src/lib/email/send.test.ts`

**Step 1: Write the failing tests** - append inside the `describe('sendEmail', …)` block:

```ts
  /**
   * A support reply must leave from the BRAND's address, threaded onto the
   * customer's conversation. Neither is a concern of the password reset that
   * this function was written for, so both arrive as options and the old
   * three-argument call keeps meaning exactly what it did.
   */
  it('sends from the address given, with custom headers, and returns Postmark id', async () => {
    const fn = vi.fn<Fetch>(async () => new Response('{"MessageID":"pm-123"}', { status: 200 }))
    vi.stubGlobal('fetch', fn)

    const r = await sendEmail('kari@example.com', 'Re: Order', 'Hello', {
      from: 'support@panetti.no',
      headers: { 'Message-ID': '<a@panetti.no>', 'In-Reply-To': '<b@gmail.com>' },
    })

    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.From).toBe('support@panetti.no')
    expect(body.Headers).toEqual([
      { Name: 'Message-ID', Value: '<a@panetti.no>' },
      { Name: 'In-Reply-To', Value: '<b@gmail.com>' },
    ])
    expect(r).toEqual({ postmarkId: 'pm-123' })
  })

  it('falls back to EMAIL_FROM and sends no Headers field when none are given', async () => {
    const fn = ok()
    vi.stubGlobal('fetch', fn)
    await sendEmail('amb@example.com', 'S', 'B')
    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.From).toBe('no-reply@panetti.no')
    expect(body.Headers).toBeUndefined()
  })

  it('an explicit from does not need EMAIL_FROM to be set', async () => {
    vi.stubEnv('EMAIL_FROM', '')
    vi.stubGlobal('fetch', ok())
    await expect(sendEmail('a@b.c', 'S', 'B', { from: 'support@panetti.no' })).resolves.toEqual({ postmarkId: null })
  })
```

**Step 2: Run to see them fail**

Run: `npx vitest run src/lib/email/send.test.ts`
Expected: 3 failed (type errors on the 4th argument / `Headers` undefined / return value).

**Step 3: Implement** - replace the function signature and body in `src/lib/email/send.ts`:

```ts
export type SendOptions = {
  /** Who the message is from. Defaults to EMAIL_FROM - the app's own voice. */
  from?: string
  /** Extra RFC headers, e.g. Message-ID / In-Reply-To / References for threading. */
  headers?: Record<string, string>
}

export type SendResult = {
  /** Postmark's own id for the delivery, for its activity log. Null if it sent none. */
  postmarkId: string | null
}

export async function sendEmail(
  to: string,
  subject: string,
  textBody: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  const token = process.env.POSTMARK_SERVER_TOKEN
  const from = opts.from ?? process.env.EMAIL_FROM

  // Checked before the network, so a misconfigured server never opens a
  // connection to be told something it could have known locally. The variable
  // is NAMED in the message because the only person who ever reads it is
  // whoever has to go and set it.
  if (!token) throw new Error('POSTMARK_SERVER_TOKEN is not set, so no email can be sent')
  if (!from) throw new Error('EMAIL_FROM is not set, so no email can be sent')

  const headers = opts.headers
    ? Object.entries(opts.headers).map(([Name, Value]) => ({ Name, Value }))
    : undefined

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: subject,
      TextBody: textBody,
      MessageStream: STREAM,
      ...(headers ? { Headers: headers } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok) {
    // Postmark answers a JSON body with an ErrorCode and a Message that says
    // exactly what is wrong ("Sender signature not confirmed", "Bad token").
    // Carrying it into the thrown error is the difference between a diagnosable
    // failure and a bare status code.
    const body = (await res.text()).slice(0, 200)
    throw new Error(`Postmark responded ${res.status}: ${body}`)
  }

  // Best-effort: the send already succeeded, and an unparseable body must not
  // turn it into a failure the caller then retries into a duplicate email.
  const parsed = (await res.json().catch(() => null)) as { MessageID?: unknown } | null
  return { postmarkId: typeof parsed?.MessageID === 'string' ? parsed.MessageID : null }
}
```

Keep the existing file header comments (`TIMEOUT_MS`, `ENDPOINT`, `STREAM` and the doc comment on the function) intact; only the signature/body change.

**Step 4: Run tests**

Run: `npx vitest run src/lib/email/send.test.ts src/app/api/auth/forgot`
Expected: all pass (the forgot route ignores the new return value).

Run: `npx tsc --noEmit` - clean.

**Step 5: Commit**

```bash
git add src/lib/email/send.ts src/lib/email/send.test.ts
git commit -m "feat(email): a message can leave from a brand's own address, threaded, and says what Postmark called it"
```

---

### Task 3: Threading - pure header logic

**Files:**
- Create: `src/lib/inbox/threading.ts`
- Test: `src/lib/inbox/threading.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  headerValue, messageIdsIn, threadRefs, ticketNumberIn, ticketToken,
  replySubject, mintMessageId, isAutomated, spamScoreOf,
} from './threading'

const H = (pairs: [string, string][]) => pairs.map(([Name, Value]) => ({ Name, Value }))

describe('headerValue', () => {
  it('is case-insensitive on the name, because mailers disagree on it', () => {
    expect(headerValue(H([['message-id', '<a@x>']]), 'Message-ID')).toBe('<a@x>')
    expect(headerValue(H([]), 'Message-ID')).toBeNull()
  })
})

describe('messageIdsIn', () => {
  it('extracts every bracketed id, brackets stripped, in order', () => {
    expect(messageIdsIn('<a@x> <b@y>\r\n <c@z>')).toEqual(['a@x', 'b@y', 'c@z'])
  })
  it('accepts a bare id without brackets, which some clients send', () => {
    expect(messageIdsIn('a@x')).toEqual(['a@x'])
  })
  it('is empty for nothing', () => {
    expect(messageIdsIn(null)).toEqual([])
    expect(messageIdsIn('')).toEqual([])
  })
})

describe('threadRefs', () => {
  it('reads Message-ID, In-Reply-To and References from the header list', () => {
    const refs = threadRefs(H([
      ['Message-ID', '<c@gmail.com>'],
      ['In-Reply-To', '<b@panetti.no>'],
      ['References', '<a@gmail.com> <b@panetti.no>'],
    ]))
    expect(refs).toEqual({ messageId: 'c@gmail.com', inReplyTo: 'b@panetti.no', references: ['a@gmail.com', 'b@panetti.no'] })
  })
  it('is all-empty when the headers carry none', () => {
    expect(threadRefs(H([]))).toEqual({ messageId: null, inReplyTo: null, references: [] })
  })
})

describe('ticket token in the subject', () => {
  it('finds our own token anywhere in the subject', () => {
    expect(ticketNumberIn('Re: Where is my order [PA-1042]')).toBe(1042)
    expect(ticketNumberIn('Fwd: [PA-7] hello')).toBe(7)
  })
  it('ignores subjects without one, and other people\'s brackets', () => {
    expect(ticketNumberIn('Order #1042')).toBeNull()
    expect(ticketNumberIn('[Ticket 1042]')).toBeNull()
  })
  it('renders the token the same way it parses it', () => {
    expect(ticketNumberIn(`x ${ticketToken(1042)}`)).toBe(1042)
  })
})

describe('replySubject', () => {
  it('prefixes Re: once and appends the token once', () => {
    expect(replySubject('Where is my order?', 12)).toBe('Re: Where is my order? [PA-12]')
    expect(replySubject('Re: Where is my order? [PA-12]', 12)).toBe('Re: Where is my order? [PA-12]')
    expect(replySubject('RE: hello', 3)).toBe('RE: hello [PA-3]')
  })
  it('gives an empty subject something to thread on', () => {
    expect(replySubject('', 5)).toBe('Re: Your message [PA-5]')
  })
})

describe('mintMessageId', () => {
  it('is bracketed, carries the ticket number and the mailbox domain, and never repeats', () => {
    const a = mintMessageId(1042, 'support@panetti.no')
    const b = mintMessageId(1042, 'support@panetti.no')
    expect(a).toMatch(/^<pa1042\.[a-z0-9]+\.[a-f0-9]{8}@panetti\.no>$/)
    expect(a).not.toBe(b)
  })
})

describe('isAutomated', () => {
  it('flags out-of-office and bulk mail by the headers Zendesk suspends on', () => {
    expect(isAutomated(H([['Auto-Submitted', 'auto-replied']]))).toBe(true)
    expect(isAutomated(H([['Precedence', 'bulk']]))).toBe(true)
    expect(isAutomated(H([['X-Autoreply', 'yes']]))).toBe(true)
  })
  it('lets a human message through, including Auto-Submitted: no', () => {
    expect(isAutomated(H([['Auto-Submitted', 'no']]))).toBe(false)
    expect(isAutomated(H([]))).toBe(false)
  })
})

describe('spamScoreOf', () => {
  it('reads Postmark\'s SpamAssassin score', () => {
    expect(spamScoreOf(H([['X-Spam-Score', '7.3']]))).toBe(7.3)
    expect(spamScoreOf(H([['X-Spam-Score', '-0.1']]))).toBe(-0.1)
  })
  it('is null when absent or unreadable - unknown, not clean', () => {
    expect(spamScoreOf(H([]))).toBeNull()
    expect(spamScoreOf(H([['X-Spam-Score', 'n/a']]))).toBeNull()
  })
})
```

**Step 2: Run to see them fail**

Run: `npx vitest run src/lib/inbox/threading.test.ts`
Expected: FAIL - cannot find module './threading'

**Step 3: Implement `src/lib/inbox/threading.ts`**

```ts
import { randomBytes } from 'crypto'

/** One header as Postmark's inbound webhook hands it over. */
export type Header = { Name: string; Value: string }

export function headerValue(headers: Header[], name: string): string | null {
  const want = name.toLowerCase()
  const hit = headers.find((h) => typeof h?.Name === 'string' && h.Name.toLowerCase() === want)
  return hit && typeof hit.Value === 'string' ? hit.Value : null
}

/**
 * Every message id in a header value, brackets stripped, in order. A bare id
 * with no brackets is accepted too: the RFC requires them, some clients omit
 * them, and a reply that fails to thread because of a missing '<' is a ticket
 * duplicated for nothing.
 */
export function messageIdsIn(value: string | null): string[] {
  if (!value) return []
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1])
  if (bracketed.length) return bracketed
  const bare = value.trim()
  return bare && !/\s/.test(bare) ? [bare] : []
}

export type ThreadRefs = {
  messageId: string | null
  inReplyTo: string | null
  references: string[]
}

export function threadRefs(headers: Header[]): ThreadRefs {
  return {
    messageId: messageIdsIn(headerValue(headers, 'Message-ID'))[0] ?? null,
    inReplyTo: messageIdsIn(headerValue(headers, 'In-Reply-To'))[0] ?? null,
    references: messageIdsIn(headerValue(headers, 'References')),
  }
}

/**
 * Our own token in a subject line, the fallback for clients that strip the
 * threading headers. The same shape Zendesk keeps ([1G7EOR-0Q2J]) for the
 * same reason.
 */
const TICKET_TOKEN = /\[PA-(\d+)\]/

export function ticketNumberIn(subject: string): number | null {
  const m = TICKET_TOKEN.exec(subject)
  return m ? Number(m[1]) : null
}

export const ticketToken = (number: number): string => `[PA-${number}]`

/**
 * Gmail threads on headers AND a matching subject, so the customer's subject is
 * kept as-is under a single "Re:" - never rewritten - with our token added
 * once at the end.
 */
export function replySubject(subject: string, number: number): string {
  const base = subject.trim() || 'Your message'
  const withRe = /^re:/i.test(base) ? base : `Re: ${base}`
  return ticketNumberIn(withRe) === number ? withRe : `${withRe} ${ticketToken(number)}`
}

/**
 * A Message-ID of our own, minted BEFORE the send. Building the References
 * chain from ids we chose means it never depends on reading anything back
 * from Postmark, which returns only its own UUID.
 */
export function mintMessageId(ticketNumber: number, mailboxAddress: string, now: Date = new Date()): string {
  const domain = mailboxAddress.split('@')[1] ?? 'localhost'
  return `<pa${ticketNumber}.${now.getTime().toString(36)}.${randomBytes(4).toString('hex')}@${domain}>`
}

/**
 * An autoresponder, by the headers the RFCs and Zendesk agree on. Answering
 * one is how two helpdesks talk to each other until someone pulls the plug.
 */
export function isAutomated(headers: Header[]): boolean {
  const auto = headerValue(headers, 'Auto-Submitted')
  if (auto && auto.trim().toLowerCase() !== 'no') return true
  const precedence = headerValue(headers, 'Precedence')?.trim().toLowerCase()
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true
  return headerValue(headers, 'X-Autoreply') !== null || headerValue(headers, 'X-Autorespond') !== null
}

/** Postmark runs SpamAssassin on inbound and stamps the score; 5 is its threshold. */
export function spamScoreOf(headers: Header[]): number | null {
  const raw = headerValue(headers, 'X-Spam-Score')
  if (raw === null) return null
  const n = Number(raw.trim())
  return Number.isFinite(n) ? n : null
}
```

**Step 4: Run tests**

Run: `npx vitest run src/lib/inbox/threading.test.ts`
Expected: all pass

**Step 5: Commit**

```bash
git add src/lib/inbox/threading.ts src/lib/inbox/threading.test.ts
git commit -m "feat(inbox): the threading rules - ids, our subject token, and what counts as an autoresponder"
```

---

### Task 4: Identifiers in the text - order numbers, tracking numbers, phones

**Files:**
- Create: `src/lib/inbox/identifiers.ts`
- Test: `src/lib/inbox/identifiers.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { orderNumbersIn, trackingNumbersIn, phonesIn, normalizePhone } from './identifiers'

describe('orderNumbersIn', () => {
  it('finds a hash-prefixed number and the number after the word order in five languages', () => {
    expect(orderNumbersIn('Hei, ordre #1042 har ikke kommet')).toEqual(['1042'])
    expect(orderNumbersIn('my order 1042 is late')).toEqual(['1042'])
    expect(orderNumbersIn('Bestilling 1042, ordrenummer 1043')).toEqual(['1042', '1043'])
    expect(orderNumbersIn('Beställning 1042')).toEqual(['1042'])
    expect(orderNumbersIn('Bestellung 1042 / Bestellnummer: 1044')).toEqual(['1042', '1044'])
    expect(orderNumbersIn('Tilaus 1042')).toEqual(['1042'])
  })
  it('keeps a B2B number whole', () => {
    expect(orderNumbersIn('invoice for B-0007 please')).toEqual(['B-0007'])
  })
  it('does not mistake a year, a phone or a tracking number for an order', () => {
    expect(orderNumbersIn('in 2026 I called 91234567')).toEqual([])
    expect(orderNumbersIn('parcel 373123456789012345')).toEqual([])
  })
  it('dedupes', () => {
    expect(orderNumbersIn('#1042 and again order 1042')).toEqual(['1042'])
  })
})

describe('trackingNumbersIn', () => {
  it('finds Bring 18-digit numbers and DHL JJD numbers', () => {
    expect(trackingNumbersIn('Sporing: 373123456789012345.')).toEqual(['373123456789012345'])
    expect(trackingNumbersIn('DHL JJD000390013287654321 stuck')).toEqual(['JJD000390013287654321'])
  })
  it('ignores short digit runs like phones and order numbers', () => {
    expect(trackingNumbersIn('call 91234567 about #1042')).toEqual([])
  })
})

describe('phones', () => {
  it('normalises to digits with the country prefix kept', () => {
    expect(normalizePhone('+47 912 34 567')).toBe('4791234567')
    expect(normalizePhone('0047 912 34 567')).toBe('4791234567')
    expect(normalizePhone('912 34 567')).toBe('91234567')
  })
  it('finds phone-shaped runs in text, normalised', () => {
    expect(phonesIn('ring meg på +47 912 34 567 eller 22 33 44 55')).toEqual(['4791234567', '22334455'])
  })
  it('does not report an order number or a tracking number as a phone', () => {
    expect(phonesIn('order #1042, parcel 373123456789012345')).toEqual([])
  })
})
```

**Step 2: Run to see them fail** - `npx vitest run src/lib/inbox/identifiers.test.ts` → cannot find module.

**Step 3: Implement `src/lib/inbox/identifiers.ts`**

```ts
/**
 * What a customer types when they mean an order, in the languages the shops
 * trade in. The number itself is 3-7 digits: shop numbers run #1000-#99999
 * today, and anything longer is a parcel or a phone.
 */
const ORDER_WORD =
  /(?:#|\b(?:order|ordre|ordrenummer|ordrenr|bestilling|bestillingsnummer|beställning|beställningsnummer|ordernummer|bestellung|bestellnummer|tilaus|tilausnumero)\b[\s:.#-]*)(\d{3,7})\b/gi

const B2B_NUMBER = /\bB-\d{4,}\b/g

export function orderNumbersIn(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(ORDER_WORD)) found.add(m[1])
  for (const m of text.matchAll(B2B_NUMBER)) found.add(m[0])
  return [...found]
}

/**
 * Bring's 18-digit numbers start 373 (the shape lib/bring already matches);
 * DHL Express is JJD + digits. A generic 14-20 digit run covers the rest of
 * Bring's range without swallowing 8-12 digit phones.
 */
const TRACKING = /\b(?:373\d{15}|JJD\d{15,22}|\d{14,20})\b/g

export function trackingNumbersIn(text: string): string[] {
  return [...new Set([...text.matchAll(TRACKING)].map((m) => m[0]))]
}

/** Digits only, with a 00 international prefix folded into a plus-less country code. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.startsWith('00') ? digits.slice(2) : digits
}

/**
 * A phone is 8-12 digits once the spaces come out, optionally led by + or 00.
 * The run is matched WITH its separators so "912 34 567" is one number, not
 * three, and then normalised. Anything that also reads as a tracking number
 * is not a phone.
 */
const PHONE = /(?:\+|00)?\d(?:[\s.-]?\d){7,11}\b/g

export function phonesIn(text: string): string[] {
  const parcels = new Set(trackingNumbersIn(text))
  const found = new Set<string>()
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, '')
    if (parcels.has(digits)) continue
    // A run that began with # is an order number, not a phone.
    if (m.index !== undefined && text[m.index - 1] === '#') continue
    const n = normalizePhone(m[0])
    if (n.length >= 8 && n.length <= 12) found.add(n)
  }
  return [...found]
}
```

**Step 4: Run** - `npx vitest run src/lib/inbox/identifiers.test.ts` → all pass. If `phonesIn('order #1042, …')` still finds `1042`: it is 4 digits, below the 8-digit floor, so it cannot - but verify the `#` guard against `#91234567` style input by adding that as an extra case if you wish.

**Step 5: Commit**

```bash
git add src/lib/inbox/identifiers.ts src/lib/inbox/identifiers.test.ts
git commit -m "feat(inbox): order numbers, parcel numbers and phones, as customers actually write them"
```

---

### Task 5: Category and language - keyword rules, honest about not knowing

**Files:**
- Create: `src/lib/inbox/classify.ts`
- Test: `src/lib/inbox/classify.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { categorize, detectLanguage, CATEGORIES, LANGUAGES } from './classify'

describe('categorize', () => {
  it('reads the customer\'s intent from subject and body in the shops\' languages', () => {
    expect(categorize('Hvor er pakken min?', '')).toBe('shipping')
    expect(categorize('', 'Where is my order, it says in transit')).toBe('shipping')
    expect(categorize('Retur', 'Jeg vil returnere stolen')).toBe('return')
    expect(categorize('Widerruf', 'Ich möchte die Bestellung zurückschicken')).toBe('return')
    expect(categorize('Reklamasjon', 'Massasjepistolen er ødelagt')).toBe('warranty')
    expect(categorize('Garanti', 'Stolen er defekt etter 2 måneder')).toBe('warranty')
    expect(categorize('Refusjon', 'Når får jeg pengene tilbake?')).toBe('refund')
    expect(categorize('Rückerstattung', '')).toBe('refund')
    expect(categorize('Bruksanvisning', 'Hvordan bruker jeg varmefunksjonen?')).toBe('product')
    expect(categorize('How do I', 'set up the massage chair')).toBe('product')
  })
  it('says other, never guesses, when no rule fires', () => {
    expect(categorize('Hello', 'Just saying thanks!')).toBe('other')
  })
  it('a refund question about a return is a refund question', () => {
    expect(categorize('', 'I returned the chair last week, when is my refund coming?')).toBe('refund')
  })
  it('exports the category list the UI filters on', () => {
    expect(CATEGORIES).toEqual(['shipping', 'return', 'warranty', 'refund', 'product', 'other'])
  })
})

describe('detectLanguage', () => {
  it('tells the six languages apart on ordinary support sentences', () => {
    expect(detectLanguage('Hei! Jeg har ikke fått pakken min. Takk')).toBe('nb')
    expect(detectLanguage('Hej! Jag har inte fått mitt paket. Tack')).toBe('sv')
    expect(detectLanguage('Hej! Jeg har ikke modtaget min pakke. Tak')).toBe('da')
    expect(detectLanguage('Hei! En ole saanut pakettiani. Kiitos')).toBe('fi')
    expect(detectLanguage('Hallo! Ich habe mein Paket nicht erhalten. Danke')).toBe('de')
    expect(detectLanguage('Hello! I have not received my package. Thanks')).toBe('en')
  })
  it('returns null rather than a guess on a tie or too little text', () => {
    expect(detectLanguage('ok')).toBeNull()
    expect(detectLanguage('#1042')).toBeNull()
  })
  it('exports the language list', () => {
    expect(LANGUAGES).toEqual(['nb', 'sv', 'da', 'fi', 'de', 'en'])
  })
})
```

**Step 2: Run to see them fail.**

**Step 3: Implement `src/lib/inbox/classify.ts`**

```ts
export const CATEGORIES = ['shipping', 'return', 'warranty', 'refund', 'product', 'other'] as const
export type Category = (typeof CATEGORIES)[number]

/**
 * Keyword rules, most specific intent first: a customer asking where their
 * REFUND is has usually also mentioned the return, and the money question is
 * the one they want answered. Word STEMS, so every inflection the shops'
 * languages produce still matches. An AI classifier can replace this whole
 * table without the ticket column changing shape.
 */
const RULES: [Category, RegExp][] = [
  ['refund', /\b(refund|refusjon|refunder|återbetal|tilbagebetal|hyvity|rückerstatt|erstattung|pengene tilbake|pengarna tillbaka)/i],
  ['return', /\b(return|retur|retour|angrerett|angre|ångra|fortryd|palaut|widerruf|rücksend|zurückschick|zurückgeben)/i],
  ['warranty', /\b(warranty|garanti|reklamasjon|reklamation|takuu|gewährleistung|defekt|broken|ødelagt|trasig|rikki|kaputt|virker ikke|fungerar inte|funktioniert nicht)/i],
  ['shipping', /\b(where is|track|shipping|delivery|deliver|levering|leverans|sendung|lieferung|toimitus|pakke|paket|paketti|sporing|spårning|sendingsnummer|transit)/i],
  ['product', /\b(how do i|how to|instruction|manual|bruksanvisning|brugsanvisning|käyttöohje|anleitung|bedienung|hvordan bruker|hur använder)/i],
]

export function categorize(subject: string, body: string): Category {
  const text = `${subject}\n${body}`
  for (const [category, rule] of RULES) if (rule.test(text)) return category
  return 'other'
}

export const LANGUAGES = ['nb', 'sv', 'da', 'fi', 'de', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

/**
 * Stop-word scoring. Deliberately tiny: the mailbox's default language is
 * already a strong prior, so this only needs to be right when it speaks, and
 * it speaks only on a clear winner. Bokmål and Danish share most of their
 * short words - hei/takk against hej/tak is what separates them here - and
 * when they tie the answer is null, never a coin toss.
 */
const WORDS: Record<Language, string[]> = {
  nb: ['og', 'ikke', 'jeg', 'er', 'det', 'har', 'en', 'med', 'på', 'min', 'hei', 'takk', 'fått', 'kan', 'dere', 'pakken', 'bestilling', 'ordre'],
  sv: ['och', 'inte', 'jag', 'är', 'det', 'har', 'en', 'med', 'på', 'min', 'mitt', 'hej', 'tack', 'fått', 'kan', 'ni', 'paketet', 'paket', 'beställning'],
  da: ['og', 'ikke', 'jeg', 'er', 'det', 'har', 'en', 'med', 'på', 'min', 'hej', 'tak', 'modtaget', 'kan', 'i', 'pakke', 'pakken', 'ordre'],
  fi: ['ja', 'ei', 'en', 'olen', 'on', 'se', 'ole', 'saanut', 'hei', 'kiitos', 'voitteko', 'minun', 'että', 'pakettiani', 'paketti', 'tilaus'],
  de: ['und', 'nicht', 'ich', 'ist', 'das', 'habe', 'ein', 'mit', 'auf', 'mein', 'meine', 'hallo', 'danke', 'erhalten', 'können', 'sie', 'paket', 'bestellung'],
  en: ['and', 'not', 'i', 'is', 'the', 'have', 'a', 'with', 'on', 'my', 'hello', 'thanks', 'received', 'can', 'you', 'package', 'order', 'please'],
}

export function detectLanguage(text: string): Language | null {
  const tokens = text.toLowerCase().match(/[a-zæøåäöüß]+/g) ?? []
  if (tokens.length < 3) return null
  const scores = LANGUAGES.map((lang) => {
    const set = new Set(WORDS[lang])
    return { lang, score: tokens.filter((t) => set.has(t)).length }
  }).sort((a, b) => b.score - a.score)
  const [best, second] = scores
  return best.score >= 2 && best.score > second.score ? best.lang : null
}
```

**Step 4: Run** - `npx vitest run src/lib/inbox/classify.test.ts`. If a language case ties, adjust the sentence in the test toward the language's distinct words (hei/takk vs hej/tak; `mitt`/`inte` for sv; `modtaget` for da) - the lists are the spec, the sentences are the examples.

**Step 5: Commit**

```bash
git add src/lib/inbox/classify.ts src/lib/inbox/classify.test.ts
git commit -m "feat(inbox): what a ticket is about and which language it speaks, or null"
```

---

### Task 6: Macros - render variables, block on the missing ones

**Files:**
- Create: `src/lib/inbox/macros.ts`
- Test: `src/lib/inbox/macros.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { renderMacro, MACRO_VARIABLES } from './macros'

describe('renderMacro', () => {
  it('fills every variable it has', () => {
    const r = renderMacro('Hi {{customer_name}}, order {{order_number}} is {{delivery_status}}.', {
      customer_name: 'Kari', order_number: '#1042', delivery_status: 'in transit',
    })
    expect(r).toEqual({ text: 'Hi Kari, order #1042 is in transit.', missing: [] })
  })

  /**
   * Gorgias replaces a missing variable with a blank and sends "Hi , your
   * order  is on its way". We mark it and refuse to send instead.
   */
  it('marks a variable it cannot fill and names it as missing', () => {
    const r = renderMacro('Parcel {{tracking_number}} for {{customer_name}}', { customer_name: 'Kari' })
    expect(r.text).toBe('Parcel ⟪tracking_number⟫ for Kari')
    expect(r.missing).toEqual(['tracking_number'])
  })

  it('treats null and empty as missing - an empty name is not a name', () => {
    expect(renderMacro('{{customer_name}}', { customer_name: '' }).missing).toEqual(['customer_name'])
    expect(renderMacro('{{customer_name}}', { customer_name: null }).missing).toEqual(['customer_name'])
  })

  it('reports an unknown variable as missing rather than leaving braces in a customer email', () => {
    const r = renderMacro('{{shoe_size}}', {})
    expect(r.text).toBe('⟪shoe_size⟫')
    expect(r.missing).toEqual(['shoe_size'])
  })

  it('tolerates spaces inside the braces and lists each missing name once', () => {
    const r = renderMacro('{{ order_number }} and {{order_number}}', {})
    expect(r.missing).toEqual(['order_number'])
  })

  it('exports the variable list the settings page documents', () => {
    expect(MACRO_VARIABLES).toEqual([
      'customer_name', 'order_number', 'tracking_number', 'product_name', 'delivery_status', 'agent_name', 'brand_name',
    ])
  })
})
```

**Step 2: Run to see it fail.**

**Step 3: Implement `src/lib/inbox/macros.ts`**

```ts
export const MACRO_VARIABLES = [
  'customer_name', 'order_number', 'tracking_number', 'product_name', 'delivery_status', 'agent_name', 'brand_name',
] as const
export type MacroVariable = (typeof MACRO_VARIABLES)[number]

export type MacroVars = Partial<Record<string, string | null>>

/**
 * The marker a missing value leaves behind. Visibly not a brace pair, so the
 * composer can find it, and visibly not prose, so it can never be mistaken for
 * the sentence it interrupts. The send button stays disabled while one exists.
 */
export const MISSING_OPEN = '⟪'
export const MISSING_CLOSE = '⟫'

export function renderMacro(body: string, vars: MacroVars): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, raw: string) => {
    const name = raw.toLowerCase()
    const value = vars[name]
    if (value === undefined || value === null || value === '') {
      if (!missing.includes(name)) missing.push(name)
      return `${MISSING_OPEN}${name}${MISSING_CLOSE}`
    }
    return value
  })
  return { text, missing }
}

/** True while the composer still holds a marker from renderMacro. */
export function hasMissingMarker(text: string): boolean {
  return text.includes(MISSING_OPEN)
}
```

**Step 4: Run** - all pass.

**Step 5: Commit**

```bash
git add src/lib/inbox/macros.ts src/lib/inbox/macros.test.ts
git commit -m "feat(inbox): macro variables fill in, and a missing one is marked, never blanked"
```

---

### Task 7: Delivery phrase - the same verdict, in words a customer can read

**Files:**
- Create: `src/lib/inbox/delivery-phrase.ts`
- Test: `src/lib/inbox/delivery-phrase.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import type { OrderDelivery } from '@/lib/delivery/view'
import { deliveryPhrase } from './delivery-phrase'

const view = (over: Partial<OrderDelivery>): OrderDelivery => ({
  state: 'IN_TRANSIT', totalDays: null, warehouseDays: null, transitDays: null,
  availableAt: null, collectedAt: null, deadline: null, promiseDays: null,
  late: false, daysOver: null, parcels: [], ...over,
})

describe('deliveryPhrase', () => {
  it('says what the Delivery page would say, in a sentence', () => {
    expect(deliveryPhrase(view({ state: 'DELIVERED', totalDays: 3 }))).toBe('delivered, 3 days after the order')
    expect(deliveryPhrase(view({ state: 'DELIVERED_UNDATED' }))).toBe('delivered')
    expect(deliveryPhrase(view({ state: 'AVAILABLE' }))).toBe('ready for pickup')
    expect(deliveryPhrase(view({ state: 'IN_TRANSIT' }))).toBe('in transit')
    expect(deliveryPhrase(view({ state: 'IN_TRANSIT', late: true, daysOver: 2 }))).toBe('in transit, 2 days past the promised date')
    expect(deliveryPhrase(view({ state: 'BOOKED' }))).toBe('packed at the warehouse, not yet handed to the carrier')
    expect(deliveryPhrase(view({ state: 'NO_TRACKING' }))).toBe('not shipped yet')
    expect(deliveryPhrase(view({ state: 'NOT_DUE' }))).toBe('not shipped yet')
    expect(deliveryPhrase(view({ state: 'RETURNED' }))).toBe('returned to sender')
    expect(deliveryPhrase(view({ state: 'CANCELLED' }))).toBe('shipment cancelled')
  })
  it('is null when there is nothing honest to say', () => {
    expect(deliveryPhrase(view({ state: 'UNTRACKED' }))).toBeNull()
    expect(deliveryPhrase(view({ state: 'BEFORE_TRACKING' }))).toBeNull()
    expect(deliveryPhrase(view({ state: 'VOIDED' }))).toBeNull()
  })
})
```

**Step 2: Run to see it fail.**

**Step 3: Implement `src/lib/inbox/delivery-phrase.ts`**

```ts
import type { OrderDelivery } from '@/lib/delivery/view'

/**
 * `{{delivery_status}}` in a macro, and the sidebar's one-line summary. Reads
 * from deliveryFor()'s verdict so support can never tell a customer a
 * different story than the Delivery page tells the owner. Null where the
 * page would show a dash: an untracked shop is not "not shipped".
 */
export function deliveryPhrase(d: OrderDelivery): string | null {
  switch (d.state) {
    case 'DELIVERED':
      return d.totalDays === null ? 'delivered' : `delivered, ${d.totalDays} days after the order`
    case 'DELIVERED_UNDATED':
      return 'delivered'
    case 'AVAILABLE':
      return 'ready for pickup'
    case 'IN_TRANSIT':
      return d.late && d.daysOver !== null ? `in transit, ${d.daysOver} days past the promised date` : 'in transit'
    case 'BOOKED':
      return 'packed at the warehouse, not yet handed to the carrier'
    case 'NO_TRACKING':
    case 'NOT_DUE':
      return 'not shipped yet'
    case 'RETURNED':
      return 'returned to sender'
    case 'CANCELLED':
      return 'shipment cancelled'
    case 'UNTRACKED':
    case 'BEFORE_TRACKING':
    case 'VOIDED':
      return null
  }
}
```

**Step 4: Run** - all pass. `npx tsc --noEmit` clean (the switch is exhaustive over `DeliveryState`; if TS complains about a missing return, add `default: return null`).

**Step 5: Commit**

```bash
git add src/lib/inbox/delivery-phrase.ts src/lib/inbox/delivery-phrase.test.ts
git commit -m "feat(inbox): the delivery verdict in a customer's sentence, or nothing"
```

---

### Task 8: The phone Woo always sent - map, store, backfill

**Files:**
- Modify: `src/lib/woo/map.ts:34` (WooOrder.billing), `:57` (MappedOrder), `:102` (mapOrder)
- Modify: `src/lib/woo/sync.ts:187-206` (storeOrder data), `:339-362` (backfillCustomers)
- Test: `src/lib/woo/map.test.ts` (append), `src/lib/woo/sync.test.ts` (append one case near the existing backfill tests - grep `backfillCustomers` in that file for the fixture helpers it already uses)

**Step 1: Failing test in `map.test.ts`** - append:

```ts
describe('customer phone', () => {
  it('carries the billing phone, and an empty string when the store has none', () => {
    const base = { id: 1, number: '1', status: 'completed', currency: 'NOK', date_created_gmt: '2026-01-01T00:00:00',
      discount_total: '0', discount_tax: '0', shipping_total: '0', shipping_tax: '0', total_tax: '0', total: '0',
      coupon_lines: [], line_items: [] }
    expect(mapOrder({ ...base, billing: { phone: ' +47 912 34 567 ' } }).customerPhone).toBe('+47 912 34 567')
    expect(mapOrder({ ...base, billing: {} }).customerPhone).toBe('')
    expect(mapOrder(base).customerPhone).toBe('')
  })
})
```

(Adapt `base` to whatever minimal fixture helper `map.test.ts` already uses - grep for `const woo` / `fixture` at its top and reuse it rather than duplicating.)

**Step 2: Run** - `npx vitest run src/lib/woo/map.test.ts` → fails: `customerPhone` undefined.

**Step 3: Implement**

`map.ts` - extend the billing type and MappedOrder, and add the mapping line:

```ts
  billing?: { first_name?: string; last_name?: string; email?: string; country?: string; phone?: string }
```

```ts
  // Same convention as customerEmail: '' = checked, none on file.
  customerPhone: string
```

```ts
    customerPhone: woo.billing?.phone?.trim() ?? '',
```

`sync.ts` `storeOrder` - add `customerPhone: o.customerPhone,` after `customerEmail: o.customerEmail,` in the `data` object.

`sync.ts` `backfillCustomers` - the queue widens to orders missing the phone too, and the write carries all three. Replace the `where` and the `update`:

```ts
    // Widened when the phone column arrived: every order synced before it has
    // customerName set and customerPhone null. Same queue, same drain, same
    // '' when the store has none - it costs zero again once history is filled.
    where: { shopId, OR: [{ customerName: null }, { customerPhone: null }] },
```

```ts
      data: {
        customerName: o?.customerName ?? '',
        customerEmail: o?.customerEmail ?? '',
        customerPhone: o?.customerPhone ?? '',
      },
```

Update the function's doc comment: "touches NOTHING but the three customer fields".

**Step 4: Sync test** - in `sync.test.ts`, find the existing backfill test (grep `backfillCustomers`) and add one assertion-level case beside it: an order created with `customerName: 'X', customerPhone: null` is picked up and ends with `customerPhone` from the fixture Woo order (`billing.phone`), and an order with both set is not touched. Follow the file's existing `connectedShop(...)` + fetch-stub helpers exactly.

Run: `npx vitest run src/lib/woo/map.test.ts src/lib/woo/sync.test.ts` → pass. `npx tsc --noEmit` clean (every place constructing a `MappedOrder` literal in tests must gain `customerPhone` - the compiler lists them).

**Step 5: Commit**

```bash
git add src/lib/woo/map.ts src/lib/woo/sync.ts src/lib/woo/map.test.ts src/lib/woo/sync.test.ts
git commit -m "feat(woo): keep the customer's phone, and backfill it the way the name was"
```

---

### Task 9: The matching cascade

**Files:**
- Create: `src/lib/inbox/match.ts`
- Test: `src/lib/inbox/match.integration.test.ts`

**Step 1: Write the failing integration test**

```ts
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { matchOrder } from './match'

const TAG = '[inbox-test-match]'
let shopA: string, shopB: string
let orderA1042: string, orderA1050: string, orderB1042: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'TMATCH' } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

const order = (shopId: string, number: string, placedAt: string, email: string, phone = '') =>
  db.order.create({
    data: {
      shopId, externalId: `m-${shopId}-${number}`, number, placedAt: new Date(placedAt), status: 'completed',
      currency: 'NOK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: 'Kari Olsen', customerEmail: email, customerPhone: phone,
    },
  })

beforeEach(async () => {
  await cleanup()
  shopA = (await db.shop.create({ data: { name: `Panetti A ${TAG}`, currency: 'NOK' } })).id
  shopB = (await db.shop.create({ data: { name: `Mazzetti B ${TAG}`, currency: 'NOK' } })).id
  orderA1042 = (await order(shopA, '#1042', '2026-05-01', 'kari@example.com', '+47 912 34 567')).id
  orderA1050 = (await order(shopA, '#1050', '2026-06-01', 'kari@example.com')).id
  orderB1042 = (await order(shopB, '#1042', '2026-05-15', 'other@example.com')).id
  await db.shipment.create({ data: { trackingNumber: 'TMATCH373000000000000001', carrier: 'BRING', orderId: orderA1042 } })
})

describe('matchOrder', () => {
  it('an order number in the text wins, scoped to the mailbox\'s own shop', async () => {
    const m = await matchOrder({ email: 'kari@example.com', text: 'hvor er ordre #1042?', shopId: shopA })
    expect(m).toEqual({ orderId: orderA1042, via: 'order_number' })
  })
  it('the same number on another shop is not this shop\'s order', async () => {
    const m = await matchOrder({ email: 'nobody@example.com', text: '#1042', shopId: shopB })
    expect(m).toEqual({ orderId: orderB1042, via: 'order_number' })
  })
  it('with no shop scope, a number is only trusted when it is unique across shops', async () => {
    expect(await matchOrder({ email: 'nobody@example.com', text: '#1042', shopId: null })).toBeNull()
    expect(await matchOrder({ email: 'nobody@example.com', text: '#1050', shopId: null })).toEqual({ orderId: orderA1050, via: 'order_number' })
  })
  it('a tracking number lands on its order', async () => {
    const m = await matchOrder({ email: 'nobody@example.com', text: 'parcel TMATCH373000000000000001 is lost', shopId: null })
    expect(m).toEqual({ orderId: orderA1042, via: 'tracking' })
  })
  it('otherwise the sender\'s newest order, by email, case-insensitively', async () => {
    const m = await matchOrder({ email: 'Kari@Example.com', text: 'hello', shopId: null })
    expect(m).toEqual({ orderId: orderA1050, via: 'email' })
  })
  it('then a phone number in the text', async () => {
    const m = await matchOrder({ email: 'husband@example.com', text: 'my wife\'s number is 912 34 567', shopId: null })
    expect(m).toEqual({ orderId: orderA1042, via: 'phone' })
  })
  it('and null when nothing fits - never a guess', async () => {
    expect(await matchOrder({ email: 'stranger@example.com', text: 'hi', shopId: null })).toBeNull()
  })
})
```

Note: the tracking number in the fixture deliberately breaks the `373…` shape with a `TMATCH` prefix so cleanup can find it; `trackingNumbersIn` will not match it, so make the test text carry the digits alone as well: use `text: 'parcel 373000000000000001 TMATCH373000000000000001'` and store the shipment as `'373000000000000001'`… **No** - keep cleanup safe: store `trackingNumber: 'TMATCH373000000000000001'` and in `match.ts` also look up any whitespace-delimited token of 12+ alphanumerics against `Shipment.trackingNumber` (`candidates = [...trackingNumbersIn(text), ...text.match(/\b[A-Z0-9]{12,}\b/g)]`). Real Bring/DHL numbers satisfy both; the test satisfies the second.

**Step 2: Run** - `npx vitest run src/lib/inbox/match.integration.test.ts` → module not found.

**Step 3: Implement `src/lib/inbox/match.ts`**

```ts
import { db } from '@/lib/db'
import { orderNumbersIn, phonesIn, trackingNumbersIn, normalizePhone } from './identifiers'

export type Match = { orderId: string; via: 'order_number' | 'tracking' | 'email' | 'phone' } | null

/**
 * Which order is this email about?
 *
 * Most specific evidence first. A number the customer typed beats the newest
 * order on their address, because "where is #1042" is not a question about
 * #1050. Every step returns the ONE order it is sure of or moves on; nothing
 * here picks the best of several, because a wrong confident match is the one
 * outcome the inbox must never produce - null is shown as "no order matched"
 * and the person picks.
 *
 * `shopId` is the receiving mailbox's shop. Woo order numbers repeat across
 * stores, so without it a bare number is only trusted when exactly one order
 * in the whole workspace carries it.
 */
export async function matchOrder(input: { email: string; text: string; shopId: string | null }): Promise<Match> {
  const numbers = orderNumbersIn(input.text)
  if (numbers.length) {
    // "#1042" and "1042" are the same order; stored numbers carry the hash on
    // webshop orders and none on B2B (B-0001).
    const forms = numbers.flatMap((n) => (n.startsWith('B-') ? [n] : [n, `#${n}`]))
    const hits = await db.order.findMany({
      where: { number: { in: forms }, ...(input.shopId ? { shopId: input.shopId } : {}) },
      orderBy: { placedAt: 'desc' },
      select: { id: true, number: true },
      take: 2,
    })
    if (hits.length === 1 || (hits.length > 1 && input.shopId)) return { orderId: hits[0].id, via: 'order_number' }
  }

  const parcels = [...new Set([...trackingNumbersIn(input.text), ...(input.text.match(/\b[A-Z0-9]{12,}\b/g) ?? [])])]
  if (parcels.length) {
    const hit = await db.shipment.findFirst({
      where: { trackingNumber: { in: parcels }, orderId: { not: null } },
      select: { orderId: true },
    })
    if (hit?.orderId) return { orderId: hit.orderId, via: 'tracking' }
  }

  const byEmail = await db.order.findFirst({
    where: { customerEmail: { equals: input.email, mode: 'insensitive' } },
    orderBy: { placedAt: 'desc' },
    select: { id: true },
  })
  if (byEmail) return { orderId: byEmail.id, via: 'email' }

  const phones = phonesIn(input.text)
  if (phones.length) {
    // Stored as typed ("+47 912 34 567"); compared on digits. A scan over the
    // customer's recent orders is cheap at this scale and avoids a normalised
    // shadow column nobody else needs.
    const recent = await db.order.findMany({
      where: { customerPhone: { not: '' }, NOT: { customerPhone: null } },
      orderBy: { placedAt: 'desc' },
      select: { id: true, customerPhone: true },
      take: 5000,
    })
    const hit = recent.find((o) => o.customerPhone && phones.includes(normalizePhone(o.customerPhone)))
    if (hit) return { orderId: hit.id, via: 'phone' }
  }

  return null
}
```

**Step 4: Run** - all pass.

**Step 5: Commit**

```bash
git add src/lib/inbox/match.ts src/lib/inbox/match.integration.test.ts
git commit -m "feat(inbox): which order an email is about - number, parcel, address, phone, or honestly none"
```

---

### Task 10: Sidebar context - the customer, their orders, their parcels, their history

**Files:**
- Create: `src/lib/inbox/context.ts`
- Test: `src/lib/inbox/context.integration.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { customerContext } from './context'

const TAG = '[inbox-test-context]'
const NOW = new Date('2026-08-20T12:00:00Z')
let shopId: string, mailboxId: string

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: 'context.inbox-test.invalid' } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: 'context.inbox-test.invalid' } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'TCTX' } } })
  await db.orderItem.deleteMany({ where: { order: { shop: { name: { contains: TAG } } } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.product.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') } })).id
  mailboxId = (await db.mailbox.create({ data: { address: 'support@context.inbox-test.invalid', name: 'ctx', shopId } })).id
  const product = await db.product.create({ data: { shopId, externalId: 'p1', sku: 'MPX-001', name: 'Massasjepistol Pro X' } })
  const o1 = await db.order.create({
    data: {
      shopId, externalId: 'c1', number: '#2001', placedAt: new Date('2026-08-10T10:00:00Z'), status: 'completed', currency: 'NOK',
      grossSales: 249900, discountTotal: 0, netSales: 249900, shippingCharged: 0, taxTotal: 62475, total: 312375,
      customerName: 'Kari Olsen', customerEmail: 'kari@example.com', customerPhone: '+47 912 34 567', shippingCountry: 'NO',
      items: { create: [{ productId: product.id, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 1, unitPrice: 249900, lineNetTotal: 249900 }] },
    },
  })
  await db.shipment.create({ data: { trackingNumber: 'TCTX1', carrier: 'BRING', orderId: o1.id, handedInAt: new Date('2026-08-11T10:00:00Z') } })
  await db.order.create({
    data: {
      shopId, externalId: 'c2', number: '#1990', placedAt: new Date('2026-06-01T10:00:00Z'), status: 'refunded', currency: 'NOK',
      grossSales: 100000, discountTotal: 0, netSales: 100000, shippingCharged: 0, taxTotal: 25000, total: 125000,
      customerName: 'Kari Olsen', customerEmail: 'KARI@example.com', customerPhone: '',
    },
  })
  await db.ticket.create({
    data: { mailboxId, subject: 'Old question', customerEmail: 'kari@example.com', status: 'CLOSED',
      firstMessageAt: new Date('2026-07-01'), lastMessageAt: new Date('2026-07-02') },
  })
})

describe('customerContext', () => {
  it('assembles the customer, their orders newest first with products, parcels, refund state and delivery, and past tickets', async () => {
    const ctx = await customerContext('kari@example.com', 'not-a-ticket', NOW)
    expect(ctx.customer).toEqual({ name: 'Kari Olsen', email: 'kari@example.com', phone: '+47 912 34 567', country: 'NO' })
    expect(ctx.orders.map((o) => o.number)).toEqual(['#2001', '#1990'])
    const [o1, o2] = ctx.orders
    expect(o1.products).toEqual([{ name: 'Massasjepistol Pro X', quantity: 1 }])
    expect(o1.total).toBe(312375)
    expect(o1.currency).toBe('NOK')
    expect(o1.refunded).toBe(false)
    expect(o1.parcels[0].number).toBe('TCTX1')
    expect(o1.delivery.state).toBe('IN_TRANSIT')
    expect(o1.deliveryPhrase).toMatch(/^in transit/)
    expect(o2.refunded).toBe(true)
    expect(o2.deliveryPhrase).toBeNull()
    expect(ctx.previousTickets.map((t) => t.subject)).toEqual(['Old question'])
  })
  it('is empty-handed, not wrong, for an unknown address', async () => {
    const ctx = await customerContext('stranger@example.com', 'x', NOW)
    expect(ctx).toEqual({ customer: null, orders: [], previousTickets: [] })
  })
})
```

**Step 2: Run** - fails, module missing.

**Step 3: Implement `src/lib/inbox/context.ts`**

```ts
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { deliveryFor, type OrderDelivery, type Parcel } from '@/lib/delivery/view'
import { VOIDED_STATUSES } from '@/lib/metrics/types'
import { deliveryPhrase } from './delivery-phrase'

export type OrderSummary = {
  id: string
  number: string
  shop: string
  placedAt: string
  status: string
  /** Refunded or cancelled in the shop. We know the order, not the bank. */
  refunded: boolean
  currency: string
  total: number
  products: { name: string; quantity: number }[]
  parcels: Parcel[]
  delivery: OrderDelivery
  deliveryPhrase: string | null
}

export type CustomerContext = {
  customer: { name: string; email: string; phone: string | null; country: string | null } | null
  orders: OrderSummary[]
  previousTickets: { id: string; number: number; subject: string; status: string; lastMessageAt: string }[]
}

const MAX_ORDERS = 10

/**
 * Everything the sidebar shows about the person on the other end, derived
 * from orders - there is no Customer table, on purpose, and at this scale a
 * lookup by email is instant. Delivery comes from the same deliveryFor() the
 * Delivery page prints, so support and the owner read one story.
 */
export async function customerContext(email: string, excludeTicketId: string, now: Date = new Date()): Promise<CustomerContext> {
  const [orders, tickets, promises, setting] = await Promise.all([
    db.order.findMany({
      where: { customerEmail: { equals: email, mode: 'insensitive' } },
      orderBy: { placedAt: 'desc' },
      take: MAX_ORDERS,
      include: {
        shop: { select: { name: true, timezone: true, deliveryTrackingFrom: true } },
        items: { select: { name: true, quantity: true } },
        shipments: true,
      },
    }),
    db.ticket.findMany({
      where: { customerEmail: { equals: email, mode: 'insensitive' }, id: { not: excludeTicketId } },
      orderBy: { lastMessageAt: 'desc' },
      take: 20,
      select: { id: true, number: true, subject: true, status: true, lastMessageAt: true },
    }),
    db.deliveryPromise.findMany(),
    getSetting(),
  ])

  if (orders.length === 0 && tickets.length === 0) return { customer: null, orders: [], previousTickets: [] }

  // The newest order is the freshest word on who they are. Null means we
  // never stored it, and the sidebar says so rather than showing a blank.
  const newest = orders[0]
  const customer = newest
    ? {
        name: newest.customerName ?? '',
        email: newest.customerEmail ?? email,
        phone: newest.customerPhone || null,
        country: newest.shippingCountry || null,
      }
    : null

  return {
    customer,
    orders: orders.map((o) => {
      const delivery = deliveryFor(
        {
          id: o.id, number: o.number, placedAt: o.placedAt, status: o.status, shippingCountry: o.shippingCountry,
          shopId: o.shopId, shopName: o.shop.name, shopTimezone: o.shop.timezone, shopTrackingFrom: o.shop.deliveryTrackingFrom,
          shipments: o.shipments,
        },
        promises,
        setting.timezone,
        now,
      )
      return {
        id: o.id,
        number: o.number,
        shop: o.shop.name,
        placedAt: o.placedAt.toISOString(),
        status: o.status,
        refunded: (VOIDED_STATUSES as readonly string[]).includes(o.status.toLowerCase()),
        currency: o.currency,
        total: o.total,
        products: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
        parcels: delivery.parcels,
        delivery,
        deliveryPhrase: deliveryPhrase(delivery),
      }
    }),
    previousTickets: tickets.map((t) => ({ ...t, lastMessageAt: t.lastMessageAt.toISOString() })),
  }
}
```

**Step 4: Run** - pass. If `deliveryFor` on a refunded order does not return `VOIDED` in your fixture, the phrase test still holds via the `null` branch - check `view.ts` line ~150 onward for the exact precedence and adjust the expected `state` only if the verdict itself differs; never change the phrase to make it pass.

**Step 5: Commit**

```bash
git add src/lib/inbox/context.ts src/lib/inbox/context.integration.test.ts
git commit -m "feat(inbox): the sidebar's facts - orders, parcels, the delivery verdict, and past tickets"
```

---

### Task 11: Ingest - an inbound email becomes or continues a ticket

**Files:**
- Create: `src/lib/inbox/ingest.ts`
- Test: `src/lib/inbox/ingest.integration.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { ingestInbound, type InboundPayload } from './ingest'

const DOMAIN = 'ingest.inbox-test.invalid'
const SUPPORT = `support@${DOMAIN}`
const TAG = '[inbox-test-ingest]'
let shopId: string, mailboxId: string

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

const payload = (over: Partial<InboundPayload> = {}): InboundPayload => ({
  From: 'kari@example.com', FromName: 'Kari Olsen', FromFull: { Email: 'kari@example.com', Name: 'Kari Olsen' },
  To: SUPPORT, ToFull: [{ Email: SUPPORT, Name: '' }], Cc: '', CcFull: [], OriginalRecipient: SUPPORT,
  Subject: 'Hvor er ordre #1042?', MessageID: 'pm-uuid-1', Date: 'Thu, 20 Aug 2026 10:00:00 +0200',
  TextBody: 'Hei, hvor er pakken min? Ordre #1042. Takk, Kari',
  HtmlBody: '<p>Hei, hvor er pakken min? Ordre #1042.</p>', StrippedTextReply: '',
  Headers: [{ Name: 'Message-ID', Value: '<m1@gmail.com>' }, { Name: 'X-Spam-Score', Value: '0.1' }],
  Attachments: [],
  ...over,
})

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK' } })).id
  mailboxId = (await db.mailbox.create({ data: { address: SUPPORT, name: 'Panetti NO', shopId, language: 'nb' } })).id
  await db.order.create({
    data: { shopId, externalId: 'i1', number: '#1042', placedAt: new Date('2026-08-10'), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: 'Kari Olsen', customerEmail: 'kari@example.com' },
  })
})

describe('ingestInbound', () => {
  it('creates a ticket on the mailbox the mail was sent to, matched, classified, with the message stored', async () => {
    const r = await ingestInbound(payload())
    expect(r.outcome).toBe('created')
    const t = await db.ticket.findUniqueOrThrow({ where: { id: r.ticketId }, include: { messages: true, matchedOrder: true } })
    expect(t.mailboxId).toBe(mailboxId)
    expect(t.status).toBe('OPEN')
    expect(t.customerEmail).toBe('kari@example.com')
    expect(t.customerName).toBe('Kari Olsen')
    expect(t.category).toBe('shipping')
    expect(t.language).toBe('nb')
    expect(t.matchedOrder?.number).toBe('#1042')
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0]).toMatchObject({ direction: 'INBOUND', rfcMessageId: 'm1@gmail.com', fromEmail: 'kari@example.com', toEmail: SUPPORT, spamScore: 0.1 })
  })

  it('a redelivered webhook is a no-op', async () => {
    const a = await ingestInbound(payload())
    const b = await ingestInbound(payload())
    expect(b).toEqual({ outcome: 'duplicate', ticketId: a.ticketId })
    expect(await db.ticketMessage.count({ where: { ticketId: a.ticketId } })).toBe(1)
  })

  it('a reply carrying our id in References continues the ticket and reopens it', async () => {
    const a = await ingestInbound(payload())
    await db.ticketMessage.create({ data: { ticketId: a.ticketId!, direction: 'OUTBOUND', rfcMessageId: 'ours1@' + DOMAIN, fromEmail: SUPPORT, toEmail: 'kari@example.com', textBody: 'On its way', sentAt: new Date() } })
    await db.ticket.update({ where: { id: a.ticketId }, data: { status: 'CLOSED', closedAt: new Date() } })

    const b = await ingestInbound(payload({
      Subject: 'Re: Hvor er ordre #1042?', TextBody: 'Fortsatt ikke kommet',
      Headers: [{ Name: 'Message-ID', Value: '<m2@gmail.com>' }, { Name: 'In-Reply-To', Value: `<ours1@${DOMAIN}>` }, { Name: 'References', Value: `<m1@gmail.com> <ours1@${DOMAIN}>` }],
    }))
    expect(b).toEqual({ outcome: 'continued', ticketId: a.ticketId, messageId: expect.any(String) })
    const t = await db.ticket.findUniqueOrThrow({ where: { id: a.ticketId } })
    expect(t.status).toBe('OPEN')
    expect(t.closedAt).toBeNull()
    expect(await db.ticketMessage.count({ where: { ticketId: a.ticketId } })).toBe(3)
  })

  it('a reply with stripped headers still finds the ticket by our subject token', async () => {
    const a = await ingestInbound(payload())
    const number = (await db.ticket.findUniqueOrThrow({ where: { id: a.ticketId } })).number
    const b = await ingestInbound(payload({ Subject: `Re: Hvor er ordre #1042? [PA-${number}]`, Headers: [{ Name: 'Message-ID', Value: '<m3@gmail.com>' }] }))
    expect(b.outcome).toBe('continued')
    expect(b.ticketId).toBe(a.ticketId)
  })

  it('a second mail from the same sender on the same mailbox within 14 days continues the open ticket', async () => {
    const a = await ingestInbound(payload())
    const b = await ingestInbound(payload({ Subject: 'Hallo?', Headers: [{ Name: 'Message-ID', Value: '<m4@gmail.com>' }] }))
    expect(b.outcome).toBe('continued')
    expect(b.ticketId).toBe(a.ticketId)
  })

  it('never merges across mailboxes: same token, other brand, is refused and a new ticket made', async () => {
    const other = await db.mailbox.create({ data: { address: `support@other.${DOMAIN}`, name: 'Other', language: 'de' } })
    const a = await ingestInbound(payload())
    const number = (await db.ticket.findUniqueOrThrow({ where: { id: a.ticketId } })).number
    const b = await ingestInbound(payload({ To: other.address, ToFull: [{ Email: other.address, Name: '' }], OriginalRecipient: other.address,
      Subject: `Re: x [PA-${number}]`, Headers: [{ Name: 'Message-ID', Value: '<m5@gmail.com>' }] }))
    expect(b.outcome).toBe('created')
    expect(b.ticketId).not.toBe(a.ticketId)
  })

  it('an autoresponder never opens a ticket', async () => {
    const r = await ingestInbound(payload({ Headers: [{ Name: 'Message-ID', Value: '<ooo@x>' }, { Name: 'Auto-Submitted', Value: 'auto-replied' }] }))
    expect(r).toEqual({ outcome: 'automated' })
    expect(await db.ticket.count({ where: { mailboxId } })).toBe(0)
  })

  it('mail from our own support address is dropped - the self-loop', async () => {
    const r = await ingestInbound(payload({ From: SUPPORT, FromFull: { Email: SUPPORT, Name: 'us' }, Headers: [{ Name: 'Message-ID', Value: '<self@x>' }] }))
    expect(r).toEqual({ outcome: 'ignored_own' })
  })

  it('mail to an address nobody connected is reported, not stored', async () => {
    const r = await ingestInbound(payload({ To: 'nobody@elsewhere.invalid', ToFull: [{ Email: 'nobody@elsewhere.invalid', Name: '' }], OriginalRecipient: 'nobody@elsewhere.invalid' }))
    expect(r).toEqual({ outcome: 'no_mailbox' })
  })

  it('stores attachments under the cap and skips a whale, without failing the mail', async () => {
    const small = Buffer.from('hello').toString('base64')
    const r = await ingestInbound(payload({ Attachments: [
      { Name: 'photo.jpg', ContentType: 'image/jpeg', ContentLength: 5, Content: small },
      { Name: 'huge.bin', ContentType: 'application/octet-stream', ContentLength: 11 * 1024 * 1024, Content: 'x'.repeat(15 * 1024 * 1024) },
    ] }))
    const files = await db.ticketAttachment.findMany({ where: { message: { ticketId: r.ticketId } } })
    expect(files.map((f) => f.filename)).toEqual(['photo.jpg'])
    expect(Buffer.from(files[0].content).toString()).toBe('hello')
  })

  it('an email with no Message-ID header still dedupes on Postmark\'s own id', async () => {
    const a = await ingestInbound(payload({ Headers: [] }))
    const b = await ingestInbound(payload({ Headers: [] }))
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('duplicate')
  })
})
```

**Step 2: Run** - module missing.

**Step 3: Implement `src/lib/inbox/ingest.ts`**

```ts
import { db } from '@/lib/db'
import { categorize, detectLanguage } from './classify'
import { matchOrder } from './match'
import { isAutomated, spamScoreOf, threadRefs, ticketNumberIn, type Header } from './threading'

/** The fields of Postmark's inbound webhook this code reads. */
export type InboundPayload = {
  From: string
  FromName?: string
  FromFull?: { Email?: string; Name?: string }
  To: string
  ToFull?: { Email?: string; Name?: string }[]
  Cc?: string
  CcFull?: { Email?: string; Name?: string }[]
  OriginalRecipient?: string
  Subject: string
  MessageID: string
  Date?: string
  TextBody?: string
  HtmlBody?: string
  StrippedTextReply?: string
  Headers?: Header[]
  Attachments?: { Name?: string; ContentType?: string; ContentLength?: number; Content?: string }[]
}

export type IngestResult =
  | { outcome: 'created' | 'continued'; ticketId: string; messageId: string }
  | { outcome: 'duplicate'; ticketId: string }
  | { outcome: 'automated' | 'ignored_own' | 'no_mailbox' }

/** Postmark caps a whole inbound message at 35 MB; one file here at 10. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_B64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4

/** A second mail from the same person, this soon, is the same conversation. */
const SAME_SENDER_WINDOW_DAYS = 14

const lower = (s: string | undefined | null) => (s ?? '').trim().toLowerCase()

/** Every address the mail was delivered to, in the order Postmark is surest of. */
function recipients(p: InboundPayload): string[] {
  const list = [
    lower(p.OriginalRecipient),
    ...(p.ToFull ?? []).map((t) => lower(t.Email)),
    ...(p.CcFull ?? []).map((t) => lower(t.Email)),
    ...(p.To ?? '').split(',').map((t) => lower(/<([^>]+)>/.exec(t)?.[1] ?? t)),
  ]
  return [...new Set(list.filter(Boolean))]
}

function sender(p: InboundPayload): { email: string; name: string } {
  const email = lower(p.FromFull?.Email) || lower(/<([^>]+)>/.exec(p.From)?.[1] ?? p.From)
  const name = (p.FromFull?.Name ?? p.FromName ?? '').trim()
  return { email, name }
}

/**
 * One inbound email → a ticket. The order of the checks is the design:
 *
 *  1. Which mailbox? By the address it was sent TO. None → not ours.
 *  2. From ourselves? Drop it: that is how two helpdesks talk forever.
 *  3. Seen this Message-ID? Postmark redelivers on any non-200; the unique
 *     column makes the second delivery a no-op instead of a second ticket.
 *  4. An autoresponder? Never opens a ticket.
 *  5. Which ticket? References/In-Reply-To against every id we hold, then
 *     our own [PA-n] subject token, then an open conversation with the same
 *     sender on the same mailbox. Never across mailboxes - a token from
 *     another brand's ticket is treated as no token.
 *
 * The message row and the ticket write land in one transaction.
 */
export async function ingestInbound(p: InboundPayload, now: Date = new Date()): Promise<IngestResult> {
  const headers = p.Headers ?? []
  const to = recipients(p)
  const mailboxes = await db.mailbox.findMany({ where: { active: true, address: { in: to } }, include: { shop: { select: { id: true } } } })
  const mailbox = to.map((a) => mailboxes.find((m) => m.address === a)).find(Boolean)
  if (!mailbox) return { outcome: 'no_mailbox' }

  const from = sender(p)
  if (await db.mailbox.findFirst({ where: { address: from.email }, select: { id: true } })) return { outcome: 'ignored_own' }

  const refs = threadRefs(headers)
  // Postmark's own UUID stands in when a mailer sent no Message-ID: rare, but
  // without it such a mail would be stored once per redelivery.
  const rfcMessageId = refs.messageId ?? `postmark:${p.MessageID}`
  const seen = await db.ticketMessage.findUnique({ where: { rfcMessageId }, select: { ticketId: true } })
  if (seen) return { outcome: 'duplicate', ticketId: seen.ticketId }

  if (isAutomated(headers)) return { outcome: 'automated' }

  const text = (p.TextBody ?? '').trim()
  const stripped = (p.StrippedTextReply ?? '').trim() || null
  const subject = (p.Subject ?? '').trim()
  const sentAt = p.Date && !Number.isNaN(Date.parse(p.Date)) ? new Date(p.Date) : now

  const existing = await findTicket(mailbox.id, refs.inReplyTo, refs.references, subject, from.email, now)

  const attachments = (p.Attachments ?? []).flatMap((a) => {
    const name = typeof a.Name === 'string' ? a.Name : ''
    const content = typeof a.Content === 'string' ? a.Content : ''
    // Judged on the still-encoded length so a whale is refused before it is
    // ever decoded into memory - the delivery intake's own rule.
    if (!name || !content || content.length > MAX_ATTACHMENT_B64_CHARS) return []
    const buf = Buffer.from(content, 'base64')
    return [{ filename: name, contentType: a.ContentType || 'application/octet-stream', sizeBytes: buf.length, content: buf }]
  })

  const message = {
    direction: 'INBOUND',
    rfcMessageId,
    inReplyTo: refs.inReplyTo,
    references: refs.references.join(' '),
    fromEmail: from.email,
    toEmail: mailbox.address,
    subject,
    textBody: text,
    htmlBody: p.HtmlBody || null,
    strippedReply: stripped,
    spamScore: spamScoreOf(headers),
    postmarkId: p.MessageID || null,
    sentAt,
    attachments: { create: attachments },
  }

  if (existing) {
    const created = await db.$transaction(async (tx) => {
      const m = await tx.ticketMessage.create({ data: { ...message, ticketId: existing.id } })
      // The customer wrote again: whatever state the ticket was in, someone
      // must look. A first match is also attempted now if none was ever made.
      const match = existing.matchedOrderId ? null : await matchOrder({ email: from.email, text: `${subject}\n${text}`, shopId: mailbox.shopId })
      await tx.ticket.update({
        where: { id: existing.id },
        data: { status: 'OPEN', closedAt: null, lastMessageAt: sentAt, ...(match ? { matchedOrderId: match.orderId } : {}) },
      })
      return m
    })
    return { outcome: 'continued', ticketId: existing.id, messageId: created.id }
  }

  const match = await matchOrder({ email: from.email, text: `${subject}\n${text}`, shopId: mailbox.shopId })
  const ticket = await db.ticket.create({
    data: {
      mailboxId: mailbox.id,
      subject: subject || '(no subject)',
      customerEmail: from.email,
      customerName: from.name,
      category: categorize(subject, text),
      language: detectLanguage(`${subject}\n${text}`),
      matchedOrderId: match?.orderId ?? null,
      firstMessageAt: sentAt,
      lastMessageAt: sentAt,
      messages: { create: message },
    },
    include: { messages: { select: { id: true } } },
  })
  return { outcome: 'created', ticketId: ticket.id, messageId: ticket.messages[0].id }
}

async function findTicket(
  mailboxId: string, inReplyTo: string | null, references: string[], subject: string, fromEmail: string, now: Date,
): Promise<{ id: string; matchedOrderId: string | null } | null> {
  const ids = [...new Set([inReplyTo, ...references].filter((x): x is string => !!x))]
  if (ids.length) {
    const hit = await db.ticketMessage.findFirst({
      where: { rfcMessageId: { in: ids }, ticket: { mailboxId } },
      select: { ticket: { select: { id: true, matchedOrderId: true } } },
    })
    if (hit) return hit.ticket
  }
  const number = ticketNumberIn(subject)
  if (number !== null) {
    const byToken = await db.ticket.findFirst({ where: { number, mailboxId }, select: { id: true, matchedOrderId: true } })
    if (byToken) return byToken
  }
  const since = new Date(now.getTime() - SAME_SENDER_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  return db.ticket.findFirst({
    where: { mailboxId, customerEmail: fromEmail, status: { not: 'CLOSED' }, lastMessageAt: { gte: since } },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true, matchedOrderId: true },
  })
}
```

**Step 4: Run** - `npx vitest run src/lib/inbox/ingest.integration.test.ts` → all pass. (`matchOrder` inside the transaction uses `db`, not `tx` - acceptable: it only reads, and Postgres reads outside the transaction see committed data, which is all it needs.)

**Step 5: Commit**

```bash
git add src/lib/inbox/ingest.ts src/lib/inbox/ingest.integration.test.ts
git commit -m "feat(inbox): an inbound email becomes a ticket, or joins the one it belongs to"
```

---

### Task 12: Reply - from the brand, in the thread

**Files:**
- Create: `src/lib/inbox/reply.ts`
- Test: `src/lib/inbox/reply.integration.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'
import { addNote, sendTicketReply } from './reply'

const DOMAIN = 'reply.inbox-test.invalid'
const SUPPORT = `support@${DOMAIN}`
let ticketId: string, userId: string, mailboxId: string

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>
const postmarkOk = () => vi.fn<Fetch>(async () => new Response('{"MessageID":"pm-9"}', { status: 200 }))

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
  await db.user.deleteMany({ where: { email: `agent@${DOMAIN}` } })
}
afterAll(cleanup)
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

beforeEach(async () => {
  await cleanup()
  vi.stubEnv('POSTMARK_SERVER_TOKEN', 'tok')
  userId = (await db.user.create({ data: { email: `agent@${DOMAIN}`, passwordHash: 'x', role: 'ADMIN' } })).id
  mailboxId = (await db.mailbox.create({ data: { address: SUPPORT, name: 'Panetti', signature: 'Med vennlig hilsen\nPanetti' } })).id
  const t = await db.ticket.create({
    data: {
      mailboxId, subject: 'Hvor er ordre #1042?', customerEmail: 'kari@example.com', customerName: 'Kari',
      firstMessageAt: new Date('2026-08-20T08:00:00Z'), lastMessageAt: new Date('2026-08-20T08:00:00Z'),
      messages: { create: [{ direction: 'INBOUND', rfcMessageId: 'm1@gmail.com', fromEmail: 'kari@example.com', toEmail: SUPPORT, textBody: 'hvor?', sentAt: new Date('2026-08-20T08:00:00Z') }] },
    },
  })
  ticketId = t.id
})

describe('sendTicketReply', () => {
  it('sends from the mailbox, to the customer, threaded onto their message, signed, and records it', async () => {
    const fn = postmarkOk()
    vi.stubGlobal('fetch', fn)

    const r = await sendTicketReply(ticketId, userId, 'Den er på vei.')

    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.From).toBe(SUPPORT)
    expect(body.To).toBe('kari@example.com')
    const number = (await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).number
    expect(body.Subject).toBe(`Re: Hvor er ordre #1042? [PA-${number}]`)
    expect(body.TextBody).toBe('Den er på vei.\n\nMed vennlig hilsen\nPanetti')
    const h = Object.fromEntries(body.Headers.map((x: { Name: string; Value: string }) => [x.Name, x.Value]))
    expect(h['In-Reply-To']).toBe('<m1@gmail.com>')
    expect(h['References']).toBe('<m1@gmail.com>')
    expect(h['Message-ID']).toMatch(new RegExp(`^<pa${number}\\..+@${DOMAIN}>$`))

    const m = await db.ticketMessage.findUniqueOrThrow({ where: { id: r.messageId } })
    expect(m).toMatchObject({ direction: 'OUTBOUND', authorUserId: userId, fromEmail: SUPPORT, toEmail: 'kari@example.com', inReplyTo: 'm1@gmail.com', references: 'm1@gmail.com', postmarkId: 'pm-9' })
    expect(`<${m.rfcMessageId}>`).toBe(h['Message-ID'])
    const t = await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })
    expect(t.status).toBe('PENDING')
  })

  it('the second reply references the whole chain, oldest first', async () => {
    vi.stubGlobal('fetch', postmarkOk())
    const first = await sendTicketReply(ticketId, userId, 'one')
    const ours = (await db.ticketMessage.findUniqueOrThrow({ where: { id: first.messageId } })).rfcMessageId!
    const fn = postmarkOk()
    vi.stubGlobal('fetch', fn)
    await sendTicketReply(ticketId, userId, 'two')
    const body = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)
    const h = Object.fromEntries(body.Headers.map((x: { Name: string; Value: string }) => [x.Name, x.Value]))
    expect(h['References']).toBe(`<m1@gmail.com> <${ours}>`)
    // Still answering the customer's last message, not our own.
    expect(h['In-Reply-To']).toBe('<m1@gmail.com>')
  })

  it('stores nothing when Postmark refuses, so the agent can retry without a ghost reply', async () => {
    vi.stubGlobal('fetch', vi.fn<Fetch>(async () => new Response('{"Message":"Sender signature not confirmed"}', { status: 422 })))
    await expect(sendTicketReply(ticketId, userId, 'x')).rejects.toThrow(/422/)
    expect(await db.ticketMessage.count({ where: { ticketId, direction: 'OUTBOUND' } })).toBe(0)
  })

  it('refuses an empty reply', async () => {
    vi.stubGlobal('fetch', postmarkOk())
    await expect(sendTicketReply(ticketId, userId, '   ')).rejects.toThrow(/empty/i)
  })
})

describe('addNote', () => {
  it('records an internal note that never touches Postmark or the ticket status', async () => {
    const fn = postmarkOk()
    vi.stubGlobal('fetch', fn)
    const r = await addNote(ticketId, userId, 'Called the warehouse.')
    expect(fn).not.toHaveBeenCalled()
    const m = await db.ticketMessage.findUniqueOrThrow({ where: { id: r.messageId } })
    expect(m).toMatchObject({ direction: 'NOTE', textBody: 'Called the warehouse.', fromEmail: `agent@${DOMAIN}`, toEmail: '' })
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status).toBe('OPEN')
  })
})
```

**Step 2: Run** - module missing.

**Step 3: Implement `src/lib/inbox/reply.ts`**

```ts
import { db } from '@/lib/db'
import { sendEmail } from '@/lib/email/send'
import { mintMessageId, replySubject } from './threading'

/**
 * A reply leaves from the ticket's mailbox - the brand's own address - and
 * carries the three headers that keep it in the customer's thread:
 *
 *   Message-ID   ours, minted BEFORE the send and stored with the row
 *   In-Reply-To  the customer's latest message (never our own last reply)
 *   References   every id in the conversation, oldest first
 *
 * The subject is theirs under one "Re:", plus our [PA-n] token for clients
 * that strip headers. Nothing is stored unless Postmark accepted the message:
 * a failed send must not leave a reply on screen that the customer never got.
 */
export async function sendTicketReply(ticketId: string, userId: string, text: string, now: Date = new Date()): Promise<{ messageId: string }> {
  const body = text.trim()
  if (!body) throw new Error('The reply is empty')

  const ticket = await db.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { mailbox: true, messages: { orderBy: { sentAt: 'asc' }, select: { direction: true, rfcMessageId: true } } },
  })

  const chain = ticket.messages.map((m) => m.rfcMessageId).filter((x): x is string => !!x && !x.startsWith('postmark:'))
  const lastInbound = [...ticket.messages].reverse().find((m) => m.direction === 'INBOUND' && m.rfcMessageId && !m.rfcMessageId.startsWith('postmark:'))
  const messageId = mintMessageId(ticket.number, ticket.mailbox.address, now)
  const subject = replySubject(ticket.subject, ticket.number)
  const signed = ticket.mailbox.signature.trim() ? `${body}\n\n${ticket.mailbox.signature.trim()}` : body

  const headers: Record<string, string> = { 'Message-ID': messageId }
  if (lastInbound?.rfcMessageId) headers['In-Reply-To'] = `<${lastInbound.rfcMessageId}>`
  if (chain.length) headers['References'] = chain.map((id) => `<${id}>`).join(' ')

  const { postmarkId } = await sendEmail(ticket.customerEmail, subject, signed, { from: ticket.mailbox.address, headers })

  const message = await db.$transaction(async (tx) => {
    const m = await tx.ticketMessage.create({
      data: {
        ticketId, direction: 'OUTBOUND', authorUserId: userId,
        rfcMessageId: messageId.slice(1, -1),
        inReplyTo: lastInbound?.rfcMessageId ?? null,
        references: chain.join(' '),
        fromEmail: ticket.mailbox.address, toEmail: ticket.customerEmail,
        subject, textBody: signed, postmarkId, sentAt: now,
      },
    })
    // We answered; the ball is in the customer's court until they write back,
    // which ingest turns into OPEN again.
    await tx.ticket.update({ where: { id: ticketId }, data: { status: 'PENDING', lastMessageAt: now } })
    return m
  })
  return { messageId: message.id }
}

/** An internal note: same row shape, never sent, never changes the status. */
export async function addNote(ticketId: string, userId: string, text: string, now: Date = new Date()): Promise<{ messageId: string }> {
  const body = text.trim()
  if (!body) throw new Error('The note is empty')
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const m = await db.ticketMessage.create({
    data: { ticketId, direction: 'NOTE', authorUserId: userId, fromEmail: user.email, toEmail: '', textBody: body, sentAt: now },
  })
  return { messageId: m.id }
}
```

**Step 4: Run** - all pass.

**Step 5: Commit**

```bash
git add src/lib/inbox/reply.ts src/lib/inbox/reply.integration.test.ts
git commit -m "feat(inbox): a reply leaves from the brand's address and stays in the customer's thread"
```

---

### Task 13: The webhook route - Postmark knocks here

**Files:**
- Create: `src/app/api/inbox/inbound/route.ts`
- Test: `src/app/api/inbox/inbound/route.integration.test.ts`
- Modify: `src/middleware.ts:35` (`MACHINE_PATHS`)

**Step 1: Failing test**

```ts
import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'
import { POST } from './route'

const DOMAIN = 'hook.inbox-test.invalid'
const SUPPORT = `support@${DOMAIN}`

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
}
afterAll(cleanup)
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
  await cleanup()
  vi.stubEnv('INBOX_INBOUND_SECRET', 's3cret')
  await db.mailbox.create({ data: { address: SUPPORT, name: 'Hook' } })
})

const post = (token: string, body: unknown) =>
  POST(new Request(`http://localhost/api/inbox/inbound?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

const mail = {
  From: 'kari@example.com', FromFull: { Email: 'kari@example.com', Name: 'Kari' }, To: SUPPORT, ToFull: [{ Email: SUPPORT }],
  OriginalRecipient: SUPPORT, Subject: 'Hei', MessageID: 'pm-1', TextBody: 'hei', Headers: [{ Name: 'Message-ID', Value: '<h1@x>' }], Attachments: [],
}

describe('POST /api/inbox/inbound', () => {
  it('refuses without the shared secret, and with the secret unset', async () => {
    expect((await post('wrong', mail)).status).toBe(401)
    vi.stubEnv('INBOX_INBOUND_SECRET', '')
    expect((await post('s3cret', mail)).status).toBe(401)
  })
  it('creates the ticket and answers 200 with the outcome', async () => {
    const res = await post('s3cret', mail)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'created' })
    expect(await db.ticket.count({ where: { mailbox: { address: SUPPORT } } })).toBe(1)
  })
  it('answers 200 for mail that is not ours, so Postmark does not retry it for six hours', async () => {
    const res = await post('s3cret', { ...mail, To: 'x@elsewhere.invalid', ToFull: [{ Email: 'x@elsewhere.invalid' }], OriginalRecipient: 'x@elsewhere.invalid' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'no_mailbox' })
  })
  it('400s a body that is not JSON', async () => {
    expect((await post('s3cret', 'not json')).status).toBe(400)
  })
})
```

**Step 2: Run** - module missing.

**Step 3: Implement `src/app/api/inbox/inbound/route.ts`**

```ts
import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { ingestInbound, type InboundPayload } from '@/lib/inbox/ingest'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Attachments arrive inline and a thread can be long; parsing is not instant. */
export const maxDuration = 60

/**
 * NOT admin-only, and deliberately so: Postmark is a machine and has no
 * session. A shared secret in the URL is the whole of the authentication -
 * the same arrangement api/delivery/inbound already runs on - so it is
 * compared in constant time and nothing happens before it passes.
 */
function authorised(req: Request): boolean {
  const expected = process.env.INBOX_INBOUND_SECRET
  if (!expected) return false
  const given = new URL(req.url).searchParams.get('token') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * One inbound email from Postmark.
 *
 * Unlike the delivery intake, a failure here is allowed to be a 500: Postmark
 * retries ten times over six hours, which is exactly right for a database
 * that was briefly unreachable, and the unique Message-ID makes every retry
 * of a message we DID store a no-op. Only the outcomes that would fail
 * identically forever - not our mailbox, an autoresponder, our own mail -
 * are acknowledged with a 200, so they never come back.
 */
export async function POST(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorised' }, { status: 401, headers: NO_STORE })

  let body: InboundPayload
  try {
    body = (await req.json()) as InboundPayload
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400, headers: NO_STORE })
  }

  try {
    const result = await ingestInbound(body)
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ ok: false, error: 'Could not store the email' }, { status: 500, headers: NO_STORE })
  }
}
```

Then in `src/middleware.ts` change the machine list to:

```ts
const MACHINE_PATHS = ['/api/cron/', '/api/webhooks/', '/api/delivery/inbound', '/api/inbox/inbound']
```

and add `'/inbox'` to `PROTECTED_PAGES` (Task 17 relies on it; do it now so it is not forgotten):

```ts
const PROTECTED_PAGES = ['/dashboard', '/marketing', '/settings', '/portal', '/account', '/ambassadors', '/inbox']
```

**Step 4: Run** - `npx vitest run src/app/api/inbox/inbound src/middleware` → pass (there is a `middleware.test.ts`; if it enumerates `MACHINE_PATHS`, extend its expectation).

**Step 5: Commit**

```bash
git add src/app/api/inbox/inbound src/middleware.ts
git commit -m "feat(inbox): the door Postmark knocks on, and why it may answer 500"
```

---

### Task 14: Ticket routes - list, open, update

**Files:**
- Create: `src/app/api/inbox/tickets/route.ts`
- Create: `src/app/api/inbox/tickets/[id]/route.ts`
- Test: `src/app/api/inbox/tickets/route.integration.test.ts`

**Step 1: Failing test**

```ts
import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))
const { currentUser } = await import('@/lib/auth/current-user')
const { GET: list } = await import('./route')
const { GET: detail, PATCH } = await import('./[id]/route')

const DOMAIN = 'tickets.inbox-test.invalid'
let mailboxId: string, t1: string, t2: string, userId: string

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
  await db.user.deleteMany({ where: { email: `agent@${DOMAIN}` } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  userId = (await db.user.create({ data: { email: `agent@${DOMAIN}`, passwordHash: 'x', role: 'ADMIN' } })).id
  mailboxId = (await db.mailbox.create({ data: { address: `support@${DOMAIN}`, name: 'T' } })).id
  const mk = (subject: string, email: string, status: string, at: string) =>
    db.ticket.create({ data: { mailboxId, subject, customerEmail: email, customerName: 'Kari', status, firstMessageAt: new Date(at), lastMessageAt: new Date(at),
      messages: { create: { direction: 'INBOUND', fromEmail: email, toEmail: `support@${DOMAIN}`, textBody: 'body text', sentAt: new Date(at) } } } })
  t1 = (await mk('Where is my order', 'kari@example.com', 'OPEN', '2026-08-20T10:00:00Z')).id
  t2 = (await mk('Retur', 'ola@example.com', 'CLOSED', '2026-08-19T10:00:00Z')).id
})

const url = (q = '') => new Request(`http://localhost/api/inbox/tickets${q}`)
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describe('GET /api/inbox/tickets', () => {
  it('lists newest-first with the fields the queue shows, filtered by status and search', async () => {
    const all = await (await list(url(`?mailboxId=${mailboxId}`))).json()
    expect(all.tickets.map((t: { subject: string }) => t.subject)).toEqual(['Where is my order', 'Retur'])
    expect(all.tickets[0]).toMatchObject({ status: 'OPEN', customerEmail: 'kari@example.com', mailbox: `support@${DOMAIN}` })
    const open = await (await list(url(`?mailboxId=${mailboxId}&status=OPEN`))).json()
    expect(open.tickets).toHaveLength(1)
    const found = await (await list(url(`?mailboxId=${mailboxId}&q=ola@`))).json()
    expect(found.tickets.map((t: { id: string }) => t.id)).toEqual([t2])
  })
  it('is admin-only', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'x@y.z', role: 'MARKETING' } as never)
    expect((await list(url())).status).toBe(403)
  })
})

describe('GET + PATCH /api/inbox/tickets/[id]', () => {
  it('opens a ticket with its messages and the customer context', async () => {
    const res = await detail(new Request('http://localhost/x'), ctx(t1))
    const body = await res.json()
    expect(body.ticket.subject).toBe('Where is my order')
    expect(body.messages).toHaveLength(1)
    expect(body.context).toHaveProperty('orders')
    expect(body.context.previousTickets).toEqual([])
  })
  it('updates status, assignee, priority, tags and the matched order, and stamps closedAt', async () => {
    const res = await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ status: 'CLOSED', assigneeUserId: userId, priority: 'HIGH', tags: ['vip'] }) }), ctx(t1))
    expect(res.status).toBe(200)
    const t = await db.ticket.findUniqueOrThrow({ where: { id: t1 } })
    expect(t).toMatchObject({ status: 'CLOSED', assigneeUserId: userId, priority: 'HIGH', tags: ['vip'] })
    expect(t.closedAt).not.toBeNull()
    await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ status: 'OPEN', assigneeUserId: null }) }), ctx(t1))
    const again = await db.ticket.findUniqueOrThrow({ where: { id: t1 } })
    expect(again.closedAt).toBeNull()
    expect(again.assigneeUserId).toBeNull()
  })
  it('rejects a status it does not know', async () => {
    const res = await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ status: 'SNOOZED' }) }), ctx(t1))
    expect(res.status).toBe(400)
  })
  it('404s an unknown ticket', async () => {
    expect((await detail(new Request('http://localhost/x'), ctx('nope'))).status).toBe(404)
  })
})
```

**Step 2: Run** - modules missing.

**Step 3: Implement**

`src/app/api/inbox/tickets/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

const STATUSES = new Set(['OPEN', 'PENDING', 'CLOSED'])
const PAGE = 100

/**
 * The queue. Filters are AND-ed; `q` searches the subject, the customer's
 * name and address, and a bare ticket number ("1042" or "PA-1042"). Message
 * bodies are deliberately not searched yet: at this scale a LIKE over every
 * email body is fine, but it turns "search" into "grep", and the queue's job
 * is finding a ticket, not a sentence.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())
    const p = new URL(req.url).searchParams
    const status = p.get('status')
    const mailboxId = p.get('mailboxId')
    const assignee = p.get('assigneeId') // 'me' handled by the client, which knows its id; 'none' = unassigned
    const q = p.get('q')?.trim() ?? ''
    const number = /^(?:PA-)?(\d+)$/i.exec(q)?.[1]

    const tickets = await db.ticket.findMany({
      where: {
        ...(status && STATUSES.has(status) ? { status } : {}),
        ...(mailboxId ? { mailboxId } : {}),
        ...(assignee === 'none' ? { assigneeUserId: null } : assignee ? { assigneeUserId: assignee } : {}),
        ...(q
          ? {
              OR: [
                { subject: { contains: q, mode: 'insensitive' } },
                { customerEmail: { contains: q, mode: 'insensitive' } },
                { customerName: { contains: q, mode: 'insensitive' } },
                ...(number ? [{ number: Number(number) }] : []),
              ],
            }
          : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: PAGE,
      include: { mailbox: { select: { address: true, name: true } }, assignee: { select: { id: true, email: true } } },
    })

    return NextResponse.json(
      {
        tickets: tickets.map((t) => ({
          id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority,
          customerEmail: t.customerEmail, customerName: t.customerName, tags: t.tags, category: t.category,
          language: t.language, mailbox: t.mailbox.address, mailboxName: t.mailbox.name,
          assignee: t.assignee ? { id: t.assignee.id, email: t.assignee.email } : null,
          lastMessageAt: t.lastMessageAt.toISOString(),
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the inbox' }, { status: 500, headers: NO_STORE })
  }
}
```

`src/app/api/inbox/tickets/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { customerContext } from '@/lib/inbox/context'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

const Patch = z.object({
  status: z.enum(['OPEN', 'PENDING', 'CLOSED']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
  assigneeUserId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  matchedOrderId: z.string().min(1).nullable().optional(),
})

export async function GET(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const t = await db.ticket.findUnique({
      where: { id },
      include: {
        mailbox: { select: { id: true, address: true, name: true, language: true, shopId: true } },
        assignee: { select: { id: true, email: true } },
        matchedOrder: { select: { id: true, number: true } },
        messages: {
          orderBy: { sentAt: 'asc' },
          include: { author: { select: { email: true } }, attachments: { select: { id: true, filename: true, contentType: true, sizeBytes: true } } },
        },
      },
    })
    if (!t) return NextResponse.json({ error: 'No such ticket' }, { status: 404, headers: NO_STORE })

    const context = await customerContext(t.customerEmail, t.id)
    return NextResponse.json(
      {
        ticket: {
          id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, tags: t.tags,
          category: t.category, language: t.language ?? t.mailbox.language, languageDetected: t.language !== null,
          customerEmail: t.customerEmail, customerName: t.customerName,
          mailbox: t.mailbox, assignee: t.assignee, matchedOrder: t.matchedOrder,
          firstMessageAt: t.firstMessageAt.toISOString(), lastMessageAt: t.lastMessageAt.toISOString(),
        },
        messages: t.messages.map((m) => ({
          id: m.id, direction: m.direction, author: m.author?.email ?? null, fromEmail: m.fromEmail, toEmail: m.toEmail,
          // The thread shows the customer's new words, not the quoted history
          // beneath them; the full text is one click away.
          text: m.direction === 'INBOUND' ? (m.strippedReply || m.textBody) : m.textBody,
          fullText: m.textBody, hasHtml: m.htmlBody !== null, spamScore: m.spamScore,
          sentAt: m.sentAt.toISOString(), attachments: m.attachments,
        })),
        context,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the ticket' }, { status: 500, headers: NO_STORE })
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const parsed = Patch.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'That change is not one the ticket understands' }, { status: 400, headers: NO_STORE })
    const { id } = await params
    const d = parsed.data
    const updated = await db.ticket.updateMany({
      where: { id },
      data: {
        ...(d.status ? { status: d.status, closedAt: d.status === 'CLOSED' ? new Date() : null } : {}),
        ...(d.priority ? { priority: d.priority } : {}),
        ...(d.assigneeUserId !== undefined ? { assigneeUserId: d.assigneeUserId } : {}),
        ...(d.tags ? { tags: [...new Set(d.tags)] } : {}),
        ...(d.matchedOrderId !== undefined ? { matchedOrderId: d.matchedOrderId } : {}),
      },
    })
    if (updated.count === 0) return NextResponse.json({ error: 'No such ticket' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not update the ticket' }, { status: 500, headers: NO_STORE })
  }
}
```

**Step 4: Run** - pass. `npx tsc --noEmit` clean.

**Step 5: Commit**

```bash
git add src/app/api/inbox/tickets
git commit -m "feat(inbox): the queue, one ticket with its facts, and the fields a person changes"
```

---

### Task 15: Message route - reply or note

**Files:**
- Create: `src/app/api/inbox/tickets/[id]/messages/route.ts`
- Test: `src/app/api/inbox/tickets/[id]/messages/route.integration.test.ts`

**Step 1: Failing test**

```ts
import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
const { currentUser } = await import('@/lib/auth/current-user')
const { POST } = await import('./route')

const DOMAIN = 'messages.inbox-test.invalid'
let ticketId: string, userId: string
type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
  await db.user.deleteMany({ where: { email: `agent@${DOMAIN}` } })
}
afterAll(cleanup)
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
beforeEach(async () => {
  await cleanup()
  vi.stubEnv('POSTMARK_SERVER_TOKEN', 'tok')
  userId = (await db.user.create({ data: { email: `agent@${DOMAIN}`, passwordHash: 'x', role: 'ADMIN' } })).id
  vi.mocked(currentUser).mockResolvedValue({ id: userId, email: `agent@${DOMAIN}`, role: 'ADMIN' } as never)
  const mailboxId = (await db.mailbox.create({ data: { address: `support@${DOMAIN}`, name: 'M' } })).id
  ticketId = (await db.ticket.create({ data: { mailboxId, subject: 'S', customerEmail: 'kari@example.com', firstMessageAt: new Date(), lastMessageAt: new Date(),
    messages: { create: { direction: 'INBOUND', rfcMessageId: `in@${DOMAIN}`, fromEmail: 'kari@example.com', toEmail: `support@${DOMAIN}`, textBody: 'hi', sentAt: new Date() } } } })).id
})

const post = (id: string, body: unknown) =>
  POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })

describe('POST /api/inbox/tickets/[id]/messages', () => {
  it('a note is stored and nothing is sent', async () => {
    const fn = vi.fn<Fetch>(async () => new Response('{}'))
    vi.stubGlobal('fetch', fn)
    const res = await post(ticketId, { kind: 'note', text: 'checking' })
    expect(res.status).toBe(200)
    expect(fn).not.toHaveBeenCalled()
    expect(await db.ticketMessage.count({ where: { ticketId, direction: 'NOTE' } })).toBe(1)
  })
  it('a reply goes out through Postmark as the signed-in agent', async () => {
    const fn = vi.fn<Fetch>(async () => new Response('{"MessageID":"pm"}'))
    vi.stubGlobal('fetch', fn)
    const res = await post(ticketId, { kind: 'reply', text: 'On its way' })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(1)
    const m = await db.ticketMessage.findFirstOrThrow({ where: { ticketId, direction: 'OUTBOUND' } })
    expect(m.authorUserId).toBe(userId)
  })
  it('a reply that Postmark refuses comes back as a readable error, not a 500 shrug', async () => {
    vi.stubGlobal('fetch', vi.fn<Fetch>(async () => new Response('{"Message":"Sender signature not confirmed"}', { status: 422 })))
    const res = await post(ticketId, { kind: 'reply', text: 'x' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Sender signature/)
  })
  it('refuses an empty text and an unknown kind', async () => {
    expect((await post(ticketId, { kind: 'reply', text: '  ' })).status).toBe(400)
    expect((await post(ticketId, { kind: 'shout', text: 'x' })).status).toBe(400)
  })
})
```

**Step 2: Run** - missing.

**Step 3: Implement `src/app/api/inbox/tickets/[id]/messages/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { addNote, sendTicketReply } from '@/lib/inbox/reply'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
type Ctx = { params: Promise<{ id: string }> }

const Body = z.object({ kind: z.enum(['reply', 'note']), text: z.string().trim().min(1).max(20000) })

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = await currentUser()
    assertAdmin(user)
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Write something first' }, { status: 400, headers: NO_STORE })
    const { id } = await params
    if (!(await db.ticket.findUnique({ where: { id }, select: { id: true } })))
      return NextResponse.json({ error: 'No such ticket' }, { status: 404, headers: NO_STORE })

    if (parsed.data.kind === 'note') {
      const r = await addNote(id, user.id, parsed.data.text)
      return NextResponse.json({ ok: true, ...r }, { headers: NO_STORE })
    }
    try {
      const r = await sendTicketReply(id, user.id, parsed.data.text)
      return NextResponse.json({ ok: true, ...r }, { headers: NO_STORE })
    } catch (e) {
      // Postmark's own sentence ("Sender signature not confirmed", "POSTMARK_
      // SERVER_TOKEN is not set") is the one thing the agent can act on.
      const reason = e instanceof Error ? e.message : 'The email could not be sent'
      return NextResponse.json({ error: `Not sent: ${reason}` }, { status: 502, headers: NO_STORE })
    }
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the message' }, { status: 500, headers: NO_STORE })
  }
}
```

**Step 4: Run** - pass.

**Step 5: Commit**

```bash
git add "src/app/api/inbox/tickets/[id]/messages"
git commit -m "feat(inbox): reply or note, and a refused send says why"
```

---

### Task 16: Macro and mailbox routes

**Files:**
- Create: `src/app/api/inbox/macros/route.ts` (GET, POST), `src/app/api/inbox/macros/[id]/route.ts` (PATCH, DELETE)
- Create: `src/app/api/inbox/mailboxes/route.ts` (GET, POST), `src/app/api/inbox/mailboxes/[id]/route.ts` (PATCH, DELETE)
- Test: `src/app/api/inbox/macros/route.integration.test.ts`, `src/app/api/inbox/mailboxes/route.integration.test.ts`

**Step 1: Failing tests** - both files follow Task 14's mock pattern. Cases:

Macros:
- `POST {name:'Where is my order?', language:'en', body:'Hi {{customer_name}}…'}` → 200; `GET` lists it with `variables` = the `MACRO_VARIABLES` array in the response envelope.
- `POST` with a body using `{{unknown_var}}` → 400 naming the variable ("unknown_var is not a variable macros know").
- `POST` duplicate name+language → 409.
- `PATCH [id] {body:'new'}` → 200 and stored; `DELETE [id]` → 200, gone; `DELETE` unknown → 404.
- Non-admin → 403.
Use `name: '[inbox-test] …'` and clean up with `db.macro.deleteMany({ where: { name: { startsWith: '[inbox-test]' } } })`.

Mailboxes:
- `POST {address:'Support@Macros.inbox-test.invalid ', name:'X', shopId, language:'nb', signature:'Hilsen'}` → 200; stored lowercase + trimmed.
- `POST` with a malformed address → 400; duplicate → 409; `language: 'xx'` → 400.
- `GET` lists with `shop: { id, name } | null`, `ticketCount`.
- `PATCH [id] { active:false, signature:'…' }` → 200.
- `DELETE [id]` with tickets → 409 ("Deactivate instead - N tickets would lose their mailbox"); without → 200.

**Step 2: Run** - missing.

**Step 3: Implement** - same shape as Task 14's routes (assertAdmin, zod, NO_STORE, AuthError → 403, P2002 → 409 via the `isUniqueViolation` helper copied from `api/ambassadors/[id]/codes/route.ts:14`). Validation:

```ts
// macros
const MacroBody = z.object({
  name: z.string().trim().min(1).max(80),
  language: z.enum(LANGUAGES),
  body: z.string().trim().min(1).max(20000),
})
// A macro may only use variables the composer can fill; catching a typo here
// is cheaper than an agent discovering ⟪custmer_name⟫ mid-reply.
function unknownVariable(body: string): string | null {
  for (const m of body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) {
    if (!(MACRO_VARIABLES as readonly string[]).includes(m[1].toLowerCase())) return m[1]
  }
  return null
}
```

```ts
// mailboxes
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MailboxBody = z.object({
  address: z.string().trim().toLowerCase().regex(EMAIL, 'Enter a full email address'),
  name: z.string().trim().min(1).max(80),
  shopId: z.string().min(1).nullable().optional(),
  language: z.enum(LANGUAGES).default('en'),
  signature: z.string().max(2000).default(''),
})
```

GET `/api/inbox/mailboxes` also returns `forwardingAddress: process.env.POSTMARK_INBOUND_ADDRESS ?? null` - the settings page shows it beside every mailbox as "forward to this address", and says how to find it in Postmark when unset.

**Step 4: Run** - pass. `npx tsc --noEmit` clean.

**Step 5: Commit**

```bash
git add src/app/api/inbox/macros src/app/api/inbox/mailboxes
git commit -m "feat(inbox): macros and mailboxes, managed from settings"
```

---

### Task 17: The Inbox page

**Files:**
- Create: `src/app/inbox/page.tsx`, `src/app/inbox/InboxClient.tsx`
- Create: `src/app/inbox/InboxClient.test.tsx`
- Modify: `src/components/shell/AppShell.tsx:72` (nav item after Advisor), `e2e/global-setup.ts:9` (warm `/inbox`, `/settings/inbox`)

**Layout** (three columns inside `PageBody`, one `AppShell`, header title "Inbox"):

1. **Queue** (left, 320px): status tabs `Open · Pending · Closed` (counts from the loaded list), a `<select aria-label="Mailbox">` (All mailboxes + each), a `<select aria-label="Assignee">` (Anyone / Me / Unassigned / each user), a search `<input aria-label="Search tickets">`. Rows are `<button data-testid="ticket-row">` showing `PA-{number}`, subject, customer name or email, mailbox name, relative time, tags, priority chip when HIGH. Selected row gets `aria-current="true"`.
2. **Thread** (middle): ticket subject as `<h2>`, category/language chips, then messages oldest-first. INBOUND = surface card; OUTBOUND = accent-soft card with "Sent from {mailbox}"; NOTE = warn-soft card labelled **Internal note**. Each message shows author/from and time; INBOUND with `fullText !== text` gets a "Show quoted text" toggle. Attachments as filename chips. Below: the **composer** - tabs `Reply` / `Internal note`, a `<select aria-label="Insert macro">` (only on Reply; lists macros in the ticket's language first, then the rest, grouped by language), a `<textarea aria-label="Message">`, and a button reading `Send reply` or `Add note`. The send button is disabled while `hasMissingMarker(text)`; a line under the textarea says "Fill in: tracking_number" listing the missing names.
3. **Sidebar** (right, 320px, `data-testid="ticket-sidebar"`): **Customer** (name, email, phone or "No phone on file", country + shop of the newest order, or "No customer found - no orders on this address"); **This ticket** (status `<select aria-label="Status">`, assignee `<select aria-label="Assign to">`, priority `<select aria-label="Priority">`, tags input with Enter-to-add and chips with ×, matched order `<select aria-label="Matched order">` listing the context's orders + "None"); **Orders** (each: number, shop, date, `formatMoney(total, currency)`, "Refunded in the shop" chip when refunded, products "1 × Massasjepistol Pro X", parcels as links (`Parcel.url`), delivery phrase); **Previous conversations** (PA-n · subject · status · date, click selects that ticket).

**Data flow:** `GET /api/inbox/tickets?…` on mount and whenever a filter changes (AbortController, exactly like `DashboardClient.tsx:92-107`); `GET /api/inbox/tickets/{id}` when a row is selected; `PATCH` on any sidebar field change then re-fetch the ticket and the list; `POST …/messages` on send; `useLiveTick()` refetches the list once a minute (same hook the dashboard uses). Toasts via `useToast()` for errors ("Not sent: …") and successes ("Reply sent", "Note added"). Macro insertion: `renderMacro(macro.body, vars)` with vars from the ticket + context: `customer_name` = first word of `customerName` (or null), `order_number` = matched order's number, `tracking_number` = matched order's first parcel number, `product_name` = matched order's products joined with ", ", `delivery_status` = matched order's `deliveryPhrase`, `agent_name` = the local part of the signed-in email, `brand_name` = mailbox name. Appends to the textarea (does not replace typed text).

**page.tsx** (mirror `advisor/page.tsx`):

```tsx
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { InboxClient } from './InboxClient'

export const dynamic = 'force-dynamic'

export default async function InboxPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const [mailboxes, users, macros] = await Promise.all([
    db.mailbox.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, address: true, name: true, language: true } }),
    db.user.findMany({ where: { role: { in: ['ADMIN', 'MARKETING'] } }, orderBy: { email: 'asc' }, select: { id: true, email: true } }),
    db.macro.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }] }),
  ])
  return <InboxClient me={{ id: user.id, email: user.email }} mailboxes={mailboxes} users={users} macros={macros} />
}
```

**InboxClient.test.tsx** (jsdom, `vi.stubGlobal('fetch', …)` returning canned list/detail payloads, as `DashboardClient.test.tsx` does):
- renders the queue rows from the list payload and selects the first;
- selecting a row shows the sidebar customer name and the order number from the detail payload;
- choosing the macro "Where is my order?" fills the textarea with the order number and no `{{`;
- a macro whose `tracking_number` cannot be filled disables **Send reply** and shows "Fill in: tracking_number";
- switching to Internal note changes the button to **Add note** and posts `{kind:'note'}`;
- an unmatched detail payload shows "No customer found".

**Nav:** in `AppShell.tsx` add after the Advisor item:

```tsx
      {
        href: '/inbox',
        label: 'Inbox',
        icon: icon(
          <>
            <path d="M22 12h-6l-2 3h-4l-2-3H2" />
            <path d="M5.5 5h13l3.5 7v7H2v-7Z" />
          </>,
        ),
      },
```

**Run:** `npx vitest run src/app/inbox src/components/shell` → pass; `npx tsc --noEmit`; `npm run lint`.

**Commit:** `feat(inbox): the inbox - queue, thread, composer with macros, and the customer beside every ticket`

---

### Task 18: Settings - mailboxes and macros, and how to connect

**Files:**
- Create: `src/app/settings/inbox/page.tsx`, `src/app/settings/inbox/InboxSettingsClient.tsx`
- Modify: `src/app/settings/SettingsTabs.tsx:24` - add after the Affiliate tile:
  `{ href: '/settings/inbox', title: 'Support inbox', blurb: 'Connect your support addresses, write macros', icon: '📥' },`

**Page:** admin-gated like Task 17; loads mailboxes (with shop + ticketCount), shops (`id, name`), macros, and `process.env.POSTMARK_INBOUND_ADDRESS ?? null`; renders `InboxSettingsClient`.

**Client sections:**
1. **Support addresses** - table (address, name, shop, language, active, tickets) with an **Add address** form (`aria-label`s: "Email address", "Name", "Shop", "Language", "Signature") and per-row **Edit** (inline: name/shop/language/signature/active) and **Remove** (disabled with a title when `ticketCount > 0`).
2. **How to connect** - a card: "Forward each address to **{forwardingAddress}**" (or, when null: "Set `POSTMARK_INBOUND_ADDRESS` to your Postmark server's inbound address - Postmark → your server → Inbound stream → Settings"), then four short per-host notes (Google Workspace admin routing; Gmail per-mailbox forwarding confirms by email - the confirmation lands as a ticket here, open it and click the link; Microsoft 365 needs external forwarding enabled in the outbound spam policy; domain hosts: a plain forward/alias). Then "Sending: verify each brand domain in Postmark (DKIM + Return-Path) so replies leave from these addresses."
3. **Macros** - table (name, language, first line) with **Add macro** form ("Macro name", "Language", "Body") and the variable list rendered from `MACRO_VARIABLES` as chips, Edit inline, Delete.

Test `InboxSettingsClient.test.tsx`: renders the forwarding address when given and the instruction when null; adding a macro posts to `/api/inbox/macros`; a mailbox with tickets has its Remove disabled.

**Run:** `npx vitest run src/app/settings/inbox src/app/settings` → pass; tsc; lint.

**Commit:** `feat(inbox): settings - the addresses, the macros, and how to point the mail here`

---

### Task 19: Seed - a working inbox on a fresh database

**Files:**
- Modify: `prisma/seed.ts` - clearing block (~line 82) and a new section after "Creating affiliate sales…" (~line 407)

**Step 1: Clearing** - add at the top of the block, before `db.affiliateTransaction.deleteMany()`:

```ts
  await db.ticketAttachment.deleteMany()
  await db.ticketMessage.deleteMany()
  await db.ticket.deleteMany()
  await db.macro.deleteMany()
  await db.mailbox.deleteMany()
```

**Step 2: Phones on orders** - in the order `create` (line ~285), after `customerEmail`, add:

```ts
          customerPhone: customer ? `+47 9${String(1000000 + CUSTOMERS.indexOf(customer) * 7919).slice(-7)}` : '',
```

**Step 3: The inbox section** - append before `const orders = await db.order.count()`:

```ts
  console.log('Creating the support inbox...')
  const byName = (name: string) => shops.find((s) => s.name === name)!
  const MAILBOXES = [
    { address: 'support@panetti.no', name: 'Panetti Norway', shop: byName('Panetti Norway'), language: 'nb', signature: 'Med vennlig hilsen\nPanetti kundeservice' },
    { address: 'support@panetti.de', name: 'Panetti Germany', shop: byName('Panetti Germany'), language: 'de', signature: 'Mit freundlichen Grüßen\nPanetti Kundenservice' },
    { address: 'support@mazzetti.no', name: 'Mazzetti Norway', shop: byName('Mazzetti.no'), language: 'nb', signature: 'Med vennlig hilsen\nMazzetti' },
  ]
  const mailboxes = []
  for (const m of MAILBOXES) {
    mailboxes.push(await db.mailbox.create({ data: { address: m.address, name: m.name, shopId: m.shop.id, language: m.language, signature: m.signature } }))
  }

  const MACROS: { name: string; language: string; body: string }[] = [
    { name: 'Where is my order?', language: 'en', body: 'Hi {{customer_name}},\n\nThank you for your message. Your order {{order_number}} is {{delivery_status}}. You can follow the parcel with tracking number {{tracking_number}}.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Where is my order?', language: 'nb', body: 'Hei {{customer_name}},\n\nTakk for meldingen. Bestillingen din {{order_number}} er {{delivery_status}}. Du kan følge pakken med sporingsnummer {{tracking_number}}.\n\nMed vennlig hilsen,\n{{agent_name}}' },
    { name: 'Return instructions', language: 'en', body: 'Hi {{customer_name}},\n\nYou can return {{product_name}} within 14 days of delivery. Pack it in its original box, attach the return label we send you, and hand it in at your nearest pickup point. Quote order {{order_number}}.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Warranty', language: 'en', body: 'Hi {{customer_name}},\n\n{{product_name}} carries a two-year warranty. Please reply with a short description of the fault and, if possible, a photo or video, and quote order {{order_number}}. We will get back to you within two working days.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Damaged product', language: 'en', body: 'Hi {{customer_name}},\n\nWe are sorry {{product_name}} arrived damaged. Please send us a photo of the damage and of the packaging, quoting order {{order_number}}, and we will arrange a replacement or a refund straight away.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Refund confirmation', language: 'en', body: 'Hi {{customer_name}},\n\nYour refund for order {{order_number}} has been issued. Depending on your bank it takes 3-5 working days to appear on your statement.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Product instructions', language: 'en', body: 'Hi {{customer_name}},\n\nThank you for choosing {{product_name}}. The user guide is in the box; if it is missing, reply to this email and we will send it as a PDF.\n\nKind regards,\n{{agent_name}}' },
  ]
  for (const m of MACROS) await db.macro.create({ data: m })

  // Tickets from customers the seed already gave orders, so the sidebar has
  // real orders to show on day one. Read from the data rather than hard-coded:
  // the order numbers are whatever the loop above produced.
  const norway = mailboxes[0]
  const germany = mailboxes[1]
  const recentNorway = await db.order.findFirst({
    where: { shopId: byName('Panetti Norway').id, customerEmail: { not: '' }, status: 'completed' },
    orderBy: { placedAt: 'desc' },
  })
  if (!recentNorway) throw new Error('seed: expected a Panetti Norway order with a customer')
  const first = recentNorway.customerName!.split(' ')[0]

  const t1 = await db.ticket.create({
    data: {
      mailboxId: norway.id, subject: `Hvor er ordre ${recentNorway.number}?`, customerEmail: recentNorway.customerEmail!, customerName: recentNorway.customerName!,
      category: 'shipping', language: 'nb', matchedOrderId: recentNorway.id, priority: 'HIGH', tags: ['late'],
      firstMessageAt: new Date('2026-07-13T09:12:00Z'), lastMessageAt: new Date('2026-07-13T09:12:00Z'),
      messages: { create: [{ direction: 'INBOUND', rfcMessageId: 'seed-1@customer.test', fromEmail: recentNorway.customerEmail!, toEmail: norway.address, subject: `Hvor er ordre ${recentNorway.number}?`,
        textBody: `Hei,\n\nJeg bestilte for over en uke siden (ordre ${recentNorway.number}) og har ikke fått noen sporing. Hva skjer?\n\n${first}`, sentAt: new Date('2026-07-13T09:12:00Z') }] },
    },
  })
  await db.ticket.create({
    data: {
      mailboxId: norway.id, subject: 'Spørsmål om varmefunksjonen', customerEmail: recentNorway.customerEmail!, customerName: recentNorway.customerName!,
      category: 'product', language: 'nb', status: 'CLOSED', closedAt: new Date('2026-06-21T10:00:00Z'),
      firstMessageAt: new Date('2026-06-20T14:00:00Z'), lastMessageAt: new Date('2026-06-21T10:00:00Z'),
      messages: { create: [
        { direction: 'INBOUND', rfcMessageId: 'seed-2@customer.test', fromEmail: recentNorway.customerEmail!, toEmail: norway.address, textBody: 'Hvordan slår jeg på varmen i stolen?', sentAt: new Date('2026-06-20T14:00:00Z') },
        { direction: 'OUTBOUND', rfcMessageId: 'seed-2r@panetti.no', fromEmail: norway.address, toEmail: recentNorway.customerEmail!, textBody: 'Hei! Hold inne knappen med flammesymbolet i to sekunder.\n\nMed vennlig hilsen\nPanetti kundeservice', sentAt: new Date('2026-06-21T10:00:00Z') },
      ] },
    },
  })
  await db.ticket.create({
    data: {
      mailboxId: germany.id, subject: 'Rücksendung meiner Bestellung', customerEmail: 'jonas.weber@example.de', customerName: 'Jonas Weber',
      category: 'return', language: 'de',
      firstMessageAt: new Date('2026-07-12T16:40:00Z'), lastMessageAt: new Date('2026-07-12T16:40:00Z'),
      messages: { create: [{ direction: 'INBOUND', rfcMessageId: 'seed-3@example.de', fromEmail: 'jonas.weber@example.de', toEmail: germany.address, textBody: 'Hallo,\n\nich möchte meine Bestellung zurückschicken. Wie gehe ich vor?\n\nJonas Weber', sentAt: new Date('2026-07-12T16:40:00Z') }] },
    },
  })
  await db.ticket.create({
    data: {
      mailboxId: mailboxes[2].id, subject: 'Question about the massage chair', customerEmail: 'unknown@example.com', customerName: 'Sam',
      category: 'product', language: 'en', status: 'PENDING',
      firstMessageAt: new Date('2026-07-11T08:00:00Z'), lastMessageAt: new Date('2026-07-11T12:00:00Z'),
      messages: { create: [
        { direction: 'INBOUND', rfcMessageId: 'seed-4@example.com', fromEmail: 'unknown@example.com', toEmail: mailboxes[2].address, textBody: 'Does the Lite Comfort fit under a 70 cm desk?', sentAt: new Date('2026-07-11T08:00:00Z') },
        { direction: 'NOTE', fromEmail: 'admin@ecom.test', toEmail: '', textBody: 'Checked with the warehouse: 68 cm with the headrest down.', sentAt: new Date('2026-07-11T11:00:00Z') },
        { direction: 'OUTBOUND', rfcMessageId: 'seed-4r@mazzetti.no', fromEmail: mailboxes[2].address, toEmail: 'unknown@example.com', textBody: 'Yes - 68 cm with the headrest down.\n\nMed vennlig hilsen\nMazzetti', sentAt: new Date('2026-07-11T12:00:00Z') },
      ] },
    },
  })
  void t1
```

Assign the NOTE's `authorUserId` and the OUTBOUND's to the admin user if you kept a reference to it (`const admin = await db.user.create(...)` at line 148 - capture it).

**Step 4: Run** - `npm run db:seed` → ends with `Done. 11 shops, 24 ambassadors, N orders.` and no error. `npm test` still green (seed data does not affect tagged tests).

**Step 5: Commit** - `feat(inbox): sample mailboxes, macros and tickets so the inbox works before any mail is connected`

---

### Task 20: End-to-end

**Amendment (shared-environment):** the local Postgres and port 3000 are shared with another live session, so (a) **never run `npm run db:seed`** during this work - it wipes that session's local affiliate data; the seed code in Task 19 is written and type-checked but not run; (b) the spec below must be **self-sufficient**: it creates its own mailbox through `POST /api/inbox/mailboxes` (unique address `support+e2e<timestamp>@e2e.invalid`), ingests its own email through `POST /api/inbox/inbound?token=…` (`INBOX_INBOUND_SECRET=e2e-secret` in the worktree `.env`, read by the dev server), and matches it against a real order found via `page.request.get('/api/orders?preset=last_12_months&limit=50')` (pick the first row with a non-empty `customerEmail`; send the webhook From that address with `#<number>` in the body); it removes its mailbox (and thereby its tickets, cascade) at the end. Macros are created by the spec too (`POST /api/inbox/macros`, name `[e2e] Where is my order?`) and deleted after. (c) `playwright.config.ts` reads `const port = Number(process.env.E2E_PORT ?? 3000)` for both `baseURL` and `webServer.url`, and `webServer.command` becomes `` `npm run dev -- -p ${port}` ``; run with `E2E_PORT=3100`. Assertions stay as written below, substituting the created data for the seeded tickets.

**Files:**
- Create: `e2e/inbox.spec.ts`
- Modify: `e2e/global-setup.ts:9` (add `'/inbox', '/settings/inbox'` - if not done in Task 17)

**The spec** (copy the `signIn` helper from `e2e/orders.spec.ts:3-9`):

```ts
test('the inbox lists tickets, and opening one shows the customer and their orders', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.getByRole('link', { name: 'Inbox' }).click()
  await expect(page).toHaveURL(/\/inbox/)
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible()

  const row = page.getByTestId('ticket-row').filter({ hasText: /Hvor er ordre/ }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  const subject = await row.textContent()
  const number = /#\d+/.exec(subject ?? '')![0]
  await row.click()

  const sidebar = page.getByTestId('ticket-sidebar')
  await expect(sidebar).toContainText(number)
  await expect(sidebar).toContainText('Orders')
  await expect(sidebar).toContainText('Previous conversations')
  await expect(sidebar).toContainText('Spørsmål om varmefunksjonen')
})

test('a macro fills in the order, an unmatched ticket says so, notes stay internal, and the queue filters', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/inbox')
  const row = page.getByTestId('ticket-row').filter({ hasText: /Hvor er ordre/ }).first()
  await row.click()
  const number = /#\d+/.exec((await row.textContent()) ?? '')![0]

  // Macro: the order number lands in the text, and nothing is left unfilled.
  await page.getByLabel('Insert macro').selectOption({ label: 'Where is my order? (nb)' })
  const box = page.getByLabel('Message')
  await expect(box).toHaveValue(new RegExp(number.replace('#', '\\#')))
  await expect(box).not.toHaveValue(/\{\{/)

  // Note: recorded, labelled, never sent.
  await page.getByRole('tab', { name: 'Internal note' }).click()
  await box.fill('Ringte lageret.')
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByText('Internal note').last()).toBeVisible()
  await expect(page.getByText('Ringte lageret.')).toBeVisible()

  // Assignment and status.
  await page.getByLabel('Assign to').selectOption({ label: 'admin@ecom.test' })
  await page.getByLabel('Status').selectOption('PENDING')
  await page.getByRole('tab', { name: 'Pending' }).click()
  await expect(page.getByTestId('ticket-row').filter({ hasText: /Hvor er ordre/ })).toBeVisible()
  await page.getByLabel('Status').selectOption('OPEN')

  // The unmatched one.
  await page.getByRole('tab', { name: 'Pending' }).click()
  await page.getByTestId('ticket-row').filter({ hasText: 'Question about the massage chair' }).click()
  await expect(page.getByTestId('ticket-sidebar')).toContainText('No customer found')

  // Search narrows by subject.
  await page.getByRole('tab', { name: 'Open' }).click()
  await page.getByLabel('Search tickets').fill('Rücksendung')
  await expect(page.getByTestId('ticket-row')).toHaveCount(1)
})

test('settings: a support address can be added and the forwarding instructions are there', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/inbox')
  await expect(page.getByRole('heading', { name: 'Support inbox' })).toBeVisible()
  await expect(page.getByText(/Forward each address|POSTMARK_INBOUND_ADDRESS/)).toBeVisible()
  const address = `support+${Date.now()}@bellino.no`
  await page.getByLabel('Email address').fill(address)
  await page.getByLabel('Name').fill('Bellino')
  await page.getByRole('button', { name: 'Add address' }).click()
  await expect(page.getByRole('cell', { name: address })).toBeVisible()
  await page.getByRole('row', { name: new RegExp(address) }).getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('cell', { name: address })).toHaveCount(0)
})
```

**Run:** `npm run db:seed` (fresh data) then `npm run test:e2e -- --headed e2e/inbox.spec.ts` → 3 passed. Then the whole e2e suite once: `npm run test:e2e -- --headed` → all pass (the seed reset the DB; the other specs expect the seed).

**Commit:** `test(inbox): the inbox end to end - queue, sidebar, macro, note, status, search, settings`

---

### Task 21: The gate - everything green, then hand over

1. `npx tsc --noEmit` → clean.
2. `npm run lint` → clean.
3. `npm test` → **0 failed**. If `sync.test.ts` times out, rerun it alone (`npx vitest run src/lib/woo/sync.test.ts`); it is the shared-Postgres flake, and must pass alone.
4. `npm run test:e2e -- --headed` → all pass.
5. `npm run build` → succeeds (this pushes the schema, then builds - proves the additive migration is accepted).
6. Update `README.md`: a short **Support inbox** section after "How data stays current": what it is, env vars (`INBOX_INBOUND_SECRET`, `POSTMARK_INBOUND_ADDRESS`), the forwarding sentence, the DKIM/Return-Path sentence. Commit: `docs(inbox): how the support inbox is connected`.
7. `git log --oneline main..HEAD` - one commit per task. Then invoke **superpowers:finishing-a-development-branch**.

**Production checklist for the hand-over note (not code):** Postmark plan must include inbound (Pro); set `INBOX_INBOUND_SECRET` and `POSTMARK_INBOUND_ADDRESS` in Vercel; point the Postmark inbound webhook at `https://panetti.vercel.app/api/inbox/inbound?token=…`; verify each brand domain in Postmark (DKIM + Return-Path) before agents reply from it; forward each support address; the first live inbound email is the test of the one unconfirmed fact (raw `Message-ID` / `References` in Postmark's `Headers[]`) - open it in the inbox and confirm its `rfcMessageId` is not `postmark:…`.

