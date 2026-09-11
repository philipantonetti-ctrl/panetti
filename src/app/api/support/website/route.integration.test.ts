import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))
const { GET, PUT } = await import('./route')
const { POST } = await import('./read/route')
const { currentUser } = await import('@/lib/auth/current-user')

const TAG = '[website-route-test]'
let shopId = ''

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.websitePage.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK', wooUrl: 'https://panetti.example.test' } })).id
})

describe('GET /api/support/website', () => {
  it('lists every shop with its counts and its pages, admin only', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'https://panetti.example.test/betingelser/', title: 'Betingelser', active: true } })
    const body = await (await GET(new Request('http://localhost/api/support/website'))).json()
    const shop = body.shops.find((s: { id: string }) => s.id === shopId)
    expect(shop).toMatchObject({ siteUrl: 'https://panetti.example.test', readAt: null, products: null, pages: null, error: null })
    expect(shop.pageList).toEqual([{ externalId: 12, url: 'https://panetti.example.test/betingelser/', title: 'Betingelser', active: true }])

    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    expect((await GET(new Request('http://localhost/api/support/website'))).status).toBe(403)
  })

  it('re-lists a shop\'s pages from the site when asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 5, link: 'https://panetti.example.test/faq/', slug: 'faq', title: { rendered: 'FAQ' } }]), { status: 200 })))
    const body = await (await GET(new Request(`http://localhost/api/support/website?refresh=${shopId}`))).json()
    const shop = body.shops.find((s: { id: string }) => s.id === shopId)
    expect(shop.pageList).toEqual([{ externalId: 5, url: 'https://panetti.example.test/faq/', title: 'FAQ', active: true }])
  })
})

describe('PUT /api/support/website', () => {
  it('ticks and unticks a page', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'x', title: 'Betingelser', active: false } })
    const res = await PUT(new Request('http://localhost/api/support/website', { method: 'PUT', body: JSON.stringify({ shopId, externalId: 12, active: true }) }))
    expect(res.status).toBe(200)
    expect((await db.websitePage.findUniqueOrThrow({ where: { shopId_externalId: { shopId, externalId: 12 } } })).active).toBe(true)
  })

  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    const res = await PUT(new Request('http://localhost/api/support/website', { method: 'PUT', body: JSON.stringify({ shopId, externalId: 12, active: true }) }))
    expect(res.status).toBe(403)
  })
})

describe('POST /api/support/website/read', () => {
  it('reads the shop now and answers the counts', async () => {
    await db.shop.update({ where: { id: shopId }, data: { wooKey: null, wooSecret: null } })
    const res = await POST(new Request('http://localhost/api/support/website/read', { method: 'POST', body: JSON.stringify({ shopId }) }))
    // No Woo keys on this shop: the read cannot fetch its catalogue and says so.
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('No WooCommerce credentials for this shop')
  })

  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    const res = await POST(new Request('http://localhost/api/support/website/read', { method: 'POST', body: JSON.stringify({ shopId }) }))
    expect(res.status).toBe(403)
  })

  it('reads one published product with a description into one website row, and reports the counts', async () => {
    await db.shop.update({
      where: { id: shopId },
      data: { wooKey: encryptSecret('ck_test'), wooSecret: encryptSecret('cs_test') },
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/wp-json/wc/v3/products')) {
        return new Response(JSON.stringify([{
          id: 500, name: 'ProMix', sku: 'PROMIX', permalink: 'https://panetti.example.test/promix/',
          status: 'publish', catalog_visibility: 'visible',
          short_description: '', description: 'A'.repeat(60),
        }]), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    }))

    const res = await POST(new Request('http://localhost/api/support/website/read', { method: 'POST', body: JSON.stringify({ shopId }) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ products: 1, withDescriptions: 1, pages: 0, rows: 1 })
    expect(await db.knowledgeItem.count({ where: { shopId, source: 'website' } })).toBe(1)
  })

  it('reading shop A leaves shop B\'s website rows untouched', async () => {
    const shopB = await db.shop.create({ data: { name: `Panetti B ${TAG}`, currency: 'NOK', wooUrl: 'https://panetti-b.example.test' } })
    await db.knowledgeItem.create({
      data: { kind: 'product', title: `B product ${TAG}`, body: 'x', shopId: shopB.id, source: 'website', sourceKey: `website:${shopB.id}:product:1:0` },
    })
    await db.shop.update({
      where: { id: shopId },
      data: { wooKey: encryptSecret('ck_test'), wooSecret: encryptSecret('cs_test') },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))

    const res = await POST(new Request('http://localhost/api/support/website/read', { method: 'POST', body: JSON.stringify({ shopId }) }))
    expect(res.status).toBe(200)
    expect(await db.knowledgeItem.count({ where: { shopId: shopB.id, source: 'website' } })).toBe(1)
  })
})
