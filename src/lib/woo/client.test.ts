import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchCoupons, fetchOrders } from './client'

const CREDS = { url: 'https://shop.example', key: 'ck', secret: 'cs' }

const couponsPage = (codes: string[]) =>
  new Response(JSON.stringify(codes.map((code, i) => ({ id: i, code }))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

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

    const { orders, hasMore } = await fetchOrders(CREDS, {})
    expect(orders).toHaveLength(137)
    expect(hasMore).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops at maxPages and says more is behind', async () => {
    // A fresh Response per call — a Response body can only be read once, and
    // mockResolvedValue would replay the exact same (already-consumed) instance.
    const fetchMock = vi.fn().mockImplementation(async () => page(100))
    vi.stubGlobal('fetch', fetchMock)

    const { orders, hasMore } = await fetchOrders(CREDS, { maxPages: 3 })
    expect(orders).toHaveLength(300)
    expect(hasMore).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3) // never a 4th request
  })

  it('filters by modified date for incremental syncs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('modified_after=2026-07-01T10%3A00%3A00')
    expect(url).not.toContain('after=2026-07-01T10%3A00%3A00&') // no created filter
  })

  it('filters by created date for first-sync chunks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { createdAfter: new Date('2024-01-29T00:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('after=2024-01-29T00%3A00%3A00')
    expect(url).not.toContain('modified_after')
  })
})

describe('fetchCoupons', () => {
  it('returns the store coupon codes, uppercased and deduped', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => couponsPage(['john10', 'JOHN10', 'summer']))
    vi.stubGlobal('fetch', fetchMock)

    const codes = await fetchCoupons(CREDS)
    expect(codes.sort()).toEqual(['JOHN10', 'SUMMER'])

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/wp-json/wc/v3/coupons')
  })

  it('pages until a short page and stops', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => couponsPage(Array.from({ length: 100 }, (_, i) => `C${i}`)))
      .mockImplementationOnce(async () => couponsPage(['LAST']))
    vi.stubGlobal('fetch', fetchMock)

    const codes = await fetchCoupons(CREDS)
    expect(codes).toContain('LAST')
    expect(codes).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws when the store rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))
    await expect(fetchCoupons(CREDS)).rejects.toThrow(/401/)
  })
})
