// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { formatMoney } from '@/lib/money'

// AppShell is a client component: it reads the current route and pushes on sign-out.
vi.mock('next/navigation', () => ({
  usePathname: () => '/b2b',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import { B2bClient } from './B2bClient'

// B2bClient is a leaf page client, like ExpensesClient and CostsClient: it uses
// the throwing useToast() hook, so every render needs a real ToastProvider
// ancestor, matching those siblings' own renderWithToast helper.
function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

const shops = [{ id: 's1', name: 'Mazzetti.no', currency: 'NOK' }]

const customer = {
  id: 'c1', name: 'Nordic Retail AS', shopId: 's1', shopName: 'Mazzetti.no',
  currency: 'EUR', vatPercent: 25, email: null, note: null, active: true,
  priceCount: 4, orderCount: 12, revenue: 1422000,
}

function mockFetch(customers: unknown[], orders: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(
      JSON.stringify(url.includes('/api/b2b/customers') ? { customers } : { orders, total: orders.length }),
      { status: 200 },
    ),
  ))
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.unstubAllGlobals())

describe('B2bClient', () => {
  it('shows a customer’s revenue in THEIR currency, not the shop’s', async () => {
    mockFetch([customer])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    // The digits alone (14,220.00) are identical whether formatted as EUR or
    // NOK at this value, so assert the currency marker too: the EUR rendering
    // must be present AND the shop's NOK rendering must be absent. That way a
    // regression back to the shop's currency — the exact bug this test is
    // named for — fails loudly instead of slipping through on shared digits.
    const eurRendering = formatMoney(customer.revenue, 'EUR')
    const nokRendering = formatMoney(customer.revenue, 'NOK')
    expect(await screen.findByText(eurRendering)).toBeInTheDocument()
    expect(screen.queryByText(nokRendering)).not.toBeInTheDocument()
    expect(screen.getByText('Nordic Retail AS')).toBeInTheDocument()
    expect(screen.getByText('Mazzetti.no')).toBeInTheDocument()
  })

  it('teaches the next action when there are no customers yet', async () => {
    mockFetch([])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)
    expect(
      await screen.findByText(/add one and you can start entering their orders/i),
    ).toBeInTheDocument()
  })

  it('says so when the list could not be loaded, rather than showing an empty table', async () => {
    // An empty table reads as "you have no customers". That would be a lie.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Could not load customers' }), { status: 500 }),
    ))
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    const message = await screen.findByText('Could not load customers')
    // Inline, in the table body — matching the empty-row convention — not a
    // toast that fades and leaves the table looking like zero customers.
    const cell = message.closest('td')
    expect(cell).not.toBeNull()
    expect(cell?.closest('table')).not.toBeNull()
  })

  it('offers no "add customer" button when there is no shop to attach one to', async () => {
    mockFetch([])
    renderWithToast(<B2bClient email="a@b.test" shops={[]} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /add customer/i })).toBeNull())
  })

  it('shows a voided order’s profit as "—", never a confident zero', async () => {
    const liveOrder = {
      id: 'o1', number: '#1001', placedAt: '2026-05-01T00:00:00.000Z', status: 'completed',
      currency: 'EUR', netSales: 50000, customer: 'Nordic Retail AS', figures: { profit: 12000 },
    }
    const voidedOrder = {
      id: 'o2', number: '#1002', placedAt: '2026-05-02T00:00:00.000Z', status: 'voided',
      currency: 'EUR', netSales: 30000, customer: 'Nordic Retail AS', figures: null,
    }
    mockFetch([customer], [liveOrder, voidedOrder])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    await screen.findByText('#1001')

    const voidedRow = screen.getByText('#1002').closest('tr') as HTMLElement
    const voidedProfitCell = voidedRow.querySelectorAll('td')[5]
    // A voided order earns nothing and says so — never a confident "0".
    expect(voidedProfitCell.textContent).toBe('—')

    const liveRow = screen.getByText('#1001').closest('tr') as HTMLElement
    const liveProfitCell = liveRow.querySelectorAll('td')[5]
    expect(liveProfitCell.textContent).toBe(formatMoney(12000, 'EUR'))
  })

  it('opens the add-customer form and warns about a currency we hold no rate for', async () => {
    const user = userEvent.setup()
    mockFetch([])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    await user.click(await screen.findByRole('button', { name: /add customer/i }))
    expect(screen.getByRole('heading', { name: /add business customer/i })).toBeInTheDocument()

    // The shop's own currency is the sensible default and IS convertible.
    expect(screen.queryByText(/we have no exchange rate/i)).toBeNull()
  })

  it('shows the exchange-rate warning once a currency we hold no rate for is picked', async () => {
    // Pairs with the test above: that one only proves the warning is absent
    // for a convertible default, which a deleted warning block would also
    // pass. This one proves the warning is wired to isConvertible by actually
    // triggering it — AED is a real ISO currency but is not on the ECB list
    // src/lib/currencies.ts holds rates for, so it must switch the warning on.
    const user = userEvent.setup()
    mockFetch([])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    await user.click(await screen.findByRole('button', { name: /add customer/i }))
    await user.click(screen.getByRole('button', { name: 'Currency' }))
    await user.type(screen.getByRole('textbox', { name: 'Search Currency' }), 'AED')
    await user.click(await screen.findByRole('button', { name: /^AED\b/ }))

    expect(await screen.findByText(/we have no exchange rate/i)).toBeInTheDocument()
    // The warning must name the actual currency chosen, not a generic message
    // that would read the same for any unconvertible code.
    expect(screen.getByText('AED')).toBeInTheDocument()
  })
})
