// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
  orderedAt: '2026-08-01T00:00:00.000Z',
  eta: null,
  receivedAt: null,
  item: { sku: 'PANPIZPRO', name: 'Pizzetta Pro' },
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
})
