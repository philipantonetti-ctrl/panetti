// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { OrdersClient, paymentBadge, fulfillmentBadge } from './OrdersClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/orders',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const paidOrder = {
  id: 'o1',
  number: '10356',
  placedAt: '2026-07-21T18:47:05.000Z',
  status: 'completed',
  shop: 'Mazzetti Denmark',
  currency: 'DKK',
  netSales: 2159920,
  discountTotal: 0,
  taxTotal: 540000,
  shippingCharged: 235000,
  total: 2699900,
  couponCode: 'RAYMOND500',
  customerName: 'Tino Skaarup',
  customerEmail: 'tino@x.dk',
  itemCount: 1,
  products: [
    {
      name: 'Mazzetti Advanced Comfort',
      sku: 'MACBL661',
      quantity: 1,
      unitPrice: 2159920,
      lineNetTotal: 2159920,
      imageUrl: 'https://shop.dk/chair.jpg',
    },
  ],
  figures: {
    cogs: 850000,
    fulfillment: 236600,
    fee: 32699,
    commission: 215992,
    profit: 1059629,
    margin: 0.4425,
  },
}

const refundedOrder = {
  ...paidOrder,
  id: 'o2',
  number: '10333',
  status: 'refunded',
  customerName: '',
  customerEmail: 'obsenemail@x.dk',
  figures: null,
}

const payload = { total: 2, orders: [paidOrder, refundedOrder] }

function renderPage(body: unknown = payload) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
  render(<OrdersClient email="admin@test.local" shops={[{ id: 's1', name: 'Mazzetti Denmark', currency: 'DKK' }]} />)
}

describe('status badges', () => {
  it('reads one Woo status as the two facts shown side by side', () => {
    expect(paymentBadge('completed').label).toBe('Paid')
    expect(paymentBadge('processing').label).toBe('Paid')
    expect(paymentBadge('refunded').label).toBe('Refunded')
    expect(paymentBadge('cancelled').label).toBe('Cancelled')
    expect(paymentBadge('on-hold').label).toBe('On hold')
    expect(paymentBadge('trash').label).toBe('Voided')

    expect(fulfillmentBadge('completed').label).toBe('Fulfilled')
    expect(fulfillmentBadge('processing').label).toBe('Unfulfilled')
    expect(fulfillmentBadge('refunded').label).toBe('Unfulfilled')
  })
})

describe('OrdersClient', () => {
  it('lists orders with number, both status badges, customer and shop', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    expect(screen.getAllByText('Mazzetti Denmark').length).toBeGreaterThan(0)
    expect(screen.getByText('Tino Skaarup')).toBeTruthy()

    // Each row wears both facts. ("Paid" is also a column header, so look
    // inside the rows, not the whole page.)
    const paidRow = screen.getByText('10356').closest('tr')!
    expect(within(paidRow).getByText('Paid')).toBeTruthy()
    expect(within(paidRow).getByText('Fulfilled')).toBeTruthy()

    // The refunded order says so, in so many words.
    const refundedRow = screen.getByText('10333').closest('tr')!
    expect(within(refundedRow).getByText('Refunded')).toBeTruthy()
    expect(within(refundedRow).getByText('Unfulfilled')).toBeTruthy()
  })

  it('shows per-order profit, and "—" on a voided order instead of pretend money', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    // The voided row shows dashes in the figure columns (6 of them).
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(6)
    expect(screen.getByText('44.25%')).toBeTruthy() // the live order's margin
  })

  it('expands an order into a product sub-table: SKU, name, unit price, qty, total', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    // Products are hidden until the order is opened.
    expect(screen.queryByText('Mazzetti Advanced Comfort')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /order 10356/i }))
    expect(screen.getByText('Mazzetti Advanced Comfort')).toBeTruthy()
    expect(screen.getByText(/MACBL661/)).toBeTruthy()
    expect(screen.getByText('SKU')).toBeTruthy()
    expect(screen.getByText('Unit price')).toBeTruthy()
    expect(screen.getByText('Qty')).toBeTruthy()
  })

  it('offers date, shop, status and search controls, and a sync button', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())
    expect(screen.getByLabelText('Date range')).toBeTruthy()
    expect(screen.getByLabelText('Status')).toBeTruthy()
    expect(screen.getByLabelText('Search orders')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy()
  })

  it('asks the server for everything by default, and for one status when narrowed', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(calls[0]).toContain('includeVoided=true')

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'refunded' } })
    await waitFor(() => {
      const latest = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
      expect(latest[latest.length - 1]).toContain('status=refunded')
    })
  })

  it('reports how many orders the filter found', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())
    expect(screen.getByText(/found/i)).toBeTruthy()
  })
})
