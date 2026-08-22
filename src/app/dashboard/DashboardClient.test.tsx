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
  lastYear: { ...ZERO_FIGURES },
  series: [],
  leaderboard: [],
  range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z' },
  previousRange: { from: '2026-07-11T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
  lastYearRange: { from: '2025-08-01T00:00:00.000Z', to: '2025-08-21T00:00:00.000Z' },
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

/**
 * The client asked for YoY beside the figure he had. The strip gets both
 * comparisons from this page, each named by what it is actually against - the
 * 21 days before this one, and the same 21 dates last year - so the words
 * under the numbers come from the ranges the API really compared, not from a
 * preset label guessed on the client.
 */
describe('DashboardClient comparisons', () => {
  it('labels the period before by its length, and names last year', async () => {
    // Production's own figures for 1-21 Aug 2026, the 21 days before, and
    // 1-21 Aug 2025 (read 2026-08-22). Every figure non-zero on every side, so
    // all five lines carry a percentage and its label rather than "no data".
    const figures = (orders: number, netRevenue: number, netProfit: number, avgOrderValue: number, ambassadorSales: number) =>
      ({ ...ZERO_FIGURES, orders, netRevenue, netProfit, avgOrderValue, ambassadorSales })
    const live = {
      ...payload,
      metrics: { ...payload.metrics, total: figures(828, 385113348, 101852287, 465113, 22679631) },
      previous: figures(825, 364608641, 106179678, 441950, 21264435),
      lastYear: figures(622, 279836067, 42968191, 449897, 5134879),
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(live), { status: 200 }))))
    render(<DashboardClient email="admin@test.local" shops={[]} />)
    expect(await screen.findAllByText('vs 21 days before')).toHaveLength(5)
    expect(screen.getAllByText('vs last year')).toHaveLength(5)
    // And the dates behind each, on hover: the API's own ranges.
    expect(screen.getAllByTitle('vs last year: 2025-08-01 → 2025-08-21').length).toBeGreaterThan(0)
    expect(screen.getAllByTitle('vs 21 days before: 2026-07-11 → 2026-07-31').length).toBeGreaterThan(0)
  })

  it('says "the day before" for a one-day range rather than "1 days before"', async () => {
    const oneDay = {
      ...payload,
      previousRange: { from: '2026-08-20T00:00:00.000Z', to: '2026-08-20T00:00:00.000Z' },
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(oneDay), { status: 200 }))))
    render(<DashboardClient email="admin@test.local" shops={[]} />)
    // Zero figures both sides, so the label lives in the tooltip of the "no data" line.
    expect(await screen.findAllByTitle('vs the day before: 2026-08-20 → 2026-08-20')).toHaveLength(5)
  })
})
