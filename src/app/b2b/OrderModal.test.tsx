// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { OrderModal } from './OrderModal'

// OrderModal is a leaf page client, like ExpensesClient and B2bClient: it uses
// the throwing useToast() hook, so every render needs a real ToastProvider
// ancestor, matching those siblings' own renderWithToast helper. Rendering the
// modal bare — as its brief's snippet does — throws before the first line
// asserts anything, for a reason that has nothing to do with this component.
function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

const customers = [
  {
    id: 'c1', name: 'Nordic Retail AS', shopId: 's1', shopName: 'Mazzetti.no',
    currency: 'EUR', vatPercent: 25, email: null, note: null,
    vismaCustomerNumber: null, active: true,
    priceCount: 1, orderCount: 0, revenue: 0,
  },
]

const detail = {
  customer: {
    id: 'c1', shopCurrency: 'NOK', currency: 'EUR', vatPercent: 25,
    prices: [{ productId: 'p1', sku: 'SKU-1', name: 'Massage gun', unitPrice: 8900, costPerItem: 4000, handlingCost: 0 }],
  },
}

const catalogue = { products: [{ id: 'p1', sku: 'SKU-1', name: 'Massage gun' }, { id: 'p2', sku: 'SKU-2', name: 'Belt' }] }

// Optionally answers `GET /api/b2b/orders/<id>` too, for edit-mode tests —
// the create-mode tests above never pass this, so `/api/b2b/orders/` is left
// unrouted for them exactly as before.
function mockFetch(orderResponse?: { order: Record<string, unknown> } | null) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/products')) return new Response(JSON.stringify(catalogue), { status: 200 })
    if (url.includes('/api/b2b/orders/')) return new Response(JSON.stringify(orderResponse ?? null), { status: 200 })
    return new Response(JSON.stringify(detail), { status: 200 })
  }))
}

// Like mockFetch, but records every call's URL, method and body so a save
// test can assert what actually went out over the wire, not just what the
// screen shows.
function mockFetchCapturing(
  calls: { url: string; method?: string; body?: string }[],
  orderResponse: { order: Record<string, unknown> },
) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string | undefined })
    if (url.includes('/api/products')) return new Response(JSON.stringify(catalogue), { status: 200 })
    if (url.includes('/api/b2b/orders/')) return new Response(JSON.stringify(orderResponse), { status: 200 })
    return new Response(JSON.stringify(detail), { status: 200 })
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('OrderModal', () => {
  it('fills in the agreed price and shows the line total as you type', async () => {
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } })
    fireEvent.click(await screen.findByRole('button', { name: /add a line/i }))
    fireEvent.change(await screen.findByLabelText('Product 1'), { target: { value: 'p1' } })

    // The agreed 89.00 arrives on its own — the whole point of the price book.
    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(89)

    fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '10' } })
    expect(await screen.findByTestId('line-total-1')).toHaveTextContent('890.00')
  })

  it('takes a percentage discount and shows the VAT and total it produces', async () => {
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } })
    fireEvent.click(await screen.findByRole('button', { name: /add a line/i }))
    fireEvent.change(await screen.findByLabelText('Product 1'), { target: { value: 'p1' } })
    fireEvent.change(await screen.findByLabelText('Quantity 1'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Discount 1'), { target: { value: '10' } })

    expect(await screen.findByTestId('total-net-sales')).toHaveTextContent('801.00')
    expect(screen.getByTestId('total-vat')).toHaveTextContent('200.25') // 25% of 801.00
    expect(screen.getByTestId('total-total')).toHaveTextContent('1,001.25')
  })

  it('labels the fixed discount per unit, and the shipping cost in the SHOP’s currency', async () => {
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } })
    fireEvent.click(await screen.findByRole('button', { name: /add a line/i }))

    // The customer pays EUR; the shipping we paid is a cost, and costs are NOK.
    expect(await screen.findByText(/shipping we paid \(NOK\)/i)).toBeInTheDocument()
    expect(screen.getByText(/shipping charged \(EUR\)/i)).toBeInTheDocument()

    const kind = screen.getByLabelText('Discount kind 1')
    expect(kind).toHaveValue('PERCENT')
    fireEvent.change(kind, { target: { value: 'AMOUNT' } })
    expect(screen.getByLabelText('Discount kind 1')).toHaveValue('AMOUNT')
  })

  it('highlights a product with no agreed price and offers to remember it', async () => {
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } })
    fireEvent.click(await screen.findByRole('button', { name: /add a line/i }))
    fireEvent.change(await screen.findByLabelText('Product 1'), { target: { value: 'p2' } }) // no agreed price

    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(null)
    expect(screen.getByLabelText('Save price 1')).toBeInTheDocument()
  })

  it('computes an AMOUNT discount per unit, distinct from what a PERCENT reading or a dropped toMinor would give', async () => {
    // The brief's own worked example: 4 units at 245.00, with 20.00 off EACH
    // ONE. A 20%-of-the-line reading would land on net 784.00 instead of
    // 900.00; a discount that skipped toMinor would apply 0.80 instead of
    // 80.00 and land on net 979.20. Both are visibly distinct from 900.00, so
    // this only passes if the AMOUNT branch is both per-unit and in minor units.
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } })
    fireEvent.click(await screen.findByRole('button', { name: /add a line/i }))
    fireEvent.change(await screen.findByLabelText('Product 1'), { target: { value: 'p2' } }) // no agreed price, so the price is free to type
    fireEvent.change(await screen.findByLabelText('Unit price 1'), { target: { value: '245' } })
    fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Discount kind 1'), { target: { value: 'AMOUNT' } })
    fireEvent.change(screen.getByLabelText('Discount 1'), { target: { value: '20' } })

    expect(await screen.findByTestId('total-discount')).toHaveTextContent('80.00')
    expect(screen.getByTestId('total-net-sales')).toHaveTextContent('900.00')
  })

  it('never labels the shipping-cost field with the customer’s currency, and disables it, while the shop’s own currency is unknown', async () => {
    // The customer-detail fetch fails outright, so shopCurrency never arrives
    // — not just "hasn't arrived yet". The component's own .catch() only
    // toasts and never recovers a value, so a `shopCurrency || customer.currency`
    // fallback would show the WRONG currency (the customer's, EUR) forever,
    // with nothing on screen to say anything went wrong.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/b2b/customers/')) throw new Error('network down')
      return new Response(JSON.stringify(catalogue), { status: 200 })
    }))
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } })

    const label = await screen.findByText(/shipping we paid/i)
    expect(label).not.toHaveTextContent('EUR')
    expect(screen.getByLabelText(/shipping we paid/i)).toBeDisabled()
  })

  it('clears the previous shop’s currency the moment you switch customers, rather than showing it until the new one loads', async () => {
    const twoShops = [
      customers[0],
      {
        id: 'c2', name: 'Bergen Distro', shopId: 's2', shopName: 'Distro.se',
        currency: 'EUR', vatPercent: 25, email: null, note: null,
        vismaCustomerNumber: null, active: true,
        priceCount: 0, orderCount: 0, revenue: 0,
      },
    ]
    const detailTwo = {
      customer: { id: 'c2', shopCurrency: 'SEK', currency: 'EUR', vatPercent: 25, prices: [] },
    }

    // c1's own detail resolves normally; c2's is held open, so the moment
    // right after switching — before c2's fetch has answered — can be
    // inspected directly. That gap is exactly what the reset must cover.
    let resolveC2Detail: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/products')) return new Response(JSON.stringify(catalogue), { status: 200 })
      if (url.includes('/api/b2b/customers/c2'))
        return new Promise<Response>((resolve) => { resolveC2Detail = resolve })
      return new Response(JSON.stringify(detail), { status: 200 }) // c1
    }))

    renderWithToast(<OrderModal customers={twoShops} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } })
    // Prove NOK is genuinely showing first — otherwise clearing it on switch
    // would prove nothing about a real previous value being wiped.
    expect(await screen.findByText(/shipping we paid \(NOK\)/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c2' } })

    // c2's detail fetch has not resolved yet. The label must not still read
    // c1's NOK, and the field must not be left enabled on c1's answer.
    const label = screen.getByText(/shipping we paid/i)
    expect(label).not.toHaveTextContent('NOK')
    expect(screen.getByLabelText(/shipping we paid/i)).toBeDisabled()

    // Letting c2's own answer land shows its OWN shop currency, proving the
    // reset does not break the real load — only the stale gap before it.
    resolveC2Detail(new Response(JSON.stringify(detailTwo), { status: 200 }))
    expect(await screen.findByText(/shipping we paid \(SEK\)/i)).toBeInTheDocument()
  })
})

describe('OrderModal in edit mode', () => {
  it('loads the order and prefills every field', async () => {
    mockFetch({ order: {
      id: 'o1', number: 'B-0007', status: 'completed', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 5000, fulfillmentCost: 42000,
      lines: [{ productId: 'p1', quantity: 10, unitPrice: 8900, discountValue: 10, discountKind: 'PERCENT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o1' }} onClose={() => {}} onSaved={() => {}} />)

    // Minor units on the wire, major in the fields — toMajor, not /100. If the
    // load skipped toMajor (or fed 8900 straight to the field), this would
    // read 8900, not 89.
    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(89)
    expect(screen.getByLabelText('Quantity 1')).toHaveValue(10)
    expect(screen.getByLabelText('Discount 1')).toHaveValue(10)
    expect(screen.getByLabelText('Shipping charged (EUR)')).toHaveValue(50)
    // The heading says which order you are editing — proves `loaded` (from
    // the GET response) reached the form, not just the id passed in as a prop.
    expect(screen.getByRole('heading', { name: /B-0007/ })).toBeInTheDocument()
  })

  it('converts an AMOUNT discount back to major units, and a PERCENT one not at all', async () => {
    // 2000 minor = 20.00 per unit. A PERCENT 10 must stay 10, not become 0.1.
    // This is the discriminating test: a wholesale toMajor applied to both
    // kinds would still pass an AMOUNT-only assertion, and skipping toMajor
    // entirely would still pass a PERCENT-only assertion. Only the correct,
    // kind-conditional conversion passes both lines below at once.
    mockFetch({ order: {
      id: 'o2', number: 'B-0008', status: 'completed', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 0, fulfillmentCost: 0,
      lines: [{ productId: 'p1', quantity: 4, unitPrice: 24500, discountValue: 2000, discountKind: 'AMOUNT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o2' }} onClose={() => {}} onSaved={() => {}} />)

    expect(await screen.findByLabelText('Discount 1')).toHaveValue(20)
    expect(screen.getByLabelText('Discount kind 1')).toHaveValue('AMOUNT')
  })

  it('locks the customer picker, because the server refuses moving an order', async () => {
    mockFetch({ order: {
      id: 'o3', number: 'B-0009', status: 'completed', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 0, fulfillmentCost: 0,
      lines: [{ productId: 'p1', quantity: 1, unitPrice: 8900, discountValue: 0, discountKind: 'PERCENT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o3' }} onClose={() => {}} onSaved={() => {}} />)
    // Waits for the load to complete first, so this cannot pass merely
    // because the select renders disabled before any data has arrived.
    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(89)
    expect(screen.getByLabelText('Customer')).toBeDisabled()
  })

  it('saves with PATCH to the order, not POST to the collection', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    mockFetchCapturing(calls, { order: {
      id: 'o4', number: 'B-0010', status: 'completed', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 0, fulfillmentCost: 0,
      lines: [{ productId: 'p1', quantity: 1, unitPrice: 8900, discountValue: 0, discountKind: 'PERCENT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o4' }} onClose={() => {}} onSaved={() => {}} />)

    // Wait for the load to actually land, and for the fields it populates to
    // show up, before clicking — Save stays disabled until then (see the
    // component's own comment on that button), so clicking any earlier would
    // hit a no-op and prove nothing about which verb a real save uses.
    await screen.findByLabelText('Discount 1')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    // Assert the request itself, not the render: an implementation that still
    // POSTed a new order (creating a duplicate) would leave the screen looking
    // identical, so only inspecting the actual calls catches it.
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/api/b2b/orders/o4') && c.method === 'PATCH')).toBe(true),
    )
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('preserves a refunded order’s status on save when nothing about the status is touched', async () => {
    // This is the bug found by the whole-branch review: the PATCH body used
    // to omit `status` entirely, and the route defaults a missing status to
    // 'completed' — so editing a voided order silently un-voided it. This
    // test must fail against the code as it stood before this fix.
    const calls: { url: string; method?: string; body?: string }[] = []
    mockFetchCapturing(calls, { order: {
      id: 'o5', number: 'B-0011', status: 'refunded', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 0, fulfillmentCost: 0,
      lines: [{ productId: 'p1', quantity: 1, unitPrice: 8900, discountValue: 0, discountKind: 'PERCENT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o5' }} onClose={() => {}} onSaved={() => {}} />)

    await screen.findByLabelText('Discount 1')
    // The select is seeded from the loaded order, not left on the create
    // default — proof the widened `loaded` state actually reached the form.
    expect(screen.getByLabelText('Status')).toHaveValue('refunded')

    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeDefined()
      const body = JSON.parse(patch!.body!)
      expect(body.status).toBe('refunded')
    })
  })

  it('sends a deliberately chosen status when the Status select is changed', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    mockFetchCapturing(calls, { order: {
      id: 'o6', number: 'B-0012', status: 'refunded', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 0, fulfillmentCost: 0,
      lines: [{ productId: 'p1', quantity: 1, unitPrice: 8900, discountValue: 0, discountKind: 'PERCENT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o6' }} onClose={() => {}} onSaved={() => {}} />)

    await screen.findByLabelText('Discount 1')
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'completed' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeDefined()
      const body = JSON.parse(patch!.body!)
      expect(body.status).toBe('completed')
    })
  })

  it('sends no status when creating, and shows no Status control to change', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined })
      if (url.includes('/api/products')) return new Response(JSON.stringify(catalogue), { status: 200 })
      if (url.includes('/api/b2b/orders'))
        return new Response(JSON.stringify({ order: { number: 'B-0099' } }), { status: 200 })
      return new Response(JSON.stringify(detail), { status: 200 })
    }))

    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    // No `order` prop — nothing to load a status from, and nothing to move.
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument()

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } })
    fireEvent.click(await screen.findByRole('button', { name: /add a line/i }))
    fireEvent.change(await screen.findByLabelText('Product 1'), { target: { value: 'p1' } })
    await screen.findByLabelText('Unit price 1')

    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')!
    const body = JSON.parse(post.body!)
    expect(body).not.toHaveProperty('status')
  })
})
