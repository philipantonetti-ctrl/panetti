// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PlatformTable } from './PlatformTable'
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

describe('PlatformTable', () => {
  it('shows spend, impressions, clicks and CPC per platform', () => {
    render(
      <PlatformTable
        rows={[row({ spend: 443_199_00, impressions: 5_560_745, clicks: 55_721, cpc: 7_95 })]}
        currency="NOK"
      />,
    )
    // 'en-US' grouping, matching MarketingTable's own count cells: 5,560,745.
    // Verified against the repo convention at MarketingTable.tsx:110 — do not
    // switch to a space-grouped locale, the two tables sit on the same page.
    const cells = within(screen.getByRole('row', { name: /Meta/ })).getAllByRole('cell')
    expect(cells.map((c) => c.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('5,560,745')]),
    )
  })

  it('renders a dash where a ratio has no denominator', () => {
    // A platform with no clicks has no cost per click. Printing 0 would claim
    // clicks were free.
    render(<PlatformTable rows={[row({ spend: 100_00, clicks: 0, cpc: null })]} currency="NOK" />)
    expect(screen.getByTestId('cpc-meta')).toHaveTextContent('—')
  })

  it('renders nothing at all when there are no platforms', () => {
    const { container } = render(<PlatformTable rows={[]} currency="NOK" />)
    expect(container).toBeEmptyDOMElement()
  })
})
