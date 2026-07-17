import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { syncShop } from './sync'
import { encryptSecret } from '../secrets'
import { db } from '../db'

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[sync-test]' } } })
}
beforeEach(cleanup)
afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
})

const jsonPage = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const emptyPage = () => jsonPage([])

/** A full, mappable WooCommerce order. */
function wooOrder(id: number, placedAt: string) {
  return {
    id,
    number: String(id),
    status: 'completed',
    currency: 'NOK',
    date_created_gmt: placedAt,
    discount_total: '0.00',
    discount_tax: '0.00',
    shipping_total: '0.00',
    shipping_tax: '0.00',
    total_tax: '25.00',
    total: '125.00',
    coupon_lines: [],
    line_items: [
      {
        id: id * 10,
        product_id: 900001,
        sku: 'SKU-1',
        name: 'Massager',
        quantity: 1,
        subtotal: '100.00',
        total: '100.00',
      },
    ],
  }
}

/** `n` orders, one minute apart, oldest first. */
function fullPage(n: number, startId: number) {
  return Array.from({ length: n }, (_, i) =>
    wooOrder(startId + i, new Date(Date.UTC(2024, 0, 1, 0, startId + i)).toISOString().slice(0, 19)),
  )
}

async function connectedShop(name: string) {
  return db.shop.create({
    data: {
      name,
      currency: 'NOK',
      wooUrl: 'https://shop.example',
      wooKey: encryptSecret('ck_real'),
      wooSecret: encryptSecret('cs_real'),
    },
  })
}

describe('syncShop', () => {
  it('decrypts stored keys and syncs (0 orders is a fine sync)', async () => {
    const shop = await connectedShop('Sync [sync-test]')
    const fetchMock = vi.fn().mockResolvedValue(emptyPage())
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(true)
    expect(result.ordersSynced).toBe(0)

    // The decrypted key — not the enc:v1: blob — must reach WooCommerce.
    const auth = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('ck_real:cs_real').toString('base64')}`)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).not.toBeNull()
  })

  it('reports unreadable keys as "reconnect", and never calls the store', async () => {
    const shop = await db.shop.create({
      data: {
        name: 'Sync bad key [sync-test]',
        currency: 'NOK',
        wooUrl: 'https://shop.example',
        wooKey: 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        wooSecret: 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Reconnect this shop/)
    expect(fetchMock).not.toHaveBeenCalled()

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).toBeNull() // watermark untouched on failure
  })

  it('a big first sync stores a chunk and reports more, leaving the watermark unset', async () => {
    const shop = await connectedShop('Sync backfill [sync-test]')
    // One full page (the chunk limit for this test), so history is "behind it".
    const fetchMock = vi.fn().mockImplementation(async () => jsonPage(fullPage(100, 1)))
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id, { backfillPages: 1 })
    expect(result.ok).toBe(true)
    expect(result.more).toBe(true)
    expect(result.ordersSynced).toBe(100)

    // The chunk LANDED, but the shop is still mid-backfill: watermark stays unset
    // so the next press resumes instead of switching to incremental mode.
    expect(await db.order.count({ where: { shopId: shop.id } })).toBe(100)
    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).toBeNull()
  })

  it('the next press resumes just behind the newest stored order', async () => {
    const shop = await connectedShop('Sync resume [sync-test]')
    await db.order.create({
      data: {
        shopId: shop.id,
        externalId: 'resume-1',
        number: '1',
        placedAt: new Date('2024-06-01T12:00:00Z'),
        status: 'completed',
        currency: 'NOK',
        grossSales: 10000,
        discountTotal: 0,
        netSales: 10000,
        shippingCharged: 0,
        taxTotal: 2500,
        total: 12500,
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(emptyPage())
    vi.stubGlobal('fetch', fetchMock)

    const before = Date.now()
    const result = await syncShop(shop.id)
    expect(result.ok).toBe(true)
    expect(result.more).toBeUndefined()

    // Resumes by CREATED date, one second behind the newest stored order so the
    // boundary order is re-fetched rather than risk being skipped.
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('after=2024-06-01T11%3A59%3A59')
    expect(url).not.toContain('modified_after')

    // History complete: the watermark starts a day back, so anything edited
    // while the backfill ran is picked up by the first incremental sync.
    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    const wm = saved.lastSyncAt!.getTime()
    expect(wm).toBeGreaterThan(before - 25 * 60 * 60 * 1000)
    expect(wm).toBeLessThan(before - 23 * 60 * 60 * 1000)
  })

  it('an incremental sync with 5,000+ changed orders stops loudly instead of skipping', async () => {
    const shop = await connectedShop('Sync inc cap [sync-test]')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: new Date('2026-07-01') } })
    const fetchMock = vi.fn().mockImplementation(async () => jsonPage(fullPage(100, 1)))
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/over 5,000/)

    // Nothing stored, watermark unchanged: the next run retries the same window.
    expect(await db.order.count({ where: { shopId: shop.id } })).toBe(0)
    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt!.toISOString()).toBe(new Date('2026-07-01').toISOString())
  })
})
