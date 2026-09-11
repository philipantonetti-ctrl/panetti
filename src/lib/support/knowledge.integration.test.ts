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
