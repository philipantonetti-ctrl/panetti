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

    // Default-visible headers, including both clearly named ROAS columns.
    for (const label of ['Ad spend', 'Purchases', 'Conv. value', 'P. ROAS', 'Cost/purchase', 'Store ROAS', 'CPA']) {
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
    expect(sweden.textContent).toContain('—')

    expect(screen.getByText('Total')).toBeTruthy()
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
