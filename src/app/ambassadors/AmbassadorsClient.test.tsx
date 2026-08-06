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
        catalogue: [
          // s1 sells both; s2 sells only Pro X, so the store filter is observable.
          { sku: 'MACBL661', name: 'Advanced Comfort', shopIds: ['s1'] },
          { sku: 'MPX-001', name: 'Pro X', shopIds: ['s1', 's2'] },
        ],
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

describe('the row menu', () => {
  const roster = [
    {
      id: 'a1', name: 'Maria Ghanem', email: 'maria@x.local', commissionPercent: 10, active: true,
      onboarded: false, invitePath: '/invite/x', products: [],
      codes: [{ id: 'c1', code: 'MARIA500', shopId: 's1', shopName: 'Norway' }],
    },
  ]

  it('keeps the row verbs out of sight until asked for', async () => {
    renderPage(roster)
    await waitFor(() => expect(screen.getByText('MARIA500')).toBeTruthy())

    // The row shows one control, not four. Spelling every verb out is what made
    // the last column the widest thing on the page.
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Maria Ghanem' }))
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Deactivate' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })

  it('leaves the invite link in the open, beside the status it belongs to', async () => {
    renderPage(roster)
    // Not filed under the menu: it is the one thing needed the moment someone
    // is added, and it exists only while they are "Not set up yet".
    await waitFor(() => expect(screen.getByTestId('copy-invite')).toBeTruthy())
    expect(screen.getByText('Not set up yet')).toBeTruthy()
  })

  it('closes on Escape without running anything', async () => {
    renderPage(roster)
    await waitFor(() => expect(screen.getByText('MARIA500')).toBeTruthy())

    const trigger = screen.getByRole('button', { name: 'Actions for Maria Ghanem' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull())
    // Focus returns to the row it came from, rather than leaving a keyboard
    // user at the top of the document with no idea which row they were on.
    expect(document.activeElement).toBe(trigger)
  })

  it('offers Reactivate, not Deactivate, for someone switched off', async () => {
    renderPage([{ ...roster[0], active: false, onboarded: true, invitePath: null }])
    await waitFor(() => expect(screen.getByText('Deactivated')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Maria Ghanem' }))
    expect(screen.getByRole('menuitem', { name: 'Reactivate' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Deactivate' })).toBeNull()
  })
})

describe('the Edit window offers only their own store products', () => {
  /** s2 sells Pro X only; s1 sells both. */
  const onShop = (shopId: string) => [
    {
      id: 'a1', name: 'Solo Store', email: 'solo@x.local', commissionPercent: 10, active: true,
      onboarded: false, invitePath: '/invite/x', products: [],
      codes: [{ id: 'c1', code: 'SOLO10', shopId, shopName: shopId }],
    },
  ]

  async function openEditAndPicker(shopId: string) {
    renderPage(onShop(shopId))
    await waitFor(() => expect(screen.getByText('SOLO10')).toBeTruthy())
    // Edit lives in the row's own menu now, so the menu opens first.
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Solo Store' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // The catalogue arrives from its own fetch; clicking blind is a race.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Product' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Product' }))
  }

  it('hides a product their store does not sell', async () => {
    await openEditAndPicker('s2')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pro X' })).toBeTruthy())
    // s2 does not sell it, so it must not be offered.
    expect(screen.queryByRole('button', { name: 'Advanced Comfort' })).toBeNull()
  })

  it('offers both when their store sells both', async () => {
    await openEditAndPicker('s1')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pro X' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Advanced Comfort' })).toBeTruthy()
  })
})

describe('recording products while the ambassador is being created', () => {
  /** Fills everything except the products. */
  async function fillRequiredFields(shop = 's1') {
    await waitFor(() => expect(screen.getByText('Add an ambassador')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Person' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@x.local' } })
    fireEvent.change(screen.getByLabelText('Store'), { target: { value: shop } })
    fireEvent.change(screen.getByLabelText('Discount code'), { target: { value: 'NEW10' } })
    // The catalogue arrives from its own fetch, so the ticks do not exist on
    // the first render and asserting against them immediately is a race.
    await waitFor(() => expect(screen.getByTestId('product-ticks')).toBeTruthy())
  }

  const submit = () => screen.getByRole('button', { name: 'Add ambassador' }) as HTMLButtonElement
  const tick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }))

  /** The body of the one POST the form made. */
  function postedBody() {
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    const post = calls.find(([, init]) => init?.method === 'POST')
    return post ? JSON.parse(String(post[1].body)) : null
  }

  it('is visible without being asked for, and says a product is required', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Add an ambassador')).toBeTruthy())
    expect(screen.getByText(/Products they got from us/)).toBeTruthy()
    expect(screen.getByText(/required/)).toBeTruthy()
  })

  it('asks for the store first, because the list depends on it', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/Pick a store first/)).toBeTruthy())
    expect(screen.queryByTestId('product-ticks')).toBeNull()
  })

  it('names the store the list came from', async () => {
    renderPage()
    await fillRequiredFields('s1')
    expect(screen.getByText('Showing products sold on Norway.')).toBeTruthy()
  })

  it('offers only the products that store sells', async () => {
    renderPage()
    await fillRequiredFields('s2') // s2 sells Pro X only

    expect(screen.getByRole('checkbox', { name: 'Pro X' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Advanced Comfort' })).toBeNull()
  })

  it('will not save until a product is ticked', async () => {
    renderPage()
    await fillRequiredFields()
    expect(submit().disabled).toBe(true)

    tick('Advanced Comfort')
    expect(submit().disabled).toBe(false)
  })

  it('clears the ticks when the store changes', async () => {
    // A Norwegian selection is meaningless once the store is Sweden, and
    // carrying it silently would attach products that store does not sell.
    renderPage()
    await fillRequiredFields('s1')
    tick('Advanced Comfort')
    expect(submit().disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Store'), { target: { value: 's2' } })
    expect(submit().disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Pro X' }) as HTMLInputElement).checked).toBe(false)
  })

  it('sends one record per ticked product, with no quantity', async () => {
    renderPage()
    await fillRequiredFields()
    tick('Advanced Comfort')
    tick('Pro X')
    fireEvent.change(screen.getByLabelText('Discount code'), { target: { value: 'NEW10' } })
    fireEvent.click(submit())

    await waitFor(() => {
      const body = postedBody()
      expect(body).toBeTruthy()
      expect(body.products).toHaveLength(2)
      // The NAME travels with the SKU: the record is a snapshot, so renaming a
      // shop's listing later never rewrites what we handed over.
      expect(body.products.map((p: { sku: string }) => p.sku).sort()).toEqual(['MACBL661', 'MPX-001'])
      expect(body.products[0].name).toBe('Advanced Comfort')
      expect('quantity' in body.products[0]).toBe(false)
    })
  })

  it('gives every ticked product the one date and note for the batch', async () => {
    renderPage()
    await fillRequiredFields()
    tick('Advanced Comfort')
    tick('Pro X')
    fireEvent.change(screen.getByLabelText('Date received'), { target: { value: '2026-03-12' } })
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'launch batch' } })
    fireEvent.click(submit())

    await waitFor(() => {
      const body = postedBody()
      expect(body).toBeTruthy()
      for (const p of body.products) {
        expect(p.receivedAt).toBe('2026-03-12')
        expect(p.note).toBe('launch batch')
      }
    })
  })
})
