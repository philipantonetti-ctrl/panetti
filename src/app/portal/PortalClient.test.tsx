// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { PortalClient } from './PortalClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/portal',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

afterEach(() => vi.unstubAllGlobals())

const order = (n: number) => ({
  id: `o${n}`,
  date: '2026-03-10T12:00:00.000Z',
  shop: 'Panetti Norway',
  sales: 407903,
  commission: 40790,
  products: [
    { name: `Product ${n}`, quantity: 2, imageUrl: `https://img.example/${n}.png` },
  ],
})

const payload = {
  name: 'Philip',
  codes: ['TEKGUIDE500'],
  commissionRate: 0.1,
  currency: 'NOK',
  sales: 407903,
  commission: 40790,
  orders: 14,
  rank: 1,
  totalAmbassadors: 3,
  lifetimeOrders: 14,
  firstSaleAt: '2026-03-10T12:00:00.000Z',
  lastSaleAt: '2026-03-10T12:00:00.000Z',
  recent: Array.from({ length: 14 }, (_, i) => order(i)),
  productTotals: [
    { productId: 'p1', name: 'Pizza Oven', imageUrl: 'https://img.example/oven.png', units: 11, revenue: 1100000, commission: 110000 },
    { productId: 'p2', name: 'Pizza Spade', imageUrl: null, units: 3, revenue: 75000, commission: 7500 },
  ],
}

function renderPortal(body: unknown = payload) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
  render(<PortalClient email="amb@test.local" />)
}

describe('PortalClient', () => {
  it('shows a picture beside each product on an order', async () => {
    renderPortal()
    await waitFor(() => expect(screen.getAllByText('Panetti Norway').length).toBeGreaterThan(0))
    const img = screen.getAllByRole('img', { name: 'Product 0' })[0] as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://img.example/0.png')
  })

  it('reveals the rest of the orders instead of stopping at ten', async () => {
    renderPortal()
    await waitFor(() => expect(screen.getAllByText('Panetti Norway')).toHaveLength(10))

    fireEvent.click(screen.getByRole('button', { name: /Show all 14 orders/i }))
    await waitFor(() => expect(screen.getAllByText('Panetti Norway')).toHaveLength(14))
  })

  it('has a Products tab ranking everything sold, with units, revenue and commission', async () => {
    renderPortal()
    await waitFor(() => expect(screen.getByRole('button', { name: /^Products/ })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Products/ }))

    await waitFor(() => expect(screen.getByText('Pizza Oven')).toBeTruthy())
    expect(screen.getByRole('columnheader', { name: 'Units sold' })).toBeTruthy()
    expect(screen.getByText('11')).toBeTruthy() // units
    const img = screen.getByRole('img', { name: 'Pizza Oven' }) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://img.example/oven.png')
  })

  // The client saw "No sales yet" while holding 476 real orders.
  it('does not claim "no sales yet" when the period is merely quiet', async () => {
    renderPortal({
      ...payload,
      orders: 0,
      sales: 0,
      commission: 0,
      rank: null,
      recent: [],
      productTotals: [],
      lifetimeOrders: 476,
      firstSaleAt: '2024-01-21T13:46:41.000Z',
      lastSaleAt: '2025-11-11T23:11:44.000Z',
    })

    await waitFor(() => expect(screen.getByTestId('quiet-period')).toBeTruthy())
    const note = screen.getByTestId('quiet-period').textContent ?? ''
    expect(note).toMatch(/476/) // the sales they really have
    expect(note).toMatch(/Nov 2025/) // when they last sold
    expect(screen.queryByText(/Share your code and they will appear here/)).toBeNull()
    // And the headline must not say they have never sold.
    expect(screen.queryByText('No sales yet')).toBeNull()
  })

  it('offers one click to jump to the sales they do have', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...payload, orders: 0, recent: [], productTotals: [], rank: null,
          lifetimeOrders: 476,
          firstSaleAt: '2024-01-21T13:46:41.000Z',
          lastSaleAt: '2025-11-11T23:11:44.000Z',
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<PortalClient email="amb@test.local" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Show all my sales/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Show all my sales/i }))

    // It must re-query starting from their first sale, not the quiet period.
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes('from=2024-01-21'))).toBe(true)
    })
  })

  it('still tells a brand new ambassador to share their code', async () => {
    renderPortal({
      ...payload, orders: 0, recent: [], productTotals: [], rank: null,
      lifetimeOrders: 0, firstSaleAt: null, lastSaleAt: null,
    })
    await waitFor(() =>
      expect(screen.getByText(/Share your code and they will appear here/)).toBeTruthy(),
    )
    expect(screen.queryByTestId('quiet-period')).toBeNull()
  })

  it('ends the footnote at "excluding VAT" with nothing trailing', async () => {
    renderPortal()
    await waitFor(() => expect(screen.getByTestId('earn-note')).toBeTruthy())
    const note = screen.getByTestId('earn-note').textContent ?? ''
    expect(note.trim()).toMatch(/excluding VAT\.$/)
    expect(note).not.toMatch(/shipping/i)
    expect(note).not.toMatch(/own currency/i)
  })
})
