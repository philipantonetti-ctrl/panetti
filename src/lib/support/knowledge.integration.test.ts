import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { knowledgeBlock, knowledgeFor } from './knowledge'

const TAG = '[knowledge-rank-test]'
let shopId = ''

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { body: { contains: TAG } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK' } })).id
})

describe('knowledgeFor', () => {
  it('ranks a row whose title names the product above a longer row that only mentions it', async () => {
    await db.knowledgeItem.create({ data: { kind: 'product', title: 'Panetti ProMix - Hva følger med', body: `Product: Panetti ProMix\n\nBolle, eltekrok, visp. ${TAG}`, shopId, source: 'website', sourceUrl: 'https://panetti.no/promix/', sourceKey: `${TAG}:1` } })
    await db.knowledgeItem.create({ data: { kind: 'product', title: 'Pizzaovn - Bruk', body: `ProMix ProMix ProMix ProMix ovn ovn ovn ovn ${TAG}`, shopId, source: 'website', sourceKey: `${TAG}:2` } })

    const rows = await knowledgeFor('Hva følger med ProMix?', { shopId })
    expect(rows[0].title).toBe('Panetti ProMix - Hva følger med')
    expect(rows[0]).toMatchObject({ source: 'website', sourceUrl: 'https://panetti.no/promix/' })
  })

  it('reaches a customer with no orders, because website product rows carry no sku scope', async () => {
    await db.knowledgeItem.create({ data: { kind: 'product', title: 'Panetti ProMix', body: `Product: Panetti ProMix (SKU PROMIX)\n\nKraftig maskin. ${TAG}`, shopId, source: 'website', sourceKey: `${TAG}:3` } })
    const rows = await knowledgeFor('Er ProMix kraftig?', { shopId, skus: [] })
    expect(rows.some((r) => r.title === 'Panetti ProMix')).toBe(true)
  })

  it('still returns a house rule once the 400-row window fills with website rows newer than it', async () => {
    await db.knowledgeItem.create({
      data: {
        kind: 'tone', title: `House tone ${TAG}`, body: `Speak warmly and keep it short. ${TAG}`, shopId,
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      },
    })
    await db.knowledgeItem.createMany({
      data: Array.from({ length: 401 }, (_, i) => ({
        kind: 'product', title: `Website row ${i} ${TAG}`, body: `Product row number ${i}. ${TAG}`, shopId,
        source: 'website', sourceKey: `${TAG}:website:${i}`,
      })),
    })

    const rows = await knowledgeFor('anything at all', { shopId })
    expect(rows.some((r) => r.title === `House tone ${TAG}`)).toBe(true)
  })
})

describe('knowledgeBlock', () => {
  it('names where a website row came from', () => {
    const text = knowledgeBlock([
      { kind: 'product', title: 'Panetti ProMix', body: 'Page: https://panetti.no/promix/\n\nKraftig.', source: 'website', sourceUrl: 'https://panetti.no/promix/' },
      { kind: 'faq', title: 'Frakt', body: 'Gratis.', source: 'manual', sourceUrl: null },
    ])
    expect(text).toContain('[product, from panetti.no] Panetti ProMix')
    expect(text).toContain('[faq] Frakt')
  })
})

/**
 * The product page as a whole. A page is stored as a dozen chunks and the
 * customer's question rarely shares a word with the one chunk that holds the
 * answer: "hvor mange grader" against a chunk that says "450 °C". When a
 * word of the question names a product, the whole page goes, in page order.
 */
describe('knowledgeFor, when the customer names a product', () => {
  const product = (ext: string, name: string, chunks: string[], updatedAt?: Date) =>
    db.knowledgeItem.createMany({
      data: chunks.map((text, n) => ({
        kind: 'product', title: n === 0 ? name : `${name} - Section ${n}`, body: `Product: ${name} (SKU X${ext})\nPage: https://panetti.dk/p/\n\n${text} ${TAG}`,
        shopId, source: 'website', sourceKey: `website:${shopId}:product:${ext}:${n}`, sourceUrl: 'https://panetti.dk/p/',
        ...(updatedAt ? { updatedAt } : {}),
      })),
    })

  it('sends the whole page when a word of the question names the product, the answering chunk included', async () => {
    // The practice question of 2026-09-14, on the Danish shop's real chunking.
    const chunks = Array.from({ length: 14 }, (_, n) => `Om ovnen, del ${n}.`)
    chunks[7] = 'Med kraftig og effektiv varme når Panetti Pizzetta Pro op til 450 °C på kun 15 minutter.'
    await product('11173', 'Panetti Pizzetta Pro - Elektrisk pizzaovn', chunks)
    await product('10101', 'Panetti PrimoChef - Smart køkkenassistent', ['Hvor mange retter kan du lave? Mange.', 'Del to.'])

    const rows = await knowledgeFor('Hei! Hvor mange grader kan pizzaovnen gå opp til?', { shopId })

    const pizzetta = rows.filter((r) => r.title.startsWith('Panetti Pizzetta Pro'))
    expect(pizzetta.map((r) => r.title.replace(/^.* - Section /, ''))).toEqual([
      'Panetti Pizzetta Pro - Elektrisk pizzaovn', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13',
    ])
    expect(pizzetta[7].body).toContain('450 °C')
  })

  it('keeps the loose word matches after the named page', async () => {
    await product('11173', 'Panetti Pizzetta Pro - Elektrisk pizzaovn', ['Del null.', 'Del en.'])
    await db.knowledgeItem.create({ data: { kind: 'faq', title: `Garanti ${TAG}`, body: `Garantien gjelder 2 år, også ved høye grader. ${TAG}`, shopId } })

    const rows = await knowledgeFor('Hvor mange grader tåler pizzaovnen?', { shopId })

    expect(rows.map((r) => r.title)).toEqual(['Panetti Pizzetta Pro - Elektrisk pizzaovn', 'Panetti Pizzetta Pro - Elektrisk pizzaovn - Section 1', `Garanti ${TAG}`])
  })

  it('cuts a named page at the character budget, first chunks first', async () => {
    // Forty chunks of 1,500: twice the budget. Every page read so far is under it.
    await product('900', 'Mazzetti Lite Comfort - Massagestol', Array.from({ length: 40 }, (_, n) => `Chunk ${n} `.padEnd(1400, 'x')))

    const rows = await knowledgeFor('Hvor tung er massagestolen?', { shopId })

    // The page, in order, from the top, until the budget ends. What the cut
    // left out may still arrive behind it as a loose match on its title, but
    // that stage has its own ceiling of twelve rows.
    const page = rows.filter((r) => r.title.startsWith('Mazzetti Lite Comfort'))
    expect(page.length).toBeLessThan(40)
    expect(page.reduce((sum, r) => sum + r.body.length, 0)).toBeLessThanOrEqual(30_000 + 12 * 1_500)
    let inOrder = 0
    while (inOrder < page.length && page[inOrder].body.includes(`Chunk ${inOrder} `)) inOrder++
    expect(inOrder).toBeGreaterThan(12)
  })

  it('a word that most product names share names none of them', async () => {
    // "panetti" is in half the Danish shop's product names. The brand is not a product.
    for (const [ext, name] of [['1', 'Panetti PrimoChef'], ['2', 'Panetti ProMix'], ['3', 'Panetti Pizzetta Pro']]) {
      await product(ext, name, Array.from({ length: 6 }, (_, n) => `Om produktet, del ${n}.`))
    }
    await product('4', 'Pizzasten', ['En stein til ovnen.'])

    const rows = await knowledgeFor('Hei Panetti, har dere åpent i dag?', { shopId })

    // Nothing named, so only the loose matches: at most twelve of the eighteen chunks.
    expect(rows.length).toBeLessThanOrEqual(12)
  })
})
