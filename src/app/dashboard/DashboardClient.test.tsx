// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { DashboardClient } from './DashboardClient'
import { ZERO_FIGURES } from '@/lib/metrics/types'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const payload = {
  metrics: { displayCurrency: 'USD', byShop: [], total: { ...ZERO_FIGURES } },
  previous: { ...ZERO_FIGURES },
  series: [],
  leaderboard: [],
}

/** A fresh Response per call — a body can only be read once. */
function renderPage() {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
  )
  vi.stubGlobal('fetch', fetchMock)
  render(<DashboardClient email="admin@test.local" shops={[]} />)
  return fetchMock
}

// FIX 6: the whole point of this branch was to let the operator consolidate
// into a currency other than USD. Gating the notice on currency === 'USD'
// made it vanish for exactly that case, leaving a DKK+NOK view with
// converted figures and no sentence saying so.
describe('DashboardClient consolidation notice', () => {
  it('shows the notice for multiple shops in NOK, not just USD', async () => {
    const withNok = { ...payload, metrics: { ...payload.metrics, displayCurrency: 'NOK' } }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(withNok), { status: 200 }))))

    render(
      <DashboardClient
        email="admin@test.local"
        shops={[
          { id: 'a', name: 'Panetti Norway', currency: 'NOK' },
          { id: 'b', name: 'Panetti Denmark', currency: 'DKK' },
        ]}
      />,
    )
    await act(async () => {})

    expect(screen.getByText(/consolidated to NOK/)).toBeTruthy()
  })

  it('does not show the notice for a single shop', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))))

    render(<DashboardClient email="admin@test.local" shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]} />)
    await act(async () => {})

    expect(screen.queryByText(/consolidated to/)).toBeNull()
  })
})

describe('DashboardClient live refresh', () => {
  it('refetches metrics when the window regains focus — silently, nothing dims', async () => {
    vi.useFakeTimers()
    const fetchMock = renderPage()
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Compare shops')).toBeTruthy()

    act(() => vi.advanceTimersByTime(1_500)) // past the tick's coalescing guard
    fireEvent(window, new Event('focus'))
    await act(async () => {})

    // Two metrics fetches — the tick also asks /api/version, so count by URL.
    const metricCalls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0])).filter((u) => u.includes('/api/metrics'))
    expect(metricCalls.length).toBe(2)
    // The refresh never re-enters the loading state: no dimmed aria-busy veil.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('polls once a minute while the tab stays visible', async () => {
    vi.useFakeTimers()
    const fetchMock = renderPage()
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    const metricCalls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0])).filter((u) => u.includes('/api/metrics'))
    expect(metricCalls.length).toBe(2)
  })
})
