// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/payouts',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const { PayoutsClient, ordersCell } = await import('./PayoutsClient')

afterEach(() => vi.unstubAllGlobals())

const payout = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  shopId: 'sh1',
  shopName: 'Panetti Norway',
  provider: 'dintero_payout',
  settledAt: '2026-08-28T09:00:00Z',
  periodStart: '2026-08-17T00:00:00Z',
  periodEnd: '2026-08-23T23:59:59Z',
  currency: 'NOK',
  amount: 980000,
  capture: 1000000,
  refund: 0,
  fee: 20000,
  reference: 'DINTERO-42',
  linesPending: false,
  orders: 12,
  matched: 12,
  ...over,
})

const listResponse = (payouts: unknown[], connected = true, waiting: unknown[] = []) =>
  new Response(
    JSON.stringify({ from: '2026-08-01', to: '2026-08-31', connected, payouts, waiting, waitingCount: waiting.length }),
    { status: 200 },
  )

describe('ordersCell', () => {
  it('reads complete, short, and pending as three different sentences', () => {
    expect(ordersCell(payout() as never).text).toBe('12 of 12')
    expect(ordersCell(payout({ matched: 11 }) as never)).toMatchObject({
      text: '11 of 12 matched',
      tone: expect.stringContaining('warn'),
    })
    expect(ordersCell(payout({ linesPending: true }) as never).text).toBe('report pending')
  })

  it('no lines and no reference means the report is still owed, not an empty week', () => {
    expect(ordersCell(payout({ orders: 0, matched: 0, reference: null }) as never).text).toBe('report pending')
    expect(ordersCell(payout({ orders: 0, matched: 0 }) as never).text).toBe('no orders')
  })
})

describe('PayoutsClient', () => {
  it('shows the payouts with bank reference and per-currency totals, opening on this month', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(listResponse([payout()])))
    vi.stubGlobal('fetch', fetchMock)
    render(<PayoutsClient email="a@b.test" />)

    expect(await screen.findByRole('columnheader', { name: 'Bank reference' })).toBeInTheDocument()
    expect(screen.getByText('DINTERO-42')).toBeInTheDocument()
    // Once in the shop filter, once in the table row.
    expect(screen.getAllByText('Panetti Norway').length).toBeGreaterThan(1)
    expect(screen.getByText('12 of 12')).toBeInTheDocument()
    expect(screen.getByText('Paid out - NOK')).toBeInTheDocument()
    // Fees are magnitudes in the payload; the minus is said at render time,
    // in the row and in the totals card alike.
    expect(screen.getAllByText(/-NOK\s?200\.00/).length).toBeGreaterThanOrEqual(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('preset=this_month')
  })

  it('an unfetched report reads as pending when opened, not as an empty payout', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/payouts/p1')) {
        return Promise.resolve(
          new Response(JSON.stringify({ currency: 'NOK', linesPending: false, reference: null, lines: [] }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(listResponse([payout({ orders: 0, matched: 0, reference: null })]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PayoutsClient email="a@b.test" />)

    fireEvent.click(await screen.findByRole('button', { name: /Open payout/ }))

    expect(await screen.findByText(/has not been fetched yet/)).toBeInTheDocument()
  })

  it('opens a payout into its orders and names the reference nobody wears', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/payouts/p1')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              currency: 'NOK',
              linesPending: false,
              lines: [
                { id: 'l1', reference: '3041', amount: 490000, capture: 500000, refund: 0, fee: 10000, transactionDate: '2026-08-18T00:00:00Z', paymentType: 'dintero_payout.creditcard', cardBrand: 'Visa', order: { number: '3041', placedAt: '2026-08-18T10:00:00Z', status: 'completed', total: 625000 } },
                // The plugin's generated id in reference, the order number in
                // reference2 - the page must name the ORDER, not the id.
                { id: 'l2', reference: 'dwc6a8ea49994f8f8.21480369', reference2: '9999', amount: 490000, capture: 500000, refund: 0, fee: 10000, transactionDate: null, paymentType: null, cardBrand: null, order: null },
              ],
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(listResponse([payout()]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PayoutsClient email="a@b.test" />)

    fireEvent.click(await screen.findByRole('button', { name: /Open payout/ }))

    expect(await screen.findByText('#3041')).toBeInTheDocument()
    expect(screen.getByText(/9999 - no order with this number/)).toBeInTheDocument()
    expect(screen.getByText('Visa')).toBeInTheDocument()
  })

  it('names the paid orders no payout contains, and says so when there are none', async () => {
    const waiting = [{
      id: 'o1', shopId: 'sh1', number: '14200', shopName: 'Panetti Norway',
      placedAt: '2026-08-20T10:00:00Z', status: 'completed', total: 499900, currency: 'NOK',
    }]
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(listResponse([payout()], true, waiting))))
    render(<PayoutsClient email="a@b.test" />)

    expect(await screen.findByText(/1 paid order older than 8 days in no payout/)).toBeInTheDocument()
    expect(screen.getByText('#14200')).toBeInTheDocument()

    cleanup()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(listResponse([payout()]))))
    render(<PayoutsClient email="a@b.test" />)
    expect(await screen.findByText(/Nothing is waiting on Dintero/)).toBeInTheDocument()
  })

  it('invites the connection when nothing is connected yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(listResponse([], false))))
    render(<PayoutsClient email="a@b.test" />)

    expect(await screen.findByText('Dintero is not connected yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect Dintero' })).toHaveAttribute('href', '/settings/payouts')
  })
})
