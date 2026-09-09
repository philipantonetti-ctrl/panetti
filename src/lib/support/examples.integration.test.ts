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
    const item = await db.knowledgeItem.findUniqueOrThrow({ where: { id: promoted!.knowledgeItemId } })
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

  it('does nothing for a blank correction or an unknown conversation', async () => {
    expect(await promoteCorrection('no-such-id', 'text')).toBeNull()
    const conv = await db.aiConversation.create({
      data: { source: 'sandbox', externalTicketId: 'EX-3', question: 'q', decision: 'drafted' },
    })
    expect(await promoteCorrection(conv.id, '   ')).toBeNull()
    expect(await db.knowledgeItem.count({ where: { body: { contains: TAG } } })).toBe(0)
  })
})
