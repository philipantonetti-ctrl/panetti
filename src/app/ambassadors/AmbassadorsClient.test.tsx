// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { AmbassadorsClient } from './AmbassadorsClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/ambassadors',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

function renderPage(ambassadors: unknown[] = [], role: 'ADMIN' | 'MARKETING' = 'ADMIN') {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'POST') return json({ ok: true, id: 'new' })
    if (u.includes('/api/shops')) return json({ shops: [{ id: 's1', name: 'Norway' }, { id: 's2', name: 'Sweden' }] })
    if (u.includes('/api/coupons')) return json({ codes: ['JOHN10', 'SUMMER'] })
    // Before the /api/ambassadors branch on purpose. It does not currently
    // match ("ambassador-products" is not "ambassadors"), but the two differ by
    // one character and the next person should not have to notice that.
    if (u.includes('/api/ambassador-products'))
      return json({
        overview: [],
        catalogue: [{ sku: 'MACBL661', name: 'Advanced Comfort' }, { sku: 'MPX-001', name: 'Pro X' }],
      })
    if (u.includes('/api/ambassadors/stats'))
      return json({
        leaderboard: [
          { rank: 1, ambassadorId: 'a9', name: 'Salla Klemetti', shops: ['Norway'], orders: 3, sales: 90000, commission: 9000 },
        ],
        shopOptions: [{ id: 's1', name: 'Norway' }, { id: 's2', name: 'Sweden' }],
        displayCurrency: 'USD',
        range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
      })
    if (u.includes('/api/ambassadors')) return json({ ambassadors })
    return json({})
  }))
  render(
    <ToastProvider>
      <AmbassadorsClient email="admin@test.local" role={role} />
    </ToastProvider>,
  )
}

describe('the statistics on top', () => {
  it('shows the Top ambassadors table with its shop and period filters', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Top ambassadors')).toBeTruthy()
      expect(screen.getByText('Salla Klemetti')).toBeTruthy()
    })
    expect(screen.getByLabelText('Shops')).toBeTruthy()
    expect(screen.getByLabelText('Period')).toBeTruthy()
  })

  it('marketing gets a nav without the dashboard; the roster is still theirs', async () => {
    renderPage([], 'MARKETING')
    await waitFor(() => expect(screen.getByText('Top ambassadors')).toBeTruthy())
    expect(screen.queryByText('Dashboard')).toBeNull()
    expect(screen.getByText('Add an ambassador')).toBeTruthy()
  })

  it('an admin keeps the dashboard in the nav next to the ambassadors', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeTruthy())
  })
})

describe('AmbassadorsClient store-scoped codes', () => {
  it('lists the connected stores in the Store select', async () => {
    renderPage()
    // Scoped: the statistics' own Shops filter lists the same store names.
    await waitFor(() => {
      const store = within(screen.getByLabelText('Store'))
      expect(store.getByRole('option', { name: 'Norway' })).toBeTruthy()
      expect(store.getByRole('option', { name: 'Sweden' })).toBeTruthy()
    })
  })

  it('keeps the code field disabled until a store is chosen, then loads that store codes', async () => {
    renderPage()
    const codeInput = screen.getByLabelText('Discount code') as HTMLInputElement
    expect(codeInput.disabled).toBe(true)

    await waitFor(() =>
      expect(within(screen.getByLabelText('Store')).getByRole('option', { name: 'Norway' })).toBeTruthy(),
    )
    fireEvent.change(screen.getByLabelText('Store'), { target: { value: 's1' } })

    await waitFor(() => {
      expect((screen.getByLabelText('Discount code') as HTMLInputElement).disabled).toBe(false)
    })
    fireEvent.focus(screen.getByLabelText('Discount code'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'JOHN10' })).toBeTruthy()
    })
  })

  it('says an ambassador uses their existing login, and offers no dead invite link', async () => {
    // The owner: their email is already the admin login, so an invite can never
    // be redeemed. Showing "Not set up yet" with a Copy invite link misleads.
    renderPage([
      {
        id: 'a1', name: 'Philip', email: 'owner@x.local', commissionPercent: 10, active: true,
        onboarded: false, emailHasLogin: true, invitePath: null,
        codes: [{ id: 'c1', code: 'TEKGUIDE500', shopId: 's1', shopName: 'Panetti Norway' }],
        products: [],
      },
    ])
    await waitFor(() => expect(screen.getByText('Uses existing login')).toBeTruthy())
    expect(screen.queryByText('Not set up yet')).toBeNull()
    expect(screen.queryByTestId('copy-invite')).toBeNull()
  })

  it('shows each existing code with the store it belongs to', async () => {
    renderPage([
      {
        id: 'a1', name: 'John', email: 'john@x.local', commissionPercent: 10, active: true,
        onboarded: false, invitePath: '/invite/x',
        codes: [{ id: 'c1', code: 'JOHN10', shopId: 's1', shopName: 'Norway' }],
        products: [],
      },
    ])
    await waitFor(() => expect(screen.getByText('JOHN10')).toBeTruthy())
    expect(screen.getByText(/· Norway/)).toBeTruthy()
  })
})

describe('recording products while the ambassador is being created', () => {
  /** Fills everything the submit button insists on, leaving products alone. */
  async function fillRequiredFields() {
    await waitFor(() => expect(screen.getByText('Add an ambassador')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Person' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@x.local' } })
    fireEvent.change(screen.getByLabelText('Store'), { target: { value: 's1' } })
    fireEvent.change(screen.getByLabelText('Discount code'), { target: { value: 'NEW10' } })
  }

  async function addProduct(label: string, quantity: string) {
    // SearchableSelect is a button that opens a list of buttons. The wait is
    // load-bearing: the catalogue arrives from its own fetch, so the option
    // does not exist on the first render and clicking blind is a race.
    fireEvent.click(screen.getByRole('button', { name: 'Product' }))
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: label }))
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: quantity } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to list' }))
  }

  /** The body of the one POST the form made. */
  function postedBody() {
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    const post = calls.find(([, init]) => init?.method === 'POST')
    return post ? JSON.parse(String(post[1].body)) : null
  }

  it('stays out of the way until asked for', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Add an ambassador')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Add to list' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '+ Add products they got from us' }))
    expect(screen.getByRole('button', { name: 'Add to list' })).toBeTruthy()
  })

  it('sends the listed products with the create, as one request', async () => {
    renderPage()
    await fillRequiredFields()

    fireEvent.click(screen.getByRole('button', { name: '+ Add products they got from us' }))
    await addProduct('Advanced Comfort', '2')

    // It shows as a chip before anything is sent.
    expect(screen.getByRole('button', { name: 'Remove item 1: Advanced Comfort' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Add ambassador' }))

    await waitFor(() => {
      const body = postedBody()
      expect(body).toBeTruthy()
      expect(body.products).toHaveLength(1)
      // The NAME travels with the SKU: the record is a snapshot, so renaming a
      // shop's listing later never rewrites what we handed over.
      expect(body.products[0]).toMatchObject({
        sku: 'MACBL661',
        name: 'Advanced Comfort',
        quantity: 2,
      })
    })
  })

  it('numbers the chips so two of the same product are still tellable apart', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Add an ambassador')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '+ Add products they got from us' }))
    await addProduct('Pro X', '1')
    await addProduct('Pro X', '1')

    // getByRole throws on more than one match, so this fails outright if both
    // chips carry the same name.
    expect(screen.getByRole('button', { name: 'Remove item 1: Pro X' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove item 2: Pro X' })).toBeTruthy()
  })

  it('drops a product from the list, and never sends it', async () => {
    renderPage()
    await fillRequiredFields()

    fireEvent.click(screen.getByRole('button', { name: '+ Add products they got from us' }))
    await addProduct('Advanced Comfort', '1')
    await addProduct('Pro X', '3')

    fireEvent.click(screen.getByRole('button', { name: 'Remove item 1: Advanced Comfort' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add ambassador' }))

    await waitFor(() => {
      const body = postedBody()
      expect(body).toBeTruthy()
      expect(body.products).toHaveLength(1)
      expect(body.products[0]).toMatchObject({ sku: 'MPX-001', quantity: 3 })
    })
  })

  it('omits products entirely when none were added, so the old body is unchanged', async () => {
    renderPage()
    await fillRequiredFields()
    fireEvent.click(screen.getByRole('button', { name: 'Add ambassador' }))

    await waitFor(() => {
      const body = postedBody()
      expect(body).toBeTruthy()
      expect(body.name).toBe('New Person')
      expect('products' in body).toBe(false)
    })
  })
})
