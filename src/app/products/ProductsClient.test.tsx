// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ProductsClient } from './ProductsClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/products',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/lib/use-live-tick', () => ({ useLiveTick: () => 0 }))

const SHOPS = [
  { id: 'no', name: 'Panetti Norway', currency: 'NOK' },
  { id: 'de', name: 'Panetti Germany', currency: 'EUR' },
  { id: 'fi', name: 'Panetti Finland', currency: 'EUR' },
]

const EMPTY = {
  displayCurrency: 'NOK',
  rows: [],
  total: { orders: 0, quantity: 0, grossSales: 0, netSales: 0, cogs: 0, profit: 0, margin: 0 },
  uncosted: 0,
  range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z' },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(EMPTY), { status: 200 })))
})

describe('ProductsClient', () => {
  it('loads every shop by default', async () => {
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
  })

  it('refuses a mixed-currency selection without asking the server', async () => {
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    ;(fetch as ReturnType<typeof vi.fn>).mockClear()

    fireEvent.click(screen.getByLabelText('Shops'))
    fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
    fireEvent.click(screen.getByLabelText('Panetti Germany'))

    expect(await screen.findByText(/Mixed currencies/i)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('offers each currency group as a one-click fix', async () => {
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())

    fireEvent.click(screen.getByLabelText('Shops'))
    fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
    fireEvent.click(screen.getByLabelText('Panetti Germany'))

    expect(await screen.findByRole('button', { name: /Show the 1 NOK store/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Show the 1 EUR store/ })).toBeInTheDocument()
  })

  it('recovers when a currency group is chosen', async () => {
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())

    fireEvent.click(screen.getByLabelText('Shops'))
    fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
    fireEvent.click(screen.getByLabelText('Panetti Germany'))
    fireEvent.click(await screen.findByRole('button', { name: /Show the 1 NOK store/ }))

    await waitFor(() => expect(screen.queryByText(/Mixed currencies/i)).not.toBeInTheDocument())
  })

  it('says how many products have no cost entered', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ ...EMPTY, uncosted: 7 }), { status: 200 }),
    )
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    expect(await screen.findByText(/7 products have no cost entered/i)).toBeInTheDocument()
  })

  it('shows the reason when the server refuses', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Could not load product analytics' }), { status: 500 }),
    )
    render(<ProductsClient email="a@b.c" shops={SHOPS} />)
    expect(await screen.findByText('Could not load product analytics')).toBeInTheDocument()
  })
})
