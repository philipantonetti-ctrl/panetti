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

  // Task 5: the route now says how many of the shop's accounts on this
  // provider it consulted. Zero and "ran no campaigns" must read as different
  // sentences — reading the second when the first is true is how someone
  // concludes a platform is dead when it was never connected.
  it('says there are no ad accounts when none exist for this platform', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ rows: [], errors: [], accountsChecked: 0 }))),
    )

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() =>
      expect(screen.getByText('No Meta ad accounts on this store yet.')).toBeTruthy(),
    )
    expect(screen.queryByText('No campaigns ran in this period.')).toBeNull()
  })

  // Names the platform actually selected, not a hardcoded "Meta" — the self-
  // review question this branch's own briefs ask by name.
  it('names Google, not Meta, when Google has no accounts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ rows: [], errors: [], accountsChecked: 0 }))),
    )

    render(<BreakdownTable shopId="shop1" provider="google" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() =>
      expect(screen.getByText('No Google ad accounts on this store yet.')).toBeTruthy(),
    )
    expect(screen.queryByText('No Meta ad accounts on this store yet.')).toBeNull()
  })

  // The other side of the same distinction: an account exists and was asked,
  // it simply spent nothing — that is the pre-existing empty state, not the
  // new one.
  it('says nothing ran, not that no account exists, once an account was actually checked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ rows: [], errors: [], accountsChecked: 1 }))),
    )

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('No campaigns ran in this period.')).toBeTruthy())
    expect(screen.queryByText(/No Meta ad accounts/)).toBeNull()
  })

  // C1: a campaign id belongs to exactly one ad account. The row being
  // expanded knows which one (row.accountId), so a child request must carry
  // it — otherwise a second account on the same connection gets asked the
  // same object id and its ad sets come back mislabelled as the first
  // account's (see breakdown.ts / meta.ts). The top-level request must NOT
  // carry it: campaign level is the one place the fan-out across every
  // account is the point.
  it("sends the row's own accountId when expanding into children, and omits it from the top-level request", async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const adset = row({ id: 'as1', name: 'Ad Set A', accountId: 'acc1' })
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('level=adset')) return Promise.resolve(jsonResponse({ rows: [adset], errors: [] }))
      return Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    const topUrl = new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
    expect(topUrl.searchParams.has('accountId')).toBe(false)

    fireEvent.click(screen.getByText('Campaign One'))
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())

    const childUrl = new URL(String(fetchMock.mock.calls[1][0]), 'http://x')
    expect(childUrl.searchParams.get('accountId')).toBe('acc1')
  })

  // I3: `toggle` marks a row "fetched" before the request resolves and never
  // un-marks it, so a failed expansion used to be stuck that way forever —
  // collapsing and re-expanding replayed the same cached error instead of
  // asking again. Transient failures (rate limits, a brief 500, a token
  // blip) are exactly what a live platform read hits.
  it('retries a failed expansion when collapsed and re-expanded', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const adset = row({ id: 'as1', name: 'Ad Set A', accountId: 'acc1' })
    let childCalls = 0
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('level=adset')) {
        childCalls++
        if (childCalls === 1) return Promise.resolve(jsonResponse({ error: 'Meta answered 500' }, 500))
        return Promise.resolve(jsonResponse({ rows: [adset], errors: [] }))
      }
      return Promise.resolve(jsonResponse({ rows: [campaign], errors: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    fireEvent.click(screen.getByText('Campaign One')) // expand -> the child request fails
    await waitFor(() => expect(screen.getByText(/Meta answered 500/)).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByText('Campaign One')) // collapse
    await waitFor(() => expect(screen.queryByText(/Meta answered 500/)).toBeNull())

    fireEvent.click(screen.getByText('Campaign One')) // re-expand: must ask again, not replay the cached failure
    await waitFor(() => expect(screen.getByText('Ad Set A')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(3) // proves the retry actually re-fetched
  })

  // I2: the catch handler used to set loadError while leaving rows === null
  // forever, so the red error banner and "Loading campaigns…" rendered at
  // the same time, permanently, with no way out. A session expiring in an
  // open tab (a 403 from the route) is the mundane, everyday trigger.
  it('does not show Loading… underneath the error banner when the initial load fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Session expired'))))

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Session expired')).toBeTruthy())

    expect(screen.queryByText('Loading campaigns…')).toBeNull()
  })

  it('retries the initial load when Try again is pressed', async () => {
    const campaign = row({ id: 'c1', name: 'Campaign One', accountId: 'acc1' })
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Session expired'))
      .mockResolvedValueOnce(jsonResponse({ rows: [campaign], errors: [], accountsChecked: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText('Session expired')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText('Campaign One')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Session expired')).toBeNull()
  })

  // I4: accountsChecked === 1 and rows.length === 0 used to always render "No
  // campaigns ran in this period" — a false claim about the client's own
  // money when the real reason is that the only account errored, not that it
  // spent nothing. The per-account reason (from `errors`) stays visible in
  // the banner above; only the false claim underneath it is suppressed.
  it('does not claim nothing ran when the only account errored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            rows: [],
            errors: [{ accountId: 'acc1', accountName: 'Account One', message: 'Facebook login expired.' }],
            accountsChecked: 1,
          }),
        ),
      ),
    )

    render(<BreakdownTable shopId="shop1" provider="meta" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() => expect(screen.getByText(/Facebook login expired/)).toBeTruthy())

    expect(screen.getByText('Could not read this period.')).toBeTruthy()
    expect(screen.queryByText('No campaigns ran in this period.')).toBeNull()
  })

  // I8: the breakdown is live from one platform, in the ad account's own
  // currency, while MarketingTable above it is consolidated stored data —
  // both right, but nothing else on the page says why the two spend figures
  // can differ for the same store.
  it('captions the table with where the numbers come from, naming the platform actually selected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ rows: [], errors: [], accountsChecked: 1 }))),
    )

    render(<BreakdownTable shopId="shop1" provider="google" from="2026-07-01" to="2026-07-31" />)
    await waitFor(() =>
      expect(screen.getByText('Live from Google, in the ad account’s own currency.')).toBeTruthy(),
    )
    expect(screen.queryByText(/Live from Meta/)).toBeNull()
  })
})
