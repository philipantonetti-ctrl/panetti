// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketing/email',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const { CampaignTable, EmailClient } = await import('./EmailClient')

afterEach(() => vi.unstubAllGlobals())

const campaign = (over: Record<string, unknown> = {}) => ({
  campaignId: 'c1',
  name: 'August news',
  channel: 'email',
  sentAt: '2026-08-01T09:00:00.000Z',
  recipients: 500,
  opens: 200,
  clicks: 40,
  conversions: 12,
  conversionValue: 1543250,
  ...over,
})

describe('CampaignTable', () => {
  it('computes the rates from the counts, so the two can never disagree', () => {
    render(<CampaignTable campaigns={[campaign()]} currency="NOK" hasOrderMetric />)

    expect(screen.getByText('August news')).toBeInTheDocument()
    expect(screen.getByText('40.0%')).toBeInTheDocument() // 200 of 500 opened
    expect(screen.getByText('8.0%')).toBeInTheDocument() // 40 of 500 clicked
    // Money in minor units on the wire, kroner on screen.
    expect(screen.getByText(/15[\s,.]432/)).toBeInTheDocument()
  })

  it('shows a dash, not a division by zero, for a campaign sent to nobody', () => {
    render(
      <CampaignTable
        campaigns={[campaign({ recipients: 0, opens: 0, clicks: 0 })]}
        currency="NOK"
        hasOrderMetric
      />,
    )
    expect(screen.getAllByText('-').length).toBeGreaterThan(0)
    expect(screen.queryByText('NaN%')).not.toBeInTheDocument()
  })

  it('hides the money columns when the account cannot attribute revenue', () => {
    render(<CampaignTable campaigns={[campaign()]} currency="NOK" hasOrderMetric={false} />)
    expect(screen.queryByText('Revenue')).not.toBeInTheDocument()
    expect(screen.queryByText('Orders')).not.toBeInTheDocument()
  })
})

describe('EmailClient', () => {
  it('points at the settings page while nothing is connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ connected: false, campaigns: [] }), { status: 200 })),
      ),
    )
    render(<EmailClient email="a@b.test" />)

    expect(await screen.findByText('Klaviyo is not connected yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect Klaviyo' })).toHaveAttribute('href', '/settings/email')
  })

  it('shows the campaigns under the Marketing tabs when connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              connected: true,
              currency: 'NOK',
              hasOrderMetric: true,
              lastSyncAt: '2026-08-31T08:00:00.000Z',
              lastError: null,
              campaigns: [campaign()],
            }),
            { status: 200 },
          ),
        ),
      ),
    )
    render(<EmailClient email="a@b.test" />)

    expect(await screen.findByText('August news')).toBeInTheDocument()
    // The two-tab header, so ads and email read as one subject.
    expect(screen.getByRole('link', { name: 'Advertising' })).toHaveAttribute('href', '/marketing')
    expect(screen.getByRole('link', { name: 'Email' })).toHaveAttribute('href', '/marketing/email')
  })
})
