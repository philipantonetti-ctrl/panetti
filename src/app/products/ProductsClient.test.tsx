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

// Every shop shares one currency: the default selection ([]) needs no
// auto-narrowing, so these are for the tests about a plain, honest load —
// fetching, the uncosted notice, the server-error message.
const SAME_CURRENCY_SHOPS = [
  { id: 'a', name: 'Panetti Oslo', currency: 'NOK' },
  { id: 'b', name: 'Panetti Bergen', currency: 'NOK' },
  { id: 'c', name: 'Panetti Trondheim', currency: 'NOK' },
]

// Spans two currencies, EUR the bigger group (2 shops) over NOK (1) — for the
// mixed-currency guard tests, and for the auto-select-the-biggest tests.
const MIXED_SHOPS = [
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
  describe('a shop list that already shares one currency', () => {
    it('loads every shop by default', async () => {
      render(<ProductsClient email="a@b.c" shops={SAME_CURRENCY_SHOPS} />)
      await waitFor(() => expect(fetch).toHaveBeenCalled())

      // Genuinely "every shop": no auto-narrowing kicks in when there is
      // nothing to narrow, so the request carries no shops= at all.
      const url = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])
      expect(url).not.toContain('shops=')
    })

    it('says how many products have no cost entered', async () => {
      ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify({ ...EMPTY, uncosted: 7 }), { status: 200 }),
      )
      render(<ProductsClient email="a@b.c" shops={SAME_CURRENCY_SHOPS} />)
      expect(await screen.findByText(/7 products have no cost entered/i)).toBeInTheDocument()
    })

    it('shows the reason when the server refuses', async () => {
      ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Could not load product analytics' }), { status: 500 }),
      )
      render(<ProductsClient email="a@b.c" shops={SAME_CURRENCY_SHOPS} />)
      expect(await screen.findByText('Could not load product analytics')).toBeInTheDocument()
    })
  })

  describe('the mixed-currency guard', () => {
    it('refuses a mixed-currency selection without asking the server', async () => {
      render(<ProductsClient email="a@b.c" shops={MIXED_SHOPS} />)
      // Default lands on the auto-selected EUR group (2 shops beat NOK's 1),
      // which is not mixed and genuinely fetches.
      await waitFor(() => expect(fetch).toHaveBeenCalled())

      fireEvent.click(screen.getByLabelText('Shops'))
      fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
      // Norway alone is not mixed either, so this intermediate state
      // legitimately re-fetches too (confirmed: without this clear, the mock
      // shows exactly one prior call for shops=no). Clear here, after that
      // real fetch, so the assertion below is about the NEXT change only —
      // adding Germany, which must fetch nothing at all.
      ;(fetch as ReturnType<typeof vi.fn>).mockClear()
      fireEvent.click(screen.getByLabelText('Panetti Germany'))

      expect(await screen.findByText(/Mixed currencies/i)).toBeInTheDocument()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('offers each currency group as a one-click fix', async () => {
      render(<ProductsClient email="a@b.c" shops={MIXED_SHOPS} />)
      await waitFor(() => expect(fetch).toHaveBeenCalled())

      fireEvent.click(screen.getByLabelText('Shops'))
      fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
      fireEvent.click(screen.getByLabelText('Panetti Germany'))

      expect(await screen.findByRole('button', { name: /Show the 1 NOK store/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Show the 1 EUR store/ })).toBeInTheDocument()
    })

    it('recovers when a currency group is chosen', async () => {
      render(<ProductsClient email="a@b.c" shops={MIXED_SHOPS} />)
      await waitFor(() => expect(fetch).toHaveBeenCalled())

      fireEvent.click(screen.getByLabelText('Shops'))
      fireEvent.click(screen.getByLabelText('Only Panetti Norway'))
      fireEvent.click(screen.getByLabelText('Panetti Germany'))
      fireEvent.click(await screen.findByRole('button', { name: /Show the 1 NOK store/ }))

      await waitFor(() => expect(screen.queryByText(/Mixed currencies/i)).not.toBeInTheDocument())
    })
  })

  describe('auto-selecting the biggest currency group', () => {
    it('auto-selects the largest currency group on first load and fetches it', async () => {
      render(<ProductsClient email="a@b.c" shops={MIXED_SHOPS} />)
      await waitFor(() => expect(fetch).toHaveBeenCalled())

      // EUR (Germany + Finland, 2 shops) beats NOK (Norway alone, 1 shop).
      // Parsed via URL/URLSearchParams rather than a raw substring match, so
      // the comma's percent-encoding in the querystring isn't a false alarm.
      const url = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])
      const shopsParam = new URL(url, 'http://test').searchParams.get('shops')
      expect(shopsParam).toBe('de,fi')
    })

    it('names the auto-selected currency and store count', async () => {
      render(<ProductsClient email="a@b.c" shops={MIXED_SHOPS} />)
      expect(await screen.findByText(/Showing your 2 EUR stores/i)).toBeInTheDocument()
    })

    it('reflects the auto-selection in the shop filter itself, not "All shops"', async () => {
      render(<ProductsClient email="a@b.c" shops={MIXED_SHOPS} />)
      await screen.findByText(/Showing your 2 EUR stores/i)

      expect(screen.getByLabelText('Shops')).toHaveTextContent('2 shops')
      expect(screen.getByLabelText('Shops')).not.toHaveTextContent('All shops')
    })

    it('clears the explanatory line once the user changes the selection', async () => {
      render(<ProductsClient email="a@b.c" shops={MIXED_SHOPS} />)
      await screen.findByText(/Showing your 2 EUR stores/i)

      fireEvent.click(screen.getByLabelText('Shops'))
      fireEvent.click(screen.getByLabelText('Only Panetti Norway'))

      await waitFor(() => expect(screen.queryByText(/Showing your/i)).not.toBeInTheDocument())
    })

    // A comparison-based "is this still the auto-selected array?" check would
    // wrongly keep the line up here, because the user's own choice below
    // lands back on exactly ['de', 'fi'] — the same set, same order, as the
    // auto-selection. An explicit flag cleared on any onChange does not care
    // what the new array contains, only that the user chose it.
    it('clears the flag on any change, even one that ends up reselecting the same shops', async () => {
      render(<ProductsClient email="a@b.c" shops={MIXED_SHOPS} />)
      await screen.findByText(/Showing your 2 EUR stores/i)

      fireEvent.click(screen.getByLabelText('Shops'))
      fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
      fireEvent.click(screen.getByLabelText('Panetti Norway')) // untick Norway: left with [de, fi]

      await waitFor(() => expect(screen.queryByText(/Showing your/i)).not.toBeInTheDocument())
    })

    it('does not auto-narrow or show the line when every shop already shares one currency', async () => {
      render(<ProductsClient email="a@b.c" shops={SAME_CURRENCY_SHOPS} />)
      await waitFor(() => expect(fetch).toHaveBeenCalled())

      const url = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])
      expect(url).not.toContain('shops=')
      expect(screen.queryByText(/Showing your/i)).not.toBeInTheDocument()
      expect(screen.getByLabelText('Shops')).toHaveTextContent(`All shops · ${SAME_CURRENCY_SHOPS.length}`)
    })
  })
})
