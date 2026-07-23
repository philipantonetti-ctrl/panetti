// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PortalClient } from './PortalClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/portal',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

afterEach(() => vi.unstubAllGlobals())

const payload = {
  name: 'Philip',
  codes: ['TEKGUIDE500'],
  commissionRate: 0.1,
  currency: 'NOK',
  sales: 407903,
  commission: 40790,
  orders: 1,
  rank: 1,
  totalAmbassadors: 3,
  recent: [
    {
      id: 'o1',
      date: '2026-03-10T12:00:00.000Z',
      shop: 'Panetti Norway',
      sales: 407903,
      commission: 40790,
      products: [
        { name: 'Mazzetti Advanced Comfort', quantity: 1 },
        { name: 'Massasjepistol Pro X', quantity: 2 },
      ],
    },
  ],
}

function renderPortal(body: unknown = payload) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
  render(<PortalClient email="amb@test.local" />)
}

describe('PortalClient order products', () => {
  it('shows what was sold in each order, with quantities', async () => {
    renderPortal()
    await waitFor(() => expect(screen.getByText('Panetti Norway')).toBeTruthy())

    expect(screen.getByRole('columnheader', { name: 'Products' })).toBeTruthy()
    expect(screen.getByText(/Mazzetti Advanced Comfort/)).toBeTruthy()
    expect(screen.getByText(/Massasjepistol Pro X/)).toBeTruthy()
    // The quantity sold matters to an ambassador, not just the name.
    expect(screen.getByText(/× 2/)).toBeTruthy()
  })

  it('says so plainly when an order has no product lines', async () => {
    renderPortal({ ...payload, recent: [{ ...payload.recent[0], products: [] }] })
    await waitFor(() => expect(screen.getByText('Panetti Norway')).toBeTruthy())
    expect(screen.getByTestId('no-products')).toBeTruthy()
  })
})
