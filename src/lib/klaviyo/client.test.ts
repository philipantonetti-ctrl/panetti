import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KlaviyoApiError,
  fetchCampaignValues,
  fetchCampaigns,
  findPlacedOrderMetricId,
  verifyKey,
} from './client'

afterEach(() => vi.unstubAllGlobals())

const KEY = 'pk_test_1234567890'

function stub(...responses: Response[]) {
  const mock = vi.fn()
  for (const r of responses) mock.mockResolvedValueOnce(r)
  vi.stubGlobal('fetch', mock)
  return mock
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('verifyKey', () => {
  it('sends the private key and the pinned revision, and reads the currency back', async () => {
    const mock = stub(
      json({ data: [{ type: 'account', id: 'AB12CD', attributes: { preferred_currency: 'NOK', test_account: false } }] }),
    )

    const account = await verifyKey(KEY)

    expect(account).toEqual({ accountId: 'AB12CD', currency: 'NOK' })
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://a.klaviyo.com/api/accounts')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Klaviyo-API-Key ${KEY}`)
    expect(headers.revision).toBe('2026-07-15')
  })

  it('turns a 401 into words a person can act on, without echoing the key', async () => {
    stub(json({ errors: [{ detail: 'Incorrect authentication' }] }, 401))

    await expect(verifyKey(KEY)).rejects.toThrow(KlaviyoApiError)
    await stub(json({ errors: [] }, 401)) // fresh stub, same shape
    const err = await verifyKey(KEY).catch((e: Error) => e)
    expect(String(err)).toMatch(/rejected the key/i)
    expect(String(err)).not.toContain(KEY)
  })
})

describe('fetchCampaigns', () => {
  it('walks both channels and every page, and keeps name, channel and send time', async () => {
    stub(
      // email, page 1 of 2
      json({
        data: [{ id: 'c1', attributes: { name: 'August news', send_time: '2026-08-01T09:00:00+00:00' } }],
        links: { next: 'https://a.klaviyo.com/api/campaigns?page%5Bcursor%5D=abc' },
      }),
      // email, page 2
      json({ data: [{ id: 'c2', attributes: { name: 'Pizza week', send_time: null } }], links: { next: null } }),
      // sms
      json({ data: [{ id: 'c3', attributes: { name: 'SMS blast', send_time: '2026-08-10T10:00:00+00:00' } }], links: { next: null } }),
    )

    const campaigns = await fetchCampaigns(KEY)

    expect(campaigns).toEqual([
      { id: 'c1', name: 'August news', channel: 'email', sentAt: new Date('2026-08-01T09:00:00Z') },
      { id: 'c2', name: 'Pizza week', channel: 'email', sentAt: null },
      { id: 'c3', name: 'SMS blast', channel: 'sms', sentAt: new Date('2026-08-10T10:00:00Z') },
    ])
  })
})

describe('findPlacedOrderMetricId', () => {
  it('finds the Placed Order metric revenue is attributed against', async () => {
    stub(
      json({
        data: [
          { id: 'M1', attributes: { name: 'Opened Email' } },
          { id: 'M2', attributes: { name: 'Placed Order' } },
        ],
        links: { next: null },
      }),
    )
    expect(await findPlacedOrderMetricId(KEY)).toBe('M2')
  })

  it('answers null when the account has no such metric, rather than inventing one', async () => {
    stub(json({ data: [{ id: 'M1', attributes: { name: 'Opened Email' } }], links: { next: null } }))
    expect(await findPlacedOrderMetricId(KEY)).toBeNull()
  })
})

describe('fetchCampaignValues', () => {
  it('asks for the twelve-month report grouped by campaign, and parses the rows', async () => {
    const mock = stub(
      json({
        data: {
          attributes: {
            results: [
              {
                groupings: { campaign_id: 'c1', send_channel: 'email' },
                statistics: { recipients: 500, opens: 200, clicks: 40, conversions: 12, conversion_value: 15432.5 },
              },
            ],
          },
        },
      }),
    )

    const rows = await fetchCampaignValues(KEY, 'M2')

    expect(rows).toEqual([
      { campaignId: 'c1', recipients: 500, opens: 200, clicks: 40, conversions: 12, conversionValue: 1543250 },
    ])
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://a.klaviyo.com/api/campaign-values-reports')
    const body = JSON.parse(String(init.body))
    expect(body.data.type).toBe('campaign-values-report')
    expect(body.data.attributes.timeframe).toEqual({ key: 'last_12_months' })
    expect(body.data.attributes.conversion_metric_id).toBe('M2')
    expect(body.data.attributes.statistics).toContain('opens')
  })

  it('leaves revenue out of the request when the account has no order metric', async () => {
    const mock = stub(json({ data: { attributes: { results: [] } } }))

    await fetchCampaignValues(KEY, null)

    const body = JSON.parse(String((mock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.data.attributes.conversion_metric_id).toBeUndefined()
    expect(body.data.attributes.statistics).not.toContain('conversions')
    expect(body.data.attributes.statistics).not.toContain('conversion_value')
  })
})
