// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { MarketingClient } from './MarketingClient'
import type { MarketingShopRow } from '@/lib/ads/marketing'

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketing',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
// BreakdownTable's own fetch/expand/error behaviour is Task 4's ground — 13
// tests in BreakdownTable.test.tsx already cover it. Standing in for itself
// here means these tests prove only what MarketingClient controls: which
// provider and which single shop it mounts the table with.
vi.mock('./BreakdownTable', () => ({
  BreakdownTable: (props: { shopId: string; provider: string; from: string; to: string }) => (
    <div data-testid="breakdown-table">{JSON.stringify(props)}</div>
  ),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const row = (over: Partial<MarketingShopRow>): MarketingShopRow => ({
  shopId: 'a',
  shopName: 'Panetti Norway',
  spend: 0,
  dailyBudget: null,
  metaSpend: 0,
  googleSpend: 0,
  impressions: 0,
  clicks: 0,
  linkClicks: 0,
  conversions: 0,
  conversionValue: 0,
  videoViews3s: 0,
  thruplays: 0,
  orders: 0,
  grossRevenue: 0,
  roas: null,
  platformRoas: null,
  cpa: null,
  costPerPurchase: null,
  avgPurchaseValue: null,
  cpm: null,
  cpc: null,
  costPerLinkClick: null,
  ctr: null,
  linkCtr: null,
  holdRate: null,
  ...over,
})

const payload = {
  displayCurrency: 'USD',
  byShop: [
    row({
      spend: 120000,
      orders: 8,
      grossRevenue: 900000,
      roas: 7.5,
      platformRoas: 6.28,
      conversions: 12,
      conversionValue: 753600,
      costPerPurchase: 10000,
      cpa: 15000,
    }),
  ],
  total: row({
    shopId: '',
    shopName: 'Total',
    spend: 120000,
    orders: 8,
    grossRevenue: 900000,
    roas: 7.5,
    platformRoas: 6.28,
    conversions: 12,
    conversionValue: 753600,
    costPerPurchase: 10000,
  }),
  series: [],
  connected: true,
  // Real route response includes this (src/app/api/marketing/route.ts:81); the
  // existing Payload type here just never declared it before BreakdownTable
  // needed a concrete range to ask its own endpoint for.
  range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
}

describe('MarketingClient', () => {
  it('fetches marketing metrics and shows the Ads Manager numbers', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    const calls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls.some((u) => u.includes('/api/marketing?'))).toBe(true)

    expect(screen.getByText('AD SPEND')).toBeTruthy()
    expect(screen.getByText('PURCHASE ROAS')).toBeTruthy()
    expect(screen.getByText('COST PER PURCHASE')).toBeTruthy()
    expect(screen.getAllByText('$1,200.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('6.28×').length).toBeGreaterThan(0)
    expect(screen.getByText('Panetti Norway')).toBeTruthy()
    expect(screen.getByText('No ad spend in this period.')).toBeTruthy()
  })

  it('shows the connect doorway and fetches nothing when no account exists', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<MarketingClient email="admin@test.local" shops={[]} hasAccounts={false} />)
    await act(async () => {})

    expect(screen.getByText('No ad accounts connected yet')).toBeTruthy()
    expect(screen.getByText('Connect an ad account')).toBeTruthy()
    const marketingCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/marketing'))
    expect(marketingCalls).toHaveLength(0)
  })

  // Three shops, not one: "all shops" (the default, an empty selection) and
  // "several shops" (two of the three, explicitly) are different sentences in
  // the brief and must both be provably distinct from "exactly one" — with
  // only two shops total, ticking every box collapses back to the empty-array
  // "all" state (ShopFilter's own normalisation), which would make "several"
  // untestable as its own case.
  const threeShops = [
    { id: 'a', name: 'Panetti Norway', currency: 'NOK' },
    { id: 'b', name: 'Panetti Sweden', currency: 'SEK' },
    { id: 'c', name: 'Panetti Denmark', currency: 'DKK' },
  ]

  const fetchPayload = () =>
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })))

  /** Drives the real ShopFilter dropdown rather than reaching into state. */
  function selectOnly(shopName: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Shops' }))
    fireEvent.click(screen.getByRole('button', { name: `Only ${shopName}` }))
  }

  function breakdownProps() {
    return JSON.parse(screen.getByTestId('breakdown-table').textContent!)
  }

  it('shows the breakdown only for a single store', async () => {
    vi.stubGlobal('fetch', fetchPayload())

    render(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})

    // Default selection is every shop — neither the switcher nor the table,
    // and the one-sentence reason instead.
    expect(screen.queryByTestId('breakdown-table')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Meta' })).toBeNull()
    expect(screen.getByText(/campaigns belong to one ad account/i)).toBeTruthy()

    // Several, but not all: still hidden. Unchecking Denmark from "all" (every
    // box ticked) leaves Norway and Sweden both selected — a genuine
    // two-shop array, not the empty-array "all" state under another name.
    fireEvent.click(screen.getByRole('button', { name: 'Shops' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Panetti Denmark' }))
    await act(async () => {})
    expect(screen.queryByTestId('breakdown-table')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Meta' })).toBeNull()
    expect(screen.getByText(/campaigns belong to one ad account/i)).toBeTruthy()

    // Exactly one: the switcher and the table appear, scoped to that shop.
    fireEvent.click(screen.getByRole('button', { name: 'Only Panetti Norway' }))
    await act(async () => {})
    expect(screen.getByRole('tab', { name: 'Meta' })).toBeTruthy()
    expect(screen.getByTestId('breakdown-table')).toBeTruthy()
    expect(screen.queryByText(/campaigns belong to one ad account/i)).toBeNull()
    expect(breakdownProps().shopId).toBe('a')
  })

  // Beyond the required three: NO_SHOPS ('none', reached via "Deselect all")
  // is also a one-element array, but it names no real shop. The gate must
  // read it as "not exactly one store", not hand a fake shopId to
  // BreakdownTable — which would fetch a real /api/marketing/breakdown
  // request for a shop that does not exist and print a misleading "no
  // account" sentence instead of the actual reason (nothing is selected).
  it('treats "no shops" as not exactly one, not as a shop named none', async () => {
    vi.stubGlobal('fetch', fetchPayload())

    render(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Shops' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
    await act(async () => {})

    expect(screen.queryByTestId('breakdown-table')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Meta' })).toBeNull()
    expect(screen.getByText(/campaigns belong to one ad account/i)).toBeTruthy()
  })

  it('switches the table between Meta and Google', async () => {
    vi.stubGlobal('fetch', fetchPayload())

    render(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})
    selectOnly('Panetti Norway')
    await act(async () => {})

    expect(breakdownProps().provider).toBe('meta')

    fireEvent.click(screen.getByRole('tab', { name: 'Google' }))

    expect(breakdownProps().provider).toBe('google')
    expect(breakdownProps().shopId).toBe('a') // same store — only the platform moved
  })

  it('starts on Meta', async () => {
    vi.stubGlobal('fetch', fetchPayload())

    render(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})
    selectOnly('Panetti Norway')
    await act(async () => {})

    expect(screen.getByRole('tab', { name: 'Meta' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Google' }).getAttribute('aria-selected')).toBe('false')
    expect(breakdownProps().provider).toBe('meta')
  })
})
