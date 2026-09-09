# AI chat agent on Gorgias live chat: design

Date: 2026-09-09. Status: approved by Jacinta (developer) after Philip's answers below.

## What Philip asked

> When could we start turning on the AI live chat from Gorgias? I have it on
> the website but it sits there, no function. Would be nice if we could try it
> out in the software first, ask it questions, see how it would respond, give
> it corrections so it can learn, and then turn it on for different webshops so
> it could start to reply to simple questions, and if there is any question it
> doesn't know, it would set them over to a real life agent.

Answers obtained 2026-09-08/09:

- Gorgias's own AI Agent cannot be used: it requires a Shopify store and is
  not supported for WooCommerce (Gorgias docs, "Compatibility of automation
  features with ecommerce store providers"). Philip agreed the AI is ours,
  answering inside the Gorgias chat window customers already use.
- Start: **all day, on panetti.dk first**, widened shop by shop from a switch.

## What exists today (measured 2026-09-09 on production)

- The Gorgias chat widget is on every storefront, one widget per shop, open
  Mon-Fri 09-17 and Sat-Sun 09-16 Europe/Oslo. It works as a human live chat:
  160 chats in the last 30 days, 153 of 154 closed ones answered by Selena or
  Develyn, about 6 messages per chat, plus 45 "offline capture" chats from
  outside opening hours. Widget config: AI Agent disabled, self-service flows
  off, no help center, no store connected to the chat.
- An AI support agent was built 2026-08-28 (`src/lib/support/*`): Gorgias
  HTTP-integration webhook -> `handleMessage()` -> `judge()` (Claude, forced
  tool call, customer context + knowledge) -> `decide()` (rules: mode
  off/draft/auto, allowed categories, escalate keywords, confidence floor) ->
  reply through `Channel` (Gorgias adapter) or an internal note. A review page
  at `/support` rates answers and stores corrections. Settings at
  `/settings/ai-support`, knowledge CRUD at `/api/support/knowledge`.
- It has never run in production: zero `AiConversation` rows, zero
  `KnowledgeItem` rows, no `AiSupportRules` row. The Gorgias HTTP integration
  pointing at `/api/gorgias/webhook` was never created. Corrections are stored
  but never read by later answers. Everything AI-support is a singleton, not
  per shop. `judge()` takes one message, no history.
- Gorgias's API creates messages on chat tickets and its HTTP integrations
  fire on "Ticket message created", so a reply from us lands in the widget.
  Not yet proven on this account.

## Goals

1. A place in the software where an admin talks to the assistant as a
   customer would, sees what it would do and why, and corrects it, with the
   correction used from the next turn on.
2. Live replies inside the Gorgias chat for one shop at a time, switched on
   per shop by a date, starting with Panetti Denmark.
3. Anything the assistant should not answer goes to a person in Gorgias, and
   once a person is on the chat the assistant stays silent.

Non-goals for this work: a chat widget of our own, per-shop rule sets, Slack
notifications for handovers, opening-hours-aware wording, answering email or
social channels (the existing pipeline still handles those in whatever mode
the rules say), and any change to the delivery, orders or finance features.

## Approach

Our brain inside Gorgias chat. Gorgias remains the transport and the agents'
workplace. The August pipeline is extended, not replaced, and the `Channel`
seam is kept: nothing below `channel.ts` learns about Gorgias.

Rejected: our own widget (browser auth, a second agent inbox, three to four
times the work), and Gorgias Flows/help center without AI (not what was asked).

## Data model

All additions are `prisma db push`-safe (nullable columns, new tables).

### `Shop.aiChatFrom DateTime?`

The per-shop switch, in the same shape as `deliveryTrackingFrom` and
`wooNotesFrom`: null is off. A chat is eligible only if the Gorgias ticket was
created at or after this instant, so switching a shop on can never reach a
chat already in progress. Set on `/settings/ai-support` as a date, stored as
that date at 00:00 UTC.

### `AiChatSession` (new)

One row per Gorgias chat ticket the assistant has been asked about.

| field | type | meaning |
|---|---|---|
| id | cuid | |
| shopId | String, FK Shop | which shop's widget the chat came from |
| source | String, default `gorgias` | channel name |
| externalTicketId | String | Gorgias ticket id; `@@unique([source, externalTicketId])` |
| status | String | `ai` (assistant may reply), `handed_over` (assistant handed over, never replies again), `human` (a person wrote; assistant never replies again) |
| customerEmail | String? | as known to the ticket |
| language | String? | last detected |
| lastCustomerMessageId | String? | newest customer message id we have seen |
| replies | Int, default 0 | assistant replies sent on this ticket |
| handedOverAt | DateTime? | |
| handoverReason | String? | |
| createdAt / updatedAt | | |

### `AiConversation` changes

- `source` already exists (`gorgias`). New value `sandbox`.
- `sessionId String?` FK `AiChatSession` (null for email and sandbox rows).
- `externalMessageId String?` and `@@unique([source, externalMessageId])`
  where not null. This is the double-answer guard for chat: the same Gorgias
  message delivered twice records once and is answered once.
- `shopId String?` so the review page can filter by shop.

The review page and analytics exclude `source = 'sandbox'` from counts by
default and offer a "Sandbox" filter to see them.

### `KnowledgeItem.kind` gains `example`

An `example` is a customer question (title) with the answer that should have
been given (body), scoped like any other item (shopId, country, language,
sku). It is retrieved by the existing keyword overlap in `knowledgeFor()`; no
embeddings, per the doctrine already recorded in `knowledge.ts`. The prompt
gains one line: when an example matches the question, follow its answer.

Corrections become examples in two places: the sandbox (below) and the
existing review page, whose "Wrong + correction" now also writes an
`example` scoped to the conversation's shop and language. The
`AiConversation.correction` column stays as the record of what was typed.

## The chat turn

### Gorgias side (Philip does this from a page that hands him the values)

One HTTP integration per shop, named for the shop, method POST, URL
`https://panetti.vercel.app/api/gorgias/webhook?token=<GORGIAS_WEBHOOK_SECRET>&shop=<Shop.id>`,
trigger "Ticket message created", JSON body carrying: ticket id, message id,
message created time, customer email, customer name, message text, `via`,
`from_agent`, and the ticket's channel. The integration is restricted to that
shop's chat by a Gorgias rule (condition: channel is chat, integration is the
shop's chat widget). The settings page shows the URL and the body template
verbatim so nothing is typed by hand. The exact template variable names are
confirmed against Gorgias's HTTP-integration docs during implementation and
written into the page, not into this spec.

Escalate keywords stay one shared list. If it is empty when the page is
first saved, it is pre-filled with `menneske`, `person`, `medarbejder`,
`kundeservice`, `human`, `agent`; Philip edits from there. The sandbox
reports the action `decide()` would take with the mode treated as `auto`, so
a shop still in `draft` mode is tested as if it were live.

### Webhook (`/api/gorgias/webhook`)

Existing behaviour is kept for non-chat channels. For a body whose channel
is chat:

1. Authorise (unchanged). Resolve the shop from `?shop=`; unknown shop ->
   200, `skipped`.
2. If `Shop.aiChatFrom` is null, or the ticket was created before it -> 200,
   `skipped`. The date is checked against the ticket creation time carried
   in the body.
3. Upsert the `AiChatSession` for the ticket.
4. `from_agent` true: the assistant's own replies and notes come back
   through the same trigger. An agent message is the assistant's own when its
   text equals a reply or note recorded on this session in the last 15
   minutes; then 200, `skipped`. Any other agent message is a person -> set
   the session to `human`, 200. This is the human latch: a person typing on
   the chat silences the assistant for good on that ticket.
5. Customer message: record `lastCustomerMessageId`, then wait 6 seconds
   inside the request (`maxDuration` is 120). Then fetch the ticket's
   messages from Gorgias (`GET /api/tickets/{id}/messages`, new
   `fetchTicketMessages()` in `client.ts`). If a customer message newer than
   ours exists -> 200, `superseded`: the later delivery answers with the
   whole burst. If a human agent message exists after our last reply -> set
   `human`, 200. This is the debounce: "hi / where is my order / 14689" sent
   as three messages gets one reply.
6. Session `handed_over` or `human` -> 200, `skipped`, no call to the model.
7. `replies >= 8` -> handover (runaway cap) with the reason recorded.
8. Build the history: the last 20 messages of the ticket in order, customer
   messages as user turns and assistant replies as assistant turns, the
   burst of new customer messages joined as the final user turn.
9. `judge()` gains a `history` parameter and a `chat` flag. In chat mode the
   prompt asks for: short answers (a few sentences), the customer's language,
   self-identification as Panetti's assistant in the first reply of a session
   with an offer to fetch a person, and a request for order number plus email
   when the ticket has no customer email and the question needs an order.
   Model `claude-opus-5`, adaptive thinking, `output_config.effort: 'low'`,
   `max_tokens` 1024, request timeout 25 s. Non-streaming: Gorgias delivers a
   message whole. Target: reply visible within about ten seconds including
   the six-second wait.
10. `decide()` unchanged: send only when the rules' mode is `auto`, the
    category is in the allowed list, confidence clears the floor, no escalate
    keyword was used, and the model did not ask for a person.
11. Send: `channel.sendMessage()`; record `AiConversation` (source `gorgias`,
    sessionId, externalMessageId, shopId); `replies + 1`.
12. Draft (mode `draft`): internal note only, as today. Used for the first
    live days on panetti.dk.
13. Handover: one customer-visible line in the customer's language
    ("I am getting a colleague to help you, one moment"), the existing
    internal note (reason, summary, suggested reply), the ticket tagged
    `ai-handover` (new `tagTicket()` in `client.ts`, `PUT /api/tickets/{id}`
    with the existing tags plus this one), session -> `handed_over`.
14. Model unreachable or errored: handover as in 13, with the reason.

### Gorgias adapter fix

`gorgiasChannel(via)` uses `via` as the reply channel. Chat tickets report
`via` as `gorgias_chat` or `offline_capture`; the reply channel must be
`chat`. The adapter maps `via` to channel: `gorgias_chat`, `offline_capture`
and `chat` -> `chat`; `helpdesk` and `api` -> `email`; anything else passes
through. A pure function with a table test.

### Customer identity and order data

Order and parcel facts come from `customerContext(email)` with the ticket's
customer email only. An order number typed in the chat is looked up only
inside that customer's own orders. With no email on the ticket the assistant
answers policy questions from knowledge and asks for order number plus email
for anything order-specific; it never shows another customer's order.

## The sandbox

Route: `/support/sandbox`, admin only, linked from the `/support` page.

Layout: a shop picker (default Panetti Denmark) and an optional customer
email at the top; the chat in the middle; a "What it saw" panel beside it.

Each assistant turn shows: the reply, the action it would have taken (Send /
Draft / Hand over) with `decide()`'s reason, confidence, category, language,
and the knowledge items used (kind and title). "What it saw" lists the
customer's orders and parcels exactly as `customerContext()` returned them,
so a wrong answer can be traced to missing knowledge versus missing facts.

Every reply has Good and Wrong. Wrong opens a correction box; Save writes a
`KnowledgeItem` of kind `example` (title = the customer's question, body =
the corrected answer, shopId = the picked shop, language = the detected
language) and marks the `AiConversation` row rated `bad` with the
correction. The next turn in the same sandbox conversation retrieves it.

`POST /api/support/sandbox` takes `{ shopId, customerEmail?, messages[] }`
(the whole transcript, the last entry being the new customer message) and
runs `handleMessage()` with a capturing `Channel` (no network) and a `dryRun`
option: it records with source `sandbox`, and it reports what `decide()`
would have done regardless of the rules' mode, so a shop still in `draft`
mode can be tested as if live. The sandbox never calls Gorgias.

## Settings

`/settings/ai-support` gains a per-shop table: shop name, "AI chat from"
date input (writes `Shop.aiChatFrom`), and, per shop, the webhook URL and
body template to paste into Gorgias, with a copy button each. The existing
rules editor stays one shared set, with the keyword pre-fill described
under "Gorgias side".

## Safety rules, stated once

- Nothing is sent to a customer unless: the shop's `aiChatFrom` is set and
  the ticket is newer, the rules' mode is `auto`, the category is allowed,
  confidence clears the floor, no escalate keyword, no human on the ticket,
  the session is `ai`, and fewer than 8 replies so far.
- The assistant says it is an assistant in its first reply and offers a
  person. Any request for a person hands over.
- A person writing on the ticket silences the assistant on that ticket for
  good. There is no "hand back" in this version.
- Handover always leaves the internal note with a suggested reply, so the
  person picking up has the summary in front of them.
- Facts only from the ticket's own customer's orders; policies only from
  knowledge; otherwise ask or hand over. These are the existing prompt rules.

## Rollout

Phase 1: sandbox, correction loop (sandbox and review page), per-shop switch
UI, Danish keyword defaults, `example` kind. No Gorgias traffic changes.
Philip trains it from the sandbox.

Phase 2: chat turn pipeline, session table, adapter fix, `fetchTicketMessages`
and `tagTicket`, settings webhook panel, Gorgias setup instructions. Live
proof on panetti.dk in `draft` mode: the assistant leaves notes on real chats
and sends nothing. Philip switches the mode to `auto` when he is happy with
the drafts.

Later, on request: opening-hours-aware handover text, a Slack ping on
handover, per-shop rules, more shops (a date each).

## Testing

Unit (pure, no DB): via-to-channel mapping; the burst/supersede decision
given a message list; the human latch given a message list; the reply cap;
history assembly (last 20, roles, burst joined); example promotion payload;
chat-mode prompt contains the self-identification and order-number rules.

Integration (local Postgres, stubbed `fetch` for Gorgias and Anthropic):
duplicate webhook delivery answers once; three quick customer messages
answer once with all three in the prompt; a human reply then a customer
message produces no assistant call; handover sends the line, the note, the
tag and locks the session; shop with `aiChatFrom` null is skipped; a ticket
older than `aiChatFrom` is skipped; sandbox route records `source =
'sandbox'` and makes no outbound request; review page counts exclude
sandbox rows; a saved correction is returned by `knowledgeFor()` for the
same question.

Live proof, by Philip, recorded in the PR: one real chat on panetti.dk in
draft mode showing the internal note, then one in auto mode showing the
reply inside the widget and a handover reaching Selena or Develyn.
