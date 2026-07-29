import { afterEach, describe, expect, it, vi } from 'vitest'
import { listGoogleAdAccounts, listMetaAdAccounts, parseCustomerClients } from './listing'
import type { GoogleCredentials } from './types'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const CREDS: GoogleCredentials = {
  developerToken: 'dev',
  clientId: 'cid',
  clientSecret: 'sec',
  refreshToken: 'ref',
}

afterEach(() => vi.unstubAllGlobals())

describe('listMetaAdAccounts', () => {
  it('collects the login’s ad accounts across pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          data: [{ account_id: '111', name: 'Mazzetti - NO', currency: 'NOK' }],
          paging: { next: 'https://graph.facebook.com/v25.0/me/adaccounts?after=x' },
        }),
      )
      .mockResolvedValueOnce(json({ data: [{ account_id: '222', name: 'Panetti Danmark', currency: 'DKK' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const accounts = await listMetaAdAccounts('tok')
    expect(accounts).toEqual([
      { externalId: '111', name: 'Mazzetti - NO', currency: 'NOK' },
      { externalId: '222', name: 'Panetti Danmark', currency: 'DKK' },
    ])
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
  })
})

describe('parseCustomerClients', () => {
  it('keeps leaves, drops managers, and tags accounts reached through one', () => {
    const accounts = parseCustomerClients(
      [
        { customerClient: { id: '900', descriptiveName: 'My MCC', manager: true } },
        { customerClient: { id: '901', descriptiveName: 'Mazzetti NO', currencyCode: 'NOK', manager: false } },
        { customer_client: { id: '902', descriptive_name: 'Mazzetti SE', currency_code: 'SEK', manager: false } },
      ],
      '900',
    )
    expect(accounts).toEqual([
      { externalId: '901', name: 'Mazzetti NO', currency: 'NOK', loginCustomerId: '900' },
      { externalId: '902', name: 'Mazzetti SE', currency: 'SEK', loginCustomerId: '900' },
    ])
  })

  it('leaves off the manager header for a directly accessible account', () => {
    const accounts = parseCustomerClients(
      [{ customerClient: { id: '55', descriptiveName: 'Solo', currencyCode: 'EUR', manager: false } }],
      '55',
    )
    expect(accounts).toEqual([{ externalId: '55', name: 'Solo', currency: 'EUR' }])
  })
})

describe('listGoogleAdAccounts', () => {
  it('flattens every accessible customer and dedupes', async () => {
    const fetchMock = vi
      .fn()
      // token exchange
      .mockResolvedValueOnce(json({ access_token: 'at' }))
      .mockResolvedValueOnce(json({ resourceNames: ['customers/900'] }))
      .mockResolvedValueOnce(
        json([
          {
            results: [
              { customerClient: { id: '900', manager: true } },
              { customerClient: { id: '901', descriptiveName: 'Mazzetti NO', currencyCode: 'NOK', manager: false } },
            ],
          },
        ]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const accounts = await listGoogleAdAccounts(CREDS)
    expect(accounts).toEqual([
      { externalId: '901', name: 'Mazzetti NO', currency: 'NOK', loginCustomerId: '900' },
    ])

    const clientCall = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(clientCall[0]).toContain('customers/900/googleAds:searchStream')
    const headers = clientCall[1].headers as Record<string, string>
    expect(headers['login-customer-id']).toBe('900')
    expect(headers['developer-token']).toBe('dev')
  })
})
