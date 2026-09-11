import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import type { CatalogEntry } from '@/lib/woo/client'
import { dueForRead, productRows, refreshWebsiteKnowledge, syncPageInventory } from './website-sync'

const TAG = '[website-sync-test]'
let shopId = ''

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { OR: [{ shop: { name: { contains: TAG } } }, { title: { contains: TAG } }] } })
  await db.websitePage.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti Norway ${TAG}`, currency: 'NOK', wooUrl: 'https://panetti.example.test' } })).id
})

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  price: 129900, stock: 3, name: 'Panetti ProMix Kjøkkenmaskin', sku: 'PROMIX-NO',
  permalink: 'https://panetti.example.test/promix/',
  shortDescription: '<p>Kraftig kjøkkenmaskin med 1500 W motor, utviklet eksklusivt for Panetti.</p>',
  description: '<h2>Hva følger med</h2><p>Bolle i rustfritt stål, eltekrok, visp og spatel. Alt du trenger for å komme i gang med baking hjemme.</p><h2>Bruk</h2><p>Sett bollen på plass, velg hastighet og start. Maskinen stopper automatisk ved overbelastning.</p>',
  published: true,
  ...over,
})

const noPages = () => vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))

describe('productRows', () => {
  it('makes one row per section, titled with the product and its heading, with the page link in the body', () => {
    const rows = productRows(shopId, '24256', entry())
    expect(rows.map((r) => r.title)).toEqual([
      'Panetti ProMix Kjøkkenmaskin',
      'Panetti ProMix Kjøkkenmaskin - Hva følger med',
      'Panetti ProMix Kjøkkenmaskin - Bruk',
    ])
    expect(rows[0].sourceKey).toBe(`website:${shopId}:product:24256:0`)
    expect(rows[1].body).toBe('Product: Panetti ProMix Kjøkkenmaskin (SKU PROMIX-NO)\nPage: https://panetti.example.test/promix/\n\nBolle i rustfritt stål, eltekrok, visp og spatel. Alt du trenger for å komme i gang med baking hjemme.')
    expect(rows[1].sourceUrl).toBe('https://panetti.example.test/promix/')
  })

  it('yields nothing for an unpublished product or one with no words', () => {
    expect(productRows(shopId, '1', entry({ published: false }))).toEqual([])
    expect(productRows(shopId, '2', entry({ shortDescription: '', description: '' }))).toEqual([])
  })
})

describe('refreshWebsiteKnowledge', () => {
  it('writes product rows scoped to the shop, marked website, and reports the counts', async () => {
    noPages()
    const counts = await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry()], ['1', entry({ name: `Bare ${TAG}`, shortDescription: '', description: '' })]]) })

    expect(counts).toEqual({ products: 2, withDescriptions: 1, pages: 0, rows: 3 })
    const rows = await db.knowledgeItem.findMany({ where: { shopId, source: 'website' }, orderBy: { sourceKey: 'asc' } })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ kind: 'product', shopId, sku: null, country: null, language: null, active: true, source: 'website' })
    expect(rows[0].readAt).not.toBeNull()
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } })
    expect(shop.websiteProducts).toBe(2)
    expect(shop.websiteReadAt).not.toBeNull()
    expect(shop.websiteError).toBeNull()
  })

  it('rewrites a row in place on the next read, keeps it turned off if a person turned it off, and drops rows whose product is gone', async () => {
    noPages()
    await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry()]]) })
    const first = await db.knowledgeItem.findUniqueOrThrow({ where: { sourceKey: `website:${shopId}:product:24256:1` } })
    await db.knowledgeItem.update({ where: { id: first.id }, data: { active: false } })
    await db.knowledgeItem.create({ data: { kind: 'faq', title: `Manual ${TAG}`, body: 'typed by hand', shopId } })

    await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry({ description: '<h2>Hva følger med</h2><p>Bolle i rustfritt stål, eltekrok og visp. Nytt i år: en pastarulle følger med i esken.</p>' })]]) })

    const again = await db.knowledgeItem.findUniqueOrThrow({ where: { sourceKey: `website:${shopId}:product:24256:1` } })
    expect(again.id).toBe(first.id)
    expect(again.body).toContain('pastarulle')
    expect(again.active).toBe(false)
    expect(await db.knowledgeItem.findUnique({ where: { sourceKey: `website:${shopId}:product:24256:2` } })).toBeNull()
    expect(await db.knowledgeItem.count({ where: { shopId, source: 'manual' } })).toBe(1)
  })

  it('reads a ticked page into policy rows and leaves an unticked one alone', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'https://panetti.example.test/betingelser/', title: 'Betingelser', active: true } })
    await db.websitePage.create({ data: { shopId, externalId: 13, url: 'https://panetti.example.test/test/', title: 'test', active: false } })
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('include=12')
        ? new Response(JSON.stringify([{ id: 12, link: 'https://panetti.example.test/betingelser/', title: { rendered: 'Betingelser' }, content: { rendered: '<h2>Angrerett</h2><p>Du kan angre kjøpet innen 14 dager etter at du mottok varen, uten å oppgi grunn.</p>' } }]), { status: 200 })
        : new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const counts = await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map() })

    expect(counts.pages).toBe(1)
    const row = await db.knowledgeItem.findUniqueOrThrow({ where: { sourceKey: `website:${shopId}:page:12:0` } })
    expect(row).toMatchObject({ kind: 'policy', title: 'Betingelser - Angrerett', sourceUrl: 'https://panetti.example.test/betingelser/' })
    expect(row.body).toContain('Page: https://panetti.example.test/betingelser/')
    expect(row.body).toContain('14 dager')
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('include=13'))).toBe(false)
  })

  it('leaves the shop\'s existing product rows in place when the catalogue passed in is empty', async () => {
    await db.knowledgeItem.create({
      data: {
        kind: 'product', title: `Old product ${TAG}`, body: 'x', shopId,
        source: 'website', sourceKey: `website:${shopId}:product:24256:0`, readAt: new Date(),
      },
    })
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const counts = await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map() })

    expect(counts).toEqual({ products: 0, withDescriptions: 0, pages: 0, rows: 0 })
    expect(await db.knowledgeItem.count({ where: { shopId, source: 'website' } })).toBe(1)
  })

  it('deletes neither ticked page\'s rows when the deadline has already passed, and reports zero pages', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'https://panetti.example.test/betingelser/', title: 'Betingelser', active: true } })
    await db.websitePage.create({ data: { shopId, externalId: 14, url: 'https://panetti.example.test/vilkar/', title: 'Vilkar', active: true } })
    await db.knowledgeItem.create({ data: { kind: 'policy', title: `Old 12 ${TAG}`, body: 'x', shopId, source: 'website', sourceKey: `website:${shopId}:page:12:0`, readAt: new Date() } })
    await db.knowledgeItem.create({ data: { kind: 'policy', title: `Old 14 ${TAG}`, body: 'x', shopId, source: 'website', sourceKey: `website:${shopId}:page:14:0`, readAt: new Date() } })
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const counts = await refreshWebsiteKnowledge({
      shopId, siteUrl: 'https://panetti.example.test', catalog: new Map(), deadline: Date.now() - 1,
    })

    expect(counts.pages).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await db.knowledgeItem.count({ where: { shopId, sourceKey: `website:${shopId}:page:12:0` } })).toBe(1)
    expect(await db.knowledgeItem.count({ where: { shopId, sourceKey: `website:${shopId}:page:14:0` } })).toBe(1)
  })

  it('deletes an unticked page\'s existing rows on the next read', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 15, url: 'https://panetti.example.test/vilkar/', title: 'Vilkar', active: false } })
    await db.knowledgeItem.create({ data: { kind: 'policy', title: `Old 15 ${TAG}`, body: 'x', shopId, source: 'website', sourceKey: `website:${shopId}:page:15:0`, readAt: new Date() } })
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map() })

    expect(await db.knowledgeItem.count({ where: { shopId, sourceKey: `website:${shopId}:page:15:0` } })).toBe(0)
  })

  it('deletes a ticked page\'s rows once it has vanished from the site, while a page that still answers keeps its rows', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 16, url: 'https://panetti.example.test/gone/', title: 'Gone', active: true } })
    await db.websitePage.create({ data: { shopId, externalId: 17, url: 'https://panetti.example.test/betingelser/', title: 'Betingelser', active: true } })
    await db.knowledgeItem.create({ data: { kind: 'policy', title: `Old 16 ${TAG}`, body: 'x', shopId, source: 'website', sourceKey: `website:${shopId}:page:16:0`, readAt: new Date() } })
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('include=17')
        ? new Response(JSON.stringify([{ id: 17, link: 'https://panetti.example.test/betingelser/', title: { rendered: 'Betingelser' }, content: { rendered: '<p>Du kan angre kjøpet innen 14 dager etter at du mottok varen, uten å oppgi grunn.</p>' } }]), { status: 200 })
        // A page WordPress no longer has answers with an empty list, not a 404.
        : new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const counts = await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map() })

    expect(counts.pages).toBe(1)
    expect(await db.knowledgeItem.count({ where: { shopId, sourceKey: `website:${shopId}:page:16:0` } })).toBe(0)
    const row17 = await db.knowledgeItem.findUniqueOrThrow({ where: { sourceKey: `website:${shopId}:page:17:0` } })
    expect(row17.body).toContain('14 dager')
  })

  it('records the error and keeps the old rows when the site fails', async () => {
    noPages()
    await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry()]]) })
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'x', title: 'Betingelser', active: true } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))

    await expect(refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry()]]) })).rejects.toThrow('answered 503')

    expect(await db.knowledgeItem.count({ where: { shopId, source: 'website' } })).toBe(3)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).websiteError).toBe('panetti.example.test answered 503')
  })
})

describe('syncPageInventory', () => {
  it('lists the pages, pre-ticks the policy-like ones on first sight, and keeps a tick a person changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { id: 12, link: 'https://panetti.example.test/betingelser/', slug: 'betingelser', title: { rendered: 'Betingelser' } },
      { id: 13, link: 'https://panetti.example.test/sample-page/', slug: 'sample-page', title: { rendered: 'Sample Page' } },
    ]), { status: 200 })))

    expect(await syncPageInventory(shopId, 'https://panetti.example.test')).toBe(2)
    const pages = await db.websitePage.findMany({ where: { shopId }, orderBy: { externalId: 'asc' } })
    expect(pages.map((p) => [p.externalId, p.active])).toEqual([[12, true], [13, false]])

    await db.websitePage.update({ where: { shopId_externalId: { shopId, externalId: 12 } }, data: { active: false } })
    await syncPageInventory(shopId, 'https://panetti.example.test')
    expect((await db.websitePage.findUniqueOrThrow({ where: { shopId_externalId: { shopId, externalId: 12 } } })).active).toBe(false)
  })
})

describe('dueForRead', () => {
  const now = new Date('2026-09-10T05:00:00Z')
  it('is due when never read, or read more than 20 hours ago', () => {
    expect(dueForRead({ websiteReadAt: null }, now)).toBe(true)
    expect(dueForRead({ websiteReadAt: new Date('2026-09-09T05:00:00Z') }, now)).toBe(true)
    expect(dueForRead({ websiteReadAt: new Date('2026-09-09T20:00:00Z') }, now)).toBe(false)
  })
})
