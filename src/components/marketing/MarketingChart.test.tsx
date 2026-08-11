// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MarketingChart, ChartTooltip } from './MarketingChart'

// No container-size mocking needed: the heading, legend and toggle live
// OUTSIDE the ResponsiveContainer, so they render under jsdom at zero size.
// Verified by probe. Do not add assertions on SVG paths — those really do
// need a measured container and would fail.

const series = [
  { date: '2026-07-01', spend: 150_00, grossRevenue: 500_00, netProfit: 90_00, metaSpend: 100_00, googleSpend: 50_00 },
  { date: '2026-07-02', spend: 200_00, grossRevenue: 700_00, netProfit: 120_00, metaSpend: 120_00, googleSpend: 80_00 },
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

  it('draws ROAS and POAS alongside the money', () => {
    render(<MarketingChart series={series} currency="NOK" />)

    expect(screen.getByText('ROAS')).toBeInTheDocument()
    expect(screen.getByText('POAS')).toBeInTheDocument()
  })

  it('drops ROAS and POAS when one platform is selected, and says why', () => {
    render(<MarketingChart series={series} currency="NOK" platformFiltered />)

    expect(screen.queryByText('ROAS')).not.toBeInTheDocument()
    expect(screen.queryByText('POAS')).not.toBeInTheDocument()
    expect(screen.getByText(/whole-store/i)).toBeInTheDocument()
  })

  it('offers day, week and month, starting on day', () => {
    render(<MarketingChart series={series} currency="NOK" />)

    expect(screen.getByRole('tab', { name: 'Day' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'Week' }))
    expect(screen.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'true')
  })

  // The tooltip used to decide money-vs-ratio off `row.name`, matched against
  // two independent string literals set on the <Line> elements (name="ROAS").
  // Renaming the legend label in one place, without touching the other,
  // would silently make a ratio render as currency with no type error and no
  // other failing test. `dataKey` is the binding to the actual data field
  // (roas/poas), so it cannot drift from a display label the way `name` can.
  it('formats a ratio line as a multiple by its dataKey, even if its display name changes', () => {
    render(
      <ChartTooltip
        active
        label="2026-07-01"
        currency="NOK"
        payload={[{ name: 'Some Renamed Legend Entry', dataKey: 'roas', value: 2.084, color: '#000' }]}
      />,
    )

    expect(screen.getByText('2.08×')).toBeInTheDocument()
  })

  // series-buckets.ts's SeriesBucket.endDate is "for the tooltip" per its own
  // docstring, but nothing read it — a week bucket labelled only "29 Jun" is
  // genuinely ambiguous about what it covers. Recharts passes the whole
  // bucket back as payload[0].payload, so it's available here with no change
  // to series-buckets.ts itself.
  it('shows the full span in the tooltip when a bucket covers more than one day', () => {
    render(
      <ChartTooltip
        active
        label="2026-06-29"
        currency="NOK"
        payload={[
          {
            name: 'Gross revenue',
            dataKey: 'grossRevenue',
            value: 130000,
            color: '#000',
            payload: { date: '2026-06-29', endDate: '2026-07-05' },
          },
        ]}
      />,
    )

    expect(screen.getByText(/29 Jun.+5 Jul/)).toBeInTheDocument()
  })

  it('shows just the one date when a bucket is a single day', () => {
    render(
      <ChartTooltip
        active
        label="2026-07-01"
        currency="NOK"
        payload={[
          {
            name: 'Gross revenue',
            dataKey: 'grossRevenue',
            value: 100,
            color: '#000',
            payload: { date: '2026-07-01', endDate: '2026-07-01' },
          },
        ]}
      />,
    )

    expect(screen.getByText('1 Jul')).toBeInTheDocument()
  })
})
