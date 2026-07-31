import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchCoupons, fetchOrders, requestBudgetMs } from './client'

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

  // Truncating a modified-filtered list that is sorted by CREATED date leaves
  // nowhere safe to resume from, which is why the old code could only refuse.
  it('sorts incremental pulls by modified date, ascending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('orderby=modified')
    expect(url).toContain('order=asc')
  })

  // Without this the store reads our UTC timestamp as its own local time. A
  // store at UTC+2 then hands back a two-hour-wider window on every sync.
  it('tells the store our dates are GMT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') })

    expect(String(fetchMock.mock.calls[0][0])).toContain('dates_are_gmt=true')
  })

  // A first sync walks history forwards by creation date and resumes on it.
  it('leaves first-sync chunks sorted by created date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { createdAfter: new Date('2026-07-01T10:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('orderby=date')
    expect(url).not.toContain('orderby=modified')
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

describe('bounded pulls', () => {
  // A store that never answers must cost this run, not every run behind it.
  it('stops before a fetch once the deadline has passed', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => page(100))
    vi.stubGlobal('fetch', fetchMock)

    const { orders, hasMore } = await fetchOrders(CREDS, {
      modifiedAfter: new Date('2026-07-01T10:00:00Z'),
      deadline: Date.now() - 1,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(orders).toHaveLength(0)
    // Nothing was read, so there is certainly more.
    expect(hasMore).toBe(true)
  })

  it('stops between pages when the deadline arrives mid-pull', async () => {
    const deadline = Date.now() + 40
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30))
      return page(100)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { hasMore } = await fetchOrders(CREDS, {
      modifiedAfter: new Date('2026-07-01T10:00:00Z'),
      deadline,
    })

    expect(hasMore).toBe(true)
    // Far fewer than the 50-page ceiling: it stopped on time, not on the cap.
    expect(fetchMock.mock.calls.length).toBeLessThan(5)
  })

  it('gives one request the lesser of the ceiling and what is left', () => {
    const now = 1_000_000
    // Plenty of deadline left: the ceiling wins.
    expect(requestBudgetMs({ deadline: now + 90_000 }, now)).toBe(30_000)
    // Nearly out of deadline: what is left wins.
    expect(requestBudgetMs({ deadline: now + 5_000 }, now)).toBe(5_000)
    // No deadline at all: the ceiling.
    expect(requestBudgetMs({}, now)).toBe(30_000)
    // Never zero or negative — an already-expired budget must still be a valid
    // timeout, and the page loop is what actually stops.
    expect(requestBudgetMs({ deadline: now - 10_000 }, now)).toBe(1)
  })
})

describe('resume points', () => {
  const modifiedPage = (stamps: string[]) =>
    new Response(
      JSON.stringify(stamps.map((date_modified_gmt, i) => ({ id: i, date_modified_gmt }))),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  it('reports the last modified stamp it saw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T10:00:00', '2026-07-01T11:00:00']),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.resumeFrom).toBe('2026-07-01T11:00:00')
    expect(res.sortedByModified).toBe(true)
  })

  // If the store ignored orderby=modified, advancing to the last row would skip
  // every order it did not happen to return. Say so instead.
  it('refuses to vouch for a store that did not sort by modified date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T11:00:00', '2026-07-01T10:00:00']),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(false)
  })

  it('treats a missing modified stamp as unsortable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(false)
  })

  // A first sync is sorted by CREATED date, so modified stamps are legitimately
  // out of order. Checking them there would raise a false alarm every time.
  it('does not judge the ordering of a first-sync chunk', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T11:00:00', '2026-07-01T10:00:00']),
    ))

    const res = await fetchOrders(CREDS, { createdAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(true)
    expect(res.resumeFrom).toBeUndefined()
  })
})
