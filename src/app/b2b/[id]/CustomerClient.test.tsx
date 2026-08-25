// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { formatMoney, toMajor } from '@/lib/money'

// AppShell is a client component: it reads the current route and pushes on sign-out.
vi.mock('next/navigation', () => ({
  usePathname: () => '/b2b/c1',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import { CustomerClient } from './CustomerClient'

// CustomerClient is a leaf page client, like B2bClient: it uses the throwing
// useToast() hook, so every render needs a real ToastProvider ancestor.
function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

const shops = [{ id: 's1', name: 'Mazzetti.no', currency: 'NOK' }]

// The shop's currency (NOK) and the customer's currency (EUR) are different,
// and the underlying amounts (8050 vs 15000) are different too, so a
// currency-conflation bug OR a swapped-column bug both produce visibly wrong
// text - not a coincidentally-matching digit run.
const twoProductCustomer = {
  id: 'c1', name: 'Nordic Retail AS', shopId: 's1', shopName: 'Mazzetti.no', shopCurrency: 'NOK',
  currency: 'EUR', vatPercent: 25, email: null, note: null, active: true,
  priceCount: 2, orderCount: 5, revenue: 320000, canChangeShop: true,
  prices: [
    {
      productId: 'p1', sku: 'SKU-1', name: 'Nordic Widget', imageUrl: null,
      unitPrice: 15000, costPerItem: 8000, handlingCost: 50,
    },
    {
      productId: 'p2', sku: 'SKU-2', name: 'Nordic Gadget', imageUrl: null,
      unitPrice: 22000, costPerItem: 0, handlingCost: 100,
    },
  ],
}

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

/**
 * Serves the detail GET, and records every call (URL + RequestInit) so a
 * test can inspect exactly what a later PATCH sent - not just that one
 * happened. Every non-GET call succeeds with `{ ok: true }`.
 */
function mockFetchCapturing(detail: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (init?.method) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response(JSON.stringify({ customer: detail }), { status: 200 })
    }),
  )
  return calls
}

// Intl inserts a non-breaking space between a currency CODE (no symbol, e.g.
// NOK) and the amount. React Testing Library's default text normalizer
// collapses that in the rendered DOM before comparing, but does not touch a
// literal string matcher - so the matcher must be pre-normalized the same
// way, or an otherwise-correct render reads as "not found".
const money = (minor: number, currency: string) => formatMoney(minor, currency).replace(/ /g, ' ')

afterEach(() => vi.unstubAllGlobals())

describe('CustomerClient', () => {
  it('labels each price column with its OWN currency and never conflates the two', async () => {
    mockFetch({ customer: twoProductCustomer })
    renderWithToast(<CustomerClient email="a@b.test" customerId="c1" shops={shops} />)

    await screen.findByText('Nordic Widget')

    // Column headers name their own currency, not a shared/ambiguous one.
    expect(screen.getByText('Our cost (NOK)')).toBeInTheDocument()
    expect(screen.getByText('Agreed price (EUR)')).toBeInTheDocument()

    // The cost is the shop's currency (NOK): 8000 + 50 handling = 8050.
    const shopCurrencyCost = money(8050, 'NOK')
    // The price is the customer's currency (EUR).
    const customerCurrencyPrice = money(15000, 'EUR')
    expect(screen.getByText(shopCurrencyCost)).toBeInTheDocument()
    expect(screen.getByText(customerCurrencyPrice)).toBeInTheDocument()

    // The bug this guards against: cost falling back to the customer's
    // currency (or price to the shop's) - exactly the class of defect a
    // recent review caught on the order form. Neither wrong rendering exists.
    expect(screen.queryByText(money(8050, 'EUR'))).not.toBeInTheDocument()
    expect(screen.queryByText(money(15000, 'NOK'))).not.toBeInTheDocument()
  })

  it('warns on a product with no cost entered, and only that one', async () => {
    mockFetch({ customer: twoProductCustomer })
    renderWithToast(<CustomerClient email="a@b.test" customerId="c1" shops={shops} />)

    await screen.findByText('Nordic Widget')

    // Nordic Gadget has costPerItem: 0 - nobody entered a cost. That must
    // read as an explicit "not set" warning, never a confident formatted 0.
    const gadgetRow = screen.getByText('Nordic Gadget').closest('tr') as HTMLElement
    expect(within(gadgetRow).getByText('not set')).toBeInTheDocument()
    expect(within(gadgetRow).queryByText(money(100, 'NOK'))).not.toBeInTheDocument()

    // Nordic Widget has a real cost (8000 + 50 handling) and must show the
    // formatted amount, not the warning - the pair is what proves the ternary
    // is wired to costPerItem === 0, not always-on or always-off.
    const widgetRow = screen.getByText('Nordic Widget').closest('tr') as HTMLElement
    expect(within(widgetRow).getByText(money(8050, 'NOK'))).toBeInTheDocument()
    expect(within(widgetRow).queryByText('not set')).not.toBeInTheDocument()
  })

  it('teaches the next action when a customer has no agreed prices yet', async () => {
    mockFetch({
      customer: { ...twoProductCustomer, priceCount: 0, prices: [] },
    })
    renderWithToast(<CustomerClient email="a@b.test" customerId="c1" shops={shops} />)

    expect(await screen.findByText('No agreed prices yet')).toBeInTheDocument()
    expect(
      screen.getByText(/add some with Edit, or type a price when you enter their first order/i),
    ).toBeInTheDocument()
  })

  it('states a load failure in place, not as a toast that fades', async () => {
    mockFetch({ error: 'Could not load the customer' }, 500)
    renderWithToast(<CustomerClient email="a@b.test" customerId="c1" shops={shops} />)

    const message = await screen.findByText('Could not load the customer')

    // In the page body itself…
    expect(message.closest('main')).not.toBeNull()
    // …never inside the toast region, which fades on a timer and would be
    // gone by the time someone reloads the page and looks again.
    expect(message.closest('[role="status"]')).toBeNull()

    // The customer never loaded, so none of its content renders either.
    expect(screen.queryByText('Agreed prices')).not.toBeInTheDocument()
  })

  it('sends the existing prices back, converted to major units, when deactivating', async () => {
    // PATCH replaces the price list wholesale. Deactivating is "just a flag"
    // from the user's point of view, but if the payload ever drops `prices`
    // - or sends them in the wrong units - this customer's whole agreed
    // price list is destroyed or corrupted by a click that looks harmless.
    const calls = mockFetchCapturing(twoProductCustomer)
    renderWithToast(<CustomerClient email="a@b.test" customerId="c1" shops={shops} />)

    // Let the detail load settle before acting on it.
    await screen.findByText('Nordic Widget')

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

    await waitFor(() => {
      expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true)
    })

    const patchCall = calls.find((c) => c.init?.method === 'PATCH')!
    const body = JSON.parse(patchCall.init!.body as string)

    expect(body.active).toBe(false)
    // Not just "prices is present" - the VALUES must be the loaded prices,
    // converted to major units the way CustomerModal's own save() does.
    // Sending them still in minor units (150.00 becoming 15000) would pass
    // a check that only asked "is prices non-empty?".
    expect(body.prices).toEqual([
      { productId: 'p1', unitPrice: toMajor(15000) },
      { productId: 'p2', unitPrice: toMajor(22000) },
    ])
  })
})
