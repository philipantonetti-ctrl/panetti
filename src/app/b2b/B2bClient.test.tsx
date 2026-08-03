// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// AppShell is a client component: it reads the current route and pushes on sign-out.
vi.mock('next/navigation', () => ({
  usePathname: () => '/b2b',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import { B2bClient } from './B2bClient'

const shops = [{ id: 's1', name: 'Mazzetti.no', currency: 'NOK' }]

const customer = {
  id: 'c1', name: 'Nordic Retail AS', shopId: 's1', shopName: 'Mazzetti.no',
  currency: 'EUR', vatPercent: 25, email: null, note: null, active: true,
  priceCount: 4, orderCount: 12, revenue: 1422000,
}

function mockFetch(customers: unknown[], orders: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(
      JSON.stringify(url.includes('/api/b2b/customers') ? { customers } : { orders, total: orders.length }),
      { status: 200 },
    ),
  ))
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.unstubAllGlobals())

describe('B2bClient', () => {
  it('shows a customer’s revenue in THEIR currency, not the shop’s', async () => {
    mockFetch([customer])
    render(<B2bClient email="a@b.test" shops={shops} />)

    // 14 220.00 EUR — the shop is NOK, and converting here would be a guess.
    expect(await screen.findByText(/14,220\.00|14 220,00/)).toBeInTheDocument()
    expect(screen.getByText('Nordic Retail AS')).toBeInTheDocument()
    expect(screen.getByText('Mazzetti.no')).toBeInTheDocument()
  })

  it('teaches the next action when there are no customers yet', async () => {
    mockFetch([])
    render(<B2bClient email="a@b.test" shops={shops} />)
    expect(
      await screen.findByText(/add one and you can start entering their orders/i),
    ).toBeInTheDocument()
  })

  it('says so when the list could not be loaded, rather than showing an empty table', async () => {
    // An empty table reads as "you have no customers". That would be a lie.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Could not load customers' }), { status: 500 }),
    ))
    render(<B2bClient email="a@b.test" shops={shops} />)
    expect(await screen.findByText('Could not load customers')).toBeInTheDocument()
  })

  it('offers no "add customer" button when there is no shop to attach one to', async () => {
    mockFetch([])
    render(<B2bClient email="a@b.test" shops={[]} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /add customer/i })).toBeNull())
  })
})
