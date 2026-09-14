import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { knowledgeBlock, knowledgeFor } from './knowledge'

const TAG = '[knowledge-rank-test]'
let shopId = ''

/** This suite's own rows. Another suite's global house rule (shopId null) is in scope here too while it lives. */
const mine = (rows: { title: string; body: string }[]) => rows.filter((r) => r.body.includes(TAG))

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

    const rows = mine(await knowledgeFor('Hva følger med ProMix?', { shopId }))
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
  const product = (ext: string, name: string, chunks: string[]) =>
    db.knowledgeItem.createMany({
      data: chunks.map((text, n) => ({
        kind: 'product', title: n === 0 ? name : `${name} - Section ${n}`, body: `Product: ${name} (SKU X${ext})\nPage: https://panetti.dk/p/\n\n${text} ${TAG}`,
        shopId, source: 'website', sourceKey: `website:${shopId}:product:${ext}:${n}`, sourceUrl: 'https://panetti.dk/p/',
      })),
    })
  const section = (r: { title: string }) => r.title.replace(/^.* - Section /, '')

  it('sends the whole page when a word of the question names the product, the answering chunk included', async () => {
    // The practice question of 2026-09-14, on the Danish shop's real chunking.
    const chunks = Array.from({ length: 14 }, (_, n) => `Om ovnen, del ${n}.`)
    chunks[7] = 'Med kraftig og effektiv varme når Panetti Pizzetta Pro op til 450 °C på kun 15 minutter.'
    await product('11173', 'Panetti Pizzetta Pro - Elektrisk pizzaovn', chunks)
    await product('10101', 'Panetti PrimoChef - Smart køkkenassistent', ['Hvor mange retter kan du lave? Mange.', 'Del to.'])

    const rows = mine(await knowledgeFor('Hei! Hvor mange grader kan pizzaovnen gå opp til?', { shopId }))

    const pizzetta = rows.filter((r) => r.title.startsWith('Panetti Pizzetta Pro'))
    expect(pizzetta.map(section)).toEqual([
      'Panetti Pizzetta Pro - Elektrisk pizzaovn', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13',
    ])
    expect(pizzetta[7].body).toContain('450 °C')
  })

  it('names the page by the head noun alone: "ovnen" is the "pizzaovn"', async () => {
    // Philip's second try, 2026-09-14 08:40: no product name, just "the oven".
    const chunks = Array.from({ length: 14 }, (_, n) => `Om ovnen, del ${n}.`)
    chunks[7] = 'Med kraftig og effektiv varme når Panetti Pizzetta Pro op til 450 °C på kun 15 minutter.'
    await product('11173', 'Panetti Pizzetta Pro - Elektrisk pizzaovn', chunks)
    await product('10101', 'Panetti PrimoChef - Smart køkkenassistent', ['Del nul.', 'Del en.'])

    const rows = mine(await knowledgeFor('Hvor mange grader kan ovnen komme opp til?', { shopId }))

    expect(rows.slice(0, 14).map(section)).toEqual(['Panetti Pizzetta Pro - Elektrisk pizzaovn', ...Array.from({ length: 13 }, (_, n) => String(n + 1))])
    expect(rows[7].body).toContain('450 °C')
  })

  it('keeps the loose word matches after the named page', async () => {
    await product('11173', 'Panetti Pizzetta Pro - Elektrisk pizzaovn', ['Del null.', 'Del en.'])
    await db.knowledgeItem.create({ data: { kind: 'faq', title: `Garanti ${TAG}`, body: `Garantien gjelder 2 år, også ved høye grader. ${TAG}`, shopId } })

    const rows = mine(await knowledgeFor('Hvor mange grader tåler pizzaovnen?', { shopId }))

    expect(rows.map((r) => r.title)).toEqual(['Panetti Pizzetta Pro - Elektrisk pizzaovn', 'Panetti Pizzetta Pro - Elektrisk pizzaovn - Section 1', `Garanti ${TAG}`])
  })

  it('cuts a named page at the 30,000-character budget, from the top, and does not top it up from the bottom', async () => {
    // Forty chunks of about 1,500: twice the budget. Every page read so far is under it.
    await product('900', 'Mazzetti Lite Comfort - Massagestol', Array.from({ length: 40 }, (_, n) => `Chunk ${n} `.padEnd(1400, 'x')))

    const rows = mine(await knowledgeFor('Hvor tung er massagestolen?', { shopId }))

    // Exactly the prefix that fits: one chunk more would cross the budget,
    // and the rest of the page does not come back through the loose stage,
    // where every chunk's title would match, in reverse order.
    const page = rows.filter((r) => r.title.startsWith('Mazzetti Lite Comfort'))
    expect(rows).toEqual(page)
    expect(page.every((r, i) => r.body.includes(`Chunk ${i} `))).toBe(true)
    const total = page.reduce((sum, r) => sum + r.body.length, 0)
    expect(total).toBeLessThanOrEqual(30_000)
    expect(total + page[0].body.length).toBeGreaterThan(30_000)
  })

  it('a word in a third of the product names still names them; a word in half of them names none', async () => {
    // Six products of five chunks. "pizzetta" is in two names, "panetti" in three: the brand is not a product.
    const five = (what: string) => Array.from({ length: 5 }, (_, n) => `Om ${what}, del ${n}.`)
    await product('1', 'Panetti Pizzetta Pro', five('ovnen'))
    await product('2', 'Panetti Pizzetta Mini', five('den lille ovnen'))
    await product('3', 'Panetti ProMix', five('maskinen'))
    await product('4', 'Pizzasten', ['En stein til ovnen.'])
    await product('5', 'Pizzaspade', ['En spade.'])
    await product('6', 'Ovnbørste', ['En børste.'])

    const named = mine(await knowledgeFor('Hvilken Pizzetta skal jeg velge?', { shopId }))
    // Both Pizzetta pages first, each whole and in order.
    const first = named.slice(0, 10)
    expect(first.every((r) => r.title.includes('Pizzetta'))).toBe(true)
    expect(first.filter((r) => r.title.startsWith('Panetti Pizzetta Pro')).map(section)).toEqual(['Panetti Pizzetta Pro', '1', '2', '3', '4'])
    expect(first.filter((r) => r.title.startsWith('Panetti Pizzetta Mini')).map(section)).toEqual(['Panetti Pizzetta Mini', '1', '2', '3', '4'])

    const brand = mine(await knowledgeFor('Hei Panetti, har dere åpent i dag?', { shopId }))
    // No page: only the loose stage, whose ceiling of twelve is below the
    // fifteen chunks three named pages would have sent. (Every row's Page
    // line says panetti.dk, so the three others match loosely too.)
    expect(brand).toHaveLength(12)
  })

  it('names a product by its name alone, not by the colour in brackets', async () => {
    await product('7', 'Mazzetti Advanced Comfort - Massagestol (Beige)', ['Beige, del 0.'])
    await product('8', 'Mazzetti Advanced Comfort - Massagestol (Sort)', ['Sort, del 0.'])
    await product('9', 'Mazzetti Lite Comfort - Massagestol (Beige)', ['Lite, del 0.'])

    const rows = mine(await knowledgeFor('Har dere den i beige?', { shopId }))
    expect(rows.every((r) => r.title.includes('Beige'))).toBe(true)
    expect(rows.slice(0, 1).map(section)).not.toEqual(['Mazzetti Advanced Comfort - Massagestol (Beige)'])
  })

  it('finds a page the 400-row window has already pushed out', async () => {
    // Thirty products of fourteen chunks, the named one written first, so it
    // is the oldest of 420 rows and outside the window the loose stage reads.
    await product('11173', 'Panetti Pizzetta Pro - Elektrisk pizzaovn', Array.from({ length: 14 }, (_, n) => `Om ovnen, del ${n}.`))
    for (let i = 1; i < 30; i++) {
      await product(`x${i}`, `Panetti Vare ${i}`, Array.from({ length: 14 }, (_, n) => `Om vare ${i}, del ${n}.`))
    }

    const rows = mine(await knowledgeFor('Hvor mange grader kan pizzaovnen gå opp til?', { shopId }))

    expect(rows.slice(0, 14).map(section)).toEqual(['Panetti Pizzetta Pro - Elektrisk pizzaovn', ...Array.from({ length: 13 }, (_, n) => String(n + 1))])
  })
})
