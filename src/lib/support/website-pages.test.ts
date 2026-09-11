import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPage, listPages, policyLike } from './website-pages'

afterEach(() => vi.unstubAllGlobals())

describe('listPages', () => {
  it('asks the public pages API without a key and returns id, link, title and slug', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([
        { id: 12, link: 'https://panetti.no/betingelser/', slug: 'betingelser', title: { rendered: 'Betingelser' } },
        { id: 13, link: 'https://panetti.no/sample-page/', slug: 'sample-page', title: { rendered: 'Sample Page' } },
      ]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const pages = await listPages('https://panetti.no/')

    expect(pages).toEqual([
      { externalId: 12, url: 'https://panetti.no/betingelser/', title: 'Betingelser', slug: 'betingelser' },
      { externalId: 13, url: 'https://panetti.no/sample-page/', title: 'Sample Page', slug: 'sample-page' },
    ])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://panetti.no/wp-json/wp/v2/pages?per_page=100&page=1&_fields=id,link,slug,title')
    expect(init?.headers).toBeUndefined()
  })

  it('decodes an entity in a title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 1, link: 'x', slug: 'x', title: { rendered: 'Napolitansk Pizza &#8211; Grunnkurs' } }]), { status: 200 })))
    expect((await listPages('https://panetti.no'))[0].title).toBe('Napolitansk Pizza - Grunnkurs')
  })

  it('throws with the status when the site refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(listPages('https://panetti.no')).rejects.toThrow('panetti.no answered 503')
  })
})

describe('fetchPage', () => {
  it('returns the rendered content of one page, or null when it is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 12, link: 'https://panetti.no/betingelser/', title: { rendered: 'Betingelser' }, content: { rendered: '<p>Innledning</p>' } }]), { status: 200 })))
    expect(await fetchPage('https://panetti.no', 12)).toEqual({ title: 'Betingelser', url: 'https://panetti.no/betingelser/', html: '<p>Innledning</p>' })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    expect(await fetchPage('https://panetti.no', 99)).toBeNull()
  })
})

describe('policyLike', () => {
  it('ticks the pages that read like terms, warranty, FAQ, shipping or returns, in any of the six languages', () => {
    for (const p of [
      { slug: 'betingelser', title: 'Betingelser' },
      { slug: 'garantibevis', title: 'Warranty' },
      { slug: 'faq', title: 'FAQ' },
      { slug: 'villkor', title: 'Allmänna villkor' },
      { slug: 'toimitusehdot', title: 'Toimitus' },
      { slug: 'bedingungen', title: 'Bedingungen' },
      { slug: 'x', title: 'Rücksendung' },
    ]) expect(policyLike(p)).toBe(true)
  })

  it('leaves the rest unticked', () => {
    for (const p of [
      { slug: 'sample-page', title: 'Sample Page' },
      { slug: 'test-2', title: 'test' },
      { slug: 'om-oss', title: 'Om oss' },
      { slug: 'customer-help', title: 'Customer Help' },
      { slug: 'shop', title: 'Shop' },
    ]) expect(policyLike(p)).toBe(false)
  })
})
