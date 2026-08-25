// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { CustomerModal } from './CustomerModal'

// CustomerModal is a leaf page client, like OrderModal and B2bClient: it uses
// the throwing useToast() hook, so every render needs a real ToastProvider
// ancestor, matching those siblings' own renderWithToast helper.
function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

const shops = [{ id: 's1', name: 'Mazzetti.no', currency: 'NOK' }]

const customer = {
  id: 'c1', name: 'Nordic Retail AS', shopId: 's1', shopName: 'Mazzetti.no',
  currency: 'EUR', vatPercent: 25, email: null, note: null, vismaCustomerNumber: null,
  active: true, priceCount: 4, orderCount: 12, revenue: 1422000,
}

afterEach(() => vi.unstubAllGlobals())

describe('CustomerModal', () => {
  it('keeps Save disabled while editing until their agreed prices have actually loaded, so a failed fetch cannot wipe the price list', async () => {
    // PATCH replaces the whole price list. `rows` starts as [], and the detail
    // fetch that fills it in only toasts on failure - it never blocks Save.
    // Pressing Save while that fetch is still failed/pending would ship
    // `prices: []` and permanently delete every agreed price this customer has.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/b2b/customers/')) throw new Error('network down')
      return new Response(JSON.stringify({ products: [] }), { status: 200 })
    }))

    renderWithToast(<CustomerModal shops={shops} customer={customer} onClose={() => {}} onSaved={() => {}} />)

    // Wait out the failed detail fetch - the toast is the only externally
    // observable sign it has settled.
    await screen.findByText(/could not load their agreed prices/i)

    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled()
  })

  it('leaves Save enabled when creating a new customer, since there is nothing to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ products: [] }), { status: 200 })))

    renderWithToast(<CustomerModal shops={shops} customer={null} onClose={() => {}} onSaved={() => {}} />)

    await screen.findByRole('heading', { name: /add business customer/i })
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'New Co' } })

    // Nothing about creation should ever gate Save on a "prices loaded" fetch
    // - there is no existing price list to lose.
    expect(screen.getByRole('button', { name: /add customer/i })).not.toBeDisabled()
  })

  /**
   * The link that makes a Visma invoice arrive as one of their orders. It is
   * typed here or it is nowhere: nothing else in the product sets it, and an
   * unlinked customer's invoices are ignored entirely.
   */
  it('sends the Visma customer number that was typed', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ products: [] }), { status: 200 })
    }))

    renderWithToast(<CustomerModal shops={shops} customer={null} onClose={() => {}} onSaved={() => {}} />)

    await screen.findByRole('heading', { name: /add business customer/i })
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'Bagaren och Kocken' } })
    fireEvent.change(screen.getByLabelText(/visma customer number/i), { target: { value: '10705' } })
    fireEvent.click(screen.getByRole('button', { name: /add customer/i }))

    const post = await vi.waitFor(() => {
      const c = calls.find((x) => x.url === '/api/b2b/customers')
      if (!c) throw new Error('not saved yet')
      return c
    })
    expect(post.body).toMatchObject({ vismaCustomerNumber: '10705' })
  })

  /**
   * Blank must reach the route as blank rather than as nothing at all: on edit
   * an omitted field would leave an old link in place, and "I cleared it" would
   * silently keep importing that customer's invoices.
   */
  it('sends an empty Visma number when the field is left blank', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ products: [] }), { status: 200 })
    }))

    renderWithToast(<CustomerModal shops={shops} customer={null} onClose={() => {}} onSaved={() => {}} />)

    await screen.findByRole('heading', { name: /add business customer/i })
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'Unlinked AS' } })
    fireEvent.click(screen.getByRole('button', { name: /add customer/i }))

    const post = await vi.waitFor(() => {
      const c = calls.find((x) => x.url === '/api/b2b/customers')
      if (!c) throw new Error('not saved yet')
      return c
    })
    expect(post.body).toMatchObject({ vismaCustomerNumber: '' })
  })
})
