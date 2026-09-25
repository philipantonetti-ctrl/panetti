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
  // The picker is a second model call; in here it picks nothing, so no test spends credits or waits on the network.
  return { ...actual, judge: (...args: unknown[]) => judge(...args), pickProducts: async () => [] }
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
  async sendMessage(id, text) { sent.push({ to: id, text }); return String(9000 + sent.length) },
  async addInternalNote(id, text) { notes.push({ to: id, text }) },
  async transcript() { return transcript },
  async tag(id, tag) { tags.push({ to: id, tag }) },
}
const m = (id: number, fromAgent: boolean, text: string): TranscriptMessage => ({
  id: String(id), fromAgent, text, at: `2026-09-09T10:00:${String(id).padStart(2, '0')}Z`,
})

/** The same, with the time said out loud: a chat that spans days needs one. */
const at = (id: number, fromAgent: boolean, text: string, when: string): TranscriptMessage => ({
  id: String(id), fromAgent, text, at: when,
})

const session = () => db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })

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
  await db.knowledgeItem.deleteMany({ where: { title: { startsWith: TAG } } })
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

  it("lets the later delivery answer a burst, once that delivery has taken the message", async () => {
    transcript = [m(1, false, 'Hej'), m(2, false, 'Hvor er min pakke?'), m(3, false, '14689')]
    // The later message's own run claims it first, exactly as it would live.
    await db.aiConversation.create({
      data: { source: 'test', externalTicketId: 'C-1', externalMessageId: '3', shopId, question: '14689', decision: 'pending' },
    })
    const r = await handleChatMessage(incoming({ messageId: '2' }), deps())
    expect(r.decision).toBe('superseded')
    expect(sent).toHaveLength(0)
    expect(judge).not.toHaveBeenCalled()
  })

  /**
   * Standing down is only safe when somebody else really has the message. If
   * the later message's own webhook never arrived, deferring to it drops the
   * whole burst: the channel does not redeliver and the customer waits for ever.
   */
  it("answers the burst rather than dropping it when the later message was never taken", async () => {
    transcript = [m(1, false, 'Hej'), m(2, false, 'Hvor er min pakke?'), m(3, false, '14689')]
    const r = await handleChatMessage(incoming({ messageId: '2' }), deps())
    expect(r.decision).toBe('sent')
    expect(sent).toHaveLength(1)
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

  /**
   * Measured 2026-09-21: the Norwegian widget posts "Vi er tilbake om ca. 9
   * minutter." a millisecond after the customer's first message, in 25 of its
   * 26 newest chats. Read as a person, it silenced the assistant before its
   * first word.
   */
  it("answers past the widget's automatic line, and keeps that line out of the conversation", async () => {
    transcript = [
      m(1, false, 'Hej'),
      { ...m(2, true, 'Tak fordi du skriver! Vi er tilbage om ca. 9 minutter.'), automatic: true },
      m(3, false, 'Hvor er min pakke?'),
    ]
    const r = await handleChatMessage(incoming({ messageId: '3' }), deps())

    expect(r.decision).toBe('sent')
    expect(judge.mock.calls[0][0].message).toBe('Hej\nHvor er min pakke?')
    expect(judge.mock.calls[0][0].history).toEqual([])
    const session = await db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })
    expect(session.status).toBe('ai')
  })

  /**
   * The chat widget keeps ONE conversation for a visitor for ever. Live ticket
   * 241324637: a question on 24 September, four replies from Selena, and a new
   * question on 25 September that the assistant never answered, because the
   * latch from the day before still held. Nothing was written anywhere, so the
   * review page said "Nothing here yet" while the chat was plainly working.
   */
  it('takes a silent chat back when the customer returns the next day with a new question', async () => {
    const yesterday = [
      at(1, false, 'Hvor mange grader kan Pizzetta Pro komme op paa?', '2026-09-24T07:58:00Z'),
      at(2, true, 'Hej, Selena her! Den naar 450 grader.', '2026-09-24T08:10:00Z'),
    ]
    transcript = yesterday
    await handleChatMessage(
      incoming({ messageId: '2', fromAgent: true, text: 'Hej, Selena her! Den naar 450 grader.' }),
      deps(),
    )
    expect((await session()).status).toBe('human')

    transcript = [...yesterday, at(3, false, 'Hvad vejer den?', '2026-09-25T09:21:00Z')]
    const r = await handleChatMessage(incoming({ messageId: '3', text: 'Hvad vejer den?' }), deps())

    expect(r.decision).toBe('sent')
    expect(sent).toEqual([{ to: 'C-1', text: 'Din pakke er på vej.' }])
    // Yesterday was a different conversation and is not replayed as this one.
    expect(judge.mock.calls[0][0].history).toEqual([])
    expect(judge.mock.calls[0][0].message).toBe('Hvad vejer den?')
    expect(await session()).toMatchObject({ status: 'ai', replies: 1 })
  })

  it('stays out of a chat the person answered five hours ago, which is still the same conversation', async () => {
    const earlier = [
      at(1, false, 'Hvor mange grader?', '2026-09-24T07:58:00Z'),
      at(2, true, 'Hej, Selena her!', '2026-09-24T08:10:00Z'),
    ]
    transcript = earlier
    await handleChatMessage(incoming({ messageId: '2', fromAgent: true, text: 'Hej, Selena her!' }), deps())

    transcript = [...earlier, at(3, false, 'Er du der?', '2026-09-24T13:05:00Z')]
    const r = await handleChatMessage(incoming({ messageId: '3', text: 'Er du der?' }), deps())

    expect(r.decision).toBe('skipped')
    expect(sent).toHaveLength(0)
    expect(judge).not.toHaveBeenCalled()
  })

  it('does not take back a chat it handed over itself a moment ago', async () => {
    judge.mockResolvedValue(judgement({ wantsHuman: true, escalationReason: 'Asks for a person.' }))
    transcript = [m(1, false, 'Hej'), m(2, false, 'Jeg vil tale med et menneske')]
    await handleChatMessage(incoming({ text: 'Jeg vil tale med et menneske' }), deps())
    expect((await session()).status).toBe('handed_over')

    transcript = [...transcript, m(5, false, 'Hallo?')]
    const r = await handleChatMessage(incoming({ messageId: '5', text: 'Hallo?' }), deps())
    expect(r.decision).toBe('skipped')
    expect(judge).toHaveBeenCalledTimes(1)
  })

  /**
   * Silence has to be visible. Without a line on the review page, a chat the
   * assistant deliberately stood out of looks exactly like a chat that never
   * reached us - which is the whole reason this bug took two days to see.
   */
  it('writes one line saying it stood out of a chat a person is answering, and only one', async () => {
    // The person writes FIRST, which is how it happens live: the latch is set
    // by the agent's own webhook, so no customer message was ever claimed and
    // the whole chat had nothing written about it anywhere.
    transcript = [m(1, true, 'Hej, Selena her!')]
    await handleChatMessage(incoming({ messageId: '1', fromAgent: true, text: 'Hej, Selena her!' }), deps())
    expect(await db.aiConversation.count({ where: { externalTicketId: 'C-1' } })).toBe(0)

    transcript = [...transcript, m(2, false, 'Hvor er min pakke?')]
    const first = await handleChatMessage(incoming({ messageId: '2' }), deps())
    expect(first.decision).toBe('skipped')
    const rows = await db.aiConversation.findMany({ where: { externalTicketId: 'C-1' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: 'skipped', question: 'Hvor er min pakke?', shopId })
    expect(rows[0].escalationReason).toMatch(/person/i)

    transcript = [...transcript, m(3, false, 'Hallo?')]
    const again = await handleChatMessage(incoming({ messageId: '3', text: 'Hallo?' }), deps())
    expect(again.decision).toBe('skipped')
    expect(await db.aiConversation.count({ where: { externalTicketId: 'C-1' } })).toBe(1)
  })

  /**
   * Live on 2026-09-25, ticket 241324637: a customer asked, a colleague
   * answered twice, and the review page stayed empty - because a row was only
   * ever written when the CUSTOMER wrote. "Someone replied there and nothing
   * shows here" is the whole complaint, and it was right.
   */
  it('records the chat the moment a person answers it, without waiting for the customer to write again', async () => {
    transcript = [m(1, false, 'Hvor er min pakke?'), m(2, true, 'Hej, Selena her! Den er paa vej.')]
    const r = await handleChatMessage(
      incoming({ messageId: '2', fromAgent: true, text: 'Hej, Selena her! Den er paa vej.' }),
      deps(),
    )

    expect(r.decision).toBe('skipped')
    const rows = await db.aiConversation.findMany({ where: { externalTicketId: 'C-1' } })
    expect(rows).toHaveLength(1)
    // The QUESTION is the customer's, not the colleague's line.
    expect(rows[0]).toMatchObject({ decision: 'skipped', question: 'Hvor er min pakke?', shopId })
    expect(rows[0].escalationReason).toMatch(/person/i)
    expect((await session()).status).toBe('human')
  })

  it('says it once however many times the person writes', async () => {
    transcript = [m(1, false, 'Hvor er min pakke?'), m(2, true, 'Hej!')]
    await handleChatMessage(incoming({ messageId: '2', fromAgent: true, text: 'Hej!' }), deps())
    transcript = [...transcript, m(3, true, 'Den er paa vej.'), m(4, true, 'Har du flere spoergsmaal?')]
    await handleChatMessage(incoming({ messageId: '3', fromAgent: true, text: 'Den er paa vej.' }), deps())
    await handleChatMessage(incoming({ messageId: '4', fromAgent: true, text: 'Har du flere spoergsmaal?' }), deps())

    expect(await db.aiConversation.count({ where: { externalTicketId: 'C-1' } })).toBe(1)
  })

  /**
   * A colleague answering two seconds after the customer arrives, while that
   * customer's message is still in its burst wait. Both runs want to say the
   * same thing about the same chat; one line is the right number.
   */
  it('leaves the line to the run already in flight on the same conversation', async () => {
    transcript = [m(1, false, 'Hvor er min pakke?'), m(2, true, 'Hej, Selena her!')]
    const session2 = await db.aiChatSession.create({
      data: { shopId, source: 'test', externalTicketId: 'C-1' },
    })
    await db.aiConversation.create({
      data: {
        source: 'test', externalTicketId: 'C-1', externalMessageId: '1', sessionId: session2.id, shopId,
        question: 'Hvor er min pakke?', decision: 'pending',
      },
    })

    await handleChatMessage(incoming({ messageId: '2', fromAgent: true, text: 'Hej, Selena her!' }), deps())

    const rows = await db.aiConversation.findMany({ where: { externalTicketId: 'C-1' } })
    expect(rows.map((r) => r.decision)).toEqual(['pending'])
  })

  it('writes nothing for a chat a person opened, where no customer has asked anything', async () => {
    transcript = [m(1, true, 'Hej! Kan vi hjaelpe med noget?')]
    await handleChatMessage(incoming({ messageId: '1', fromAgent: true, text: 'Hej! Kan vi hjaelpe med noget?' }), deps())
    expect(await db.aiConversation.count({ where: { externalTicketId: 'C-1' } })).toBe(0)
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

  /**
   * The customer asks, is answered, goes away, and comes back twenty minutes
   * later. Recognising our own reply by its text inside a fifteen-minute
   * window made that chat go silent for good, with nothing written anywhere to
   * say why. The id the channel gave the reply does not expire.
   */
  it("still knows its own reply twenty minutes later, so a quiet chat is not silently abandoned", async () => {
    const start = new Date('2026-09-09T10:00:00Z')
    const later = new Date(start.getTime() + 20 * 60_000)
    await handleChatMessage(incoming(), deps({ now: () => start }))
    const reply = await db.aiConversation.findFirstOrThrow({ where: { externalMessageId: '2' } })
    expect(reply.externalReplyId).toBe('9001')

    // Our own reply comes back through the same trigger, long after the window.
    const ours = await handleChatMessage(
      incoming({ messageId: '9001', fromAgent: true, text: 'Din pakke er på vej.' }),
      deps({ now: () => later }),
    )
    expect(ours.reason).toMatch(/own message/)
    expect((await db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })).status).toBe('ai')
  })

  /**
   * The hand-over note hands an agent a suggested reply and invites them to
   * send it. Counting a DRAFTED answer as ours meant the agent sending it was
   * read as the assistant, and the assistant kept writing in a chat a person
   * was already handling.
   */
  it("treats an agent sending the suggested reply as a person, not as itself", async () => {
    judge.mockResolvedValue(judgement({ category: 'product' }))
    const drafted = await handleChatMessage(incoming(), deps())
    expect(drafted.decision).toBe('drafted')
    expect(sent).toHaveLength(0)

    const person = await handleChatMessage(
      incoming({ messageId: '7', fromAgent: true, text: 'Din pakke er på vej.' }),
      deps(),
    )
    expect(person.reason).toMatch(/person/)
    expect((await db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })).status).toBe('human')
  })

  it("keeps the answer and says what went wrong when the channel refuses the reply", async () => {
    const broken = { ...channel, sendMessage: async () => { throw new Error('Gorgias responded 401') } }
    const r = await handleChatMessage(incoming(), deps({ channel: broken }))

    expect(r.decision).toBe('failed')
    expect(r.reason).toMatch(/401/)
    const row = await db.aiConversation.findFirstOrThrow({ where: { externalMessageId: '2' } })
    // The model was paid for; the answer is kept so an agent can still use it.
    expect(row.answer).toBe('Din pakke er på vej.')
    expect(row.decision).toBe('failed')
  })

  it("still leaves the note when the customer could not be told a person is coming", async () => {
    judge.mockResolvedValue(judgement({ wantsHuman: true }))
    const broken = { ...channel, sendMessage: async () => { throw new Error('Gorgias responded 500') } }
    const r = await handleChatMessage(incoming(), deps({ channel: broken }))

    expect(r.decision).toBe('failed')
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toMatch(/Handed over by the assistant/)
    expect(tags).toEqual([{ to: 'C-1', tag: 'ai-handover' }])
    expect((await db.aiChatSession.findFirstOrThrow({ where: { externalTicketId: 'C-1' } })).status).toBe('handed_over')
  })

  /**
   * Judging takes ten to forty seconds. Nobody had written when the burst wait
   * ended; by the time there is an answer, a colleague may be mid-sentence.
   */
  it("says nothing when a person steps in while the model is still thinking", async () => {
    judge.mockImplementation(async () => {
      transcript = [...transcript, m(5, true, 'Hej, Selena her. Jeg overtager.')]
      return judgement()
    })
    const r = await handleChatMessage(incoming(), deps())

    expect(r.decision).toBe('skipped')
    expect(sent).toHaveLength(0)
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

describe('what retrieval reads on a chat', () => {
  it("reads the customer's earlier turns too, so a follow-up that names nothing still finds the product", async () => {
    await db.knowledgeItem.create({
      data: {
        kind: 'product', title: `${TAG} Panetti Pizzetta Pro`, shopId, source: 'website',
        body: 'Product: Panetti Pizzetta Pro (SKU PANPIZPRO)\nPage: https://panetti.dk/p/\n\nOp til 450 °C på 15 minutter.',
        sourceKey: `website:${shopId}:product:11173:0`, sourceUrl: 'https://panetti.dk/p/',
      },
    })
    judge.mockResolvedValue(judgement({ category: 'shipping', reply: 'Fin ovn!' }))
    transcript = [m(1, false, 'Jeg har en Pizzetta Pro')]
    await handleChatMessage(incoming({ messageId: '1', text: 'Jeg har en Pizzetta Pro' }), deps())
    expect(sent.map((s) => s.text)).toEqual(['Fin ovn!'])

    transcript = [...transcript, m(2, true, 'Fin ovn!'), m(3, false, 'Hvor mange grader bliver den?')]
    await handleChatMessage(incoming({ messageId: '3', text: 'Hvor mange grader bliver den?' }), deps())

    expect(judge).toHaveBeenCalledTimes(2)
    const second = judge.mock.calls[1][0]
    expect(second.message).toBe('Hvor mange grader bliver den?')
    expect(second.knowledge.map((k: { title: string }) => k.title)).toContain(`${TAG} Panetti Pizzetta Pro`)
    // The review row still shows what was just written, not the joined search text.
    const rows = await db.aiConversation.findMany({ where: { externalTicketId: 'C-1' }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => r.question)).toEqual(['Jeg har en Pizzetta Pro', 'Hvor mange grader bliver den?'])
  })
})
