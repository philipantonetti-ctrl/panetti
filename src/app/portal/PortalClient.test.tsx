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

  it('ends the footnote at "excluding VAT" with nothing trailing', async () => {
    renderPortal()
    await waitFor(() => expect(screen.getByTestId('earn-note')).toBeTruthy())
    const note = screen.getByTestId('earn-note').textContent ?? ''
    expect(note.trim()).toMatch(/excluding VAT\.$/)
    expect(note).not.toMatch(/shipping/i)
    expect(note).not.toMatch(/own currency/i)
  })
})
