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
