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
