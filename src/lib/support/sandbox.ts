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
  knowledge: { kind: string; title: string; source: string }[]
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
    knowledge: knowledge.map((k) => ({ kind: k.kind, title: k.title, source: k.source })),
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
