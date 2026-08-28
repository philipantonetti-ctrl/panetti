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

const SYSTEM = `You are the first line of customer service for a group of webshops selling pizza
ovens, massage chairs and kitchen machines in Norway, Sweden, Denmark, Finland and Germany.

Write as the shop, to the customer, in the customer's own language.

THE RULES, in order:

1. Every fact about an order, a parcel or a delivery comes from the CUSTOMER CONTEXT
   block. Never invent an order number, a tracking number, a date or a delivery status.
   If the context does not contain it, you do not know it.
2. Every policy - returns, warranty, shipping, refunds - comes from the KNOWLEDGE BASE
   block. If the answer would need a policy that is not there, do not guess it: ask for
   a human instead.
3. If the customer is angry, threatening, asking for money back or compensation, raising
   a safety problem, or you are simply unsure, ask for a human.
4. Never promise a refund, a replacement, a discount or a date that is not already a
   fact in the context or a written policy in the knowledge base.

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
}): Promise<SupportJudgement> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new NoApiKey('No ANTHROPIC_API_KEY is configured, so the assistant cannot read tickets.')

  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 })
  const system = [
    { type: 'text' as const, text: SYSTEM, cache_control: { type: 'ephemeral' as const } },
    ...(input.extraInstructions.trim()
      ? [{ type: 'text' as const, text: `HOUSE INSTRUCTIONS:\n${input.extraInstructions.trim()}` }]
      : []),
  ]

  const res = await client.messages.create({
    model: ADVISOR_MODEL,
    max_tokens: 2000,
    system,
    tools: [
      {
        name: 'answer',
        description: 'Your reading of this conversation and what to say about it.',
        input_schema: SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'answer' },
    messages: [
      {
        role: 'user',
        content: [
          contextBlock(input.context),
          '',
          knowledgeBlock(input.knowledge),
          '',
          `THE CUSTOMER WROTE${input.subject ? ` (subject: ${input.subject})` : ''}:`,
          input.message,
        ].join('\n'),
      },
    ],
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
