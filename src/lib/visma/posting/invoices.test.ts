import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVismaTokenCache } from '../client'
import { TEST_TENANT_ID } from '../write'
import { findOurPayment, readOpenInvoices } from './invoices'

const creds = { clientId: 'cid', clientSecret: 'sec', tenantId: TEST_TENANT_ID }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

const row = (n: number, over: Record<string, unknown> = {}) => ({
  referenceNumber: { value: String(130000 + n) },
  customer: { number: '10859', name: 'Panetti Deutschland - Webkunde' },
  status: 'Open',
  currencyId: 'EUR',
  balanceInCurrency: 29.99,
  customerRefNumber: String(14000 + n),
  ...over,
})

beforeEach(() => resetVismaTokenCache())
afterEach(() => vi.unstubAllGlobals())

describe('readOpenInvoices', () => {
  it('pages until a short page, and keeps only open invoices of THAT customer', async () => {
    const urls: string[] = []
    const page1 = Array.from({ length: 100 }, (_, i) => row(i))
    const page2 = [row(100), row(101, { status: 'Closed' }), row(102, { customer: { number: '99999' } })]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('connect/token')) return json({ access_token: 't', expires_in: 3600 })
        urls.push(u)
        return json(u.includes('pageNumber=1') ? page1 : page2)
      }),
    )
    const { invoices, calls } = await readOpenInvoices(creds, '10859')
    expect(calls).toBe(2)
    expect(urls[0]).toContain('/v1/customerinvoice?customer=10859&status=Open&pageSize=100&pageNumber=1')
    expect(invoices).toHaveLength(101)
    expect(invoices[0]).toEqual({ number: '130000', customerRefNumber: '14000', currency: 'EUR', balance: 2999 })
  })

  it('stops when Visma repeats a full page: no duplicates, and the repeat is not a second page', async () => {
    const same = Array.from({ length: 100 }, (_, i) => row(i))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token') ? json({ access_token: 't', expires_in: 3600 }) : json(same),
      ),
    )
    const { invoices, calls } = await readOpenInvoices(creds, '10859')
    expect(invoices).toHaveLength(100)
    expect(new Set(invoices.map((i) => i.number)).size).toBe(100)
    expect(calls).toBe(2)
  })

  it('skips a row with no referenceNumber rather than returning a ghost invoice', async () => {
    const { referenceNumber: _drop, ...noNumber } = row(7)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token') ? json({ access_token: 't', expires_in: 3600 }) : json([noNumber, row(1)]),
      ),
    )
    const { invoices } = await readOpenInvoices(creds, '10859')
    expect(invoices.map((i) => i.number)).toEqual(['130001'])
  })
})

describe('findOurPayment', () => {
  it('returns the payment carrying our Dintero reference, ignoring others', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('connect/token')) return json({ access_token: 't', expires_in: 3600 })
        expect(u).toContain('/v1/customerPayment?customer=10859&invoiceRefNbr=130474')
        return json([
          { refNbr: '000100', paymentRef: '130474' },
          { refNbr: '000101', paymentRef: { value: 'R17882-6311A9' } },
        ])
      }),
    )
    expect(await findOurPayment(creds, '10859', '130474', 'R17882-6311A9')).toBe('000101')
  })

  it('is null without calling Visma when our reference is blank', async () => {
    const f = vi.fn(async (url: string) =>
      String(url).includes('connect/token') ? json({ access_token: 't', expires_in: 3600 }) : json([]),
    )
    vi.stubGlobal('fetch', f)
    expect(await findOurPayment(creds, '10859', '130474', '')).toBeNull()
    expect(await findOurPayment(creds, '10859', '130474', '   ')).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('does not accept a payment whose lines belong to another invoice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token')
          ? json({ access_token: 't', expires_in: 3600 })
          : json([{ refNbr: '000200', paymentRef: 'R17882-6311A9', paymentLines: [{ refNbr: { value: '130999' } }] }]),
      ),
    )
    expect(await findOurPayment(creds, '10859', '130474', 'R17882-6311A9')).toBeNull()
  })

  it('accepts a payment whose lines include this invoice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token')
          ? json({ access_token: 't', expires_in: 3600 })
          : json([{ refNbr: '000201', paymentRef: 'R17882-6311A9', paymentLines: [{ refNbr: { value: '130474' } }] }]),
      ),
    )
    expect(await findOurPayment(creds, '10859', '130474', 'R17882-6311A9')).toBe('000201')
  })

  it('is null when none carries it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token') ? json({ access_token: 't', expires_in: 3600 }) : json([]),
      ),
    )
    expect(await findOurPayment(creds, '10859', '130474', 'R1')).toBeNull()
  })
})
