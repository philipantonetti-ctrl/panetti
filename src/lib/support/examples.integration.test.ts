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
  await db.shipment.deleteMany({ where: { order: { shop: { name: { contains: TAG } } } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
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

    const spaced = await db.aiConversation.create({
      data: {
        source: 'gorgias', externalTicketId: 'EX-8', shopId: shop.id, language: 'da', decision: 'escalated',
        question: 'Kan I ringe mig på 20 30 40 50 om ordre 15 209?',
      },
    })
    const c = await promoteCorrection(spaced.id, `Ja, vi ringer inden for en hverdag. ${TAG}`)
    const third = await db.knowledgeItem.findUniqueOrThrow({ where: { id: c!.knowledgeItemId! } })
    expect(third.title).not.toMatch(/\d/)
  })

  /**
   * The check is about THIS customer: their email, their order numbers, their
   * phone, their parcels - read from the orders on the row's email - plus any
   * order reference, parcel number or outside email at all. The shop's own
   * phone, a postcode, a price range or a model number is ordinary shop
   * knowledge and must still be taught.
   */
  async function customerRow(ticket: string) {
    const shop = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'DKK', wooUrl: 'https://www.panetti.dk' } })
    const order = await db.order.create({
      data: {
        shopId: shop.id, externalId: `${ticket}-o`, number: '15209', placedAt: new Date('2026-09-20'), status: 'completed',
        currency: 'DKK', grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        customerName: 'Anna Holm', customerEmail: 'Anna.Holm@example.invalid', customerPhone: '+45 20 30 40 50',
      },
    })
    await db.shipment.create({ data: { trackingNumber: `${ticket}370712345678901234`.slice(-18), carrier: 'BRING', orderId: order.id } })
    return db.aiConversation.create({
      data: {
        source: 'gorgias', externalTicketId: ticket, shopId: shop.id, language: 'da', decision: 'escalated',
        question: 'Hvor er min spade?', customerEmail: 'anna.holm@example.invalid',
      },
    })
  }

  it('keeps a correction that names the customer on the row, and teaches it to nobody', async () => {
    const conv = await customerRow('EX-6')
    for (const text of [
      `Din ordre 15209 er sendt i to pakker. ${TAG}`,
      `Din ordre 1042 er sendt. ${TAG}`,
      `Ordre 15.209 blev sendt. ${TAG}`,
      `Vi har sendt 15209 i to pakker. ${TAG}`,
      `Vi ringer dig på 20 30 40 50. ${TAG}`,
      `Skriv til anna.holm@example.invalid. ${TAG}`,
      `Sporing 70702146072719543 hos Bring. ${TAG}`,
    ]) {
      const r = await promoteCorrection(conv.id, text)
      expect(r, text).toEqual({ knowledgeItemId: null, withheld: expect.stringMatching(/customer/i) })
    }
    expect(await db.knowledgeItem.count({ where: { body: { contains: TAG } } })).toBe(0)
    const row = await db.aiConversation.findUniqueOrThrow({ where: { id: conv.id } })
    expect(row.rating).toBe('bad')
    expect(row.correction).toContain('70702146072719543')
  })

  it('still teaches ordinary shop answers that happen to hold numbers', async () => {
    const conv = await customerRow('EX-7')
    for (const text of [
      `Ring til kundeservice på 70 20 30 40. ${TAG}`,
      `Skriv til kundeservice@panetti.dk. ${TAG}`,
      `Returadresse: Musterstr. 1, 10115 Berlin. ${TAG}`,
      `Fragt koster 100 - 200 kr, ovnen 1 299 - 1 499 kr. ${TAG}`,
      `Model 57067 findes i str. 36 38 40 42. ${TAG}`,
      `Lukket 24-12 - 26-12 og 31-12-2026. ${TAG}`,
    ]) {
      const r = await promoteCorrection(conv.id, text)
      expect(r?.knowledgeItemId, text).toEqual(expect.any(String))
    }
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
