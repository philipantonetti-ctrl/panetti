import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchMetaBreakdown,
  fetchMetaDaily,
  fetchMetaDailyBudget,
  parseMetaInsights,
  verifyMeta,
} from './meta'
import { AdApiError } from './types'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

const zeros = {
  linkClicks: 0,
  conversions: 0,
  conversionValue: 0,
  videoViews3s: 0,
  thruplays: 0,
  reach: 0,
}

describe('parseMetaInsights', () => {
  it('maps a day of delivery into minor units', () => {
    const rows = parseMetaInsights([
      { date_start: '2026-07-01', spend: '123.45', impressions: '1000', clicks: '50' },
    ])
    expect(rows).toEqual([
      { date: new Date('2026-07-01T00:00:00Z'), spend: 12345, impressions: 1000, clicks: 50, ...zeros },
    ])
  })

  it('skips rows without a date and tolerates missing fields', () => {
    const rows = parseMetaInsights([{ spend: '9.99' }, { date_start: '2026-07-02' }])
    expect(rows).toEqual([
      { date: new Date('2026-07-02T00:00:00Z'), spend: 0, impressions: 0, clicks: 0, ...zeros },
    ])
  })

  it('reads purchases, their value, link clicks and video plays from the action lists', () => {
    const rows = parseMetaInsights([
      {
        date_start: '2026-07-01',
        spend: '100.00',
        impressions: '1000',
        clicks: '50',
        inline_link_clicks: '40',
        reach: '600',
        actions: [
          { action_type: 'omni_purchase', value: '3' },
          { action_type: 'video_view', value: '250' },
        ],
        action_values: [{ action_type: 'omni_purchase', value: '764.50' }],
        video_thruplay_watched_actions: [{ action_type: 'video_view', value: '50' }],
      },
    ])
    expect(rows[0]).toMatchObject({
      linkClicks: 40,
      reach: 600,
      conversions: 3,
      conversionValue: 76450,
      videoViews3s: 250,
      thruplays: 50,
    })
  })

  it('falls back to plain purchase actions on accounts without omni tracking', () => {
    const rows = parseMetaInsights([
      {
        date_start: '2026-07-01',
        actions: [{ action_type: 'purchase', value: '2' }],
        action_values: [{ action_type: 'purchase', value: '99.99' }],
      },
    ])
    expect(rows[0]).toMatchObject({ conversions: 2, conversionValue: 9999 })
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

describe('fetchMetaDailyBudget', () => {
  it('sums the daily budgets of ACTIVE campaigns only, across pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          data: [
            { daily_budget: '800000', effective_status: 'ACTIVE' },
            { daily_budget: '999999', effective_status: 'PAUSED' },
            { effective_status: 'ACTIVE' }, // lifetime budget: no daily amount
          ],
          paging: { next: 'https://graph.facebook.com/v25.0/act_1/campaigns?after=x' },
        }),
      )
      .mockResolvedValueOnce(json({ data: [{ daily_budget: '200000', effective_status: 'ACTIVE' }] }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchMetaDailyBudget({ accessToken: 't' }, '1')).toBe(1_000_000)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/act_1/campaigns')
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

describe('fetchMetaBreakdown', () => {
  const CREDS = { accessToken: 'tok' }
  const FROM = new Date('2026-07-01T00:00:00Z')
  const TO = new Date('2026-07-31T00:00:00Z')

  const page = (rows: unknown[]) =>
    new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  it('hangs campaign insights off the ad account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaBreakdown(CREDS, { level: 'campaign', accountExternalId: '123' }, FROM, TO)

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/act_123/insights')
    expect(url).toContain('level=campaign')
    expect(url).toContain('campaign_id')
    // Aggregated over the range: a per-day breakdown would be a different table.
    expect(url).not.toContain('time_increment')
  })

  it('hangs ad sets off the campaign they belong to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaBreakdown(
      CREDS,
      { level: 'adset', accountExternalId: '123', parentId: '777' },
      FROM,
      TO,
    )

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/777/insights')
    expect(url).toContain('level=adset')
    expect(url).not.toContain('act_123')
  })

  it('hangs ads off the ad set they belong to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaBreakdown(
      CREDS,
      { level: 'ad', accountExternalId: '123', parentId: '888' },
      FROM,
      TO,
    )

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/888/insights')
    expect(url).toContain('level=ad')
  })

  it('asks for exactly the range it was given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetaBreakdown(CREDS, { level: 'campaign', accountExternalId: '123' }, FROM, TO)

    const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]))
    expect(url).toContain('"since":"2026-07-01"')
    expect(url).toContain('"until":"2026-07-31"')
  })

  it('maps a row, taking purchases the same way the daily sync does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        page([
          {
            campaign_id: '777',
            campaign_name: 'KS - Pizzetta Pro UGC',
            spend: '2116.61',
            impressions: '12000',
            clicks: '216',
            actions: [{ action_type: 'omni_purchase', value: '284' }],
            action_values: [{ action_type: 'omni_purchase', value: '13482.79' }],
          },
        ]),
      ),
    )

    const [row] = await fetchMetaBreakdown(
      CREDS,
      { level: 'campaign', accountExternalId: '123' },
      FROM,
      TO,
    )

    expect(row).toEqual({
      id: '777',
      name: 'KS - Pizzetta Pro UGC',
      spend: 211661,
      purchases: 284,
      purchaseValue: 1348279,
      impressions: 12000,
      clicks: 216,
    })
  })

  // Older accounts report `purchase` where newer ones report `omni_purchase`.
  // The daily sync already handles both; this must not diverge from it.
  it('falls back to the older purchase action, as the daily sync does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        page([
          {
            campaign_id: '1',
            campaign_name: 'Old',
            spend: '10.00',
            actions: [{ action_type: 'purchase', value: '3' }],
            action_values: [{ action_type: 'purchase', value: '99.00' }],
          },
        ]),
      ),
    )

    const [row] = await fetchMetaBreakdown(
      CREDS,
      { level: 'campaign', accountExternalId: '1' },
      FROM,
      TO,
    )
    expect(row.purchases).toBe(3)
    expect(row.purchaseValue).toBe(9900)
  })

  it('follows paging', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ campaign_id: '1', campaign_name: 'A', spend: '1.00' }],
            paging: { next: 'https://graph.facebook.com/v25.0/next-page' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(page([{ campaign_id: '2', campaign_name: 'B', spend: '2.00' }]))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchMetaBreakdown(
      CREDS,
      { level: 'campaign', accountExternalId: '1' },
      FROM,
      TO,
    )
    expect(rows.map((r) => r.name)).toEqual(['A', 'B'])
  })

  it('turns a refusal into the platform’s own words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid OAuth token' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(
      fetchMetaBreakdown(CREDS, { level: 'campaign', accountExternalId: '1' }, FROM, TO),
    ).rejects.toThrow(/Invalid OAuth token/)
  })
})
