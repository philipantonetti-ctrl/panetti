// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { CostsClient } from './CostsClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

// AppShell is a client component: it reads the current route and pushes on sign-out.
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/costs',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

describe('CostsClient with no shops (the live production state)', () => {
  // This page shows no "Loading…" text — it loads as four skeleton rows.
  const skeletons = (container: HTMLElement) => container.querySelectorAll('.skeleton')

  /**
   * There are no products to fetch without a shop, but the shipping-rates
   * section fetches its list unconditionally — so without a stub these two
   * tests fire a real request at the jsdom origin and quietly depend on nothing
   * answering there. Stubbed the way every other describe in this file does.
   */
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/api/shipping-rates')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ rates: [] }) } as unknown as Response)
        }
        return Promise.reject(new Error(`CostsClient.test: unexpected fetch to ${url}`))
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Wrapped, like every other render in this file: the shipping-rates section
  // raises toasts, and app/layout.tsx wraps every page in a ToastProvider.
  it('stops loading instead of spinning forever', async () => {
    const { container } = renderWithToast(<CostsClient email="admin@test.local" shops={[]} />)

    // The bug: loading starts true and load() bails before clearing it, so the
    // skeleton rows shimmer for ever and the page lies about its state.
    await waitFor(() => {
      expect(skeletons(container).length).toBe(0)
    })
  })

  it('says why the table is empty, and points at connecting a shop', async () => {
    renderWithToast(<CostsClient email="admin@test.local" shops={[]} />)

    await waitFor(() => {
      expect(screen.getByText('No shops connected yet.')).toBeTruthy()
    })

    const link = screen.getByRole('link', { name: 'connect one first' })
    expect(link.getAttribute('href')).toBe('/settings/shops')
  })
})

function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

const SHOP = { id: 'shop-1', name: 'Test Shop', currency: 'NOK' }

const PRODUCT = {
  id: 'prod-1',
  sku: 'SKU-1',
  name: 'Widget',
  imageUrl: null,
  sellingPrice: 10000,
  costPerItem: 5000,
  handlingCost: 500,
  missingCost: false,
}

/** The products list resolves with one product; the cost save is rejected with a 400. */
function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/products?')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ products: [PRODUCT], currency: 'NOK' }),
      } as unknown as Response)
    }
    if (url.includes('/cost')) {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Invalid cost' }),
      } as unknown as Response)
    }
    return Promise.reject(new Error(`CostsClient.test: unexpected fetch to ${url}`))
  })
}

describe('CostsClient — a rejected save', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The day-one bug: save() discarded res.ok, so a 400 closed the modal, reloaded
  // the old value from the server, and told the user nothing at all.
  it('shows the server error, does not reload, and keeps the modal open', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)

    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save & Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // 1. The server's own message reaches the user.
    await waitFor(() => {
      expect(screen.queryByText('Invalid cost')).not.toBeNull()
    })

    // 2. onSaved was NOT called: its only job is to close the modal and reload the
    //    list, so a second GET to /api/products would mean it fired anyway.
    const reloadCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/products?'),
    )
    expect(reloadCalls).toHaveLength(1)

    // 3. The modal did NOT close — the user's numbers are still in it.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeNull()
  })
})

/**
 * A cost entered on one webshop's row is now written to that SKU in every
 * webshop. That is what the client asked for — one product, one cost, not the
 * same figure typed nine times — but a fan-out nobody can see is a fan-out
 * nobody trusts, so the save says how far it reached.
 */
describe('CostsClient — a cost that reaches every webshop', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const saveReturning = (payload: Record<string, unknown>) =>
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/products?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ products: [PRODUCT], currency: 'NOK' }),
        } as unknown as Response)
      }
      if (url.includes('/cost')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => payload,
        } as unknown as Response)
      }
      return Promise.reject(new Error(`CostsClient.test: unexpected fetch to ${url}`))
    })

  async function saveCost() {
    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save & Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  }

  it('says how many webshops the cost reached', async () => {
    vi.stubGlobal('fetch', saveReturning({ ok: true, points: 9, shops: 9, skipped: [] }))
    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await saveCost()

    expect(await screen.findByText(/9 webshops/i)).toBeTruthy()
  })

  it('reads naturally when only one webshop sells it', async () => {
    vi.stubGlobal('fetch', saveReturning({ ok: true, points: 1, shops: 1, skipped: [] }))
    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await saveCost()

    expect(await screen.findByText(/1 webshop\b/i)).toBeTruthy()
  })

  /**
   * A shop left on its old cost is the one outcome that must never pass as
   * success. Its profit is now being figured from a stale number, and only this
   * message says so.
   */
  it('names a webshop it could not convert for, rather than reporting plain success', async () => {
    vi.stubGlobal(
      'fetch',
      saveReturning({
        ok: true,
        points: 8,
        shops: 8,
        skipped: [{ shopName: 'Panetti Germany', currency: 'EUR' }],
      }),
    )
    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await saveCost()

    expect(await screen.findByText(/Panetti Germany/)).toBeTruthy()
  })

  it('tells the reader on the page itself that a cost is shared, before they type one', async () => {
    vi.stubGlobal('fetch', saveReturning({ ok: true, points: 1, shops: 1, skipped: [] }))
    const { container } = renderWithToast(
      <CostsClient email="admin@test.local" shops={[SHOP]} />,
    )

    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())
    expect(container.textContent).toMatch(/every webshop/i)
  })
})

/**
 * "We only need to see the product one time in the list" — the last clause of
 * the client's message, on the last page where it was not true. The dropdown
 * stays, because ten of the sixty-two products are sold only outside Norway and
 * six of those sold this quarter: removing it would make them uncostable.
 */
describe('CostsClient — one row per product', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const listing = (body: Record<string, unknown>) =>
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/products?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ products: [PRODUCT], currency: 'NOK', ...body }),
        } as unknown as Response)
      }
      return Promise.reject(new Error(`CostsClient.test: unexpected fetch to ${url}`))
    })

  it('opens on the combined view rather than one webshop', async () => {
    const fetchMock = listing({ onlyElsewhere: 0 })
    vi.stubGlobal('fetch', fetchMock)

    renderWithToast(
      <CostsClient email="admin@test.local" shops={[SHOP]} sourceCurrency="NOK" />,
    )

    // Found rather than indexed: the shipping-rates section on the same page
    // fetches too, and a child effect runs before its parent's.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/products')),
      ).toEqual(['/api/products?source=1'])
    })
  })

  it('still offers each webshop on its own', async () => {
    vi.stubGlobal('fetch', listing({ onlyElsewhere: 0 }))
    renderWithToast(
      <CostsClient email="admin@test.local" shops={[SHOP]} sourceCurrency="NOK" />,
    )

    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())
    expect(screen.getByRole('option', { name: /Test Shop/ })).toBeTruthy()
  })

  /**
   * A page showing 52 of 62 products and saying nothing reads as "that is all of
   * them" — the same lie as a blank cell. Six of the ten it leaves out sold this
   * quarter.
   */
  it('says how many products it is not showing, and where to find them', async () => {
    vi.stubGlobal('fetch', listing({ onlyElsewhere: 10 }))
    const { container } = renderWithToast(
      <CostsClient email="admin@test.local" shops={[SHOP]} sourceCurrency="NOK" />,
    )

    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())
    expect(container.textContent).toMatch(/10 products/i)
  })

  it('says nothing about missing products when it is showing them all', async () => {
    vi.stubGlobal('fetch', listing({ onlyElsewhere: 0 }))
    const { container } = renderWithToast(
      <CostsClient email="admin@test.local" shops={[SHOP]} sourceCurrency="NOK" />,
    )

    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())
    expect(container.textContent).not.toMatch(/only in your other webshops/i)
  })

  /**
   * Nobody has ticked a stock source, which is how every workspace starts. The
   * page must work exactly as it did before this view existed rather than
   * offering an empty one.
   */
  it('opens on a single webshop when no shop is a stock source', async () => {
    const fetchMock = listing({})
    vi.stubGlobal('fetch', fetchMock)

    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} sourceCurrency={null} />)

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/products')),
      ).toEqual(['/api/products?shopId=shop-1'])
    })
  })
})

/**
 * "Maybe its easier if we just add an average unit cost we pay per shipping
 * depending on the supplier" — the client's own words. This section is where
 * that figure gets typed, on the page he already types costs on.
 */
describe('CostsClient — shipping cost per unit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const RATE = {
    id: 'rate-1',
    sku: 'PANPIZPRO',
    perUnit: 12000,
    currency: 'NOK',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  }

  /** Products resolve as ever; the shipping list resolves with `rates`. */
  const withRates = (rates: (typeof RATE)[]) =>
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/products?')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ products: [PRODUCT], currency: 'NOK' }),
        } as unknown as Response)
      }
      if (url.startsWith('/api/shipping-rates')) {
        if ((init?.method ?? 'GET') === 'GET') {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ rates }) } as unknown as Response)
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response)
      }
      return Promise.reject(new Error(`CostsClient.test: unexpected fetch to ${url}`))
    })

  it('lists a rate as what one unit costs, and from when', async () => {
    vi.stubGlobal('fetch', withRates([RATE]))
    const { container } = renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.getByText('PANPIZPRO')).toBeTruthy())
    expect(container.textContent).toContain('120.00')
    expect(container.textContent).toContain('2026-01-01')
  })

  /**
   * An empty list must not read as "shipping is free". It means every order is
   * still charged the flat per-order rate, which is the truth and also the only
   * reason this can ship before a single rate is typed.
   */
  it('says orders keep their per-order rate while nothing is entered', async () => {
    vi.stubGlobal('fetch', withRates([]))
    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())
    // The empty-state sentence itself, not a phrase anywhere on the page: the
    // always-rendered help paragraph above the list also says "per-order", so a
    // loose match went green with the empty state deleted outright.
    expect(
      screen.getByText('No per-unit rates yet. Every order is charged your per-order fulfillment rate.'),
    ).toBeTruthy()
  })

  it('drops that sentence the moment a rate exists', async () => {
    // The other half: a page that said "every order is charged your per-order
    // rate" beside a list of per-unit rates would contradict itself.
    vi.stubGlobal('fetch', withRates([RATE]))
    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.getByText('PANPIZPRO')).toBeTruthy())
    expect(screen.queryByText(/No per-unit rates yet/)).toBeNull()
  })

  it('sends what was typed to the shipping route, then re-reads the list', async () => {
    const fetchMock = withRates([])
    vi.stubGlobal('fetch', fetchMock)
    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} sourceCurrency="NOK" />)

    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Shipping SKU'), { target: { value: 'panpizpro' } })
    fireEvent.change(screen.getByLabelText(/Cost per unit/), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText('Shipping from date'), { target: { value: '2026-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add shipping rate' }))

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
      expect(posted).toBeTruthy()
      expect(JSON.parse(String((posted![1] as RequestInit).body))).toEqual({
        sku: 'panpizpro',
        perUnit: 120,
        currency: 'NOK',
        effectiveFrom: '2026-01-01',
      })
    })

    // Re-read, so the row the user just created appears without a page reload.
    await waitFor(() => {
      const gets = fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).startsWith('/api/shipping-rates') && ((init as RequestInit)?.method ?? 'GET') === 'GET',
      )
      expect(gets.length).toBeGreaterThan(1)
    })
  })

  it('refuses to save a half-filled rate rather than posting a blank one', async () => {
    const fetchMock = withRates([])
    vi.stubGlobal('fetch', fetchMock)
    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.getByText('Widget')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Shipping SKU'), { target: { value: 'PANPIZPRO' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add shipping rate' }))

    expect(await screen.findByText(/SKU, a cost per unit and a from date/i)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(false)
  })

  it('deletes a rate by its id', async () => {
    const fetchMock = withRates([RATE])
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', () => true)
    renderWithToast(<CostsClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.getByText('PANPIZPRO')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Delete the shipping rate for PANPIZPRO/ }))

    await waitFor(() => {
      const deleted = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'DELETE')
      expect(deleted).toBeTruthy()
      expect(String(deleted![0])).toBe('/api/shipping-rates?id=rate-1')
    })
  })
})
