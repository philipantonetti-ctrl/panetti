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

const emptyPage = () =>
  new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('syncShop', () => {
  it('decrypts stored keys and syncs (0 orders is a fine sync)', async () => {
    const shop = await db.shop.create({
      data: {
        name: 'Sync [sync-test]',
        currency: 'NOK',
        wooUrl: 'https://shop.example',
        wooKey: encryptSecret('ck_real'),
        wooSecret: encryptSecret('cs_real'),
      },
    })
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
    expect(result.error).toMatch(/reconnect this shop/)
    expect(fetchMock).not.toHaveBeenCalled()

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).toBeNull() // watermark untouched on failure
  })
})
