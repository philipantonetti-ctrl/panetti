import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMetaDaily, parseMetaInsights, verifyMeta } from './meta'
import { AdApiError } from './types'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('parseMetaInsights', () => {
  it('maps a day of delivery into minor units', () => {
    const rows = parseMetaInsights([
      { date_start: '2026-07-01', spend: '123.45', impressions: '1000', clicks: '50' },
    ])
    expect(rows).toEqual([
      { date: new Date('2026-07-01T00:00:00Z'), spend: 12345, impressions: 1000, clicks: 50 },
    ])
  })

  it('skips rows without a date and tolerates missing fields', () => {
    const rows = parseMetaInsights([{ spend: '9.99' }, { date_start: '2026-07-02' }])
    expect(rows).toEqual([
      { date: new Date('2026-07-02T00:00:00Z'), spend: 0, impressions: 0, clicks: 0 },
    ])
  })
})

describe('fetchMetaDaily', () => {
  it('asks for daily account-level insights with the token in a header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaDaily({ accessToken: 'tok-1' }, '123', new Date('2026-07-01'), new Date('2026-07-10'))

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://graph.facebook.com/v25.0/act_123/insights')
    expect(url).toContain('level=account')
    expect(url).toContain('time_increment=1')
    expect(url).toContain(encodeURIComponent('2026-07-01'))
    expect(url).not.toContain('tok-1')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('follows paging.next and concatenates the pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          data: [{ date_start: '2026-07-01', spend: '10.00', impressions: '1', clicks: '1' }],
          paging: { next: 'https://graph.facebook.com/v25.0/act_123/insights?after=abc' },
        }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ date_start: '2026-07-02', spend: '20.00', impressions: '2', clicks: '2' }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchMetaDaily(
      { accessToken: 't' },
      '123',
      new Date('2026-07-01'),
      new Date('2026-07-02'),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(rows.map((r) => r.spend)).toEqual([1000, 2000])
  })

  it("throws the provider's own message on a rejected token", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'Invalid OAuth access token' } }, 401)),
    )
    await expect(
      fetchMetaDaily({ accessToken: 'bad' }, '123', new Date(), new Date()),
    ).rejects.toThrow(new AdApiError('Invalid OAuth access token'))
  })
})

describe('verifyMeta', () => {
  it('returns the account name and currency', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ name: 'Panetti NO', currency: 'NOK' })))
    expect(await verifyMeta({ accessToken: 't' }, '123')).toEqual({
      name: 'Panetti NO',
      currency: 'NOK',
    })
  })

  it('refuses an answer without a currency', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ name: 'X' })))
    await expect(verifyMeta({ accessToken: 't' }, '123')).rejects.toThrow(AdApiError)
  })
})
