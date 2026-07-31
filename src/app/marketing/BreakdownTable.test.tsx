// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { BreakdownTable } from './BreakdownTable'
import type { BreakdownRow } from '@/lib/ads/breakdown'

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketing',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

// Every field a row needs; each test overrides only what it cares about.
const row = (over: Partial<BreakdownRow>): BreakdownRow => ({
  id: 'c1',
  name: 'Campaign One',
  accountId: 'acc1',
  accountName: 'Account One',
  currency: 'USD',
  spend: 100000,
  purchases: 10,
  purchaseValue: 200000,
  impressions: 1000,
  clicks: 50,
  ...over,
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status }) // fresh Response per call — a body reads once
}

describe('BreakdownTable', () => {
  it('lists the campaigns it was given', async () => {
    const campaign = row({ id: 'c1', name: 'Summer Sale', spend: 120000 })
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ rows: [campaign], errors: [] })))
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Summer Sale')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain('/api/marketing/breakdown?')
    expect(url).toContain('shopId=shop1')
    expect(url).toContain('provider=meta')
    expect(url).toContain('level=campaign')
    expect(url).not.toContain('parentId')

    expect(screen.getByText('$1,200.00')).toBeTruthy() // formatted spend
  })

  it('derives ROAS from spend and value', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', spend: 100000, purchaseValue: 637000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))),
    )

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    expect(screen.getByText('6.37×')).toBeTruthy()
  })

  it('shows a dash rather than dividing by zero', async () => {
    const campaign = row({ id: 'c1', name: 'No spend yet', spend: 0, purchaseValue: 0 })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))),
    )

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('No spend yet')).toBeTruthy())

    const roasCell = screen.getByText('No spend yet').closest('tr')!.children[2] as HTMLElement
    expect(roasCell.textContent).toBe('—')
    expect(roasCell.textContent).not.toContain('Infinity')
    expect(roasCell.textContent).not.toContain('NaN')
  })

  it('shows a dash for CTR when nothing was shown', async () => {
    const campaign = row({ id: 'c1', name: 'No impressions', impressions: 0, clicks: 0 })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))),
    )

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('No impressions')).toBeTruthy())

    const ctrCell = screen.getByText('No impressions').closest('tr')!.children[5] as HTMLElement
    expect(ctrCell.textContent).toBe('—')
  })

  it('expands a campaign into its ad sets', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const adset = row({ id: 'as1', name: 'Ad Set A', accountId: 'acc1', spend: 50000 })
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('level=adset')) return Promise.resolve(jsonResponse({ rows: [adset], errors: [] }))
      return Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    fireEvent.click(screen.getByText('Campaign One'))
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const url = String(fetchMock.mock.calls[1][0])
    expect(url).toContain('level=adset')
    expect(url).toContain('parentId=c1')

    // Indented deeper than the campaign that owns it.
    const childCell = screen.getByText('Ad Set A').closest('td')!
    expect(childCell.className).toContain('pl-8')
  })

  it('expands an ad set into its ads', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const adset = row({ id: 'as1', name: 'Ad Set A', accountId: 'acc1' })
    const ad = row({ id: 'ad1', name: 'Ad Alpha', accountId: 'acc1', spend: 9000 })
    // Keyed on parentId identity, not a level= substring: 'level=ad' is a
    // PREFIX of 'level=adset', the exact trap this plan's own ledger flags
    // twice already (meta.test.ts, google.test.ts) — a naive substring check
    // here would silently match the wrong fixture to the wrong request.
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('parentId=as1')) return Promise.resolve(jsonResponse({ rows: [ad], errors: [] }))
      if (u.includes('level=adset')) return Promise.resolve(jsonResponse({ rows: [adset], errors: [] }))
      return Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    fireEvent.click(screen.getByText('Campaign One'))
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())

    fireEvent.click(screen.getByText('Ad Set A'))
    await waitFor(() => expect(screen.getByText('Ad Alpha')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const url = String(fetchMock.mock.calls[2][0])
    // Exact param value, not toContain('level=ad') — that substring is also
    // true of 'level=adset' and would not catch the level being wrong.
    expect(new URL(url, 'http://x').searchParams.get('level')).toBe('ad')
    expect(url).toContain('parentId=as1')

    const childCell = screen.getByText('Ad Alpha').closest('td')!
    expect(childCell.className).toContain('pl-12')

    // A leaf: no button, nothing to press.
    expect(screen.queryByRole('button', { name: /Ad Alpha/ })).toBeNull()
  })

  it('does not refetch a row it has already expanded', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const adset = row({ id: 'as1', name: 'Ad Set A', accountId: 'acc1' })
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('level=adset')) return Promise.resolve(jsonResponse({ rows: [adset], errors: [] }))
      return Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    fireEvent.click(screen.getByText('Campaign One')) // expand
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByText('Campaign One')) // collapse
    await waitFor(() => expect(screen.queryByText('Ad Set A')).toBeNull())

    fireEvent.click(screen.getByText('Campaign One')) // re-expand
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(2) // no third call
  })

  it('calls the middle level Ad set on Meta and Ad group on Google', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const adset = row({ id: 'as1', name: 'Ad Set A', accountId: 'acc1' })
    const makeFetch = () =>
      vi.fn((url: string) => {
        if (String(url).includes('level=adset')) return Promise.resolve(jsonResponse({ rows: [adset], errors: [] }))
        return Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))
      })

    vi.stubGlobal('fetch', makeFetch())
    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())
    fireEvent.click(screen.getByText('Campaign One'))
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())
    expect(screen.getByText('Ad set')).toBeTruthy()
    expect(screen.queryByText('Ad group')).toBeNull()

    cleanup()
    vi.unstubAllGlobals()

    vi.stubGlobal('fetch', makeFetch())
    render(<BreakdownTable shopId="shop1" provider="google" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())
    fireEvent.click(screen.getByText('Campaign One'))
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())
    expect(screen.getByText('Ad group')).toBeTruthy()
    expect(screen.queryByText('Ad set')).toBeNull()
  })

  it('says when nothing ran in the period', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ rows: [], errors: [] }))),
    )

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('No campaigns ran in this period.')).toBeTruthy())

    expect(screen.queryByRole('table')).toBeNull()
  })

  it('puts the reason under the row that failed', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('level=adset')) {
        return Promise.resolve(
          jsonResponse({
            rows: [],
            errors: [
              {
                accountId: 'acc1',
                accountName: 'Account One',
                message: 'Facebook login expired. Press Connect with Facebook to renew it.',
              },
            ],
          }),
        )
      }
      return Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    fireEvent.click(screen.getByText('Campaign One'))
    await waitFor(() =>
      expect(screen.getByText(/Facebook login expired/)).toBeTruthy(),
    )

    // The row that broke is still open, not collapsed back on failure.
    const toggleButton = screen.getByRole('button', { name: /Campaign One/ })
    expect(toggleButton.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/Account One: Facebook login expired/)).toBeTruthy()
  })

  // Beyond the brief's nine: the endpoint's own contract says both arrays can
  // be populated together, and dropping errors silently is the one outcome
  // the task calls "worst possible" — worth its own assertion at the top level.
  it('renders errors even when rows is non-empty', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            rows: [campaign],
            errors: [{ accountId: 'acc2', accountName: 'Account Two', message: 'Token expired.' }],
          }),
        ),
      ),
    )

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    expect(screen.getByText(/Account Two: Token expired\./)).toBeTruthy()
  })

  // Also beyond the nine: an ad is a leaf per the brief ("must not be
  // pressable"), which the ad-set test above checks by name only. This
  // confirms clicking it is inert, not merely unlabeled.
  it('does not fetch anything when an ad row is clicked', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const adset = row({ id: 'as1', name: 'Ad Set A', accountId: 'acc1' })
    const ad = row({ id: 'ad1', name: 'Ad Alpha', accountId: 'acc1' })
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('parentId=as1')) return Promise.resolve(jsonResponse({ rows: [ad], errors: [] }))
      if (u.includes('level=adset')) return Promise.resolve(jsonResponse({ rows: [adset], errors: [] }))
      return Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())
    fireEvent.click(screen.getByText('Campaign One'))
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())
    fireEvent.click(screen.getByText('Ad Set A'))
    await waitFor(() => expect(screen.getByText('Ad Alpha')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByText('Ad Alpha'))
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(3) // unchanged — a leaf takes no click
  })

  // Also beyond the nine: "What to build" requires a refetch on every prop
  // change, not just on mount, and a stale campaign's cached children must
  // not survive into the new list. The same campaign id recurring in both
  // months (a real campaign that ran in both) is the case that would expose
  // a July expansion leaking into August under the "same" row — asserting
  // only that new rows appear is not enough to catch that; a component that
  // refetches rows but forgets to drop the child cache would still pass a
  // weaker version of this test.
  it('refetches when the date range changes, and drops the old cache', async () => {
    const julyCampaign = row({ id: 'c1', name: 'Recurring Campaign', accountId: 'acc1' })
    const augustCampaign = row({ id: 'c1', name: 'Recurring Campaign', accountId: 'acc1' })
    const julyAdSet = row({ id: 'as-july', name: 'July Ad Set', accountId: 'acc1' })
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('parentId=c1')) return Promise.resolve(jsonResponse({ rows: [julyAdSet], errors: [] }))
      if (u.includes('from=2026-08-01')) return Promise.resolve(jsonResponse({ rows: [augustCampaign], errors: [] }))
      return Promise.resolve(jsonResponse({ rows: [julyCampaign], errors: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(
      <BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />,
    )
    await waitFor(() => expect(screen.getByText('Recurring Campaign')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Recurring Campaign'))
    await waitFor(() => expect(screen.getByText('July Ad Set')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(2)

    rerender(<BreakdownTable shopId="shop1" provider="meta" from="2026-08-01" to="2026-08-31" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3)) // the new top-level fetch

    // The same campaign id reappears under the new range. It must come back
    // collapsed, not still showing July's ad set as if it were August's.
    await waitFor(() => expect(screen.getByText('Recurring Campaign')).toBeTruthy())
    expect(screen.queryByText('July Ad Set')).toBeNull()
    expect(screen.getByRole('button', { name: /Recurring Campaign/ }).getAttribute('aria-expanded')).toBe('false')
  })
})
