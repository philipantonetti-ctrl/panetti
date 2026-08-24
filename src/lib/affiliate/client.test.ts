import { afterEach, describe, expect, it, vi } from 'vitest'
import { AffiliateApiError, fetchAdvertiser, fetchTransactions } from './client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

// Trimmed from a real /advertisers answer (2026-08-24). The markets object is
// keyed by market code and carries the webshop URL — the shop-mapping key.
const advertisers = {
  results: [
    {
      id: 986851,
      displayName: 'Panetti',
      name: 'Ledende Teknologi AS',
      type: 'advertiser',
      markets: {
        NO: { market: 'NO', url: 'https://www.panetti.no', status: 'active' },
        DE: { market: 'DE', url: 'https://www.panetti.de', status: 'active' },
      },
    },
  ],
  meta: { totalCount: 1, hasNextPage: false },
}

// Trimmed from a real /transactions answer. commission/eventValue are STRINGS,
// brokerageFee is a NUMBER, and the `currencies` conversion map is ignored.
const tx = (over: Record<string, unknown> = {}) => ({
  id: 1176373,
  date: '2026-01-02',
  channelId: 3464435,
  channelName: 'Forbrukertesten.com',
  market: 'NO',
  currency: 'NOK',
  eventValue: '855.64',
  commission: '128.35',
  brokerageFee: 19.25,
  status: 'paidOut',
  denyDate: null,
  eventOrderId: '19101',
  ...over,
})

describe('fetchAdvertiser', () => {
  it('reads the advertiser id, name and market URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(advertisers)))
    const a = await fetchAdvertiser('token-1')
    expect(a.externalId).toBe('986851')
    expect(a.name).toBe('Panetti')
    expect(a.markets).toEqual([
      { market: 'NO', url: 'https://www.panetti.no' },
      { market: 'DE', url: 'https://www.panetti.de' },
    ])
  })

  it('sends the bearer token', async () => {
    const spy = vi.fn().mockResolvedValue(json(advertisers))
    vi.stubGlobal('fetch', spy)
    await fetchAdvertiser('token-1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('https://addrevenue.io/api/v2/advertisers')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
  })

  it('a rejected token is a plain-words error, not a stack trace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Invalid token' }, 403)))
    await expect(fetchAdvertiser('bad')).rejects.toThrow(AffiliateApiError)
    await expect(fetchAdvertiser('bad')).rejects.toThrow(/rejected the token/i)
  })

  it('a server error names the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'boom' }, 500)))
    await expect(fetchAdvertiser('t')).rejects.toThrow(/Addrevenue answered 500/)
  })

  it('a network failure is plain words too, not a fetch stack', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(fetchAdvertiser('t')).rejects.toThrow(/could not reach Addrevenue/i)
  })

  it('a 200 that is not JSON is a plain-words error, not a SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('not json', { status: 200 }))),
    )
    await expect(fetchAdvertiser('t')).rejects.toThrow(AffiliateApiError)
    await expect(fetchAdvertiser('t')).rejects.toThrow(/was not JSON/i)
  })

  it('a token with no advertiser behind it says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ results: [], meta: { totalCount: 0, hasNextPage: false } })))
    await expect(fetchAdvertiser('t')).rejects.toThrow(/no advertiser account is attached/i)
  })
})

describe('fetchTransactions', () => {
  it('turns money strings into integer minor units and the date into UTC midnight', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ results: [tx()], meta: { totalCount: 1, hasNextPage: false } })),
    )
    const [row] = await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })
    expect(row).toEqual({
      externalId: '1176373',
      date: new Date('2026-01-02T00:00:00.000Z'),
      market: 'NO',
      channelId: '3464435',
      channelName: 'Forbrukertesten.com',
      status: 'paidOut',
      denyDate: null,
      commission: 12835,
      brokerageFee: 1925,
      orderValue: 85564,
      currency: 'NOK',
      eventOrderId: '19101',
    })
  })

  it('a null commission or brokerage is zero, and a denyDate becomes a Date', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          results: [tx({ commission: null, brokerageFee: null, denyDate: '2026-03-01 10:00:00', eventOrderId: null })],
          meta: { totalCount: 1, hasNextPage: false },
        }),
      ),
    )
    const [row] = await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })
    expect(row.commission).toBe(0)
    expect(row.brokerageFee).toBe(0)
    expect(row.denyDate).toEqual(new Date('2026-03-01T00:00:00.000Z'))
    expect(row.eventOrderId).toBeNull()
  })

  it('a missing date is a plain-words error, not a TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({ results: [tx({ date: undefined })], meta: { totalCount: 1, hasNextPage: false } }),
      ),
    )
    await expect(fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })).rejects.toThrow(
      /without a readable date/i,
    )
  })

  it('a garbage date is loud, never a silent Invalid Date', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({ results: [tx({ date: 'garbage' })], meta: { totalCount: 1, hasNextPage: false } }),
      ),
    )
    await expect(fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })).rejects.toThrow(
      /without a readable date/i,
    )
  })

  it('the first request carries no offset', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(json({ results: [tx()], meta: { totalCount: 1, hasNextPage: false } }))
    vi.stubGlobal('fetch', spy)
    await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })
    expect(String(spy.mock.calls[0][0])).not.toContain('offset=')
  })

  it('an empty page ends the walk even when hasNextPage claims more', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(json({ results: [tx()], meta: { totalCount: 2, hasNextPage: true } }))
      .mockResolvedValueOnce(json({ results: [], meta: { totalCount: 2, hasNextPage: true } }))
    vi.stubGlobal('fetch', spy)
    const rows = await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })
    expect(rows).toHaveLength(1)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('follows hasNextPage with an offset until the platform says done', async () => {
    const page = (id: number, hasNextPage: boolean) =>
      json({ results: [tx({ id })], meta: { totalCount: 2, hasNextPage } })
    const spy = vi
      .fn()
      .mockResolvedValueOnce(page(1, true))
      .mockResolvedValueOnce(page(2, false))
    vi.stubGlobal('fetch', spy)
    const rows = await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' })
    expect(rows.map((r) => r.externalId)).toEqual(['1', '2'])
    expect(String(spy.mock.calls[1][0])).toContain('offset=1')
  })

  it('refuses to run away when the platform pages forever', async () => {
    // Fresh Response per call — a body can only be read once.
    const spy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json({ results: [tx()], meta: { totalCount: 999999, hasNextPage: true } })),
      )
    vi.stubGlobal('fetch', spy)
    const err = await fetchTransactions('t', { fromDate: '2025-07-01', toDate: '2026-08-24' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AffiliateApiError)
    expect(String(err)).toMatch(/kept paging past 20 pages/)
    expect(spy).toHaveBeenCalledTimes(20)
  })
})
