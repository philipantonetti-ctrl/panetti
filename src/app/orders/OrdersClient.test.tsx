// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { OrdersClient } from './OrdersClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/orders',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const payload = {
  total: 1,
  orders: [
    {
      id: 'o1',
      number: '10356',
      placedAt: '2026-07-21T18:47:05.000Z',
      status: 'completed',
      shop: 'Mazzetti Denmark',
      currency: 'DKK',
      netSales: 2159920,
      taxTotal: 540000,
      shippingCharged: 235000,
      total: 2699900,
      couponCode: 'RAYMOND500',
      itemCount: 1,
      products: [{ name: 'Mazzetti Advanced Comfort', sku: 'MACBL661', quantity: 1 }],
    },
  ],
}

function renderPage() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })))
  render(<OrdersClient email="admin@test.local" shops={[{ id: 's1', name: 'Mazzetti Denmark', currency: 'DKK' }]} />)
}

describe('OrdersClient', () => {
  it('lists orders with their number, status and shop', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())
    expect(screen.getByText('Mazzetti Denmark')).toBeTruthy()
    expect(screen.getByText(/completed/i)).toBeTruthy()
  })

  it('expands an order to show what the customer bought', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    // Products are hidden until the order is opened.
    expect(screen.queryByText('Mazzetti Advanced Comfort')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /order 10356/i }))
    expect(screen.getByText('Mazzetti Advanced Comfort')).toBeTruthy()
    expect(screen.getByText(/MACBL661/)).toBeTruthy()
  })

  it('offers date and shop filters', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())
    expect(screen.getByLabelText('Date range')).toBeTruthy()
  })
})
