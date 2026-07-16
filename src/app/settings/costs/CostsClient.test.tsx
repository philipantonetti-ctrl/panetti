// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
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

  it('stops loading instead of spinning forever', async () => {
    const { container } = render(<CostsClient email="admin@test.local" shops={[]} />)

    // The bug: loading starts true and load() bails before clearing it, so the
    // skeleton rows shimmer for ever and the page lies about its state.
    await waitFor(() => {
      expect(skeletons(container).length).toBe(0)
    })
  })

  it('says why the table is empty, and points at connecting a shop', async () => {
    render(<CostsClient email="admin@test.local" shops={[]} />)

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
