import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DinteroApiError,
  getToken,
  listSettlements,
  pickJsonReport,
  downloadReport,
} from './client'

const CREDS = { accountId: 'P12345678', clientId: 'cid', clientSecret: 'sec' }

afterEach(() => vi.unstubAllGlobals())

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('getToken', () => {
  it('mints a token with basic auth and the account audience', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'tok', expires_in: 14400 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await getToken(CREDS)).toBe('tok')

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.dintero.com/v1/accounts/P12345678/auth/token')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`)
    expect(JSON.parse(init.body)).toEqual({
      grant_type: 'client_credentials',
      audience: 'https://api.dintero.com/v1/accounts/P12345678',
    })
  })

  it('turns a 401 into words a person can act on, never the secret', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)))
    await expect(getToken(CREDS)).rejects.toThrow(
      /Dintero rejected the credentials/,
    )
  })

  it('refuses an answer with no token in it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })))
    await expect(getToken(CREDS)).rejects.toThrow(DinteroApiError)
  })
})

describe('listSettlements', () => {
  const settlement = (id: string) => ({
    id,
    provider: 'dintero_payout',
    settled_at: '2026-08-28T09:00:00Z',
    start_at: '2026-08-17T00:00:00Z',
    end_at: '2026-08-23T23:59:59Z',
    payment_status: 'paid',
    payout_destination_id: 'seller-1',
    attachments: [
      { id: 'a-pdf', extension: 'pdf', content_type: 'application/pdf', created_by: 'dintero' },
      { id: 'a-json', extension: 'json', content_type: 'application/json', created_by: 'dintero' },
    ],
    amounts: [{ amount: 19400, capture: 30000, refund: -10000, fee: 600, currency: 'NOK' }],
  })

  it('walks the pages and maps each settlement, minor units kept as integers', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => settlement(`s${i}`))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse([settlement('s100')]))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await listSettlements(CREDS, 'tok')
    expect(rows).toHaveLength(101)
    expect(rows[0]).toMatchObject({
      id: 's0',
      provider: 'dintero_payout',
      currency: 'NOK',
      amount: 19400,
      capture: 30000,
      refund: -10000,
      fee: 600,
      payoutDestinationId: 'seller-1',
    })
    expect(rows[0].settledAt).toEqual(new Date('2026-08-28T09:00:00Z'))

    const first = new URL(String(fetchMock.mock.calls[0][0]))
    expect(first.pathname).toBe('/v1/accounts/P12345678/settlements')
    expect(first.searchParams.get('limit')).toBe('100')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
    const second = new URL(String(fetchMock.mock.calls[1][0]))
    expect(second.searchParams.get('starting_after_id')).toBe('s99')
  })

  it('narrows to one payout destination when the config names one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    await listSettlements(CREDS, 'tok', { payoutDestinationId: 'seller-2' })
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get('payout_destination_id')).toBe('seller-2')
  })

  it('accepts an envelope answer as well as a bare array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ settlements: [settlement('s1')] })))
    expect(await listSettlements(CREDS, 'tok')).toHaveLength(1)
  })

  it('a settlement announced but not yet paid carries no settled date', async () => {
    const s = { ...settlement('s1'), settled_at: undefined, payment_status: 'postponed' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([s])))
    const [row] = await listSettlements(CREDS, 'tok')
    expect(row.settledAt).toBeNull()
  })
})

describe('pickJsonReport', () => {
  it('picks the JSON attachment among the formats', () => {
    expect(
      pickJsonReport([
        { id: 'a1', extension: 'pdf', contentType: 'application/pdf', createdBy: 'dintero' },
        { id: 'a2', extension: 'json', contentType: 'application/json', createdBy: 'dintero' },
        { id: 'a3', extension: 'csv', contentType: 'text/csv', createdBy: 'dintero' },
      ]),
    ).toBe('a2')
  })

  it('falls back to content type when the extension is missing', () => {
    expect(
      pickJsonReport([{ id: 'a9', extension: null, contentType: 'application/json', createdBy: null }]),
    ).toBe('a9')
  })

  it('answers null when the settlement has no JSON report', () => {
    expect(pickJsonReport([{ id: 'a1', extension: 'pdf', contentType: null, createdBy: null }])).toBeNull()
  })
})

describe('downloadReport', () => {
  it('reads the normalized report: totals, bank reference and one line per order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        date_from: '2026-08-17',
        date_to: '2026-08-23',
        settlement_date: '2026-08-28',
        dintero_settlement_id: 's1',
        account_id: 'P12345678',
        currency: 'NOK',
        amount: 19400,
        capture: 30000,
        refund: -10000,
        fee: 600,
        settlement_reference: 'DINTERO-42',
        transactions: [
          {
            transaction_id: 'P12345678.abc',
            reference: '3041',
            amount: 4900,
            capture: 5000,
            refund: 0,
            fee: 100,
            transaction_date: '2026-08-18',
            payment_product_type: 'dintero_payout.creditcard',
            card_brand: 'Visa',
          },
          // A refund line: negative money, same shape.
          {
            transaction_id: 'P12345678.def',
            reference: '2988',
            amount: -10000,
            capture: 0,
            refund: -10000,
            fee: 0,
            transaction_date: '2026-08-19',
            payment_product_type: 'dintero_payout.creditcard',
            card_brand: null,
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const report = await downloadReport(CREDS, 'tok', 's1', 'a-json')
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.dintero.com/v1/accounts/P12345678/settlements/s1/attachments/a-json',
    )
    expect(report.reference).toBe('DINTERO-42')
    expect(report.lines).toHaveLength(2)
    expect(report.lines[0]).toMatchObject({
      transactionId: 'P12345678.abc',
      reference: '3041',
      amount: 4900,
      capture: 5000,
      refund: 0,
      fee: 100,
      paymentType: 'dintero_payout.creditcard',
      cardBrand: 'Visa',
    })
    expect(report.lines[1].amount).toBe(-10000)
  })

  it('drops a line with no transaction id rather than storing an unkeyable row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          settlement_reference: 'X',
          transactions: [{ reference: '1', amount: 100, capture: 100, refund: 0, fee: 0 }],
        }),
      ),
    )
    const report = await downloadReport(CREDS, 'tok', 's1', 'a1')
    expect(report.lines).toHaveLength(0)
  })
})
