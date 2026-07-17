import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchOrders } from './client'

const CREDS = { url: 'https://shop.example', key: 'ck', secret: 'cs' }

function page(n: number) {
  return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchOrders', () => {
  it('collects pages until a short one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(37))
    vi.stubGlobal('fetch', fetchMock)

    const orders = await fetchOrders(CREDS, null)
    expect(orders).toHaveLength(137)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws instead of silently truncating a 5,000+ order store', async () => {
    // 50 full pages and still more coming: stopping quietly would mark the
    // sync done while orders are missing. Refuse loudly instead.
    // A fresh Response per call — a Response body can only be read once, and
    // mockResolvedValue would replay the exact same (already-consumed) instance.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => page(100)))

    await expect(fetchOrders(CREDS, null)).rejects.toThrow(/over 5,000 orders/)
  })
})
