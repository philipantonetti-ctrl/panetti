// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

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

const listResponse = (payouts: unknown[], connected = true) =>
  new Response(JSON.stringify({ from: '2026-08-01', to: '2026-08-31', connected, payouts }), { status: 200 })

describe('ordersCell', () => {
  it('reads complete, short, and pending as three different sentences', () => {
    expect(ordersCell(payout() as never).text).toBe('12 of 12')
    expect(ordersCell(payout({ matched: 11 }) as never)).toMatchObject({
      text: '11 of 12 matched',
      tone: expect.stringContaining('warn'),
    })
    expect(ordersCell(payout({ linesPending: true }) as never).text).toBe('report pending')
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
    expect(String(fetchMock.mock.calls[0][0])).toContain('preset=this_month')
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
                { id: 'l2', reference: '9999', amount: 490000, capture: 500000, refund: 0, fee: 10000, transactionDate: null, paymentType: null, cardBrand: null, order: null },
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

  it('invites the connection when nothing is connected yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(listResponse([], false))))
    render(<PayoutsClient email="a@b.test" />)

    expect(await screen.findByText('Dintero is not connected yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect Dintero' })).toHaveAttribute('href', '/settings/payouts')
  })
})
