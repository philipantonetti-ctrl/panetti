// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MarketingTable } from './MarketingTable'
import type { MarketingShopRow } from '@/lib/ads/marketing'

afterEach(() => localStorage.clear())

const row = (over: Partial<MarketingShopRow>): MarketingShopRow => ({
  shopId: 'a',
  shopName: 'Alpha',
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

const FILLED = row({
  shopId: 'a',
  shopName: 'Panetti Norway',
  spend: 35500,
  conversions: 3.5,
  conversionValue: 71000,
  platformRoas: 2.0,
  costPerPurchase: 10143,
  roas: 14.0845,
  grossRevenue: 500000,
  orders: 10,
  cpa: 3550,
})

describe('MarketingTable', () => {
  it('shows the everyday columns with money, ratios and honest dashes', () => {
    render(
      <MarketingTable
        rows={[FILLED, row({ shopId: 'b', shopName: 'Panetti Sweden', orders: 4, grossRevenue: 20000 })]}
        total={row({ shopId: '', shopName: 'Total', spend: 35500, conversionValue: 71000, platformRoas: 2.0, orders: 14 })}
        currency="USD"
      />,
    )

    // Default-visible headers: the client's own list plus the store context.
    for (const label of ['Ad spend', 'Daily budget', 'Purchases', 'Conv. value', 'P. ROAS', 'Cost/purchase', 'Avg. CPC', 'Clicks', 'Store ROAS', 'CPA']) {
      expect(screen.getByRole('button', { name: `Sort by ${label}` })).toBeTruthy()
    }
    // Detail columns wait behind Select metrics.
    expect(screen.queryByRole('button', { name: 'Sort by Meta' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sort by CPM' })).toBeNull()

    expect(screen.getAllByText('$355.00').length).toBeGreaterThan(0)
    expect(screen.getByText('3.5')).toBeTruthy() // fractional purchases stay honest
    expect(screen.getAllByText('2.00×').length).toBeGreaterThan(0)
    expect(screen.getByText('14.08×')).toBeTruthy()

    // The shop without spend wears dashes, not zero-ratios.
    const sweden = screen.getByText('Panetti Sweden').closest('tr')!
    expect(sweden.textContent).toContain('-')

    expect(screen.getByText('Total')).toBeTruthy()
  })

  // FINDING 3: under a platform filter, Store ROAS and CPA dash out (they
  // divide whole-store figures by one platform's spend - see marketing.ts's
  // `ratios()`), but the static column hint never said why, so the dashes
  // read as missing data rather than a deliberate refusal. `platformFiltered`
  // must come from the caller's SETTLED platform (MarketingClient passes
  // `data.platform`, not the pending filter selection) - this component only
  // renders what it is told.
  it('explains why Store ROAS and CPA are dashed under a platform filter', () => {
    render(
      <MarketingTable
        rows={[row({ shopId: 'a', shopName: 'Panetti Norway', spend: 35500, orders: 10, grossRevenue: 500000 })]}
        total={row({ shopId: '', shopName: 'Total', spend: 35500, orders: 10, grossRevenue: 500000 })}
        currency="USD"
        platformFiltered
      />,
    )

    // Two headers (Store ROAS, CPA) and their dashed cells in both the body
    // row and the total row all carry the same explanation.
    const explained = screen.getAllByTitle(/platform filter/i)
    expect(explained.length).toBeGreaterThanOrEqual(4)
  })

  it('does not need to explain Store ROAS and CPA when no platform filter is active', () => {
    render(<MarketingTable rows={[FILLED]} total={FILLED} currency="USD" />)

    expect(screen.queryAllByTitle(/platform filter/i)).toHaveLength(0)
  })

  it('brings a hidden metric out through Select metrics and remembers it', () => {
    render(<MarketingTable rows={[FILLED]} total={FILLED} currency="USD" />)

    fireEvent.click(screen.getByRole('button', { name: 'Select metrics' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Meta' }))

    expect(screen.getByRole('button', { name: 'Sort by Meta' })).toBeTruthy()
    const saved = JSON.parse(localStorage.getItem('marketing-columns') ?? '[]') as string[]
    expect(saved).not.toContain('metaSpend')
    expect(saved).toContain('cpm') // the others stay hidden
  })
})
