import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { promoteCorrection } from './examples'
import { knowledgeFor } from './knowledge'

/**
 * The correction loop, closed: what a person typed as "it should have said"
 * is found by the retrieval the assistant actually uses, scoped to the shop
 * and language it was said in.
 */
const TAG = '[ai-example-test]'

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { body: { contains: TAG } } })
  await db.aiConversation.deleteMany({ where: { externalTicketId: { startsWith: 'EX-' } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(cleanup)

describe('promoteCorrection', () => {
  it('turns a correction into an example the next similar question can find', async () => {
    const shop = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'DKK' } })
    const conv = await db.aiConversation.create({
      data: {
        source: 'sandbox', externalTicketId: 'EX-1', shopId: shop.id, language: 'da',
        question: 'Kan jeg bytte pizzaovnen til en anden model?', decision: 'drafted',
      },
    })

    const promoted = await promoteCorrection(conv.id, `Ja, inden 14 dage, hvis den er uåbnet. ${TAG}`)

    expect(promoted).not.toBeNull()
    const item = await db.knowledgeItem.findUniqueOrThrow({ where: { id: promoted!.knowledgeItemId! } })
    expect(item).toMatchObject({
      kind: 'example', shopId: shop.id, language: 'da', active: true,
      title: 'Kan jeg bytte pizzaovnen til en anden model?',
    })

    const found = await knowledgeFor('Hej, kan jeg bytte pizzaovnen?', { shopId: shop.id, language: 'da' })
    expect(found.some((r) => r.kind === 'example' && r.body.includes(TAG))).toBe(true)

    const updated = await db.aiConversation.findUniqueOrThrow({ where: { id: conv.id } })
    expect(updated.rating).toBe('bad')
    expect(updated.correction).toContain('14 dage')
  })

  it('is not offered to another shop or language', async () => {
    const shop = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'DKK' } })
    const other = await db.shop.create({ data: { name: `Mazzetti ${TAG}`, currency: 'NOK' } })
    const conv = await db.aiConversation.create({
      data: { source: 'sandbox', externalTicketId: 'EX-2', shopId: shop.id, language: 'da', question: 'Bytte pizzaovnen?', decision: 'drafted' },
    })
    await promoteCorrection(conv.id, `Ja. ${TAG}`)

    const elsewhere = await knowledgeFor('bytte pizzaovnen', { shopId: other.id, language: 'nb' })
    expect(elsewhere.some((r) => r.body.includes(TAG))).toBe(false)
  })

  /**
   * An example is offered to every later chat on the shop, so it must carry
   * nothing of the customer it came from. Live ticket 241709254 shows why:
   * the offline form puts the customer's email first in the question.
   */
  it('keeps the email, the dashes and any order number out of the example title', async () => {
    const shop = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'DKK' } })
    const offline = await db.aiConversation.create({
      data: {
        source: 'gorgias', externalTicketId: 'EX-4', shopId: shop.id, language: 'da', decision: 'escalated',
        question: 'kunde@example.invalid\n-------------------------------\nKan den sendes til Kreta?',
      },
    })
    const numbered = await db.aiConversation.create({
      data: {
        source: 'gorgias', externalTicketId: 'EX-5', shopId: shop.id, language: 'da', decision: 'escalated',
        question: 'Spaden mangler - bestilling nr 15209',
      },
    })

    const a = await promoteCorrection(offline.id, `Nej, vi sender kun i Danmark. ${TAG}`)
    const b = await promoteCorrection(numbered.id, `Tilbehør kan komme i en pakke for sig. ${TAG}`)

    const first = await db.knowledgeItem.findUniqueOrThrow({ where: { id: a!.knowledgeItemId! } })
    const second = await db.knowledgeItem.findUniqueOrThrow({ where: { id: b!.knowledgeItemId! } })
    expect(first.title).toBe('Kan den sendes til Kreta?')
    expect(second.title).not.toMatch(/15209/)
    expect(second.title).toMatch(/Spaden mangler/)
  })

  it('keeps a correction that names a customer on the row, and teaches it to nobody', async () => {
    const shop = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'DKK' } })
    const conv = await db.aiConversation.create({
      data: {
        source: 'gorgias', externalTicketId: 'EX-6', shopId: shop.id, language: 'da', decision: 'escalated',
        question: 'Hvor er min spade?', orderNumber: '15209',
      },
    })

    for (const text of [
      `Ordre 15209 er sendt i to pakker. ${TAG}`,
      `Skriv til anna@example.invalid. ${TAG}`,
      `Sporing 70702146072719543 hos Bring. ${TAG}`,
    ]) {
      const r = await promoteCorrection(conv.id, text)
      expect(r).toEqual({ knowledgeItemId: null, withheld: expect.stringMatching(/customer/i) })
    }
    expect(await db.knowledgeItem.count({ where: { body: { contains: TAG } } })).toBe(0)
    const row = await db.aiConversation.findUniqueOrThrow({ where: { id: conv.id } })
    expect(row.rating).toBe('bad')
    expect(row.correction).toContain('70702146072719543')
  })

  it('does nothing for a blank correction or an unknown conversation', async () => {
    expect(await promoteCorrection('no-such-id', 'text')).toBeNull()
    const conv = await db.aiConversation.create({
      data: { source: 'sandbox', externalTicketId: 'EX-3', question: 'q', decision: 'drafted' },
    })
    expect(await promoteCorrection(conv.id, '   ')).toBeNull()
    expect(await db.knowledgeItem.count({ where: { body: { contains: TAG } } })).toBe(0)
  })
})
