// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MarketingChart } from './MarketingChart'

// No container-size mocking needed: the heading, legend and toggle live
// OUTSIDE the ResponsiveContainer, so they render under jsdom at zero size.
// Verified by probe. Do not add assertions on SVG paths — those really do
// need a measured container and would fail.

const series = [
  { date: '2026-07-01', spend: 150_00, grossRevenue: 500_00, metaSpend: 100_00, googleSpend: 50_00 },
  { date: '2026-07-02', spend: 200_00, grossRevenue: 700_00, metaSpend: 120_00, googleSpend: 80_00 },
]

describe('MarketingChart', () => {
  it('plots spend against revenue by default', () => {
    render(<MarketingChart series={series} currency="NOK" />)
    expect(screen.getByText('Gross revenue')).toBeInTheDocument()
    expect(screen.queryByText('Google')).not.toBeInTheDocument()
  })

  it('swaps to one line per platform when By platform is pressed', () => {
    render(<MarketingChart series={series} currency="NOK" />)
    fireEvent.click(screen.getByRole('button', { name: /by platform/i }))

    expect(screen.getByText('Meta')).toBeInTheDocument()
    expect(screen.getByText('Google')).toBeInTheDocument()
    expect(screen.queryByText('Gross revenue')).not.toBeInTheDocument()
  })
})
