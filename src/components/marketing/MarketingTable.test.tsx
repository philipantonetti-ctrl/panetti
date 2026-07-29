// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MarketingTable } from './MarketingTable'
import type { MarketingShopRow } from '@/lib/ads/marketing'

const row = (over: Partial<MarketingShopRow>): MarketingShopRow => ({
  shopId: 'a',
  shopName: 'Alpha',
  spend: 0,
  metaSpend: 0,
  googleSpend: 0,
  impressions: 0,
  clicks: 0,
  orders: 0,
  grossRevenue: 0,
  roas: null,
  cpa: null,
  cpc: null,
  ctr: null,
  ...over,
})

describe('MarketingTable', () => {
  it('shows money, ratios and honest dashes', () => {
    render(
      <MarketingTable
        rows={[
          row({
            shopId: 'a',
            shopName: 'Panetti Norway',
            spend: 35500,
            metaSpend: 30000,
            googleSpend: 5500,
            orders: 10,
            grossRevenue: 500000,
            roas: 14.0845,
            cpa: 3550,
            cpc: 284,
            ctr: 0.0277,
            clicks: 125,
            impressions: 4500,
          }),
          row({ shopId: 'b', shopName: 'Panetti Sweden', orders: 4, grossRevenue: 20000 }),
        ]}
        total={row({ shopId: '', shopName: 'Total', spend: 35500, orders: 14, grossRevenue: 520000, roas: 14.6479 })}
        currency="USD"
      />,
    )

    // Headers present.
    for (const label of ['Shop', 'Ad spend', 'Meta', 'Google', 'ROAS', 'CPA', 'CPC', 'CTR']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy()
    }

    expect(screen.getByText('Panetti Norway')).toBeTruthy()
    expect(screen.getAllByText('$355.00').length).toBeGreaterThan(0)
    expect(screen.getByText('14.08×')).toBeTruthy()
    expect(screen.getByText('2.8%')).toBeTruthy()

    // The shop without spend wears dashes, not zero-ratios.
    const swedenCells = screen.getByText('Panetti Sweden').closest('tr')!
    expect(swedenCells.textContent).toContain('—')

    // Total row.
    expect(screen.getByText('Total')).toBeTruthy()
    expect(screen.getByText('14.65×')).toBeTruthy()
  })
})
