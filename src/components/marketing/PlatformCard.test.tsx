// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PlatformCard } from './PlatformCard'
import type { MarketingPlatformRow } from '@/lib/ads/marketing'

const row = (over: Partial<MarketingPlatformRow>): MarketingPlatformRow => ({
  provider: 'meta',
  label: 'Meta',
  spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  conversionValue: 0,
  share: 0,
  cpc: null,
  cpm: null,
  ctr: null,
  platformRoas: null,
  costPerPurchase: null,
  ...over,
})

describe('PlatformCard', () => {
  it('lists each platform with its spend and the combined total', () => {
    render(
      <PlatformCard
        rows={[row({ provider: 'meta', label: 'Meta', spend: 443_199_00, share: 0.69 }), row({ provider: 'google', label: 'Google', spend: 196_137_00, share: 0.31 })]}
        total={639_336_00}
        currency="NOK"
      />,
    )

    expect(screen.getByText('Meta')).toBeInTheDocument()
    expect(screen.getByText('Google')).toBeInTheDocument()
    expect(screen.getByText(/639/)).toBeInTheDocument()
  })

  it('sizes each bar by its share', () => {
    render(<PlatformCard rows={[row({ spend: 100, share: 0.25 })]} total={400} currency="NOK" />)
    expect(screen.getByTestId('share-meta')).toHaveStyle({ width: '25%' })
  })

  it('says so plainly when nothing was spent', () => {
    render(<PlatformCard rows={[]} total={0} currency="NOK" />)
    expect(screen.getByText(/no spend to break down/i)).toBeInTheDocument()
  })
})
