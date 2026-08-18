// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
  currency: 'EUR', vatPercent: 25, email: null, note: null,
  vismaCustomerNumber: null, active: true,
  priceCount: 4, orderCount: 12, revenue: 1422000,
}

// The orders-card row shape, as `/api/orders?source=b2b` answers it.
const b2bOrder = {
  id: 'o1', number: 'B-0001', placedAt: '2026-05-01T00:00:00.000Z', status: 'completed',
  currency: 'EUR', netSales: 50000, customer: 'Nordic Retail AS', figures: { profit: 12000 },
  imported: false,
}

/** The same row, but imported from Visma — which makes it read-only. */
const importedOrder = {
  ...b2bOrder, id: 'o2', number: '123194', imported: true,
}

// The form shape `GET /api/b2b/orders/[id]` answers — what edit and void both
// load. Two lines, one of each discount kind, with numbers chosen so "no
// conversion", "convert both discounts" and "swap the two branches" each
// land on a different wrong answer than the correct one:
//   PERCENT discount 10   -> unchanged 10   (wholesale toMajor would give 0.1)
//   AMOUNT  discount 750  -> toMajor'd 7.5  (no conversion would leave 750)
const b2bOrderDetail = {
  id: 'o1', number: 'B-0001', status: 'completed', placedAt: '2026-05-01',
  customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
  shippingCharged: 500, fulfillmentCost: 200,
  lines: [
    { productId: 'p1', quantity: 2, unitPrice: 5000, discountValue: 10, discountKind: 'PERCENT' },
    { productId: 'p2', quantity: 1, unitPrice: 3000, discountValue: 750, discountKind: 'AMOUNT' },
  ],
}

function mockFetch(customers: unknown[], orders: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/b2b/customers')) return new Response(JSON.stringify({ customers }), { status: 200 })
    // Order-detail GET, hit when an order is opened for editing.
    if (url.includes('/api/b2b/orders/')) return new Response(JSON.stringify({ order: b2bOrderDetail }), { status: 200 })
    return new Response(JSON.stringify({ orders, total: orders.length }), { status: 200 })
  }))
}

// Like mockFetch, but records every call's URL, method and body so a test can
// assert what actually went out over the wire, not just what the screen shows.
function mockFetchCapturing(
  calls: { url: string; method?: string; body?: string }[],
  customers: unknown[],
  orders: unknown[] = [],
) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string | undefined })
    if (url.includes('/api/b2b/customers')) return new Response(JSON.stringify({ customers }), { status: 200 })
    if (url.includes('/api/b2b/orders/')) {
      const method = init?.method ?? 'GET'
      if (method === 'PATCH' || method === 'DELETE') return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response(JSON.stringify({ order: b2bOrderDetail }), { status: 200 })
    }
    return new Response(JSON.stringify({ orders, total: orders.length }), { status: 200 })
  }))
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
    mockFetch([])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    fireEvent.click(await screen.findByRole('button', { name: /add customer/i }))
    // find*, not get*: CustomerModal's own product fetch resolves after the
    // click handler returns, and fireEvent — unlike user-event — does not
    // wait out that microtask on its own.
    expect(await screen.findByRole('heading', { name: /add business customer/i })).toBeInTheDocument()

    // The shop's own currency is the sensible default and IS convertible.
    expect(screen.queryByText(/we have no exchange rate/i)).toBeNull()
  })

  it('shows the exchange-rate warning once a currency we hold no rate for is picked', async () => {
    // Pairs with the test above: that one only proves the warning is absent
    // for a convertible default, which a deleted warning block would also
    // pass. This one proves the warning is wired to isConvertible by actually
    // triggering it — AED is a real ISO currency but is not on the ECB list
    // src/lib/currencies.ts holds rates for, so it must switch the warning on.
    mockFetch([])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    fireEvent.click(await screen.findByRole('button', { name: /add customer/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Currency' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Currency' }), { target: { value: 'AED' } })
    fireEvent.click(await screen.findByRole('button', { name: /^AED\b/ }))

    expect(await screen.findByText(/we have no exchange rate/i)).toBeInTheDocument()
    // The warning must name the actual currency chosen, not a generic message
    // that would read the same for any unconvertible code.
    expect(screen.getByText('AED')).toBeInTheDocument()
  })

  it('opens an order for editing from the card', async () => {
    mockFetch([customer], [b2bOrder])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    fireEvent.click(await screen.findByRole('button', { name: /edit order B-0001/i }))
    expect(await screen.findByRole('heading', { name: /edit order/i })).toBeInTheDocument()
  })

  /**
   * The import's outcome lived only in the cron's JSON response, which nothing
   * reads — so "refused on every run" and "there are simply no B2B invoices"
   * were indistinguishable from inside the product, and so would a jump in
   * `imported` be if the allowlist ever leaked.
   */
  it('says what the last Visma import did', async () => {
    mockFetch([customer], [b2bOrder])
    renderWithToast(
      <B2bClient
        email="a@b.test"
        shops={shops}
        importRun={{
          ranAt: '2026-08-18T09:30:00.000Z', linked: 3, read: 40, imported: 2,
          partial: false, error: null,
        }}
      />,
    )

    expect(await screen.findByText(/imported 2/i)).toBeInTheDocument()
  })

  it('says so when the last import failed, rather than looking like a quiet week', async () => {
    mockFetch([customer], [])
    renderWithToast(
      <B2bClient
        email="a@b.test"
        shops={shops}
        importRun={{
          ranAt: '2026-08-18T09:30:00.000Z', linked: 3, read: 0, imported: 0,
          partial: false, error: 'Visma responded 429',
        }}
      />,
    )

    expect(await screen.findByText(/429/)).toBeInTheDocument()
  })

  /** Nobody linked yet is a state with an action attached, not a failure. */
  it('says nobody is linked when nobody is', async () => {
    mockFetch([customer], [])
    renderWithToast(
      <B2bClient
        email="a@b.test"
        shops={shops}
        importRun={{
          ranAt: '2026-08-18T09:30:00.000Z', linked: 0, read: 0, imported: 0,
          partial: false, error: null,
        }}
      />,
    )

    expect(await screen.findByText(/no customers are linked to visma/i)).toBeInTheDocument()
  })

  /**
   * Visma is the source of an imported order and the next fifteen-minute run
   * rewrites it from the invoice: an edit would silently revert and a delete
   * would come straight back on the next upsert, losing anything typed onto it.
   * The route refuses both; offering the buttons anyway would just be a way of
   * telling someone their change was saved when it was not.
   */
  it('offers no edit or actions on an order imported from Visma, and says where it came from', async () => {
    mockFetch([customer], [b2bOrder, importedOrder])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    expect(await screen.findByText('123194')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit order 123194/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /actions for 123194/i })).not.toBeInTheDocument()
    // Says why the buttons are missing, rather than leaving an unexplained gap.
    expect(screen.getByText(/from visma/i)).toBeInTheDocument()

    // The hand-entered order beside it is untouched by the rule.
    expect(screen.getByRole('button', { name: /edit order B-0001/i })).toBeInTheDocument()
  })

  it('voids an order by re-sending it with the new status, in major units, converted correctly per discount kind', async () => {
    // PATCH takes the whole order, so voiding loads it first and returns it
    // unchanged but for the status. Assert the request, not just the click —
    // and specifically the money conversion, since that is the riskiest part
    // of this action: PATCH expects major units, so every minor-unit field
    // must go through toMajor, EXCEPT a PERCENT discountValue, which is a
    // plain number and must pass through untouched. Getting this backwards
    // would silently rewrite every AMOUNT discount by 100x on an action
    // taken only to mark an order refunded — the worst possible outcome.
    const calls: { url: string; method?: string; body?: string }[] = []
    mockFetchCapturing(calls, [customer], [b2bOrder])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    fireEvent.click(await screen.findByRole('button', { name: /actions for B-0001/i }))
    fireEvent.click(screen.getByRole('button', { name: /mark refunded/i }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch?.url).toMatch(/\/api\/b2b\/orders\/o1$/)
      const body = JSON.parse(patch!.body!)
      expect(body.status).toBe('refunded')
      // shippingCharged 500 minor -> 5 major; fulfillmentCost 200 -> 2.
      expect(body.shippingCharged).toBe(5)
      expect(body.fulfillmentCost).toBe(2)
      expect(body.lines).toEqual([
        // PERCENT: unitPrice 5000 minor -> 50 major; discountValue 10 is a
        // plain percentage and must be untouched, not divided.
        { productId: 'p1', quantity: 2, unitPrice: 50, discountValue: 10, discountKind: 'PERCENT' },
        // AMOUNT: unitPrice 3000 minor -> 30 major; discountValue 750 minor
        // -> 7.5 major, same conversion as unitPrice, not skipped.
        { productId: 'p2', quantity: 1, unitPrice: 30, discountValue: 7.5, discountKind: 'AMOUNT' },
      ])
    })
  })

  it('asks before deleting, because the Dashboard moves', async () => {
    const calls: { url: string; method?: string }[] = []
    mockFetchCapturing(calls, [customer], [b2bOrder])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    fireEvent.click(await screen.findByRole('button', { name: /actions for B-0001/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete order/i }))

    expect(confirm).toHaveBeenCalled()
    // Declined means nothing was sent.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    confirm.mockRestore()
  })

  it('asks for twelve months of B2B orders, not ninety days', async () => {
    // The card is a working surface, but a business customer may order twice a
    // year — ninety days hid orders the client knew they had placed.
    const calls: { url: string; method?: string; body?: string }[] = []
    mockFetchCapturing(calls, [customer], [])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/orders?source=b2b'))).toBe(true))

    const url = new URL(calls.find((c) => c.url.includes('source=b2b'))!.url, 'http://localhost')
    const from = new Date(url.searchParams.get('from')!)
    const to = new Date(url.searchParams.get('to')!)
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000)

    expect(days).toBe(365)
  })

  it('says twelve months on the card', async () => {
    mockFetch([customer], [])
    renderWithToast(<B2bClient email="a@b.test" shops={shops} />)
    expect(await screen.findByText(/last 12 months/i)).toBeInTheDocument()
  })
})
