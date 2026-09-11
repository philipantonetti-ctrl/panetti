import Anthropic from '@anthropic-ai/sdk'
import { ADVISOR_MODEL } from '@/lib/advisor/brief'
import type { CustomerContext } from '@/lib/inbox/context'
import { knowledgeBlock, type KnowledgeRow } from './knowledge'

/**
 * The support assistant's one decision.
 *
 * It reads the customer's message, everything we know about their orders, and
 * the knowledge base, and returns a category, a draft reply, a summary and its
 * own confidence. It never decides whether to SEND: rules.ts does that, from
 * settings a person controls. The model can only lower its permissions here,
 * by asking for a human or by admitting low confidence.
 *
 * Facts come from the context block, policies from the knowledge base, and
 * nothing else is allowed to be stated as ours. Same doctrine as the executive
 * advisor: an invented tracking number or an imagined returns window is worse
 * than an admitted gap, because the customer acts on it.
 */

export const CATEGORIES = [
  'shipping',
  'return',
  'warranty',
  'refund',
  'product',
  'order_change',
  'complaint',
  'other',
] as const

export type SupportJudgement = {
  category: string
  language: string
  confidence: number
  wantsHuman: boolean
  escalationReason: string | null
  summary: string
  reply: string | null
}

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

export const SYSTEM = `You are the first line of customer service for a group of webshops selling pizza
ovens, massage chairs and kitchen machines in Norway, Sweden, Denmark, Finland and Germany.

Write as the shop, to the customer, in the customer's own language.

THE RULES, in order:

1. Every fact about an order, a parcel or a delivery comes from the CUSTOMER CONTEXT
   block. Never invent an order number, a tracking number, a date or a delivery status.
   If the context does not contain it, you do not know it.
2. Every policy - returns, warranty, shipping, refunds - comes from the KNOWLEDGE BASE
   block. If the answer would need a policy that is not there, do not guess it: ask for
   a human instead. Product facts (what a product is, does, includes, fits, how it is used) also
   come from the KNOWLEDGE BASE; rows marked "from <shop>" are the shop's own product pages
   and you may state them as ours. Never state a price or whether something is in stock,
   even if a row mentions one: say it is on the product page and give the Page link from the row.
3. If the customer is angry, threatening, asking for money back or compensation, raising
   a safety problem, or you are simply unsure, ask for a human.
4. Never promise a refund, a replacement, a discount or a date that is not already a
   fact in the context or a written policy in the knowledge base.
5. When the KNOWLEDGE BASE holds an [example] whose question matches this one, follow its
   answer: it is what a person said the reply should have been.

Answer with the tool. Keep the reply short and plain, no markdown, no headings.
Confidence is your own honest reading of whether this reply is safe to send with nobody
checking it: 1 means certain, below 0.8 means somebody should look.`

const SCHEMA = {
  type: 'object' as const,
  properties: {
    category: { type: 'string', enum: [...CATEGORIES], description: 'What the customer is asking about.' },
    language: { type: 'string', description: 'The language the customer wrote in, as nb, sv, da, fi, de or en.' },
    confidence: { type: 'number', description: 'Between 0 and 1. How safe this reply is to send unchecked.' },
    wantsHuman: { type: 'boolean', description: 'True if a person must handle this.' },
    escalationReason: {
      type: ['string', 'null'] as unknown as string,
      description: 'One sentence on why a person is needed. Null if not.',
    },
    summary: { type: 'string', description: 'One or two sentences an agent can read to catch up.' },
    reply: {
      type: ['string', 'null'] as unknown as string,
      description: 'The reply to the customer, in their language. Null if you cannot answer at all.',
    },
  },
  required: ['category', 'language', 'confidence', 'wantsHuman', 'escalationReason', 'summary', 'reply'],
}

/** The orders, parcels and history as the model sees them. Facts only. */
export function contextBlock(context: CustomerContext): string {
  if (!context.customer) {
    return 'CUSTOMER CONTEXT: no orders found for this email address. You do not know who this is or what they bought.'
  }
  const lines = [
    'CUSTOMER CONTEXT. These are facts from our own system:',
    `Customer: ${context.customer.name || 'name unknown'} (${context.customer.email})`,
    `Country: ${context.customer.country ?? 'unknown'}`,
    `Phone: ${context.customer.phone ?? 'none on file'}`,
    `Earlier support conversations: ${context.previousTickets.length}`,
    '',
    'Orders, newest first:',
  ]
  for (const o of context.orders) {
    const parcel = o.parcels[0]
    lines.push(
      [
        `- ${o.number} from ${o.shop}, placed ${o.placedAt.slice(0, 10)}, status ${o.status}`,
        o.refunded ? ' (REFUNDED in the shop)' : '',
        `\n  bought: ${o.products.map((p) => `${p.quantity} x ${p.name}`).join(', ') || 'unknown'}`,
        parcel ? `\n  parcel: ${parcel.number} with ${parcel.carrier}` : '\n  parcel: none booked yet',
        o.deliveryPhrase ? `\n  delivery: ${o.deliveryPhrase}` : '\n  delivery: not tracked',
      ].join(''),
    )
  }
  if (context.orders.length === 0) lines.push('- none')
  return lines.join('\n')
}

export class NoApiKey extends Error {}

/**
 * Read one message and decide what to say about it.
 *
 * Throws only when it cannot ask at all. Everything else - a refusal, an
 * unparseable answer - comes back as a judgement that wants a human, because a
 * conversation nobody looks at is the one outcome worse than a bad draft.
 */
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

  // A refusal is a 200 with no tool call, so it is checked before the content
  // is read rather than after.
  const call = res.content.find((b) => b.type === 'tool_use')
  if (res.stop_reason === 'refusal' || !call) {
    return {
      category: 'other',
      language: 'en',
      confidence: 0,
      wantsHuman: true,
      escalationReason: 'The assistant would not answer this one.',
      summary: 'The assistant declined to draft a reply.',
      reply: null,
    }
  }

  const out = call.input as Partial<SupportJudgement>
  return {
    category: typeof out.category === 'string' ? out.category : 'other',
    language: typeof out.language === 'string' ? out.language : 'en',
    // A confidence we cannot read is not a high one.
    confidence: typeof out.confidence === 'number' ? out.confidence : 0,
    wantsHuman: out.wantsHuman === true,
    escalationReason: typeof out.escalationReason === 'string' ? out.escalationReason : null,
    summary: typeof out.summary === 'string' ? out.summary : '',
    reply: typeof out.reply === 'string' && out.reply.trim() ? out.reply : null,
  }
}
