// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { AmbassadorsClient } from './AmbassadorsClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/ambassadors',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

function renderPage(role: 'ADMIN' | 'MARKETING' = 'ADMIN') {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: unknown) => {
    const u = String(url)
    if (u.includes('/api/ambassador-products'))
      return json({
        overview: [{ sku: 'MPX-001', name: 'Pro X', ambassadors: 3, units: 3 }],
        catalogue: [{ sku: 'MPX-001', name: 'Pro X', shopIds: ['s1', 's2'] }],
      })
    if (u.includes('/api/ambassadors/stats'))
      return json({
        leaderboard: [
          { rank: 1, ambassadorId: 'a9', name: 'Salla Klemetti', shops: ['Norway'], orders: 3, sales: 90000, commission: 9000 },
        ],
        shopOptions: [{ id: 's1', name: 'Norway' }, { id: 's2', name: 'Sweden' }],
        displayCurrency: 'USD',
        range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
      })
    return json({})
  }))
  render(
    <ToastProvider>
      <AmbassadorsClient email="admin@test.local" role={role} />
    </ToastProvider>,
  )
}

describe('the Ambassadors tab', () => {
  it('shows the Top ambassadors table with its shop and period filters', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Top ambassadors')).toBeTruthy()
      expect(screen.getByText('Salla Klemetti')).toBeTruthy()
    })
    expect(screen.getByLabelText('Shops')).toBeTruthy()
    expect(screen.getByLabelText('Period')).toBeTruthy()
  })

  it('shows how far each product has spread, under the statistics', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Products with ambassadors')).toBeTruthy())
    expect(within(screen.getByTestId('product-overview-row')).getByText('Pro X')).toBeTruthy()
  })

  it('is the first of two tabs, and leaves the form and the roster to the second', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Top ambassadors')).toBeTruthy())

    const tabs = within(screen.getByRole('navigation', { name: 'Section' }))
    expect(tabs.getByRole('link', { name: 'Ambassadors' }).getAttribute('aria-current')).toBe('page')
    expect(tabs.getByRole('link', { name: 'Add an ambassador' }).getAttribute('href')).toBe('/ambassadors/add')

    // The chores live on the other tab: no form, no roster, and no request for them.
    expect(screen.queryByTestId('add-ambassador')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Add an ambassador' })).toBeNull()
    expect(screen.queryByText('Actions')).toBeNull()
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
    expect(calls.some(([url]) => /\/api\/ambassadors(\?|$)/.test(String(url)))).toBe(false)
    expect(calls.some(([url]) => String(url).includes('/api/shops'))).toBe(false)
  })

  it('marketing gets a nav without the dashboard; the roster tab is still theirs', async () => {
    renderPage('MARKETING')
    await waitFor(() => expect(screen.getByText('Top ambassadors')).toBeTruthy())
    expect(screen.queryByText('Dashboard')).toBeNull()
    expect(screen.getByRole('link', { name: 'Add an ambassador' })).toBeTruthy()
  })

  it('an admin keeps the dashboard in the nav next to the ambassadors', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeTruthy())
  })
})
