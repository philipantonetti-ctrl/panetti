// @vitest-environment jsdom
import type { ReactElement, ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { MarketingClient } from './MarketingClient'
import type { MarketingShopRow } from '@/lib/ads/marketing'

// The refresh button (Task 7) calls the real useToast(), which throws without
// a ToastProvider ancestor — production gets one from the root layout, so
// every render here needs the same wrapper rather than a per-test one-off.
// Named to match the sibling convention (AdAccountsClient.test.tsx's
// renderPage), not aliased onto testing-library's own `render` — that alias
// reads as the real thing and hides the wrapping from anyone skimming a test.
function renderPage(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketing',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
// BreakdownTable's own fetch/expand/error behaviour is Task 4's ground — 13
// tests in BreakdownTable.test.tsx already cover it. Standing in for itself
// here means these tests prove only what MarketingClient controls: which
// provider and which single shop it mounts the table with.
vi.mock('./BreakdownTable', () => ({
  BreakdownTable: (props: { shopId: string; provider: string; from: string; to: string }) => (
    <div data-testid="breakdown-table">{JSON.stringify(props)}</div>
  ),
}))
// Same reasoning as BreakdownTable above: AffiliateSection fetches its own
// figures from its own endpoint and decides for itself whether it has anything
// to show. Standing in for itself here leaves these tests proving only what
// MarketingClient controls — that the section is mounted at all, and with the
// page's own filter state.
vi.mock('./AffiliateSection', () => ({
  AffiliateSection: (props: {
    preset: string
    from: string
    to: string
    shops: string[]
    tick: number
  }) => <div data-testid="affiliate-section">{JSON.stringify(props)}</div>,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const row = (over: Partial<MarketingShopRow>): MarketingShopRow => ({
  shopId: 'a',
  shopName: 'Panetti Norway',
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

const payload = {
  displayCurrency: 'USD',
  byShop: [
    row({
      spend: 120000,
      orders: 8,
      grossRevenue: 900000,
      roas: 7.5,
      platformRoas: 6.28,
      conversions: 12,
      conversionValue: 753600,
      costPerPurchase: 10000,
      cpa: 15000,
    }),
  ],
  total: row({
    shopId: '',
    shopName: 'Total',
    spend: 120000,
    orders: 8,
    grossRevenue: 900000,
    roas: 7.5,
    platformRoas: 6.28,
    conversions: 12,
    conversionValue: 753600,
    costPerPurchase: 10000,
  }),
  byPlatform: [],
  series: [],
  spendCheck: { accounts: [], needsAttention: false },
  connected: true,
  unassignedCampaigns: 0,
  partialAccounts: false,
  // Real route response includes this (src/app/api/marketing/route.ts:81); the
  // existing Payload type here just never declared it before BreakdownTable
  // needed a concrete range to ask its own endpoint for.
  range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
}

describe('MarketingClient', () => {
  it('fetches marketing metrics and shows the Ads Manager numbers', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    const calls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls.some((u) => u.includes('/api/marketing?'))).toBe(true)

    expect(screen.getByText('AD SPEND')).toBeTruthy()
    expect(screen.getByText('PURCHASE ROAS')).toBeTruthy()
    expect(screen.getByText('COST PER PURCHASE')).toBeTruthy()
    expect(screen.getAllByText('$1,200.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('6.28×').length).toBeGreaterThan(0)
    expect(screen.getByText('Panetti Norway')).toBeTruthy()
    // MarketingChart is the only place this exact sentence renders now —
    // PlatformCard's empty state says "No spend to break down." instead, so
    // the two surfaces state different, true things rather than echoing.
    expect(screen.getByText('No ad spend in this period.')).toBeTruthy()
    // Zero unassigned campaigns: the fallback notice must not render at all.
    expect(screen.queryByText(/no store assigned/i)).toBeNull()
  })

  it('shows the platform card once data arrives', async () => {
    const withPlatform = {
      ...payload,
      byPlatform: [
        {
          provider: 'meta',
          label: 'Meta',
          spend: 100_00,
          impressions: 1000,
          clicks: 20,
          conversions: 2,
          conversionValue: 50_00,
          share: 1,
          cpc: 500,
          cpm: 10000,
          ctr: 0.02,
          platformRoas: 0.5,
          costPerPurchase: 5000,
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(withPlatform), { status: 200 }))),
    )

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    // PlatformCard and PlatformTable both print the label, so there are two —
    // this test only cares that the platform data made it onto the page.
    expect((await screen.findAllByText('Meta')).length).toBeGreaterThan(0)
  })

  // Task 6: the design requires the unassigned-campaign fallback to be
  // visible, matching ProductsClient's uncosted-products notice — a count, a
  // plain sentence and a link, never rendered when the count is zero (proven
  // by the previous test's own assertion against the same payload shape).
  it('shows a count and a link when campaigns still need a store', async () => {
    const withUnassigned = { ...payload, unassignedCampaigns: 3 }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(withUnassigned), { status: 200 }))),
    )

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    expect(screen.getByText(/3 campaigns have no store assigned/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Assign campaigns' })
    expect(link.getAttribute('href')).toBe('/settings/ad-accounts')
  })

  // FIX 6: the whole point of this branch was to let the operator
  // consolidate into a currency other than USD. Gating the notice on
  // currency === 'USD' made it vanish for exactly that case, leaving a
  // DKK+NOK view with converted figures and no sentence saying so.
  it('shows the consolidation notice for multiple shops in NOK, not just USD', async () => {
    const withNok = { ...payload, displayCurrency: 'NOK' }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(withNok), { status: 200 }))))

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[
          { id: 'a', name: 'Panetti Norway', currency: 'NOK' },
          { id: 'b', name: 'Panetti Denmark', currency: 'DKK' },
        ]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    expect(screen.getByText(/consolidated to NOK/)).toBeTruthy()
  })

  it('does not show the consolidation notice for a single shop', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))))

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    expect(screen.queryByText(/consolidated to/)).toBeNull()
  })

  // FIX 4: the route computes partialAccounts from the data (a split account
  // with a campaign resolving outside scope) so the Spend Check caution can
  // fire even in the "all stores" view, where the selection-driven signal
  // (allStores) cannot see it. This proves the payload field actually
  // reaches the component that renders the caution.
  it('shows the Spend Check caution when the payload reports partialAccounts, even with every store in view', async () => {
    const withPartial = {
      ...payload,
      partialAccounts: true,
      spendCheck: {
        accounts: [
          {
            id: 'acc-1',
            name: 'Split Account',
            provider: 'google',
            currency: 'NOK',
            nativeTotal: 100_000,
            convertedTotal: 9_000,
            daysWithData: 5,
            daysInRange: 10,
            firstDay: '2026-07-01',
            lastDay: '2026-07-05',
            lastSyncAt: null,
            lastError: null,
            status: 'ok',
          },
        ],
        needsAttention: false,
      },
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(withPartial), { status: 200 }))))

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: /spend check/i }))
    expect(screen.getByTestId('spend-check-caution')).toBeInTheDocument()
  })

  it('shows the connect doorway and fetches nothing when no account exists', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderPage(<MarketingClient email="admin@test.local" shops={[]} hasAccounts={false} />)
    await act(async () => {})

    expect(screen.getByText('No ad accounts connected yet')).toBeTruthy()
    expect(screen.getByText('Connect an ad account')).toBeTruthy()
    const marketingCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/marketing'))
    expect(marketingCalls).toHaveLength(0)
  })

  // The affiliate program is its own channel, not a subset of paid ads: a
  // workspace that never connected Meta or Google can still be paying
  // affiliate commission, and that cost is already charged to net profit on
  // the dashboard. Mounted OUTSIDE the doorway ternary for exactly that
  // reason — the section decides for itself whether it has anything to show.
  it('mounts the affiliate section even with no ad account connected', async () => {
    vi.stubGlobal('fetch', vi.fn())

    renderPage(<MarketingClient email="admin@test.local" shops={[]} hasAccounts={false} />)
    await act(async () => {})

    expect(screen.getByTestId('affiliate-section')).toBeTruthy()
  })

  it("hands the affiliate section the page's own date and shop filters", async () => {
    vi.stubGlobal('fetch', fetchPayload())

    renderPage(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})

    const props = () => JSON.parse(screen.getByTestId('affiliate-section').textContent!)
    expect(props()).toMatchObject({ preset: 'this_month', shops: [] })

    selectOnly('Panetti Norway')
    await act(async () => {})
    expect(props().shops).toEqual(['a'])
  })

  // Three shops, not one: "all shops" (the default, an empty selection) and
  // "several shops" (two of the three, explicitly) are different sentences in
  // the brief and must both be provably distinct from "exactly one" — with
  // only two shops total, ticking every box collapses back to the empty-array
  // "all" state (ShopFilter's own normalisation), which would make "several"
  // untestable as its own case.
  const threeShops = [
    { id: 'a', name: 'Panetti Norway', currency: 'NOK' },
    { id: 'b', name: 'Panetti Sweden', currency: 'SEK' },
    { id: 'c', name: 'Panetti Denmark', currency: 'DKK' },
  ]

  const fetchPayload = () =>
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })))

  /** Drives the real ShopFilter dropdown rather than reaching into state. */
  function selectOnly(shopName: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Shops' }))
    fireEvent.click(screen.getByRole('button', { name: `Only ${shopName}` }))
  }

  function breakdownProps() {
    return JSON.parse(screen.getByTestId('breakdown-table').textContent!)
  }

  it('shows the breakdown only for a single store', async () => {
    vi.stubGlobal('fetch', fetchPayload())

    renderPage(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})

    // Default selection is every shop — neither the switcher nor the table,
    // and the one-sentence reason instead.
    expect(screen.queryByTestId('breakdown-table')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Meta' })).toBeNull()
    expect(screen.getByText(/campaigns belong to one ad account/i)).toBeTruthy()

    // Several, but not all: still hidden. Unchecking Denmark from "all" (every
    // box ticked) leaves Norway and Sweden both selected — a genuine
    // two-shop array, not the empty-array "all" state under another name.
    fireEvent.click(screen.getByRole('button', { name: 'Shops' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Panetti Denmark' }))
    await act(async () => {})
    expect(screen.queryByTestId('breakdown-table')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Meta' })).toBeNull()
    expect(screen.getByText(/campaigns belong to one ad account/i)).toBeTruthy()

    // Exactly one: the switcher and the table appear, scoped to that shop.
    fireEvent.click(screen.getByRole('button', { name: 'Only Panetti Norway' }))
    await act(async () => {})
    expect(screen.getByRole('tab', { name: 'Meta' })).toBeTruthy()
    expect(screen.getByTestId('breakdown-table')).toBeTruthy()
    expect(screen.queryByText(/campaigns belong to one ad account/i)).toBeNull()
    expect(breakdownProps().shopId).toBe('a')
  })

  // Beyond the required three: NO_SHOPS ('none', reached via "Deselect all")
  // is also a one-element array, but it names no real shop. The gate must
  // read it as "not exactly one store", not hand a fake shopId to
  // BreakdownTable — which would fetch a real /api/marketing/breakdown
  // request for a shop that does not exist and print a misleading "no
  // account" sentence instead of the actual reason (nothing is selected).
  it('treats "no shops" as not exactly one, not as a shop named none', async () => {
    vi.stubGlobal('fetch', fetchPayload())

    renderPage(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Shops' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
    await act(async () => {})

    expect(screen.queryByTestId('breakdown-table')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Meta' })).toBeNull()
    expect(screen.getByText(/campaigns belong to one ad account/i)).toBeTruthy()
  })

  it('switches the table between Meta and Google', async () => {
    vi.stubGlobal('fetch', fetchPayload())

    renderPage(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})
    selectOnly('Panetti Norway')
    await act(async () => {})

    expect(breakdownProps().provider).toBe('meta')

    fireEvent.click(screen.getByRole('tab', { name: 'Google' }))

    expect(breakdownProps().provider).toBe('google')
    expect(breakdownProps().shopId).toBe('a') // same store — only the platform moved
  })

  // FINDING 2: `provider` (the drill-down's own Meta/Google switcher) never
  // reacted to the page's `platform` filter, so filtering the page to Google
  // still left the drill-down open on Meta campaigns underneath a header
  // claiming a Google-only scope — two scopes on one screen. Locking the
  // drill-down to the active filter, and hiding the switcher rather than
  // leaving a control that offers a contradictory choice, is chosen over
  // merely seeding it: a visible Meta/Google tablist would still let the
  // client click the "wrong" one while the header says otherwise.
  it('locks the drill-down to the page platform filter and hides its own switcher', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...payload,
              platform: String(url).includes('platform=google') ? 'google' : null,
            }),
            { status: 200 },
          ),
        ),
      ),
    )

    renderPage(
      <MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} platforms={twoPlatforms} />,
    )
    await act(async () => {})
    selectOnly('Panetti Norway')
    await act(async () => {})

    // No page filter yet: the switcher is a real choice, defaulted to Meta.
    expect(screen.getByRole('tab', { name: 'Meta' })).toBeTruthy()
    expect(breakdownProps().provider).toBe('meta')

    fireEvent.change(screen.getByRole('combobox', { name: /ad platform/i }), {
      target: { value: 'google' },
    })
    await act(async () => {})

    // Filtered to Google: the switcher would only ever offer a contradiction,
    // so it is gone, and the drill-down follows the page's own scope.
    expect(screen.queryByRole('tab', { name: 'Meta' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Google' })).toBeNull()
    expect(breakdownProps().provider).toBe('google')
  })

  it('starts on Meta', async () => {
    vi.stubGlobal('fetch', fetchPayload())

    renderPage(<MarketingClient email="admin@test.local" shops={threeShops} hasAccounts={true} />)
    await act(async () => {})
    selectOnly('Panetti Norway')
    await act(async () => {})

    expect(screen.getByRole('tab', { name: 'Meta' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Google' }).getAttribute('aria-selected')).toBe('false')
    expect(breakdownProps().provider).toBe('meta')
  })

  // The platform list is now a server-supplied prop (workspace configuration,
  // src/app/marketing/page.tsx), not derived from the response's byPlatform —
  // so this test drives PlatformFilter via that prop directly. The base
  // `payload` fixture (byPlatform: []) is enough; only the prop needs two
  // entries for the combobox to render at all.
  const twoPlatforms = [
    { provider: 'meta', label: 'Meta' },
    { provider: 'google', label: 'Google' },
  ]

  it('asks the server for one platform when one is chosen', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
        platforms={twoPlatforms}
      />,
    )
    await act(async () => {})

    fireEvent.change(screen.getByRole('combobox', { name: /ad platform/i }), {
      target: { value: 'meta' },
    })
    await act(async () => {})

    const calls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls.some((u) => u.includes('platform=meta'))).toBe(true)
  })

  // FINDING 1: `platform` is pending client state — it flips the instant the
  // user picks a new option, before the refetch it triggers has resolved.
  // `data` only changes on fetch SUCCESS. So gating the chart on `platform`
  // (rather than on the platform that produced `data`) makes the ROAS/POAS
  // lines reappear the moment "All platforms" is picked, even though `data`
  // still holds a Meta-only fetch's numbers — worse, permanently, if the
  // refetch then fails, since nothing ever clears `loading` back onto fresh
  // data. This test drives exactly that sequence and must still find the
  // ratio lines absent once the "All platforms" refetch has failed.
  it('keeps ROAS and POAS hidden after switching to All platforms while the refetch is still Meta-only or has failed', async () => {
    const seriesWithSpend = [
      {
        date: '2026-07-01',
        spend: 50_00,
        grossRevenue: 100_00,
        netProfit: 20_00,
        metaSpend: 50_00,
        googleSpend: 0,
      },
    ]
    const metaPayload = { ...payload, platform: 'meta', series: seriesWithSpend }
    const allPayload = { ...payload, platform: null, series: seriesWithSpend }

    // The route echoes back whichever platform it actually applied
    // (src/app/api/marketing/route.ts) — the mock mirrors that contract so
    // this test exercises the same shape production sends.
    let sawMeta = false
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('platform=meta')) {
        sawMeta = true
        return Promise.resolve(new Response(JSON.stringify(metaPayload), { status: 200 }))
      }
      if (sawMeta) {
        // The refetch triggered by picking "All platforms" back off Meta —
        // simulated as failing outright, so `data` never updates.
        return Promise.reject(new Error('network down'))
      }
      return Promise.resolve(new Response(JSON.stringify(allPayload), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
        platforms={twoPlatforms}
      />,
    )
    await act(async () => {})

    fireEvent.change(screen.getByRole('combobox', { name: /ad platform/i }), {
      target: { value: 'meta' },
    })
    await act(async () => {})

    expect(screen.queryByText('ROAS')).not.toBeInTheDocument()
    expect(screen.queryByText('POAS')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: /ad platform/i }), {
      target: { value: '' },
    })
    await act(async () => {})

    // The refetch failed: `data` is still the Meta-only fetch's payload, so
    // the chart must still treat this as filtered — the pending selection
    // (now "All platforms") must not leak into what is actually on screen.
    expect(screen.queryByText('ROAS')).not.toBeInTheDocument()
    expect(screen.queryByText('POAS')).not.toBeInTheDocument()
  })

  it('syncs, then reloads the numbers the sync just wrote', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await act(async () => {})

    const calls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls).toContain('/api/ads/sync')
    // The sync only changes the DATABASE; the tab still holds the old numbers
    // until it asks again. More calls than the sync alone proves the refetch.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before + 1)
  })

  // The disabled state is asserted separately: an ordinary mocked response
  // resolves inside the same act() flush, so the button is enabled again by
  // the time a naive test looks. Holding the sync open with a deferred
  // promise is what makes "still running" observable at all.
  it('cannot be pressed twice while it is running', async () => {
    let release: (v: Response) => void = () => {}
    const fetchMock = vi.fn((url: string) =>
      String(url) === '/api/ads/sync'
        ? new Promise<Response>((resolve) => {
            release = resolve
          })
        : Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    const button = screen.getByRole('button', { name: /refresh/i })
    fireEvent.click(button)
    await act(async () => {})

    expect(button).toBeDisabled()

    await act(async () => {
      release(new Response('{}', { status: 200 }))
    })
    expect(button).not.toBeDisabled()
  })

  it('shows the sync error and does not refetch', async () => {
    const fetchMock = vi.fn((url: string) =>
      String(url) === '/api/ads/sync'
        ? Promise.resolve(
            new Response(JSON.stringify({ error: 'Meta token expired' }), { status: 500 }),
          )
        : Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    const marketingCallsBefore = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/marketing'),
    ).length

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await act(async () => {})

    expect(screen.getByText('Meta token expired')).toBeTruthy()
    // A failed sync must not silently re-pull as though it worked — the
    // database never changed, so there is nothing new to fetch.
    const marketingCallsAfter = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/marketing'),
    ).length
    expect(marketingCallsAfter).toBe(marketingCallsBefore)
  })

  it('falls back to a generic message when the sync error body is not JSON', async () => {
    const fetchMock = vi.fn((url: string) =>
      String(url) === '/api/ads/sync'
        ? Promise.resolve(new Response('not json', { status: 500 }))
        : Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await act(async () => {})

    expect(screen.getByText('Sync failed')).toBeTruthy()
  })

  it('shows a network-failure toast when the sync request throws', async () => {
    const fetchMock = vi.fn((url: string) =>
      String(url) === '/api/ads/sync'
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderPage(
      <MarketingClient
        email="admin@test.local"
        shops={[{ id: 'a', name: 'Panetti Norway', currency: 'NOK' }]}
        hasAccounts={true}
      />,
    )
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await act(async () => {})

    expect(screen.getByText('Could not reach the server')).toBeTruthy()
  })
})
