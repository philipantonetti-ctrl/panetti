// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PurchaseOrdersClient, type Order } from './PurchaseOrdersClient'

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}))

beforeEach(() => {
  router.refresh.mockClear()
})

const item = { id: 'i1', sku: 'PANPIZPRO', name: 'Pizzetta Pro' }

const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1',
  quantity: 10,
  // A hand-entered row is the default here, because that is what every test in
  // this file was written about.
  receivedQuantity: null,
  externalId: null,
  orderedAt: '2026-08-01T00:00:00.000Z',
  eta: null,
  receivedAt: null,
  item: { sku: 'PANPIZPRO', name: 'Pizzetta Pro' },
  ...over,
})

/** The same row as Visma would deliver it: part received, with an id of its own. */
const vismaOrder = (over: Partial<Order> = {}): Order =>
  order({
    id: 'v1',
    quantity: 800,
    receivedQuantity: 300,
    externalId: '500001-1',
    eta: '2026-08-20T00:00:00.000Z',
    ...over,
  })

describe('PurchaseOrdersClient', () => {
  it('adds an order with a blank Expected date, sending eta: null and quantity as a number', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    render(<PurchaseOrdersClient orders={[]} items={[item]} />)

    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'i1' } })
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: '25' } })
    fireEvent.change(screen.getByLabelText('Ordered'), { target: { value: '2026-08-14' } })
    // Expected is left blank on purpose.
    fireEvent.click(screen.getByRole('button', { name: 'Add order' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/inventory/purchase-orders')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    // An order whose arrival nobody knows must not push out a run-out date,
    // so a blank Expected has to be sent as null, not omitted or blocked.
    expect(body.eta).toBeNull()
    // The API rejects a numeric string outright, so quantity must be a number.
    expect(body.quantity).toBe(25)
    expect(typeof body.quantity).toBe('number')

    fetchSpy.mockRestore()
  })

  it('refuses units of zero and sends no request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<PurchaseOrdersClient orders={[]} items={[item]} />)

    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'i1' } })
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Ordered'), { target: { value: '2026-08-14' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add order' }))

    expect(screen.getByText('Units must be a whole number above zero.')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('shows that an order with no ETA moves no date', () => {
    const { container } = render(
      <PurchaseOrdersClient orders={[order({ eta: null })]} items={[item]} />,
    )
    expect(container.textContent).toMatch(/no ETA, so it moves no date/i)
  })

  it('does not refresh as though it worked when marking received fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 500 }),
    )
    render(<PurchaseOrdersClient orders={[order()]} items={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /mark received/i }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(router.refresh).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('says a row came from Visma, so someone knows where to fix it', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.getByText('Visma')).toBeInTheDocument()
  })

  it('says a hand-entered row was added here', () => {
    render(<PurchaseOrdersClient orders={[order()]} items={[]} />)
    expect(screen.getByText('added here')).toBeInTheDocument()
  })

  it('shows what landed and what is still coming, not just one number', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.getByText(/800 ordered/)).toBeInTheDocument()
    expect(screen.getByText(/300 landed/)).toBeInTheDocument()
    expect(screen.getByText(/500 still coming/)).toBeInTheDocument()
  })

  it('shows a hand-entered row as one number, exactly as before', () => {
    render(<PurchaseOrdersClient orders={[order({ quantity: 42 })]} items={[]} />)
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.queryByText(/landed/)).not.toBeInTheDocument()
  })

  it('does not offer to mark a Visma row received, because receipt is Visma"s fact', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.queryByRole('button', { name: 'Mark received' })).not.toBeInTheDocument()
    expect(screen.getByText(/Visma records receipts/)).toBeInTheDocument()
  })

  it('still offers it on a hand-entered row', () => {
    render(<PurchaseOrdersClient orders={[order()]} items={[]} />)
    expect(screen.getByRole('button', { name: 'Mark received' })).toBeInTheDocument()
  })

  it('says "recorded" on a Visma row, because seven of them have no real receipt', () => {
    render(
      <PurchaseOrdersClient
        orders={[vismaOrder({ receivedQuantity: 800, receivedAt: '2026-08-18T00:00:00.000Z' })]}
        items={[]}
      />,
    )
    expect(screen.getByText(/recorded/)).toBeInTheDocument()
  })

  it('says "received" on a hand-entered row, where someone really did mark it', () => {
    render(
      <PurchaseOrdersClient orders={[order({ receivedAt: '2026-08-18T00:00:00.000Z' })]} items={[]} />,
    )
    expect(screen.getByText(/received/)).toBeInTheDocument()
    expect(screen.queryByText(/recorded/)).not.toBeInTheDocument()
  })

  it('does not say "none landed yet" about an order Visma has closed', () => {
    // Order 500148's shape: closed, nothing ever booked against it. Saying we
    // are still waiting would be the opposite of the truth.
    render(
      <PurchaseOrdersClient
        orders={[
          vismaOrder({ quantity: 17, receivedQuantity: 0, receivedAt: '2024-11-20T00:00:00.000Z' }),
        ]}
        items={[]}
      />,
    )
    expect(screen.getByText(/closed with no receipt/)).toBeInTheDocument()
    expect(screen.queryByText(/none landed yet/)).not.toBeInTheDocument()
  })
})
