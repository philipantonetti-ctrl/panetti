import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchGoogleBreakdown,
  fetchGoogleCampaignDaily,
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

  // Task 4: a malformed or truncated 200 response used to be swallowed into
  // `null`, which parseGoogleChunks reads as zero rows — the sync then
  // recorded success with lastError: null. Low-impact when this was one
  // request per account; this branch makes it five windowed requests per
  // sync, so one parse failure now silently discards up to 90 days of
  // campaign spend and reports a plausible-looking short year. That is the
  // same silent-truncation class the Meta page-cap guard exists to prevent.
  it('throws rather than silently returning nothing when a 200 response cannot be parsed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('not valid json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchGoogleDaily(CREDS, '1', new Date(), new Date())).rejects.toThrow(AdApiError)
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

describe('fetchGoogleBreakdown', () => {
  const FROM = new Date('2026-07-01T00:00:00Z')
  const TO = new Date('2026-07-31T00:00:00Z')

  const reply = (results: unknown[]) =>
    new Response(JSON.stringify([{ results }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  /**
   * The GAQL actually sent, from the request body. fetchGoogleBreakdown goes
   * through searchStream, which mints a fresh access token before every query
   * (see the fetchGoogleDaily tests above) — so call [0] is always the token
   * exchange and the query itself is call [1].
   */
  const sentQuery = (fetchMock: { mock: { calls: unknown[][] } }) =>
    JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body)).query as string

  it('reads campaigns from the campaign resource', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reply([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleBreakdown(CREDS, { level: 'campaign', customerId: '111' }, FROM, TO)

    const q = sentQuery(fetchMock)
    expect(q).toContain('FROM campaign')
    expect(q).toContain("segments.date BETWEEN '2026-07-01' AND '2026-07-31'")
    // In SELECT it would segment by day and give us entities x days.
    expect(q).not.toContain('SELECT segments.date')
  })

  it('reads ad groups belonging to one campaign', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reply([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleBreakdown(
      CREDS,
      { level: 'adset', customerId: '111', parentId: '777' },
      FROM,
      TO,
    )

    const q = sentQuery(fetchMock)
    // 'FROM ad_group' alone is a prefix of 'FROM ad_group_ad' too, so it would
    // still pass if this level wrongly queried the ad resource instead.
    expect(q).toContain('FROM ad_group WHERE')
    expect(q).toContain('campaign.id = 777')
  })

  it('reads ads belonging to one ad group', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reply([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleBreakdown(CREDS, { level: 'ad', customerId: '111', parentId: '888' }, FROM, TO)

    const q = sentQuery(fetchMock)
    expect(q).toContain('FROM ad_group_ad')
    expect(q).toContain('ad_group.id = 888')
  })

  it('converts micros to minor units', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
        reply([
          {
            campaign: { id: '777', name: 'Brand' },
            metrics: {
              costMicros: '2116610000',
              conversions: 284,
              conversionsValue: 13482.79,
              impressions: '12000',
              clicks: '216',
            },
          },
        ]),
      ),
    )

    const [row] = await fetchGoogleBreakdown(CREDS, { level: 'campaign', customerId: '1' }, FROM, TO)

    expect(row).toEqual({
      id: '777',
      name: 'Brand',
      spend: 211661,
      purchases: 284,
      purchaseValue: 1348279,
      impressions: 12000,
      clicks: 216,
    })
  })

  // I5: most modern ad types (responsive search, Performance Max) leave the
  // ad's own name unset — it is an optional label, not every ad has one.
  // Meta's breakdown already falls back to the id for a missing name; Google
  // did neither, so this would have rendered a blank cell next to real
  // numbers.
  it('falls back to the id when the entity has no name, matching Meta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
        reply([
          {
            adGroupAd: { ad: { id: '999' } }, // no name field at all
            metrics: { costMicros: '10000000', impressions: '10', clicks: '1' },
          },
        ]),
      ),
    )

    const [row] = await fetchGoogleBreakdown(
      CREDS,
      { level: 'ad', customerId: '1', parentId: '1' },
      FROM,
      TO,
    )
    expect(row.id).toBe('999')
    expect(row.name).toBe('999')
  })

  // I5, the other half: a row with no id at all (a total row, the same shape
  // Meta's own breakdown parser skips) must be dropped rather than kept with
  // id: '' — that would collide with every other id-less row under the same
  // account on BreakdownTable's `accountId:id` React key.
  it('skips a row with no id, matching Meta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
        reply([
          { metrics: { costMicros: '10000000' } }, // no campaign object: a total row
          { campaign: { id: '777', name: 'Brand' }, metrics: { costMicros: '5000000' } },
        ]),
      ),
    )

    const rows = await fetchGoogleBreakdown(CREDS, { level: 'campaign', customerId: '1' }, FROM, TO)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('777')
  })
})

describe('fetchGoogleCampaignDaily', () => {
  it('returns one row per campaign per day', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        json([
          {
            results: [
              {
                campaign: { id: '111', name: 'Norway Brand' },
                segments: { date: '2026-03-01' },
                metrics: { costMicros: '1230000', impressions: '90', clicks: '4', conversions: 1.5, conversionsValue: '250.5' },
              },
              {
                campaign: { id: '222', name: 'Sweden Brand' },
                segments: { date: '2026-03-01' },
                metrics: { costMicros: '4560000', impressions: '10', clicks: '1' },
              },
            ],
          },
        ]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchGoogleCampaignDaily(CREDS, '123', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      campaignId: '111',
      campaignName: 'Norway Brand',
      spend: 123, // 1_230_000 micros / 10_000
      impressions: 90,
      clicks: 4,
      linkClicks: 4,
      conversions: 1.5,
      conversionValue: 25050,
    })
    expect(rows[1]).toMatchObject({ campaignId: '222', spend: 456 })
  })

  it('asks for segments.date in the SELECT, not only the WHERE', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGoogleCampaignDaily(CREDS, '123', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'))

    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { query: string }
    expect(body.query).toContain('SELECT campaign.id, campaign.name, segments.date')
    expect(body.query).toContain("BETWEEN '2026-03-01' AND '2026-03-02'")
  })

  it('splits a long range into chunked requests and concatenates them', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('oauth2')
          ? json({ access_token: 'live-token' })
          : json([{ results: [{ campaign: { id: '1', name: 'C' }, segments: { date: '2026-01-01' }, metrics: { costMicros: '10000' } }] }]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchGoogleCampaignDaily(CREDS, '123', new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'))

    // 365 days / 90 = 5 windows, so 5 searchStream calls and 5 rows back.
    const searchCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('searchStream'))
    expect(searchCalls).toHaveLength(5)
    expect(rows).toHaveLength(5)
  })

  it('skips a row with no campaign id rather than inventing one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json([{ results: [{ segments: { date: '2026-03-01' }, metrics: { costMicros: '10000' } }] }]))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchGoogleCampaignDaily(CREDS, '123', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))).toEqual([])
  })
})

