import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
vi.mock('@/lib/visma/client', () => ({ vismaCredentials: vi.fn(), vismaGet: vi.fn() }))
vi.mock('@/lib/visma/pages', () => ({ vismaGetPages: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { vismaCredentials, vismaGet } from '@/lib/visma/client'
import { vismaGetPages } from '@/lib/visma/pages'
import { GET } from './route'

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
const get = (qs: string) => GET(new Request(`http://x/api/diagnostics/visma-order?${qs}`))

describe('GET /api/diagnostics/visma-order', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(vismaCredentials).mockReturnValue({ clientId: 'c', clientSecret: 's', tenantId: 't' })
  })

  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    expect((await get('customer=10421&number=30187')).status).toBe(403)
    expect(vismaGet).not.toHaveBeenCalled()
  })

  it('needs a customer number and an order number', async () => {
    admin()
    expect((await get('customer=10421')).status).toBe(400)
    expect((await get('number=30187')).status).toBe(400)
  })

  it('says so when Visma is not configured here', async () => {
    admin()
    vi.mocked(vismaCredentials).mockReturnValue(null)
    expect((await get('customer=10421&number=30187')).status).toBe(503)
  })

  /**
   * Visma ignores a filter it does not know and answers 200 with every row,
   * so the order number is never trusted to a query parameter: the rows come
   * back for the customer and the date, and the match is made HERE, field by
   * field, on what each row actually carries.
   */
  it('reads the house customer since the date and keeps only rows carrying the order number', async () => {
    admin()
    vi.mocked(vismaGet)
      .mockResolvedValueOnce([
        { orderType: 'SO', orderNo: '500901', status: 'Open', date: '2026-10-08T09:00:00', customerOrder: '30187', customerRefNo: '', orderTotal: 4999, currency: 'NOK', lastModifiedDateTime: '2026-10-08T09:01:00' },
        { orderType: 'SO', orderNo: '500902', status: 'Open', date: '2026-10-08T09:00:00', customerOrder: '30188', customerRefNo: '', orderTotal: 4999, currency: 'NOK', lastModifiedDateTime: '2026-10-08T09:01:00' },
        { orderType: 'SO', orderNo: '500903', status: 'Open', date: '2026-10-08T09:00:00', customerOrder: '', customerRefNo: '301870', orderTotal: 1, currency: 'NOK', lastModifiedDateTime: '2026-10-08T09:01:00' },
      ])
      .mockResolvedValueOnce([
        { referenceNumber: '131000', documentDate: '2026-10-08T00:00:00', status: 'Open', customerRefNumber: '30187', externalReference: '30187', amountInCurrency: 4999, currencyId: 'NOK' },
        { referenceNumber: '131001', documentDate: '2026-10-08T00:00:00', status: 'Open', customerRefNumber: '30190', externalReference: '30190', amountInCurrency: 1, currencyId: 'NOK' },
      ])

    const res = await get('customer=10421&number=30187&since=2026-10-05')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')

    const [orders, invoices] = vi.mocked(vismaGet).mock.calls.map((c) => c[1])
    expect(orders).toBe(
      'controller/api/v1/customer/10421/salesorderbasic?lastModifiedDateTime=2026-10-05&lastModifiedDateTimeCondition=%3E&pageSize=500',
    )
    expect(invoices).toBe(
      'controller/api/v1/customerinvoice?customer=10421&documentDate=2026-10-05&documentDateCondition=%3E&pageSize=500',
    )

    const body = await res.json()
    expect(body.scanned).toEqual({ salesOrders: 3, invoices: 2 })
    expect(body.salesOrders).toEqual([
      { orderType: 'SO', orderNo: '500901', status: 'Open', date: '2026-10-08T09:00:00', customerOrder: '30187', customerRefNo: '', orderTotal: 4999, currency: 'NOK', lastModified: '2026-10-08T09:01:00' },
    ])
    expect(body.invoices).toEqual([
      { referenceNumber: '131000', documentDate: '2026-10-08T00:00:00', status: 'Open', customerRefNumber: '30187', externalReference: '30187', amount: 4999, currency: 'NOK' },
    ])
    expect(body.found).toBe(true)
  })

  it('reads Visma values that arrive wrapped as {value}', async () => {
    admin()
    vi.mocked(vismaGet)
      .mockResolvedValueOnce([
        { orderType: { value: 'SO' }, orderNo: { value: '500901' }, status: { value: 'Open' }, customerOrder: { value: '30187' }, orderTotal: { value: 4999 }, currency: { value: 'NOK' } },
      ])
      .mockResolvedValueOnce([])
    const body = await (await get('customer=10421&number=30187')).json()
    expect(body.salesOrders[0]).toMatchObject({ orderNo: '500901', customerOrder: '30187', orderTotal: 4999 })
    expect(body.found).toBe(true)
  })

  /**
   * "Which orders of all nine shops never reached Visma?" cannot be asked one
   * number at a time: Visma refuses after about ten quick calls. List mode
   * reads every page of the customer's sales orders and invoices since the
   * date once, and answers every webshop order number it holds.
   */
  it('in list mode answers every order number Visma holds for the customer, from every page', async () => {
    admin()
    vi.mocked(vismaGetPages)
      .mockResolvedValueOnce({
        complete: true,
        rows: [
          { customerOrder: '14176', customerRefNo: '14176' },
          { customerOrder: { value: '14178' }, customerRefNo: '' },
          { customerOrder: '', customerRefNo: '' },
        ],
      })
      .mockResolvedValueOnce({
        complete: true,
        rows: [{ customerRefNumber: '14176', externalReference: '14176' }, { customerRefNumber: '14150', externalReference: '' }],
      })

    const res = await get('customer=10430&list=1&since=2026-09-27')
    expect(res.status).toBe(200)
    const [orders, invoices] = vi.mocked(vismaGetPages).mock.calls.map((c) => c[1])
    expect(orders).toBe(
      'controller/api/v1/customer/10430/salesorderbasic?lastModifiedDateTime=2026-09-27&lastModifiedDateTimeCondition=%3E',
    )
    expect(invoices).toBe('controller/api/v1/customerinvoice?customer=10430&documentDate=2026-09-27&documentDateCondition=%3E')
    expect(await res.json()).toEqual({
      customer: '10430',
      since: '2026-09-27',
      complete: true,
      scanned: { salesOrders: 3, invoices: 2 },
      inSalesOrders: ['14176', '14178'],
      inInvoices: ['14150', '14176'],
    })
    expect(vismaGet).not.toHaveBeenCalled()
  })

  it('in list mode says incomplete when either read stopped at its page limit', async () => {
    admin()
    vi.mocked(vismaGetPages)
      .mockResolvedValueOnce({ complete: false, rows: [] })
      .mockResolvedValueOnce({ complete: true, rows: [] })
    expect((await (await get('customer=10430&list=1')).json()).complete).toBe(false)
  })

  it('answers found: false, not an error, when nothing carries the number', async () => {
    admin()
    vi.mocked(vismaGet).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    const body = await (await get('customer=10421&number=30187')).json()
    expect(body).toMatchObject({ found: false, salesOrders: [], invoices: [] })
  })
})
