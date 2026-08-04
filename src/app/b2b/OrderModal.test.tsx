// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    const user = userEvent.setup()
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1')
    await user.click(await screen.findByRole('button', { name: /add a line/i }))
    await user.selectOptions(await screen.findByLabelText('Product 1'), 'p1')

    // The agreed 89.00 arrives on its own — the whole point of the price book.
    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(89)

    await user.clear(screen.getByLabelText('Quantity 1'))
    await user.type(screen.getByLabelText('Quantity 1'), '10')
    expect(await screen.findByTestId('line-total-1')).toHaveTextContent('890.00')
  })

  it('takes a percentage discount and shows the VAT and total it produces', async () => {
    const user = userEvent.setup()
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1')
    await user.click(await screen.findByRole('button', { name: /add a line/i }))
    await user.selectOptions(await screen.findByLabelText('Product 1'), 'p1')
    await user.clear(await screen.findByLabelText('Quantity 1'))
    await user.type(screen.getByLabelText('Quantity 1'), '10')
    await user.type(screen.getByLabelText('Discount 1'), '10')

    expect(await screen.findByTestId('total-net-sales')).toHaveTextContent('801.00')
    expect(screen.getByTestId('total-vat')).toHaveTextContent('200.25') // 25% of 801.00
    expect(screen.getByTestId('total-total')).toHaveTextContent('1,001.25')
  })

  it('labels the fixed discount per unit, and the shipping cost in the SHOP’s currency', async () => {
    const user = userEvent.setup()
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1')
    await user.click(await screen.findByRole('button', { name: /add a line/i }))

    // The customer pays EUR; the shipping we paid is a cost, and costs are NOK.
    expect(await screen.findByText(/shipping we paid \(NOK\)/i)).toBeInTheDocument()
    expect(screen.getByText(/shipping charged \(EUR\)/i)).toBeInTheDocument()

    const kind = screen.getByLabelText('Discount kind 1')
    expect(kind).toHaveValue('PERCENT')
    await user.selectOptions(kind, 'AMOUNT')
    expect(screen.getByLabelText('Discount kind 1')).toHaveValue('AMOUNT')
  })

  it('highlights a product with no agreed price and offers to remember it', async () => {
    const user = userEvent.setup()
    mockFetch()
    renderWithToast(<OrderModal customers={customers} onClose={() => {}} onSaved={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1')
    await user.click(await screen.findByRole('button', { name: /add a line/i }))
    await user.selectOptions(await screen.findByLabelText('Product 1'), 'p2') // no agreed price

    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(null)
    expect(screen.getByLabelText('Save price 1')).toBeInTheDocument()
  })
})
