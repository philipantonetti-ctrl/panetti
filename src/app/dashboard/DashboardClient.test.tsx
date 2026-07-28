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

    expect(fetchMock).toHaveBeenCalledTimes(2)
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
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
