// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    currency: 'EUR', vatPercent: 25, email: null, note: null, active: true,
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

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(
      JSON.stringify(url.includes('/api/products') ? catalogue : detail),
      { status: 200 },
    ),
  ))
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
        currency: 'EUR', vatPercent: 25, email: null, note: null, active: true,
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
