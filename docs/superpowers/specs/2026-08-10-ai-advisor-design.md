# AI advisor - design

**Date:** 2026-08-10
**Status:** approved, ready for an implementation plan

## The ask

From the client, three ideas in one message:

1. **Connect the system to our ERP** so B2B orders arrive automatically - match a customer
   number in the software to the customer number in the ERP, and match our products to the
   SKUs in WooCommerce. *Explicitly not urgent.*
2. **An executive AI dashboard.** Instead of showing numbers, tell management what needs
   attention. His examples: revenue down 18% in Sweden because Meta ROAS fell 7.4 → 4.9;
   Mazzetti Germany has high mobile cart abandonment; Panetti Norway needs a purchase order
   in 23 days; Panetti Denmark shipping delays up 1.8 days. "Basically an AI COO."
3. **Demand forecasting.** "We will run out of PrimoMix in Germany on November 17." /
   "Order 620 units before August 25."

And a question: *"We have to make an AI agent for this? Or how would we proceed? I need my
own AI that can analyze data and think for itself to give me advice, and that I can talk
with inside of the system."*

## Scope: this is three projects, and this spec is one of them

| | Project | Blocked by |
| --- | --- | --- |
| A | ERP connector - customer numbers, SKU mapping, automatic B2B orders, and the stock / lead-time feed | Which ERP. Every vendor has a different API. |
| **B** | **AI advisor - facts engine, morning briefing, chat. ← this spec** | **Nothing.** |
| C | Demand forecasting | Project A's stock feed |

Decided with the client: **B first**, because it ships on data already in the database.

### Three of the client's four examples cannot be built yet

| Example | Status |
| --- | --- |
| Revenue down 18% in Sweden, Meta ROAS 7.4 → 4.9 | Available |
| Denmark shipping delays up 1.8 days | Available |
| Germany mobile cart abandonment | **No web analytics anywhere.** Needs GA4 - Woo's REST API exposes no sessions and no device. |
| Norway needs a purchase order in 23 days | **No stock.** `Product` has no stock column; there is no supplier and no purchase-order model. |

Of the seven inputs he lists for forecasting, three are absent: current stock, supplier lead
time, and shipping time from China. `stock ÷ forecast daily demand` has no answer without the
first. This is the reason Project A is a prerequisite for Project C rather than a nice-to-have
- the ERP is where that data lives.

## Which AI, and why not OpenRouter

**Direct Anthropic API, `@anthropic-ai/sdk`, `claude-opus-5`.**

OpenRouter's value is arbitrage across providers and automatic failover between them. Neither
applies here: this is one model reading one company's P&L. What it costs instead is a 5.5% fee
on credit purchases, 20-112 ms of routing overhead, day-one feature lag, and a third company in
the path of the client's revenue data.

Three first-party features carry the design:

- **Structured outputs** (`client.messages.parse()` + a Zod schema) - the briefing returns
  validated typed JSON, not prose to be parsed.
- **Prompt caching** - the chat's system prompt and tool definitions repeat across turns.
  Opus 5's minimum cacheable prefix is 512 tokens, so the chat prompt qualifies.
- **Tool use** - the chat queries the metrics engine instead of guessing.

Estimated cost at this volume: **$3-8/month** for daily briefings, plus a few cents per chat
conversation.

## The one hard problem

**An LLM must never compute money in this product.**

`PRODUCT.md` states it directly: *"A confident wrong number is the worst thing this product
could ship."* A model asked to derive an 18% revenue delta will eventually get it wrong and
state it with total confidence, and the figure will disagree with the Dashboard one tab over.

So the model never does arithmetic. TypeScript computes every figure, using the same
`computeMetrics` that every existing screen uses. The model receives those figures as
structured facts and decides only **what matters, in what order, and why**.

This is enforced in two places, not one:

1. **Validation.** Each returned item cites `factIds`. An item citing an id that is not in
   the set it was given is dropped before storage.
2. **Rendering.** The interface prints figures from `Fact`, never from the model's prose.
   The model writes the sentence; the number beside it comes from the engine. The prompt
   instructs it to keep figures out of `headline` and `why` for exactly this reason.

Worst case is therefore an awkwardly-worded sentence, never a wrong figure.

## What already exists

The facts engine is thin because almost everything it needs is written and tested.

| Piece | Where |
| --- | --- |
| Every money figure, per shop, currency-converted at each day's own rate | `src/lib/metrics/engine.ts`, `computeMetrics` |
| The prior comparison window | `src/lib/metrics/trend.ts:14`, `previousRange` |
| Period-over-period change, `null` when the prior period was zero | `src/lib/metrics/trend.ts:27`, `deltaPct` |
| ROAS, CPA, spend and daily budget per shop and per campaign | `src/lib/ads/marketing.ts`, `buildMarketing` |
| Median delivery days, on-time rate, late-now count, per country | `src/lib/delivery/stats.ts`, `deliveryStats` |
| Units and profit per product per shop, plus an `uncosted` count | `src/lib/metrics/products.ts`, `productFigures` |
| Which orders count at all | `EXCLUDED_STATUSES`, `src/lib/metrics/types.ts` |
| Per-shop sync failure reason | `Shop.lastError`, `prisma/schema.prisma:31` |
| Admin-only route guard | `src/lib/auth/guard.ts`, `assertAdmin` |
| Cron with a bearer secret and a deadline budget | `src/app/api/cron/sync/route.ts` |
| JSON stored as text | `TrackingImport.unmatched`, `prisma/schema.prisma` |

No AI code exists anywhere in the repository. No `anthropic`, `openai`, or `openrouter`
dependency, and no web-analytics, stock, supplier or purchase-order data of any kind.

## Decisions

### Three layers, and only the middle one is a model

```
Facts layer      pure TS over the existing engine   →  Fact[]     no AI
Briefing layer   Fact[] → Claude → validated JSON   →  Item[]
Chat layer       Claude + tools calling the same loaders
```

New code in `src/lib/advisor/`, following the `src/lib/delivery/` precedent: pure functions,
heavily tested, with thin route handlers that only load and call.

### The briefing is written each morning and stored

Chosen over computing it live on page load. Stored means the page opens instantly, the cost is
bounded to one generation a day, and there is a history to look back at. A **Refresh** button
re-runs it on demand for when the morning's picture has moved.

```prisma
/// One morning's briefing. Written by cron, read on the Advisor page.
model Briefing {
  id        String   @id @default(cuid())
  /// The calendar day it describes, in the workspace timezone. Unique, so a
  /// re-run replaces rather than duplicates and the cron is safely idempotent.
  day       DateTime @unique
  from      DateTime // the window the facts were computed over
  to        DateTime
  /// The computed facts, as JSON text - the same convention TrackingImport
  /// uses. Stored so the page prints figures from data rather than from prose,
  /// and so a failed generation retries against the same facts rather than
  /// against a database that has since moved on.
  facts     String
  /// The model's ordered items. Null while generating, and after a failure -
  /// the facts still render, so the page is never blank.
  items     String?
  error     String?  // why generation failed; null when it worked
  model     String?  // which model wrote it
  createdAt DateTime @default(now())
}
```

Additive only, so `scripts/db-push.mjs` ships it ahead of the build on a plain `git push`.

### A fact is a computed comparison, not an observation

```ts
export type Fact = {
  /** Stable within one briefing, e.g. "roas:shop_abc". The model cites these. */
  id: string
  kind: FactKind
  shopId: string | null
  shopName: string | null
  /** The subject when it is not a whole shop: a product, a country, a customer. */
  subject: string | null
  /** Now and before. Minor units for money; plain numbers for ratios and days. */
  current: number | null
  previous: number | null
  /** Fractional change. Null when the previous value was zero - growing from
   *  nothing is not a percentage, exactly as deltaPct already decides. */
  deltaPct: number | null
  unit: 'money' | 'ratio' | 'days' | 'count' | 'percent'
  /** 0..1, by rule. Decides which facts are sent and in what order. */
  severity: number
}
```

`Fact.severity` is a number computed by the rule below, and it decides what the model is
even shown. The `severity` on an *item* further down is a different thing: the model's own
judgement of how much the reader should care, in three named levels. They are deliberately
not the same scale - one is materiality, the other is editorial.

The comparison window is **the last 7 days against `previousRange()`'s prior 7**, so the
briefing means the same thing by "compared with before" that the Dashboard does.

### Severity is a rule, so the client can predict it

A move becomes a fact only when it clears **both** gates:

- `|deltaPct| >= 0.10`, and
- the move is worth at least **1% of total revenue** in the prior window.

Severity then scales with the move's share of total revenue, saturating at 5%.

Both gates are needed. The percentage alone promotes noise - a small shop tripling on three
orders would outrank a large one falling 12%. The absolute size alone hides a real collapse in
a small market. Data-quality facts bypass both: they are about whether a number can be trusted,
not about how large it is.

The top 40 facts by severity are sent to the model, plus every data-quality fact.

### What is watched

All four groups, agreed with the client.

| Group | Facts |
| --- | --- |
| Money & marketing | Revenue, profit and margin moves per shop; ROAS moves per shop and per campaign; spend running over or under `dailyBudget` |
| Delivery | Median days rising per shop and country; on-time rate falling; `lateNow` climbing |
| Products & customers | A product's unit rate shifting per shop; a B2B customer gone quiet; ambassador sales moving |
| Data quality | Products with no cost on file, so profit is overstated; a shop whose sync is failing; missing exchange rates |

"Gone quiet" needs a rule of its own, because a B2B customer has no percentage to compare.
It is: the customer has placed at least three orders, and the gap since their last one is
now more than **twice their own median gap** between orders. Their own rhythm, not a fixed
number of days - a customer who orders monthly and one who orders weekly are both silent at
very different points, and a shared threshold would nag about one while missing the other.

The data-quality group is the client's own *"say when you don't know"* principle applied to the
briefing itself. It is what makes "Norway's profit is understated - three products have no cost
entered" a thing the advisor says out loud rather than a silent distortion.

### The briefing's output shape

```ts
{
  headline: string          // "Sweden revenue is down"
  why: string               // the causal explanation, prose
  factIds: string[]         // what it rests on; validated against the set sent
  severity: 'high' | 'medium' | 'low'
  action: string | null     // what to do about it, or null when there is nothing to do
}[]
```

`action` is nullable on purpose. An advisor that invents a recommendation for every observation
is noise; some mornings the honest answer is "this moved, and nothing needs doing."

### Model parameters

`claude-opus-5`, adaptive thinking, non-streaming, `max_tokens: 16000`. Thinking is on by
default on this model and counts against `max_tokens`, so the ceiling is set well above the
document's own length.

`stop_reason: "refusal"` is handled explicitly - checked before reading content - and stored in
`error` like any other failure. Server-side `fallbacks` is deliberately **not** enabled: it
requires the beta messages endpoint, which would cost the `parse()` structured-output helper,
and the refusal risk on P&L analysis is negligible. If a refusal is ever actually observed, the
stored `error` will say so and the decision can be revisited with evidence.

### The chat gets tools, not SQL

Five read-only tools - `get_metrics`, `get_marketing`, `get_delivery`, `get_products`,
`get_orders` - each calling the same loaders the pages call. Asked "why was Sweden down last
week?", the model runs the engine twice and compares.

SQL access was rejected. A model writing its own `SELECT` against `Order` would sooner or later
sum `netSales` without excluding refunded and cancelled rows, and produce a number that
contradicts every screen in the product. Routing every query through the engine makes that
impossible rather than unlikely.

`cache_control` on the system prompt keeps multi-turn conversation cheap. The conversation lives
in the browser for v1, surviving a refresh via `sessionStorage`; there is no server-side history
table. Persisted history is purely additive later.

### The page

A new **Advisor** item in the Analytics group of the sidebar. Today's briefing as ranked cards -
headline, then the fact figures in tabular numerals, then the explanation - with the chat below.
Per `DESIGN.md`: 1px border, radius 12px, no drop shadow; severity carried by position and an
explicit label, never by colour alone. The empty state teaches the next action.

Admin only, via the existing `assertAdmin`. Ambassadors and the marketing role never see company
costs or profit, and this page is made of both.

### Failing visibly

- `ANTHROPIC_API_KEY` unset → the page says so plainly, the way an unconnected shop does.
- The model call fails, times out, or refuses → `error` is stored and shown, **and the computed
  facts still render**, because they never needed the model.

Same rule as `Shop.lastError`: a visible failure, never a silent one.

### A separate cron

`0 5 * * *` in `vercel.json`, on its own route `/api/cron/briefing`, guarded by the existing
`CRON_SECRET`.

Deliberately not folded into `/api/cron/sync`. That route is budgeted tight against a 300-second
platform ceiling, and its own comments explain that the delivery alert at the end is the one
thing it cannot afford to have starved. Bolting an LLM call onto it would put an unbounded
network call in front of that alert.

05:00 UTC is 06:00 or 07:00 in `Europe/Oslo` depending on the season - before the working day in
every market, which is what "every morning" means here.

## Testing

The client asked for it green and tested end to end.

- **Unit (vitest).** Every fact rule; both severity gates, including the case each one exists to
  catch; the validator dropping an item that cites an unknown fact id; the JSON round-trip
  through `facts` and `items`. No network.
- **Integration.** The cron route against a stubbed model client: success, model failure, refusal,
  and a same-day re-run replacing rather than duplicating.
- **E2E (playwright).** `/advisor` renders a stored briefing; the empty state before the first
  run; a failed generation still showing its facts; one chat turn. Model stubbed. The route is
  added to `e2e/global-setup.ts` so it is not the test that pays the compile bill.

## Deliberately not in v1

Cart abandonment (needs GA4), stockout dates and reorder quantities (need Project A's stock
feed), server-side chat history, Slack push of the briefing, and forecasting of any kind.
