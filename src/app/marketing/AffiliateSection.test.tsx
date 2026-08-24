// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { AffiliateSection } from './AffiliateSection'
import { formatMoney } from '@/lib/money'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

type Payload = {
  connected: boolean
  displayCurrency: string
  range: { from: string; to: string }
  total: { sales: number; orderValue: number; cost: number }
  byShop: { shopId: string; shopName: string; sales: number; orderValue: number; cost: number }[]
  byChannel: { channelId: string; channelName: string; sales: number; orderValue: number; cost: number }[]
  unmatched: number
  unmatchedCost: number
}

const payload: Payload = {
  connected: true,
  displayCurrency: 'NOK',
  range: { from: '2026-04-01T00:00:00.000Z', to: '2026-04-30T00:00:00.000Z' },
  total: { sales: 3, orderValue: 126564, cost: 21756 },
  byShop: [
    { shopId: 'a', shopName: 'Panetti Norway', sales: 2, orderValue: 96564, cost: 15646 },
    { shopId: 'b', shopName: 'Panetti Sweden', sales: 1, orderValue: 30000, cost: 6110 },
  ],
  byChannel: [
    { channelId: '11', channelName: 'Blogg A', sales: 2, orderValue: 125564, cost: 21646 },
    { channelId: '22', channelName: 'Blogg B', sales: 1, orderValue: 1000, cost: 110 },
  ],
  unmatched: 0,
  unmatchedCost: 0,
}

const respondWith = (body: Payload) =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))

const sectionProps = { preset: 'this_month' as const, from: '', to: '', shops: [], tick: 0 }

/** Exact-textContent matcher, the CompareTable.test.tsx idiom — Intl glues the
 *  currency on with a no-break space, which trips string-matcher whitespace
 *  normalization. */
const money = (minor: number) => (_t: string, el: Element | null) =>
  el?.textContent === formatMoney(minor, 'NOK')

describe('AffiliateSection', () => {
  it('renders nothing before data arrives, and nothing for a workspace with no program at all', async () => {
    // First: fetch still pending — the section has nothing it could claim yet.
    const never = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', never)
    const pending = render(<AffiliateSection {...sectionProps} />)
    expect(pending.container.firstChild).toBeNull()
    pending.unmount()

    // Then: not connected, nothing recorded, nothing unmatched — no section.
    vi.stubGlobal(
      'fetch',
      respondWith({
        ...payload,
        connected: false,
        total: { sales: 0, orderValue: 0, cost: 0 },
        byShop: [],
        byChannel: [],
      }),
    )
    const empty = render(<AffiliateSection {...sectionProps} />)
    await act(async () => {})
    expect(empty.container.firstChild).toBeNull()
  })

  it('shows the stats, the channel table and the shop table', async () => {
    vi.stubGlobal('fetch', respondWith(payload))
    render(<AffiliateSection {...sectionProps} />)
    await act(async () => {})

    expect(screen.getByText('AFFILIATE COST')).toBeTruthy()
    expect(screen.getByText('TRACKED SALES')).toBeTruthy()
    expect(screen.getByText('TRACKED ORDER VALUE')).toBeTruthy()
    expect(screen.getAllByText(money(21756)).length).toBeGreaterThan(0)

    // Channel table.
    expect(screen.getByText('CHANNEL')).toBeTruthy()
    expect(screen.getByText('Blogg A')).toBeTruthy()
    expect(screen.getByText('Blogg B')).toBeTruthy()

    // Shop table (two shops, so it is not a restatement of the totals).
    expect(screen.getByText('SHOP')).toBeTruthy()
    expect(screen.getByText('Panetti Norway')).toBeTruthy()
    expect(screen.getByText('Panetti Sweden')).toBeTruthy()

    // Nothing is unmatched, so no warning about missing money.
    expect(screen.queryByText(/matches none of the shops/)).toBeNull()
  })

  it('warns with the unmatched amount and says it is missing from the total too', async () => {
    vi.stubGlobal('fetch', respondWith({ ...payload, unmatched: 2, unmatchedCost: 6110 }))
    render(<AffiliateSection {...sectionProps} />)
    await act(async () => {})

    const notice = screen.getByText(/matches none of the shops/)
    // The money, not just a count — and honest scope: every figure here
    // includes the headline total, not merely the per-shop rows.
    expect(notice.textContent).toContain(formatMoney(6110, 'NOK'))
    expect(notice.textContent).toContain('2 sales')
    expect(notice.textContent).toMatch(/including the total above/i)
    const link = screen.getByRole('link', { name: /affiliate settings/i })
    expect(link.getAttribute('href')).toBe('/settings/affiliate')
  })

  // FIX 3: a workspace whose rows ALL failed to match a shop, with the account
  // then paused, has connected=false and zero tracked sales — exactly the old
  // gate's "does not exist" case. The warning is the one thing that MUST
  // survive that state, since it explains where the money went.
  it('still renders when every sale is unmatched and the account is paused', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({
        ...payload,
        connected: false,
        total: { sales: 0, orderValue: 0, cost: 0 },
        byShop: [],
        byChannel: [],
        unmatched: 3,
        unmatchedCost: 6110,
      }),
    )
    render(<AffiliateSection {...sectionProps} />)
    await act(async () => {})

    expect(screen.getByText(/matches none of the shops/)).toBeTruthy()
    expect(screen.getByText(/including the total above/i)).toBeTruthy()
  })

  it('keeps the last good figures and says so when a refresh fails', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1
        return calls === 1
          ? Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
          : Promise.reject(new Error('network down'))
      }),
    )

    const view = render(<AffiliateSection {...sectionProps} />)
    await act(async () => {})
    expect(screen.getAllByText(money(21756)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()

    // A tick is the page's own refresh heartbeat — this one's fetch fails.
    view.rerender(<AffiliateSection {...sectionProps} tick={1} />)
    await act(async () => {})

    // The figures stay (they were true once) and say they are stale.
    expect(screen.getAllByText(money(21756)).length).toBeGreaterThan(0)
    expect(screen.getByText(/could not be refreshed/)).toBeTruthy()
  })
})
