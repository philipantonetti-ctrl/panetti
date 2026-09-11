import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

/**
 * The practice room. The judge is mocked (no credits spent), nothing has a
 * channel to reach, and every run is filed under source = sandbox so the
 * review counts never mistake practice for customers.
 */
const judge = vi.fn()
vi.mock('./agent', async () => {
  const actual = await vi.importActual<typeof import('./agent')>('./agent')
  return { ...actual, judge: (...args: unknown[]) => judge(...args) }
})

const { runSandboxTurn } = await import('./sandbox')

const TAG = '[ai-sandbox-test]'
const EMAIL = 'mette.sandbox@example.invalid'

const judgement = (over = {}) => ({
  category: 'shipping', language: 'da', confidence: 0.95, wantsHuman: false,
  escalationReason: null, summary: 'Asks where the parcel is.', reply: 'Din pakke er på vej.', ...over,
})

async function cleanup() {
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: 'sandbox:test-' } } })
  await db.knowledgeItem.deleteMany({ where: { title: { startsWith: TAG } } })
  await db.knowledgeItem.deleteMany({ where: { sourceKey: { startsWith: TAG } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

let shopId = ''
beforeEach(async () => {
  await cleanup()
  judge.mockReset()
  judge.mockResolvedValue(judgement())
  shopId = (await db.shop.create({ data: { name: `Panetti Denmark ${TAG}`, currency: 'DKK' } })).id
  await db.order.create({
    data: {
      shopId, externalId: 'sb-1', number: '14689', placedAt: new Date('2026-09-06'), status: 'completed',
      currency: 'DKK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: 'Mette', customerEmail: EMAIL,
    },
  })
})

const rules = { mode: 'draft', autoCategories: ['shipping'], escalateKeywords: [], minConfidence: 0.8, extraInstructions: '' }

describe('runSandboxTurn', () => {
  it('judges as if live even while the rules say draft, and records the run as sandbox', async () => {
    const r = await runSandboxTurn(
      { shopId, customerEmail: EMAIL, sessionKey: 'test-1', messages: [{ role: 'user', text: 'Hvor er min pakke?' }] },
      { rules },
    )

    expect(r.action).toBe('send')
    expect(r.reply).toBe('Din pakke er på vej.')
    expect(r.saw.orders.map((o) => o.number)).toEqual(['14689'])
    const row = await db.aiConversation.findUniqueOrThrow({ where: { id: r.conversationId } })
    expect(row).toMatchObject({ source: 'sandbox', externalTicketId: 'sandbox:test-1', shopId, decision: 'sent', question: 'Hvor er min pakke?' })
  })

  it('passes the earlier turns as history and says it is not the first reply', async () => {
    await runSandboxTurn(
      {
        shopId, customerEmail: null, sessionKey: 'test-2',
        messages: [
          { role: 'user', text: 'Hej' },
          { role: 'assistant', text: 'Hej, jeg er Panettis assistent.' },
          { role: 'user', text: 'Kan I sende til Bornholm?' },
        ],
      },
      { rules },
    )

    const call = judge.mock.calls[0][0]
    expect(call.history).toEqual([
      { role: 'user', text: 'Hej' },
      { role: 'assistant', text: 'Hej, jeg er Panettis assistent.' },
    ])
    expect(call.message).toBe('Kan I sende til Bornholm?')
    expect(call.chat).toEqual({ firstReply: false, customerKnown: false })
  })

  it('reports why it would not send, and offers the shop-scoped knowledge it used', async () => {
    await db.knowledgeItem.create({
      data: { kind: 'policy', title: `${TAG} Levering til Bornholm`, body: 'Vi sender til Bornholm med Bring.', shopId, language: 'da' },
    })
    judge.mockResolvedValue(judgement({ category: 'product', confidence: 0.5 }))

    const r = await runSandboxTurn(
      { shopId, customerEmail: null, sessionKey: 'test-3', messages: [{ role: 'user', text: 'Levering til Bornholm?' }] },
      { rules },
    )

    expect(r.action).toBe('draft')
    expect(r.reason).toMatch(/"product" is not a question the assistant may answer by itself/)
    expect(r.knowledge.map((k) => k.title)).toContain(`${TAG} Levering til Bornholm`)
    expect(judge.mock.calls[0][0].knowledge.some((k: { title: string }) => k.title.includes('Bornholm'))).toBe(true)
  })

  it('hands over when the customer asks for a person, whatever the judge said', async () => {
    const r = await runSandboxTurn(
      { shopId, customerEmail: null, sessionKey: 'test-4', messages: [{ role: 'user', text: 'Jeg vil tale med et menneske' }] },
      { rules: { ...rules, escalateKeywords: ['menneske'] } },
    )
    expect(r.action).toBe('escalate')
    expect(r.reason).toMatch(/menneske/)
  })

  it('hands the judge the shop\'s own product page for a customer with no orders', async () => {
    await db.knowledgeItem.create({
      data: {
        kind: 'product', title: `${TAG} Panetti ProMix - Hva følger med`, shopId, source: 'website',
        sourceUrl: 'https://panetti.dk/promix/', sourceKey: `${TAG}:promix:1`,
        body: 'Product: Panetti ProMix (SKU PROMIX)\nPage: https://panetti.dk/promix/\n\nBolle, eltekrok, visp og spatel følger med.',
      },
    })

    const r = await runSandboxTurn(
      { shopId, customerEmail: null, sessionKey: 'test-web', messages: [{ role: 'user', text: 'Hva følger med ProMix?' }] },
      { rules },
    )

    const input = judge.mock.calls[0][0] as { knowledge: { title: string; source: string }[] }
    expect(input.knowledge.some((k) => k.title.endsWith('Panetti ProMix - Hva følger med') && k.source === 'website')).toBe(true)
    expect(r.knowledge.some((k) => k.source === 'website')).toBe(true)
  })
})
