import { db } from '@/lib/db'
import { judge, NoApiKey, pickProducts, type SupportJudgement } from './agent'
import { escalateToHuman, getCustomerContext, type Channel, type TranscriptMessage } from './channel'
import {
  askedSoFar, BURST_WAIT_MS, conversationStart, handoverLine, HANDOVER_LINES, humanTookOver, normalise,
  onlyTheCustomer, type OwnMessages, OWN_TEXT_WINDOW_MS, REPLY_CAP, since, splitForJudge, supersededBy, turnsOf,
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
  decision: 'sent' | 'drafted' | 'escalated' | 'skipped' | 'superseded' | 'failed'
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
 * What the assistant itself put in this chat, so an agent message can be told
 * from a person's.
 *
 * The ids are the real answer and carry no time limit: the channel gave us
 * that id when it took the message, nobody else can write one, and a chat left
 * for twenty minutes is still our chat. The texts are the fallback for a
 * channel that numbers nothing, and they are only ever text the assistant
 * actually SENT or is in the middle of sending. A DRAFTED answer is a
 * suggestion a person may paste verbatim - counting that as ours would leave
 * the assistant writing over the very person it handed the chat to.
 */
async function ownMessages(sessionId: string, now: Date): Promise<OwnMessages> {
  const rows = await db.aiConversation.findMany({
    where: { sessionId },
    select: { externalReplyId: true, answer: true, decision: true, createdAt: true },
  })
  const fresh = new Date(now.getTime() - OWN_TEXT_WINDOW_MS)
  return {
    ids: new Set(rows.map((r) => r.externalReplyId).filter((id): id is string => Boolean(id))),
    texts: new Set([
      ...rows
        .filter((r) => SPOKEN.has(r.decision) && r.answer && r.createdAt >= fresh)
        .map((r) => normalise(r.answer as string)),
      ...Object.values(HANDOVER_LINES).map(normalise),
    ]),
  }
}

/**
 * Decisions whose answer reached the customer, or is on the wire right now.
 * `sending` exists for the gap between handing the text to the channel and
 * learning the id it was given: our own reply comes back through the same
 * webhook within that gap, and without this the assistant reads itself as a
 * person and goes quiet on a chat it had just answered correctly.
 */
const SPOKEN = new Set(['sent', 'sending'])

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

  let session = await db.aiChatSession.upsert({
    where: { source_externalTicketId: { source: channel.name, externalTicketId: incoming.conversationId } },
    create: {
      shopId: incoming.shopId,
      source: channel.name,
      externalTicketId: incoming.conversationId,
      customerEmail: incoming.customerEmail,
    },
    update: { ...(incoming.customerEmail ? { customerEmail: incoming.customerEmail } : {}) },
  })

  /**
   * Stand out of a chat, and say so on the review page - once.
   *
   * Silence with no record is what made this bug invisible for two days: a
   * chat the assistant deliberately left alone looked exactly like a chat that
   * never reached us. One line per conversation and not one per message,
   * because a person answering twenty messages is still one chat the assistant
   * stood out of. Nothing is written when the transcript could not be read,
   * since then we do not know which conversation this is.
   */
  const standDown = async (reason: string, current: TranscriptMessage[]): Promise<ChatResult> => {
    if (current.length === 0) return skip(reason)
    const said = await db.aiConversation.count({
      where: { sessionId: session.id, decision: 'skipped', externalMessageId: { in: current.map((m) => m.id) } },
    })
    if (said === 0) {
      await db.aiConversation
        .create({
          data: {
            source: channel.name,
            externalTicketId: incoming.conversationId,
            externalMessageId: incoming.messageId,
            sessionId: session.id,
            shopId: incoming.shopId,
            customerEmail: incoming.customerEmail,
            question: incoming.text.trim().slice(0, 5000),
            decision: 'skipped',
            escalationReason: reason,
          },
        })
        .catch(() => {})
    }
    return skip(reason)
  }

  // An agent message: ours comes back through the same trigger and is
  // ignored; anyone else's is a person, and the assistant goes quiet for the
  // rest of this conversation.
  if (incoming.fromAgent) {
    const own = await ownMessages(session.id, now())
    if (own.ids.has(incoming.messageId) || own.texts.has(normalise(incoming.text))) {
      return skip('The assistant’s own message.')
    }
    await db.aiChatSession.update({ where: { id: session.id }, data: { status: 'human' } })
    return skip('A person is on this chat.')
  }

  const text = incoming.text.trim()
  if (!text) return skip('The message had no text.')

  const readTranscript = async (): Promise<TranscriptMessage[]> => {
    try {
      return channel.transcript ? await channel.transcript(incoming.conversationId) : []
    } catch {
      // A transcript we could not read is not a reason to leave the customer
      // waiting: the delivered text alone is answered below. It IS a reason to
      // change nothing about who owns the chat - an empty transcript must
      // never read as a conversation nobody is in.
      return []
    }
  }

  /**
   * A chat a person joined, or one the assistant handed over, belongs to them
   * - for the rest of THAT conversation.
   *
   * A chat widget keeps one conversation per visitor for ever, so without an
   * end the latch is permanent: live ticket 241324637 was answered by a person
   * on 24 September, and the customer's new question on 25 September was
   * skipped in silence with nothing written anywhere to say why. The chat was
   * working; it just looked dead.
   *
   * So the latch is released on all three of these at once: the ticket really
   * has been quiet for six hours (NEW_CONVERSATION_GAP_MS, measured against
   * this helpdesk's own reply times), the stretch since that silence holds the
   * customer and nobody else, and there is a transcript to prove it. A
   * handover a moment ago has no silence behind it and stays exactly as it is.
   */
  if (session.status !== 'ai') {
    const seen = await readTranscript()
    const start = conversationStart(seen)
    const current = since(seen, start)
    const afterASilence = start !== null && seen.length > 0 && start !== seen[0].at
    if (!(afterASilence && onlyTheCustomer(current, await ownMessages(session.id, now())))) {
      return standDown(
        session.status === 'human' ? 'A person is on this chat.' : 'The assistant has already handed this chat over.',
        current,
      )
    }
    session = await db.aiChatSession.update({
      where: { id: session.id },
      data: { status: 'ai', replies: 0, handedOverAt: null, handoverReason: null },
    })
  }

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

  /**
   * Whether a later customer message will really be answered by its own run.
   *
   * Standing down is only safe when somebody else has taken the message: the
   * claim row is that proof. Without it a burst can be dropped in full - this
   * run defers to a later message whose own run never happened - and the
   * channel does not redeliver, so nothing ever answers the customer.
   */
  const answeredElsewhere = async (messageId: string): Promise<boolean> =>
    (await db.aiConversation.count({
      where: { source: channel.name, externalMessageId: messageId, NOT: { id: claim.id } },
    })) > 0

  /** A reason to stand down now, re-read from the channel. Null means carry on. */
  const noLongerOurs = async (): Promise<{ decision: ChatResult['decision']; reason: string } | null> => {
    const seen = await readTranscript()
    const later = supersededBy(seen, incoming.messageId)
    if (later && (await answeredElsewhere(later))) {
      return { decision: 'superseded', reason: 'The customer wrote again; the later message answers.' }
    }
    if (humanTookOver(since(seen, conversationStart(seen)), await ownMessages(session.id, now()))) {
      await db.aiChatSession.update({ where: { id: session.id }, data: { status: 'human' } }).catch(() => {})
      return { decision: 'skipped', reason: 'A person is on this chat.' }
    }
    return null
  }

  // Let the burst finish, then read all of it.
  await wait(BURST_WAIT_MS)
  const transcript = await readTranscript()
  // Only the conversation the customer is in NOW. A person who answered this
  // same ticket yesterday answered a different conversation, and the ticket
  // number is the only thing the two have in common.
  const current = since(transcript, conversationStart(transcript))
  const later = supersededBy(transcript, incoming.messageId)
  if (later && (await answeredElsewhere(later))) {
    return outcome('superseded', {}, 'The customer wrote again; the later message answers.')
  }
  const own = await ownMessages(session.id, now())
  if (humanTookOver(current, own)) {
    await db.aiChatSession.update({ where: { id: session.id }, data: { status: 'human' } })
    return outcome('skipped', {}, 'A person is on this chat.')
  }

  const rules = deps.rules ?? (await loadRules())
  if (rules.mode === 'off') return outcome('skipped', {}, 'The assistant is switched off.')

  // The whole burst is the question, and it is what the review row shows.
  // `own` is passed in so a reply of ours the channel stamped as automatic is
  // still shown to the model as its own previous turn.
  const turns = turnsOf(current, own)
  const { history, message } = splitForJudge(turns, text)
  const asked = { question: message.slice(0, 5000) }

  /**
   * A handover must reach a person even when the customer-facing line fails.
   * The note is what an agent actually reads, so a refused chat message never
   * takes the note, the tag or the session flag down with it.
   */
  const handover = async (reason: string, judgement: SupportJudgement | null): Promise<ChatResult> => {
    // Before the first judgement no language is known, so the line is English.
    const language = judgement?.language ?? session.language
    const trouble: string[] = []
    let replyId: string | null = null
    // Draft mode never speaks to the customer, not even to say a person is coming.
    if (rules.mode === 'auto') {
      try {
        replyId = await channel.sendMessage(incoming.conversationId, handoverLine(language))
      } catch (e) {
        trouble.push(`the customer was not told a person is coming (${why(e)})`)
      }
    }
    try {
      await escalateToHuman(channel, incoming.conversationId, reason, judgement?.summary ?? 'The assistant handed this chat over.', judgement?.reply ?? null)
    } catch (e) {
      trouble.push(`the note could not be left (${why(e)})`)
    }
    if (channel.tag) await channel.tag(incoming.conversationId, 'ai-handover').catch(() => {})
    await db.aiChatSession.update({
      where: { id: session.id },
      data: { status: 'handed_over', handedOverAt: now(), handoverReason: reason, ...(language ? { language } : {}) },
    }).catch(() => {})
    const told = trouble.length ? `${reason} But ${trouble.join(', and ')}.` : reason
    return outcome(trouble.length ? 'failed' : 'escalated', { ...asked, ...(judgement ? recordable(judgement) : {}), externalReplyId: replyId }, told)
  }

  if (session.replies >= REPLY_CAP) {
    return handover(`The assistant has already replied eight times in this chat, so a person takes over.`, null)
  }

  const context = incoming.customerEmail
    ? await getCustomerContext(incoming.customerEmail)
    : { customer: null, orders: [], previousTickets: [] }
  const knowledge = await knowledgeFor(askedSoFar(history, message), {
    shopId: incoming.shopId,
    country: context.customer?.country ?? null,
    language: session.language,
    skus: context.orders.flatMap((o) => o.products.map((p) => p.name)).slice(0, 20),
  }, { pickPages: pickProducts })

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

  const judged = { ...asked, ...recordable(judgement), orderNumber: context.orders[0]?.number ?? null }

  if (verdict.action === 'send' && judgement.reply) {
    // Judging took ten to forty seconds. The customer may have written again
    // in that time, or a colleague may have stepped in; neither was true when
    // the burst wait ended, and answering over either of them is worse than
    // saying nothing.
    const gone = await noLongerOurs()
    if (gone) return outcome(gone.decision, judged, gone.reason)

    // Written down BEFORE the wire, and marked as spoken, for two reasons: a
    // channel that refuses the reply must not also throw the answer away, and
    // our own reply arrives back through this same webhook within
    // milliseconds - before `sendMessage` has even returned its id.
    await db.aiConversation.update({ where: { id: claim.id }, data: { ...judged, decision: 'sending' } }).catch(() => {})

    let replyId: string | null = null
    try {
      replyId = await channel.sendMessage(incoming.conversationId, judgement.reply)
    } catch (e) {
      return outcome('failed', judged, `The answer was written but the channel refused it (${why(e)}).`)
    }
    await db.aiChatSession.update({
      where: { id: session.id },
      data: { replies: { increment: 1 }, language: judgement.language },
    }).catch(() => {})
    return outcome('sent', { ...judged, externalReplyId: replyId }, null)
  }

  if (verdict.action === 'escalate') {
    return handover(judgement.escalationReason ?? verdict.reason ?? 'A person should handle this.', judgement)
  }

  // Draft: a suggestion for whoever answers, and the session stays open so
  // the next message is drafted too. Nothing reaches the customer here, so a
  // failed note is recorded and the answer kept rather than lost.
  const reason = verdict.reason ?? 'Waiting for a person to send it.'
  await db.aiConversation.update({ where: { id: claim.id }, data: judged }).catch(() => {})
  try {
    await escalateToHuman(channel, incoming.conversationId, reason, judgement.summary, judgement.reply)
  } catch (e) {
    return outcome('failed', judged, `${reason} But the note could not be left (${why(e)}).`)
  }
  await db.aiChatSession.update({ where: { id: session.id }, data: { language: judgement.language } }).catch(() => {})
  return outcome('drafted', judged, reason)
}

/** An error in the few words that fit on a review row. */
function why(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 200) : 'unknown error'
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
