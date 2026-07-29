// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MarketingClient } from './MarketingClient'
import type { MarketingShopRow } from '@/lib/ads/marketing'

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketing',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const row = (over: Partial<MarketingShopRow>): MarketingShopRow => ({
  shopId: 'a',
  shopName: 'Panetti Norway',
  spend: 0,
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
})
