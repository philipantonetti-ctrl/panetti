import { db } from '@/lib/db'
import { judge, NoApiKey } from './agent'
import { escalateToHuman, getCustomerContext, type Channel, type IncomingMessage } from './channel'
import { knowledgeFor } from './knowledge'
import { decide, DEFAULT_RULES, type RulesConfig } from './rules'

/**
 * One conversation, from arrival to answer.
 *
 *   customer -> channel -> here -> the AI -> back through the channel
 *
 * The channel is an interface, so this file never learns which helpdesk it is
 * talking to. That is Philip's requirement made structural rather than
 * promised: replacing Gorgias means writing another adapter, not touching any
 * of this.
 *
 * Every outcome is recorded, sent or not. The reason to keep them is to find
 * out whether the assistant can be trusted with more, and a log that kept only
 * the successes could never answer that.
 */

export type HandleResult = {
  decision: 'sent' | 'drafted' | 'escalated' | 'skipped'
  reason: string | null
  conversationId: string
}

async function rules(): Promise<RulesConfig> {
  const row = await db.aiSupportRules.findUnique({ where: { id: 'singleton' } })
  if (!row) return DEFAULT_RULES
  return {
    mode: row.mode,
    autoCategories: row.autoCategories,
    escalateKeywords: row.escalateKeywords,
    minConfidence: row.minConfidence,
  }
}

export async function handleMessage(channel: Channel, message: IncomingMessage): Promise<HandleResult> {
  const config = await rules()
  const text = message.text.trim()

  // Nothing to read is nothing to answer. Recorded as skipped rather than
  // escalated: an empty automated ping is not a customer waiting.
  if (!text) return { decision: 'skipped', reason: 'The message had no text.', conversationId: message.conversationId }
  if (config.mode === 'off') {
    return { decision: 'skipped', reason: 'The assistant is switched off.', conversationId: message.conversationId }
  }

  const context = message.customerEmail
    ? await getCustomerContext(message.customerEmail)
    : { customer: null, orders: [], previousTickets: [] }

  // Scoped to what this customer actually bought, so a Norwegian policy is
  // never quoted to a German and a product manual reaches only its own SKU.
  const newest = context.orders[0]
  const knowledge = await knowledgeFor(`${message.subject ?? ''} ${text}`, {
    country: context.customer?.country ?? null,
    skus: context.orders.flatMap((o) => o.products.map((p) => p.name)).slice(0, 20),
  })

  let judgement
  try {
    judgement = await judge({
      message: text,
      subject: message.subject,
      context,
      knowledge,
      extraInstructions: (await db.aiSupportRules.findUnique({ where: { id: 'singleton' } }))?.extraInstructions ?? '',
    })
  } catch (e) {
    // The assistant being unreachable must never swallow a customer's message.
    // It goes to a person, with the reason on the ticket.
    const why = e instanceof NoApiKey ? e.message : 'The assistant could not be reached.'
    await escalateToHuman(channel, message.conversationId, why, 'The assistant failed before reading this.', null)
    await record(message, null, 'escalated', why, null, newest?.number ?? null)
    return { decision: 'escalated', reason: why, conversationId: message.conversationId }
  }

  const verdict = decide(
    { category: judgement.category, confidence: judgement.confidence, wantsHuman: judgement.wantsHuman },
    text,
    config,
  )

  if (verdict.action === 'send' && judgement.reply) {
    await channel.sendMessage(message.conversationId, judgement.reply)
    await record(message, judgement, 'sent', null, judgement.reply, newest?.number ?? null)
    return { decision: 'sent', reason: null, conversationId: message.conversationId }
  }

  // Everything else reaches a person, and the difference between the two is
  // only what the note says: a draft to check, or a handover with a reason.
  const reason =
    verdict.action === 'escalate'
      ? (judgement.escalationReason ?? verdict.reason ?? 'A person should handle this.')
      : (verdict.reason ?? 'Waiting for a person to send it.')

  await escalateToHuman(channel, message.conversationId, reason, judgement.summary, judgement.reply)
  const decision = verdict.action === 'escalate' ? 'escalated' : 'drafted'
  await record(message, judgement, decision, reason, judgement.reply, newest?.number ?? null)
  return { decision, reason, conversationId: message.conversationId }
}

/** The review record. Best-effort: bookkeeping must not undo a sent reply. */
async function record(
  message: IncomingMessage,
  judgement: { category: string; language: string; confidence: number; summary: string } | null,
  decision: string,
  escalationReason: string | null,
  answer: string | null,
  orderNumber: string | null,
): Promise<void> {
  await db.aiConversation
    .create({
      data: {
        externalTicketId: message.conversationId,
        customerEmail: message.customerEmail,
        question: message.text.slice(0, 5000),
        answer,
        category: judgement?.category ?? null,
        language: judgement?.language ?? null,
        confidence: judgement?.confidence ?? null,
        decision,
        escalationReason,
        summary: judgement?.summary ?? null,
        orderNumber,
      },
    })
    .catch(() => {})
}
