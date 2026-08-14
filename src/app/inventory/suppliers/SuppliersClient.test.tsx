// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SuppliersClient, type Item } from './SuppliersClient'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1', sku: 'PANPIZPRO', name: 'Pizzetta Pro', supplierId: null,
  productionDays: null, deliveryDays: null, moq: null,
  unitsPerContainer: null, coverDays: null,
  ...over,
})

describe('SuppliersClient', () => {
  // Same reason as InventoryClient's tests: a product name sits in a <p> inside
  // a <div>, and both match. getByText throws on multiple matches.
  it('lists every product so nobody has to type a SKU', () => {
    const { container } = render(<SuppliersClient items={[item()]} suppliers={[]} />)
    expect(container.textContent).toMatch(/Pizzetta Pro/)
  })

  it('shows what a product still needs, rather than looking finished', () => {
    const { container } = render(<SuppliersClient items={[item()]} suppliers={[]} />)
    expect(container.textContent).toMatch(/needs lead times/i)
  })

  it('saves a lead time, and sends it as a number', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    render(<SuppliersClient items={[item()]} suppliers={[]} />)

    fireEvent.change(screen.getByLabelText('Production days'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/inventory/items')
    expect(init?.method).toBe('PUT')
    // Sent as a number, not the string the input holds. The API rejects a
    // numeric string outright, so this conversion is load-bearing.
    expect(JSON.parse(String(init?.body))).toMatchObject({ sku: 'PANPIZPRO', productionDays: 30 })

    fetchSpy.mockRestore()
  })

  it('adds a supplier, posting the trimmed name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 's1', name: 'Acme' }), { status: 200 }),
    )
    render(<SuppliersClient items={[]} suppliers={[]} />)

    fireEvent.change(screen.getByLabelText('Supplier name'), { target: { value: '  Acme  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/inventory/suppliers')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Acme' })

    fetchSpy.mockRestore()
  })

  it('refuses a blank supplier name and sends no request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<SuppliersClient items={[]} suppliers={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }))

    expect(screen.getByText('A supplier needs a name.')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('refuses a number typed the way a Norwegian writes it, instead of deleting the value', async () => {
    // Number('1 000') is NaN, JSON.stringify serialises NaN as null, and the API
    // reads null as "clear this field" — so before the guard this erased a saved
    // lead time down the same path as an intentional clear. Nothing may leave
    // the browser.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<SuppliersClient items={[item({ productionDays: 30 })]} suppliers={[]} />)

    fireEvent.change(screen.getByLabelText('Production days'), { target: { value: '1 000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/whole number, digits only/i)).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('surfaces a failed save rather than looking like it worked', async () => {
    // The button used to return to "Save" on a rejected request, so a 400 was
    // indistinguishable from success.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope' }), { status: 400 }),
    )
    render(<SuppliersClient items={[item()]} suppliers={[]} />)

    fireEvent.change(screen.getByLabelText('Production days'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/could not save/i)).toBeTruthy()
    fetchSpy.mockRestore()
  })
})
