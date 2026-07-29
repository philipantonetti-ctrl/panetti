import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchGoogleDaily,
  fetchGoogleDailyBudget,
  googleAccessToken,
  microsToMinor,
  parseGoogleChunks,
  toDailyRows,
  verifyGoogle,
} from './google'
import { AdApiError, type GoogleCredentials } from './types'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const CREDS: GoogleCredentials = {
  developerToken: 'dev-tok',
  clientId: 'cid',
  clientSecret: 'sec',
  refreshToken: 'ref',
}

// A Response body reads once, so every test needs its own.
const tokenResponse = () => json({ access_token: 'live-token' })

afterEach(() => vi.unstubAllGlobals())

describe('microsToMinor', () => {
  it('turns micros into minor units', () => {
    expect(microsToMinor('1234560000')).toBe(123456)
    expect(microsToMinor(10_000)).toBe(1)
    expect(microsToMinor(undefined)).toBe(0)
    expect(microsToMinor('not-a-number')).toBe(0)
  })
})

const zeros = {
  linkClicks: 0,
  conversions: 0,
  conversionValue: 0,
  videoViews3s: 0,
  thruplays: 0,
  reach: 0,
}

describe('parseGoogleChunks / toDailyRows', () => {
  it('reads camelCase results across an array of chunks', () => {
    const rows = toDailyRows(
      parseGoogleChunks([
        { results: [{ segments: { date: '2026-07-01' }, metrics: { costMicros: '50000000', impressions: '100', clicks: '7' } }] },
        { results: [{ segments: { date: '2026-07-02' }, metrics: { costMicros: '10000' } }] },
      ]),
    )
    expect(rows).toEqual([
      { date: new Date('2026-07-01T00:00:00Z'), spend: 5000, impressions: 100, clicks: 7, ...zeros, linkClicks: 7 },
      { date: new Date('2026-07-02T00:00:00Z'), spend: 1, impressions: 0, clicks: 0, ...zeros },
    ])
  })

  it('tolerates snake_case fields and a bare object body', () => {
    const rows = toDailyRows(
      parseGoogleChunks({
        results: [{ segments: { date: '2026-07-03' }, metrics: { cost_micros: '20000' } }],
      }),
    )
    expect(rows).toEqual([
      { date: new Date('2026-07-03T00:00:00Z'), spend: 2, impressions: 0, clicks: 0, ...zeros },
    ])
  })

  it('carries conversions and their value into minor units', () => {
    const rows = toDailyRows([
      {
        segments: { date: '2026-07-04' },
        metrics: { costMicros: '10000000', clicks: '20', conversions: 2.5, conversionsValue: 764.5 },
      },
    ])
    expect(rows[0]).toMatchObject({
      conversions: 2.5,
      conversionValue: 76450,
      linkClicks: 20,
    })
  })
})

describe('googleAccessToken', () => {
  it('exchanges the refresh token for an access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse())
    vi.stubGlobal('fetch', fetchMock)

    expect(await googleAccessToken(CREDS)).toBe('live-token')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    const form = String(init.body)
    expect(form).toContain('grant_type=refresh_token')
    expect(form).toContain('refresh_token=ref')
  })

  it("throws Google's explanation when the exchange fails", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)),
    )
    await expect(googleAccessToken(CREDS)).rejects.toThrow(
      new AdApiError('Token has been expired or revoked.'),
    )
  })
})

describe('fetchGoogleDaily', () => {
  it('sends the developer token and a daily GAQL query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json([{ results: [] }]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleDaily(CREDS, '9998887776', new Date('2026-07-01'), new Date('2026-07-10'))

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://googleads.googleapis.com/v25/customers/9998887776/googleAds:searchStream')
    const headers = init.headers as Record<string, string>
    expect(headers['developer-token']).toBe('dev-tok')
    expect(headers.Authorization).toBe('Bearer live-token')
    expect(headers['login-customer-id']).toBeUndefined()
    const query = (JSON.parse(String(init.body)) as { query: string }).query
    expect(query).toContain('FROM customer')
    expect(query).toContain("BETWEEN '2026-07-01' AND '2026-07-10'")
  })

  it('names the manager account when one is configured', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json([{ results: [] }]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleDaily({ ...CREDS, loginCustomerId: '111' }, '222', new Date(), new Date())
    const headers = (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['login-customer-id']).toBe('111')
  })

  it("surfaces the API's error message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json({ error: { message: 'The developer token is not approved.' } }, 403))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchGoogleDaily(CREDS, '1', new Date(), new Date())).rejects.toThrow(
      new AdApiError('The developer token is not approved.'),
    )
  })
})

describe('fetchGoogleDailyBudget', () => {
  it('asks for ENABLED campaigns and counts a shared budget once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        json([
          {
            results: [
              { campaignBudget: { resourceName: 'customers/1/campaignBudgets/10', amountMicros: '80000000' } },
              { campaignBudget: { resourceName: 'customers/1/campaignBudgets/10', amountMicros: '80000000' } },
              { campaign_budget: { resource_name: 'customers/1/campaignBudgets/11', amount_micros: '20000000' } },
            ],
          },
        ]),
      )
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchGoogleDailyBudget(CREDS, '1')).toBe(10_000)
    const query = (JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { query: string }).query
    expect(query).toContain("campaign.status = 'ENABLED'")
  })
})

describe('verifyGoogle', () => {
  it('reads the account name and currency, camel or snake', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        json([{ results: [{ customer: { descriptiveName: 'Panetti SE', currencyCode: 'SEK' } }] }]),
      )
    vi.stubGlobal('fetch', fetchMock)
    expect(await verifyGoogle(CREDS, '42')).toEqual({ name: 'Panetti SE', currency: 'SEK' })
  })

  it('falls back to a generic name but never a missing currency', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json([{ results: [{ customer: { currency_code: 'EUR' } }] }]))
    vi.stubGlobal('fetch', fetchMock)
    expect(await verifyGoogle(CREDS, '42')).toEqual({ name: 'Google Ads 42', currency: 'EUR' })

    const failMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json([{ results: [{ customer: {} }] }]))
    vi.stubGlobal('fetch', failMock)
    await expect(verifyGoogle(CREDS, '42')).rejects.toThrow(AdApiError)
  })
})

