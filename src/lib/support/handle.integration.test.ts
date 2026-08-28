import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'
import type { Channel } from './channel'

/**
 * The whole loop, with both outsiders replaced: the assistant is mocked, so no
 * test ever spends Anthropic credits, and the channel is a fake, so nothing
 * reaches the client's live helpdesk. What is real here is the part that
 * decides - the rules, the knowledge scoping and what gets recorded.
 */

const judge = vi.fn()
vi.mock('./agent', async () => {
  const actual = await vi.importActual<typeof import('./agent')>('./agent')
  return { ...actual, judge: (...args: unknown[]) => judge(...args) }
})

const { handleMessage } = await import('./handle')

const TAG = '[ai-support-test]'
const KARI = 'kari.ai@example.invalid'

const sent: { to: string; text: string }[] = []
const notes: { to: string; text: string }[] = []
const channel: Channel = {
  name: 'test',
  async sendMessage(id, text) {
    sent.push({ to: id, text })
  },
  async addInternalNote(id, text) {
    notes.push({ to: id, text })
  },
}

const message = (over: Partial<Parameters<typeof handleMessage>[1]> = {}) => ({
  conversationId: 'T-1',
  customerEmail: KARI,
  customerName: 'Kari Olsen',
  text: 'Hvor er pakken min?',
  subject: 'Hvor er pakken?',
  via: 'email',
  ...over,
})

const judgement = (over = {}) => ({
  category: 'shipping',
  language: 'nb',
  confidence: 0.95,
  wantsHuman: false,
  escalationReason: null,
  summary: 'Asks where the parcel is.',
  reply: 'Hei Kari, pakken er underveis.',
  ...over,
})

async function cleanup() {
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: 'T-' } } })
  await db.knowledgeItem.deleteMany({ where: { title: { startsWith: TAG } } })
  await db.aiSupportRules.deleteMany({ where: { id: 'singleton' } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  sent.length = 0
  notes.length = 0
  judge.mockReset()
  judge.mockResolvedValue(judgement())

  const shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK' } })).id
  await db.order.create({
    data: {
      shopId, externalId: 'ai-1', number: '#5001', placedAt: new Date('2026-08-20'), status: 'completed',
      currency: 'NOK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: 'Kari Olsen', customerEmail: KARI,
    },
  })
})

const setRules = (over: Record<string, unknown>) =>
  db.aiSupportRules.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...over },
    update: over,
  })

describe('handleMessage', () => {
  it('drafts rather than sends by default, and tells the agent it is a draft', async () => {
    const r = await handleMessage(channel, message())

    expect(r.decision).toBe('drafted')
    expect(sent).toHaveLength(0)
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toContain('Hei Kari, pakken er underveis.')
    expect(notes[0].text).toMatch(/not sent/i)
  })

  it('answers the customer once a person has granted that category', async () => {
    await setRules({ mode: 'auto', autoCategories: ['shipping'], minConfidence: 0.8 })

    const r = await handleMessage(channel, message())

    expect(r.decision).toBe('sent')
    expect(sent).toEqual([{ to: 'T-1', text: 'Hei Kari, pakken er underveis.' }])
    expect(notes).toHaveLength(0)
  })

  /**
   * The customer's own words outrank the assistant's judgement, however sure
   * it is. This is the gate that keeps a legal threat away from an automatic
   * reply.
   */
  it('never sends when the customer used a word that must reach a person', async () => {
    await setRules({ mode: 'auto', autoCategories: ['shipping'], escalateKeywords: ['advokat'] })

    const r = await handleMessage(channel, message({ text: 'Jeg kontakter min advokat' }))

    expect(r.decision).toBe('escalated')
    expect(sent).toHaveLength(0)
    expect(notes[0].text).toMatch(/advokat/)
  })

  it('hands over with a reason and a summary when the assistant asks for a person', async () => {
    await setRules({ mode: 'auto', autoCategories: ['shipping'] })
    judge.mockResolvedValue(
      judgement({ wantsHuman: true, escalationReason: 'Wants compensation.', reply: null }),
    )

    const r = await handleMessage(channel, message())

    expect(r.decision).toBe('escalated')
    expect(notes[0].text).toContain('Wants compensation.')
    expect(notes[0].text).toContain('Asks where the parcel is.')
  })

  /** A customer waiting is worse than a bad draft, so a failure still reaches a person. */
  it('hands the conversation over when the assistant cannot be reached at all', async () => {
    judge.mockRejectedValue(new Error('network down'))

    const r = await handleMessage(channel, message())

    expect(r.decision).toBe('escalated')
    expect(notes).toHaveLength(1)
    const row = await db.aiConversation.findFirstOrThrow({ where: { externalTicketId: 'T-1' } })
    expect(row.decision).toBe('escalated')
  })

  it('does nothing at all when switched off', async () => {
    await setRules({ mode: 'off' })

    const r = await handleMessage(channel, message())

    expect(r.decision).toBe('skipped')
    expect(sent).toHaveLength(0)
    expect(notes).toHaveLength(0)
  })

  it('records every outcome for review, with the order it was about', async () => {
    await handleMessage(channel, message())

    const row = await db.aiConversation.findFirstOrThrow({ where: { externalTicketId: 'T-1' } })
    expect(row).toMatchObject({
      customerEmail: KARI,
      question: 'Hvor er pakken min?',
      answer: 'Hei Kari, pakken er underveis.',
      category: 'shipping',
      language: 'nb',
      confidence: 0.95,
      decision: 'drafted',
      orderNumber: '#5001',
    })
  })

  it('gives the assistant the customer orders and the knowledge it is allowed to use', async () => {
    await db.knowledgeItem.create({
      data: { kind: 'policy', title: `${TAG} Returns`, body: 'Fourteen days to return an unopened pizza oven.' },
    })
    await db.knowledgeItem.create({
      data: { kind: 'tone', title: `${TAG} Voice`, body: 'Warm and short.' },
    })

    await handleMessage(channel, message({ text: 'Can I return the pizza oven?' }))

    const passed = judge.mock.calls[0][0] as {
      context: { orders: { number: string }[] }
      knowledge: { title: string }[]
    }
    expect(passed.context.orders[0].number).toBe('#5001')
    const titles = passed.knowledge.map((k) => k.title)
    // The house voice always; the returns policy because it was asked about.
    expect(titles).toContain(`${TAG} Voice`)
    expect(titles).toContain(`${TAG} Returns`)
  })

  it('says nothing to a message with no words in it', async () => {
    const r = await handleMessage(channel, message({ text: '   ' }))
    expect(r.decision).toBe('skipped')
    expect(sent).toHaveLength(0)
    expect(notes).toHaveLength(0)
  })
})
